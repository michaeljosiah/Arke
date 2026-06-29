import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { DomainEvent, type HarnessAdapter, type PermissionDecision } from "@arke/contracts";
import {
  OpenCodeAdapter,
  loadOpenCodeConfig,
  type DeadLetter,
  type DeadLetterSink,
} from "@arke/adapter-opencode";
import { ReadModel } from "./read-model.js";
import { Trace } from "./trace.js";
import { MockAdapter } from "./mock-adapter.js";
import { ClientConnection } from "./client-connection.js";
import { CoordinatorSessionStore } from "./session-store.js";
import { GrantStore } from "./grant-store.js";

/**
 * Coordinator entry point (PRD §8.5; SPEC-003).
 *
 * Ingests provider events through a {@link HarnessAdapter}, validates them at the boundary,
 * folds them into a {@link ReadModel}, persists each to an append-only {@link Trace} *before*
 * pushing, and streams them to clients over WebSocket — each connection getting a snapshot
 * first, then events with its own per-connection `seq`. A slow client cannot stall the pump,
 * and a malformed event is dead-lettered, not fatal. No cloud backend on the hot path.
 */
const REPO_ROOT = process.env.ARKE_PROJECT_ROOT ?? process.cwd();
const CONFIG_PATH = process.env.ARKE_CONFIG_PATH ?? resolve(REPO_ROOT, ".arke/config.json");
const PORT = Number(process.env.ARKE_COORDINATOR_PORT ?? 4319);
const TRACE_PATH = process.env.ARKE_TRACE_PATH ?? resolve(REPO_ROOT, ".arke/trace.ndjson");
const SESSION_STORE_PATH =
  process.env.ARKE_SESSION_STORE_PATH ?? resolve(REPO_ROOT, ".arke/sessions.ndjson");
const GRANT_STORE_PATH =
  process.env.ARKE_GRANT_STORE_PATH ?? resolve(REPO_ROOT, ".arke/grants.ndjson");

export class Coordinator {
  private ingestSeq = 0; // canonical ingest order for the trace/read-model (NOT the wire seq)
  private clientIdSeq = 0;
  private readonly clients = new Set<ClientConnection>();
  /** Sessions with an open streaming turn (≥1 message.part seen, not yet quiesced). */
  private readonly streaming = new Set<string>();
  private readonly read = new ReadModel();
  private readonly trace: Trace;
  private readonly adapter: HarnessAdapter;
  private readonly grants: GrantStore;
  private readonly port: number;
  private wss?: WebSocketServer;
  private readonly abort = new AbortController();
  /** permissionId → { sessionId, actionClass } for pending asks (so `always` can be keyed). */
  private readonly pendingPerms = new Map<string, { sessionId: string; actionClass: string }>();

  constructor(adapter: HarnessAdapter, trace: Trace, grants: GrantStore, port: number = PORT) {
    this.adapter = adapter;
    this.trace = trace;
    this.grants = grants;
    this.port = port;
  }

  /** Start listening; resolves with the actual bound port (supports ephemeral port 0). */
  async start(): Promise<number> {
    const wss = new WebSocketServer({ port: this.port });
    this.wss = wss;
    wss.on("connection", (ws) => void this.onConnection(ws));
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const addr = wss.address();
    const actual = typeof addr === "object" && addr ? addr.port : this.port;
    console.log(`[coordinator] WebSocket listening on ws://127.0.0.1:${actual}`);
    console.log(
      `[coordinator] adapter=${this.adapter.id} caps=${[...this.adapter.capabilities()].join(",") || "(none)"}`,
    );
    const readiness = this.adapter.readiness?.();
    if (readiness && !readiness.ready) {
      console.error(`[coordinator] adapter not ready: ${readiness.reason}`);
      console.error("[coordinator] serving snapshot only; fix the harness and restart to stream.");
      return actual;
    }
    void this.pump();
    return actual;
  }

  /** Stop the pump and listener, close client connections, and stop any managed harness. */
  async stop(): Promise<void> {
    this.abort.abort(); // ends the adapter stream (and its reconnect loop)
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await this.adapter.stopServer?.(); // stops only a harness this adapter started (SPEC-016)
  }

  private async onConnection(ws: WebSocket): Promise<void> {
    const conn = new ClientConnection(ws, {
      id: `client-${++this.clientIdSeq}`,
      onDrop: (clientId, dropped) =>
        void this.trace.write({ kind: "client.drop", clientId, dropped, at: Date.now() }),
    });
    // Add before sending the snapshot so live events queue (gated) rather than being missed.
    this.clients.add(conn);
    const cards = this.read.snapshot();
    await this.trace.write({ kind: "snapshot", cardCount: cards.length });
    conn.sendSnapshot(JSON.stringify({ type: "snapshot", cards }));
    ws.on("close", () => this.clients.delete(conn));
    ws.on("message", (raw) => void this.onClientMessage(ws, raw.toString()));
  }

  private async onClientMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw) as { type?: string };
    } catch {
      return; // ignore malformed client input
    }
    await this.trace.write({ kind: "client.request", request: msg });

    if (msg.type === "respondToPermission" && this.adapter.respondToPermission) {
      const verb = msg.decision === "always" || msg.decision === "reject" ? msg.decision : "once";
      const decision: PermissionDecision = {
        permissionId: String(msg.permissionId ?? ""),
        decision: verb,
        ...(typeof msg.message === "string" ? { message: msg.message } : {}),
      };
      // `always` persists a remembered grant so matching future requests auto-resolve (SPEC-016).
      if (verb === "always") {
        const pending = this.pendingPerms.get(decision.permissionId);
        if (pending) {
          const grant = this.grants.remember({
            sessionId: pending.sessionId,
            actionClass: pending.actionClass,
            createdBy: "human", // SPEC-012 will carry the real identity
          });
          await this.trace.write({ kind: "grant.remembered", grant });
        }
      }
      try {
        const ack = await this.adapter.respondToPermission(decision);
        await this.trace.write({ kind: "permission.ack", ack });
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "permission.ack", ack }));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "permission.error", permissionId: decision.permissionId, reason }));
        }
      }
    } else if (msg.type === "revokeGrant") {
      this.grants.revoke(String(msg.grantId ?? ""));
      await this.trace.write({ kind: "grant.revoked", grantId: msg.grantId });
    }
  }

  /**
   * Auto-resolve a permission request matching a remembered grant — without prompting a human —
   * and record the auto-grant in the trace with the rule that authorised it (SPEC-016). Returns
   * true if handled (the caller then skips the normal emit so no needs-human flash occurs).
   */
  private async maybeAutoGrant(
    event: Extract<DomainEvent, { type: "permission.asked" }>,
  ): Promise<boolean> {
    const match = this.grants.findMatch(event.sessionId, event.title);
    if (!match) return false;
    await this.trace.write({
      kind: "permission.auto-grant",
      permissionId: event.permissionId,
      sessionId: event.sessionId,
      actionClass: event.title,
      ruleId: match.id,
      at: Date.now(),
    });
    // Fire-and-forget: awaiting would deadlock (confirmation arrives via this same stream).
    void this.adapter
      .respondToPermission?.({ permissionId: event.permissionId, decision: "once" })
      .catch(() => undefined);
    return true;
  }

  /** Ingest → validate → fold → persist → push. Crash-safe: a bad event is dead-lettered. */
  private async pump(): Promise<void> {
    for await (const incoming of this.adapter.streamEvents(this.abort.signal)) {
      const parsed = DomainEvent.safeParse(incoming);
      if (!parsed.success) {
        await this.trace.write({
          kind: "dead-letter",
          rawType: (incoming as { type?: unknown })?.type,
          reason: parsed.error.message,
          at: Date.now(),
        });
        continue; // pump never crashes on a malformed event
      }
      const event = parsed.data;

      // Permission asks: record the action class (so `always` can key a grant), and
      // auto-resolve from a remembered grant without prompting (SPEC-016) — skipping the
      // normal emit so no needs-human flash reaches the board.
      if (event.type === "permission.asked") {
        this.pendingPerms.set(event.permissionId, {
          sessionId: event.sessionId,
          actionClass: event.title,
        });
        if (await this.maybeAutoGrant(event)) continue;
      } else if (event.type === "permission.replied") {
        this.pendingPerms.delete(event.permissionId);
      }

      await this.emit(event);

      // Derive the typed quiescence receipt: a completed turn that had at least one part.
      if (event.type === "message.part") {
        this.streaming.add(event.sessionId);
      } else if (
        event.type === "message.updated" &&
        !event.isStreaming &&
        this.streaming.delete(event.sessionId)
      ) {
        await this.emit({
          seq: 0,
          ts: 0,
          harness: event.harness,
          ...(event.correlationId ? { correlationId: event.correlationId } : {}),
          type: "turn.quiescent",
          sessionId: event.sessionId,
          turnId: event.messageId,
        });
      }
    }
  }

  /** Stamp ingest seq + ts, fold, trace (before push), then push to every client. */
  private async emit(event: DomainEvent): Promise<void> {
    const stamped: DomainEvent = { ...event, seq: ++this.ingestSeq, ts: Date.now() };
    this.read.apply(stamped);
    await this.trace.write({ kind: "event", event: stamped });
    for (const conn of this.clients) conn.pushEvent(stamped);
  }
}

/** Build the harness adapter from config, falling back to the mock when unconfigured. */
async function buildAdapter(trace: Trace): Promise<HarnessAdapter> {
  const config = loadOpenCodeConfig({ configPath: CONFIG_PATH, baseDir: REPO_ROOT });
  if (!config) {
    console.log("[coordinator] no OpenCode instance in .arke/config.json — using MockAdapter");
    return new MockAdapter();
  }

  const deadLetterSink: DeadLetterSink = {
    write: (dl: DeadLetter) => trace.write({ ...dl }), // dl.kind === "dead-letter"
  };
  // The durable ownership store lives with the coordinator; the adapter writes through it.
  const adapter = new OpenCodeAdapter(config, {
    sessionStore: new CoordinatorSessionStore(SESSION_STORE_PATH, "OpenCode"),
    deadLetterSink,
    onLifecycleEvent: (record) => void trace.write(record), // harness start/stop/exit (SPEC-016)
  });
  console.log(
    `[coordinator] ${config.manageHarness ? "starting & probing" : "probing"} OpenCode at ${config.baseUrl} …`,
  );
  await adapter.init();
  return adapter;
}

async function bootstrap(): Promise<void> {
  const trace = new Trace(TRACE_PATH);
  const grants = new GrantStore(GRANT_STORE_PATH);
  grants.load(); // restore remembered grants across restarts (SPEC-016)
  let adapter: HarnessAdapter;
  try {
    adapter = await buildAdapter(trace);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[coordinator] adapter init failed (${reason}); falling back to MockAdapter`);
    adapter = new MockAdapter();
  }
  await new Coordinator(adapter, trace, grants).start();
}

// Only auto-start when run directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void bootstrap();
}
