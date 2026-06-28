import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { DomainEvent, type HarnessAdapter, type PermissionDecision } from "@arke/contracts";
import {
  FileSessionStore,
  OpenCodeAdapter,
  loadOpenCodeConfig,
  type DeadLetter,
  type DeadLetterSink,
} from "@arke/adapter-opencode";
import { ReadModel } from "./read-model.js";
import { Trace } from "./trace.js";
import { MockAdapter } from "./mock-adapter.js";

/**
 * Coordinator entry point (PRD §8.5).
 *
 * Ingests provider events through a {@link HarnessAdapter}, normalizes + validates them
 * at the boundary, folds them into a {@link ReadModel}, persists each to an append-only
 * {@link Trace}, and pushes them to connected clients over WebSocket — ordered,
 * monotonically sequenced per connection, schema-validated (NFR-8). No cloud backend
 * sits on the hot path; this process runs on the harness host, inside the trust boundary.
 *
 * The harness adapter is constructed from `.arke/config.json` when an OpenCode instance is
 * configured (SPEC-002); otherwise it falls back to the mock so the loop still runs.
 */
const REPO_ROOT = process.env.ARKE_PROJECT_ROOT ?? process.cwd();
const CONFIG_PATH = process.env.ARKE_CONFIG_PATH ?? resolve(REPO_ROOT, ".arke/config.json");
const PORT = Number(process.env.ARKE_COORDINATOR_PORT ?? 4319);
const TRACE_PATH = process.env.ARKE_TRACE_PATH ?? resolve(REPO_ROOT, ".arke/trace.ndjson");
const SESSION_STORE_PATH =
  process.env.ARKE_SESSION_STORE_PATH ?? resolve(REPO_ROOT, ".arke/sessions.ndjson");

class Coordinator {
  private seq = 0;
  private readonly clients = new Set<WebSocket>();
  private readonly read = new ReadModel();
  private readonly trace: Trace;
  private readonly adapter: HarnessAdapter;

  constructor(adapter: HarnessAdapter, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  start(): void {
    const wss = new WebSocketServer({ port: PORT });
    wss.on("connection", (ws) => this.onConnection(ws));
    console.log(`[coordinator] WebSocket listening on ws://127.0.0.1:${PORT}`);
    console.log(
      `[coordinator] adapter=${this.adapter.id} caps=${[...this.adapter.capabilities()].join(",") || "(none)"}`,
    );
    const readiness = this.adapter.readiness?.();
    if (readiness && !readiness.ready) {
      console.error(`[coordinator] adapter not ready: ${readiness.reason}`);
      console.error("[coordinator] serving snapshot only; fix the harness and restart to stream.");
      return;
    }
    void this.pump();
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    // Replay current state on (re)subscribe so a reconnecting client catches up (NFR-8).
    ws.send(JSON.stringify({ type: "snapshot", cards: this.read.snapshot() }));
    ws.on("close", () => this.clients.delete(ws));
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

    // Route a human's permission decision to the adapter; confirm via the event, not status.
    if (msg.type === "respondToPermission" && this.adapter.respondToPermission) {
      const decision: PermissionDecision = {
        permissionId: String(msg.permissionId ?? ""),
        granted: Boolean(msg.granted),
      };
      try {
        const ack = await this.adapter.respondToPermission(decision);
        await this.trace.write({ kind: "permission.ack", ack });
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "permission.ack", ack }));
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "permission.error", permissionId: decision.permissionId, reason }));
        }
      }
    }
  }

  /** Ingest → validate → normalize → persist → push. */
  private async pump(): Promise<void> {
    for await (const incoming of this.adapter.streamEvents()) {
      const event = DomainEvent.parse({ ...incoming, seq: ++this.seq, ts: Date.now() });
      this.read.apply(event);
      await this.trace.write({ kind: "event", event });
      const payload = JSON.stringify({ type: "event", event });
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    }
  }
}

/** Build the harness adapter from config, falling back to the mock when unconfigured. */
async function buildAdapter(trace: Trace): Promise<HarnessAdapter> {
  const config = loadOpenCodeConfig({ configPath: CONFIG_PATH, baseDir: REPO_ROOT });
  if (!config) {
    console.log("[coordinator] no OpenCode instance in .arke/config.json — using MockAdapter");
    return new MockAdapter();
  }

  // Dead letters are persisted to the audit trace, never silently dropped (SPEC-002 D7).
  const deadLetterSink: DeadLetterSink = {
    write: (dl: DeadLetter) => trace.write({ ...dl }), // dl.kind === "dead-letter"
  };
  const adapter = new OpenCodeAdapter(config, {
    sessionStore: new FileSessionStore(SESSION_STORE_PATH),
    deadLetterSink,
  });
  console.log(`[coordinator] probing OpenCode at ${config.baseUrl} …`);
  await adapter.init();
  return adapter;
}

async function bootstrap(): Promise<void> {
  const trace = new Trace(TRACE_PATH);
  let adapter: HarnessAdapter;
  try {
    adapter = await buildAdapter(trace);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[coordinator] adapter init failed (${reason}); falling back to MockAdapter`);
    adapter = new MockAdapter();
  }
  new Coordinator(adapter, trace).start();
}

void bootstrap();
