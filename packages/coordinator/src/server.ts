import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DomainEvent,
  type AgentImage,
  type HarnessAdapter,
  type PermissionAck,
  type PermissionDecision,
  type ScaffoldStep,
} from "@arke/contracts";
import {
  OpenCodeAdapter,
  loadOpenCodeConfig,
  resolveDirectory,
  type DeadLetter,
  type DeadLetterSink,
} from "@arke/adapter-opencode";
import { loadAgentImage } from "@arke/agent-image";
import { ReadModel } from "./read-model.js";
import { Trace } from "./trace.js";
import { MockAdapter } from "./mock-adapter.js";
import { ClientConnection } from "./client-connection.js";
import { CoordinatorSessionStore } from "./session-store.js";
import { GrantStore } from "./grant-store.js";
import { InputValidator, ValidationError } from "./input-validator.js";
import { FolderInspector, type FolderState } from "./folder-inspector.js";
import { HarnessReachabilityProbe } from "./reachability.js";
import { ScaffoldRunner, type ScaffoldTiers } from "./scaffold.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

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

  // ---- onboarding state (SPEC-004), folded into every connection's snapshot frame ----
  private readonly projectRoot: string; // the safe root all client paths are validated against
  private readonly endpoints: string[]; // harness endpoints to probe (empty → adapter readiness)
  private readonly probe: HarnessReachabilityProbe;
  private readonly tierDefaults: ScaffoldTiers; // pre-filled tier→model, from the registry
  private harnessReachable = true;
  private harnessReachabilityReason?: string;
  private harnessPartial = false;
  private projectState: FolderState | null = null;
  private missingSentinels: string[] = [];

  constructor(
    adapter: HarnessAdapter,
    trace: Trace,
    grants: GrantStore,
    port: number = PORT,
    opts: {
      projectRoot?: string;
      endpoints?: string[];
      probe?: HarnessReachabilityProbe;
      tierDefaults?: ScaffoldTiers;
    } = {},
  ) {
    this.adapter = adapter;
    this.trace = trace;
    this.grants = grants;
    this.port = port;
    this.projectRoot = opts.projectRoot ?? REPO_ROOT;
    this.endpoints = opts.endpoints ?? [];
    this.probe = opts.probe ?? new HarnessReachabilityProbe();
    this.tierDefaults = opts.tierDefaults ?? {};
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
    // Classify the project folder and probe harness reachability once at startup; both fold into
    // the snapshot every client receives, so the onboarding gate has its state before any frame.
    this.classifyProject();
    await this.refreshReachability();

    const readiness = this.adapter.readiness?.();
    if (readiness && !readiness.ready) {
      console.error(`[coordinator] adapter not ready: ${readiness.reason}`);
      console.error("[coordinator] serving snapshot only; fix the harness and restart to stream.");
      return actual;
    }
    void this.pump();
    return actual;
  }

  /** Inspect the project root and remember its method-ready classification (SPEC-004). */
  private classifyProject(): void {
    try {
      const cls = FolderInspector.classify(this.projectRoot);
      this.projectState = cls.state;
      this.missingSentinels = cls.missingSentinels;
    } catch {
      this.projectState = null;
      this.missingSentinels = [];
    }
  }

  /**
   * Probe harness reachability and push a `harness.reachability` event per endpoint (SPEC-004).
   * With no explicit endpoints (e.g. the mock), fall back to the adapter's own readiness so the
   * onboarding gate still reflects a usable harness. Updates the snapshot fields.
   */
  private async refreshReachability(): Promise<void> {
    if (this.endpoints.length === 0) {
      const r = this.adapter.readiness?.() ?? { ready: true };
      this.harnessReachable = r.ready;
      this.harnessReachabilityReason = r.ready ? undefined : (r.reason ?? "harness not ready");
      this.harnessPartial = false;
      await this.emit({
        seq: 0,
        ts: 0,
        harness: this.adapter.id,
        type: "harness.reachability",
        endpoint: this.adapter.id,
        reachable: r.ready,
        ...(this.harnessReachabilityReason ? { reason: this.harnessReachabilityReason } : {}),
      });
      return;
    }
    const { reachable, results } = await this.probe.anyReachable(this.endpoints);
    this.harnessReachable = reachable;
    const failed = results.find((res) => !res.reachable);
    this.harnessReachabilityReason = reachable ? undefined : failed?.reason;
    this.harnessPartial = !reachable && (failed?.partial ?? false);
    for (const res of results) {
      await this.emit({
        seq: 0,
        ts: 0,
        harness: this.adapter.id,
        type: "harness.reachability",
        endpoint: res.endpoint,
        reachable: res.reachable,
        ...(res.partial ? { partial: true } : {}),
        ...(res.reason ? { reason: res.reason } : {}),
      });
    }
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
    // Attach listeners synchronously — BEFORE any await — so a client that sends a request
    // immediately on open (e.g. the CLI) is not dropped while the snapshot is being prepared.
    ws.on("close", () => this.clients.delete(conn));
    ws.on("message", (raw) => void this.onClientMessage(ws, raw.toString()));
    const cards = this.read.snapshot();
    await this.trace.write({ kind: "snapshot", cardCount: cards.length });
    // The snapshot also carries the onboarding state (SPEC-004): harness reachability and the
    // project's method-ready classification, so the client can render the gate before any project
    // action. No credential value, raw path, or file content is ever included (NFR-1).
    conn.sendSnapshot(
      JSON.stringify({
        type: "snapshot",
        cards,
        harnessReachable: this.harnessReachable,
        ...(this.harnessReachabilityReason ? { harnessReachabilityReason: this.harnessReachabilityReason } : {}),
        ...(this.harnessPartial ? { harnessReachabilityPartial: true } : {}),
        projectState: this.projectState,
        missingSentinels: this.missingSentinels,
        tierDefaults: this.tierDefaults,
      }),
    );
  }

  private async onClientMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw) as { type?: string };
    } catch {
      return; // ignore malformed client input
    }
    await this.trace.write({ kind: "client.request", request: msg });

    // SPEC-017: request/response command surface (CLI + any client) over the same WS.
    if (msg.type === "request") {
      await this.handleRequest(ws, msg);
      return;
    }

    // SPEC-004 onboarding messages (browser client). Every path/URL is validated and
    // canonicalised before any filesystem or git access; failures reply `validation-error`.
    if (msg.type === "harness.probe") {
      await this.refreshReachability();
      return;
    }
    if (msg.type === "folder.inspect") {
      await this.onFolderInspect(ws, msg);
      return;
    }
    if (msg.type === "repo.clone") {
      await this.onRepoClone(ws, msg);
      return;
    }
    if (msg.type === "scaffold.run") {
      await this.onScaffoldRun(ws, msg);
      return;
    }

    // Back-compat convenience messages the browser client already sends.
    if (msg.type === "respondToPermission") {
      const decision = this.buildDecision(msg);
      try {
        const ack = await this.decidePermission(decision);
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

  private buildDecision(msg: { [k: string]: unknown }): PermissionDecision {
    // Fail closed: the WS is an API for any client, so an invalid/misspelled verb must error
    // rather than silently coercing to allow-once (which could approve a pending permission).
    const verb = msg.decision;
    if (verb !== "once" && verb !== "always" && verb !== "reject") {
      throw new Error(`invalid permission decision '${String(verb)}': must be once | always | reject`);
    }
    return {
      permissionId: String(msg.permissionId ?? ""),
      decision: verb,
      ...(typeof msg.message === "string" ? { message: msg.message } : {}),
    };
  }

  /** Relay a decision, remembering an `always` grant first, and trace the ack (SPEC-016). */
  private async decidePermission(decision: PermissionDecision): Promise<PermissionAck> {
    if (!this.adapter.respondToPermission) throw new Error("harness does not support permissions");
    if (decision.decision === "always") {
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
    const ack = await this.adapter.respondToPermission(decision);
    await this.trace.write({ kind: "permission.ack", ack });
    return ack;
  }

  /** One request → one response over the WS; ok with a result or a structured error. */
  private async handleRequest(ws: WebSocket, msg: { [k: string]: unknown }): Promise<void> {
    const id = msg.id;
    const op = String(msg.op ?? "");
    try {
      const result = await this.dispatch(op, msg.args);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "response", id, ok: true, result }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "response", id, ok: false, error }));
    }
  }

  /** Map a CLI/client op to a coordinator/adapter capability (SPEC-017). */
  private async dispatch(op: string, rawArgs: unknown): Promise<unknown> {
    const a = (rawArgs ?? {}) as Record<string, unknown>;
    switch (op) {
      case "session.create": {
        const specId = String(a.specId ?? "");
        const parent = a.parent ? String(a.parent) : undefined;
        const ref = await this.adapter.createSession({ specId, ...(parent ? { parent } : {}) });
        // Fold a normalized idle status so the new session shows up in session.list and for live
        // clients immediately, even on adapters that emit no creation event (e.g. the mock).
        await this.emit({
          seq: 0,
          ts: 0,
          harness: this.adapter.id,
          type: "session.status",
          sessionId: ref.sessionId,
          specId,
          kind: parent ? "task" : "spec",
          status: "idle",
        });
        return ref;
      }
      case "session.list":
        return this.read.snapshot();
      case "prompt.send":
      case "prompt.dispatch": {
        const input = {
          sessionId: String(a.sessionId ?? ""),
          agent: String(a.agent ?? ""),
          tier: a.tier === "capable" ? ("capable" as const) : ("mid" as const),
          parts: [{ type: "text" as const, text: String(a.message ?? "") }],
          ...(a.correlationId ? { correlationId: String(a.correlationId) } : {}),
        };
        return op === "prompt.send" ? this.adapter.sendMessage(input) : this.adapter.dispatchAsync(input);
      }
      case "todos.get":
        if (!this.adapter.getTodos) throw new Error("harness does not support todos");
        return this.adapter.getTodos({ sessionId: String(a.sessionId ?? "") });
      case "diff.get":
        if (!this.adapter.getDiff) throw new Error("harness does not support diff");
        return this.adapter.getDiff({ sessionId: String(a.sessionId ?? "") });
      case "permission.list":
        return [...this.pendingPerms.entries()].map(([permissionId, p]) => ({
          permissionId,
          sessionId: p.sessionId,
          actionClass: p.actionClass,
        }));
      case "permission.decide":
        return this.decidePermission(this.buildDecision(a));
      case "grant.list":
        return this.grants.all();
      case "grant.revoke": {
        const grantId = String(a.grantId ?? "");
        this.grants.revoke(grantId);
        await this.trace.write({ kind: "grant.revoked", grantId });
        return { revoked: grantId };
      }
      case "agents.list":
        return this.loadAgentImages(a.dir).map((img) => ({
          name: img.name,
          tier: img.tier,
          description: img.description,
          mode: img.interaction.mode,
        }));
      case "agents.materialize": {
        if (!this.adapter.materializeAgent) throw new Error("harness does not support agent materialisation");
        const images = this.loadAgentImages(a.dir);
        for (const img of images) await this.adapter.materializeAgent(img);
        return { materialized: images.map((i) => i.name) };
      }
      // SPEC-004 onboarding, exposed on the op surface so the CLI and agents can drive
      // setup end-to-end (paths/URLs validated identically to the typed-message path).
      case "harness.probe":
        await this.refreshReachability();
        return { reachable: this.harnessReachable, ...(this.harnessReachabilityReason ? { reason: this.harnessReachabilityReason } : {}) };
      case "folder.inspect":
        return this.inspectFolder(a.path);
      case "repo.clone":
        return this.cloneRepo(a.url, a.targetPath);
      case "scaffold.run": {
        const result = await this.runScaffold(a.path, a.tiers, a.resumeFrom);
        return { ok: result.ok, stepsRun: result.stepsRun, steps: result.steps };
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  /** Load every agent image directory under `dir` (default `agents/`) for list/materialize. */
  private loadAgentImages(dir: unknown): AgentImage[] {
    // `dir` comes from client args — validate it stays within the project root, refusing
    // absolute paths and `..` escapes (throws DirectoryEscapeError, surfaced as a request error).
    const base = resolveDirectory(REPO_ROOT, typeof dir === "string" && dir ? dir : "agents");
    if (!existsSync(base)) return [];
    const out: AgentImage[] = [];
    for (const name of readdirSync(base)) {
      const d = resolve(base, name);
      // Only the filesystem probe is guarded; a directory that *is* an image (has config.yaml)
      // but fails to parse must surface as an error, not be silently skipped — otherwise
      // `agents.materialize` reports success while leaving a required role unmaterialised.
      let isImage = false;
      try {
        isImage = statSync(d).isDirectory() && existsSync(resolve(d, "config.yaml"));
      } catch {
        isImage = false;
      }
      if (isImage) out.push(loadAgentImage(d)); // throws on a malformed image → fails the command
    }
    return out;
  }

  // ---- SPEC-004 onboarding core (shared by typed messages and the op surface) ----------

  /** Validate + classify a folder; updates the remembered project state. Throws on bad input. */
  private inspectFolder(rawPath: unknown): {
    state: FolderState;
    missingSentinels: string[];
    projectPath: string;
  } {
    const path = InputValidator.canonicalisePath(String(rawPath ?? ""), this.projectRoot);
    const cls = FolderInspector.classify(path);
    this.projectState = cls.state;
    this.missingSentinels = cls.missingSentinels;
    return { state: cls.state, missingSentinels: cls.missingSentinels, projectPath: path };
  }

  /** Validate a clone URL + target, run `git clone`, then classify the cloned result. */
  private async cloneRepo(
    rawUrl: unknown,
    rawTarget: unknown,
  ): Promise<{ state: FolderState; missingSentinels: string[]; projectPath: string }> {
    const url = InputValidator.validateCloneUrl(String(rawUrl ?? ""));
    const target = InputValidator.canonicalisePath(String(rawTarget ?? ""), this.projectRoot);
    if (!gitAvailable()) throw new Error("git not found on PATH; cannot clone");
    // url is validated (no shell-special chars) and passed as an arg array — no shell, no injection.
    const res = spawnSync("git", ["clone", url, target], { stdio: "ignore" });
    if (res.status !== 0) throw new Error(`git clone failed (exit ${res.status ?? "signal"})`);
    const cls = FolderInspector.classify(target);
    return { state: cls.state, missingSentinels: cls.missingSentinels, projectPath: target };
  }

  /** Validate the path, resolve tier defaults, run the scaffold, then kick off grounding. */
  private async runScaffold(rawPath: unknown, rawTiers: unknown, rawResumeFrom: unknown) {
    const path = InputValidator.canonicalisePath(String(rawPath ?? ""), this.projectRoot);
    const supplied = (rawTiers ?? {}) as Record<string, unknown>;
    const tiers: ScaffoldTiers = {
      capable: typeof supplied.capable === "string" ? supplied.capable : this.tierDefaults.capable,
      mid: typeof supplied.mid === "string" ? supplied.mid : this.tierDefaults.mid,
    };
    const resumeFrom =
      typeof rawResumeFrom === "string" ? (rawResumeFrom as ScaffoldStep) : undefined;
    const runner = new ScaffoldRunner({
      root: path,
      harness: this.adapter.id,
      emit: (e) => this.emit(e),
      trace: this.trace,
    });
    const result = await runner.run({ tiers, ...(resumeFrom ? { resumeFrom } : {}) });
    // Re-classify so a subsequent snapshot reflects the now method-ready state.
    this.classifyProject();
    if (result.ok) void this.runGrounding(path); // best-effort; never blocks the scaffold response
    return result;
  }

  /**
   * Grounding session (SPEC-004): dispatch the researcher role to analyse the repo and (re)write
   * AGENTS.md, recording full provenance in the trace. Best-effort — a harness without dispatch,
   * or any failure, is traced and never throws into the scaffold path. The commit SHA is recorded
   * when the harness commits; absent a git commit we anchor provenance on the AGENTS.md content
   * hash so the entry is still auditable.
   */
  private async runGrounding(projectPath: string): Promise<void> {
    try {
      const agentsMdPath = resolve(projectPath, "AGENTS.md");
      const previousSha = fileSha(agentsMdPath);
      const session = await this.adapter.createSession({ specId: "grounding" });
      await this.adapter.dispatchAsync({
        sessionId: session.sessionId,
        agent: "researcher",
        tier: "mid",
        parts: [
          {
            type: "text",
            text: "Analyse this repository and rewrite AGENTS.md with module structure, key entry points, and conventions.",
          },
        ],
      });
      const newSha = fileSha(agentsMdPath);
      await this.trace.write({
        kind: "grounding.session",
        sessionId: session.sessionId,
        role: "researcher",
        completedAt: new Date().toISOString(),
        agentsMdSha: newSha,
        ...(previousSha && previousSha !== newSha ? { previousAgentsMdSha: previousSha } : {}),
      });
    } catch (err) {
      await this.trace.write({
        kind: "grounding.session",
        role: "researcher",
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private sendValidationError(ws: WebSocket, err: unknown): void {
    if (ws.readyState !== ws.OPEN) return;
    if (err instanceof ValidationError) {
      ws.send(JSON.stringify({ type: "validation-error", field: err.field, reason: err.message }));
    } else {
      ws.send(JSON.stringify({ type: "error", reason: err instanceof Error ? err.message : String(err) }));
    }
  }

  private async onFolderInspect(ws: WebSocket, msg: { [k: string]: unknown }): Promise<void> {
    try {
      const r = this.inspectFolder(msg.path);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "folder.inspected", ...r }));
    } catch (err) {
      this.sendValidationError(ws, err);
    }
  }

  private async onRepoClone(ws: WebSocket, msg: { [k: string]: unknown }): Promise<void> {
    try {
      const r = await this.cloneRepo(msg.url, msg.targetPath);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "folder.inspected", ...r }));
    } catch (err) {
      this.sendValidationError(ws, err);
    }
  }

  private async onScaffoldRun(ws: WebSocket, msg: { [k: string]: unknown }): Promise<void> {
    try {
      // Validation happens before any filesystem access; scaffold.step/done events stream as it runs.
      await this.runScaffold(msg.path, msg.tiers, msg.resumeFrom);
    } catch (err) {
      this.sendValidationError(ws, err);
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

/** Whether git is on PATH (clone + advisory vendored-repos step depend on it). */
function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** sha256 of a file's contents, or undefined if it does not exist — a provenance anchor. */
function fileSha(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/** The adapter plus the onboarding metadata derived from config (endpoints, tier defaults). */
interface BuiltAdapter {
  adapter: HarnessAdapter;
  endpoints: string[];
  tierDefaults: ScaffoldTiers;
}

/** Build the harness adapter from config, falling back to the mock when unconfigured. */
async function buildAdapter(trace: Trace): Promise<BuiltAdapter> {
  const config = loadOpenCodeConfig({ configPath: CONFIG_PATH, baseDir: REPO_ROOT });
  if (!config) {
    console.log("[coordinator] no OpenCode instance in .arke/config.json — using MockAdapter");
    return { adapter: new MockAdapter(), endpoints: [], tierDefaults: {} };
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
  // Tier labels are the registry-resolved model names — the single place vendor ids live (FR-4).
  const tierDefaults: ScaffoldTiers = {
    capable: config.resolveModel?.("capable").name,
    mid: config.resolveModel?.("mid").name,
  };
  return { adapter, endpoints: [config.baseUrl], tierDefaults };
}

async function bootstrap(): Promise<void> {
  const trace = new Trace(TRACE_PATH);
  const grants = new GrantStore(GRANT_STORE_PATH);
  grants.load(); // restore remembered grants across restarts (SPEC-016)
  let built: BuiltAdapter;
  try {
    built = await buildAdapter(trace);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[coordinator] adapter init failed (${reason}); falling back to MockAdapter`);
    built = { adapter: new MockAdapter(), endpoints: [], tierDefaults: {} };
  }
  await new Coordinator(built.adapter, trace, grants, PORT, {
    endpoints: built.endpoints,
    tierDefaults: built.tierDefaults,
  }).start();
}

// Only auto-start when run directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void bootstrap();
}
