import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DomainEvent } from "@arke/contracts";
import type {
  AgentImage,
  Capability,
  CreateSessionInput,
  DiffSummary,
  HarnessAdapter,
  ModelTier,
  PermissionAck,
  PermissionDecision,
  Readiness,
  SendMessageInput,
  SendReceipt,
  SessionRef,
  TodoItem,
} from "@arke/contracts";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
  DEFAULT_RESOLVE_MODEL,
  type OpenCodeConfig,
  type ResolvedModel,
} from "./config.js";
import { OpenCodeHttp } from "./http.js";
import { HarnessProcess } from "./harness-process.js";
import { probeCapabilities } from "./capabilities.js";
import {
  FileSessionStore,
  InMemorySessionStore,
  type SessionRecord,
  type SessionStore,
} from "./session-graph.js";
import { ArrayDeadLetterSink, type DeadLetterSink } from "./dead-letter.js";
import { type EventIdentity, normalize } from "./normalize.js";
import { PermissionCoordinator, type PermissionClient } from "./permissions.js";
import { parseSse } from "./sse.js";

/**
 * OpenCode harness adapter (SPEC-002; see docs/analysis/opencode-integration-guide.md).
 *
 * Implements the backend-agnostic {@link HarnessAdapter} against a live `opencode serve`:
 * HTTP for commands, SSE for state. Everything OpenCode-specific is absorbed here so the
 * coordinator and client learn no OpenCode fact. Identity, capabilities, and reliability are
 * first-class: the session ownership graph is rebuilt from REST and persisted; capabilities
 * are probed at startup; unmappable events are dead-lettered; permissions confirm by event.
 */
export interface OpenCodeAdapterDeps {
  /** Durable session ownership graph. Defaults to in-memory (durability needs a file store). */
  sessionStore?: SessionStore;
  /** Where unmappable events go. Defaults to an in-memory array. */
  deadLetterSink?: DeadLetterSink;
  /** Records harness lifecycle events (started/exited) to the trace (SPEC-016). */
  onLifecycleEvent?: (record: Record<string, unknown>) => void;
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly id = "OpenCode";

  private readonly http: OpenCodeHttp;
  private readonly config: OpenCodeConfig;
  private readonly store: SessionStore;
  private readonly dlq: DeadLetterSink;
  private readonly onLifecycleEvent?: (record: Record<string, unknown>) => void;
  private harness?: HarnessProcess;
  private readonly permissions: PermissionCoordinator;
  private readonly resolveModel: (tier: ModelTier) => ResolvedModel;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  /** Probed capability set; empty until {@link init}. Never assumed. */
  private caps: Set<Capability> = new Set();
  private _readiness: Readiness = { ready: false, reason: "not initialised" };
  private deadLetterCount = 0;
  /** sessionId → correlationId of the in-flight turn, so emitted events attribute to it. */
  private readonly activeTurn = new Map<string, string>();

  constructor(config: OpenCodeConfig, deps: OpenCodeAdapterDeps = {}) {
    this.http = new OpenCodeHttp(config);
    this.config = config;
    this.store = deps.sessionStore ?? new InMemorySessionStore();
    this.dlq = deps.deadLetterSink ?? new ArrayDeadLetterSink();
    this.onLifecycleEvent = deps.onLifecycleEvent;
    this.resolveModel = config.resolveModel ?? DEFAULT_RESOLVE_MODEL;
    this.reconnectBaseMs = config.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;

    const permClient: PermissionClient = {
      // Map the once/always/reject vocabulary onto the server's reply (SPEC-016). OpenCode's
      // UI surfaces once/always/reject; older servers accept approve/deny — send both forms.
      reply: (id, decision, message) => {
        const response = decision === "reject" ? "reject" : decision; // once | always | reject
        const approve = decision !== "reject";
        return this.http
          .req("POST", `/permission/${id}/reply`, {
            response,
            approve, // tolerated by approve/deny servers; ignored by once/always/reject servers
            ...(message ? { message } : {}),
          })
          .then(() => undefined);
      },
      pending: async () => {
        const list = await this.http.req<
          Array<{ id?: string; request_id?: string; requestID?: string }>
        >("GET", "/permission/");
        return (list ?? [])
          .map((x) => x.id ?? x.request_id ?? x.requestID)
          .filter((x): x is string => typeof x === "string");
      },
    };
    this.permissions = new PermissionCoordinator(
      permClient,
      config.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    );
  }

  // ---- lifecycle ----------------------------------------------------------

  capabilities(): ReadonlySet<Capability> {
    return this.caps;
  }

  readiness(): Readiness {
    return this._readiness;
  }

  /** How many events have been dead-lettered (diagnostic for the coordinator/trace). */
  deadLetters(): number {
    return this.deadLetterCount;
  }

  /** Probe the live server, load durable ownership, and build the initial graph. Idempotent. */
  async init(): Promise<void> {
    this.store.load();
    if (this.config.manageHarness) await this.startServer();
    const probe = await probeCapabilities(this.http);
    this.caps = probe.capabilities;
    this._readiness = probe.readiness;
    if (probe.readiness.ready) {
      await this.rebuildSessionGraph();
    }
  }

  /** Spawn and own a harness process (managed mode). No-op if already running or in attach mode. */
  async startServer(): Promise<void> {
    if (!this.config.manageHarness || this.harness?.running) return;
    const command = this.config.harnessCommand ?? this.defaultHarnessCommand();
    this.harness = new HarnessProcess({
      command,
      cwd: this.http.directory,
      // Host-only credentials go into the child's environment, never to the client (NFR-1).
      env: this.config.password ? { OPENCODE_SERVER_PASSWORD: this.config.password } : undefined,
      healthCheck: () => this.http.req("GET", "/global/health").then(() => true).catch(() => false),
      shell: process.platform === "win32", // resolve the `opencode` shim on Windows
      onExit: (code, signal) => {
        this._readiness = {
          ready: false,
          reason: `managed harness exited (code=${code ?? "?"}, signal=${signal ?? "?"})`,
        };
        this.onLifecycleEvent?.({ kind: "harness.exit", harness: this.id, code, signal, at: Date.now() });
      },
    });
    await this.harness.start();
    this.onLifecycleEvent?.({ kind: "harness.started", harness: this.id, pid: this.harness.pid, at: Date.now() });
  }

  /** Stop a harness process this adapter started; never stops a server it did not start. */
  async stopServer(): Promise<void> {
    if (!this.harness) return; // attach mode, or we never started one
    await this.harness.stop();
    this.onLifecycleEvent?.({ kind: "harness.stopped", harness: this.id, at: Date.now() });
    this.harness = undefined;
  }

  private defaultHarnessCommand(): string[] {
    const u = new URL(this.config.baseUrl);
    const port = u.port || "4096";
    const host = u.hostname || "127.0.0.1";
    return ["opencode", "serve", "--hostname", host, "--port", port];
  }

  // ---- agent images (SPEC-016) -------------------------------------------

  /** Materialise a portable agent image into OpenCode's `.opencode/agents/<name>.md` convention. */
  async materializeAgent(image: AgentImage): Promise<void> {
    const dir = join(this.http.directory, ".opencode", "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${image.name}.md`), this.agentMarkdown(image), "utf8");
    // Sub-agents become their own files (OpenCode links them by parentID at runtime).
    for (const sub of image.subAgents) await this.materializeAgent(sub);
  }

  /** Render the OpenCode agent markdown: frontmatter (with logical `tier:`) + instruction body. */
  private agentMarkdown(image: AgentImage): string {
    const lines: string[] = ["---", `description: ${image.description ?? image.name}`, `mode: ${image.interaction.mode}`];
    // The tier is the contract; the registry resolves it to a concrete model at session-create.
    lines.push(`tier: ${image.tier}`);
    const perms = Object.entries(image.permission);
    if (perms.length > 0) {
      lines.push("permission:");
      for (const [k, v] of perms) lines.push(`  ${k}: ${v}`);
    }
    lines.push("---", "", image.instructions ?? "");
    return lines.join("\n") + "\n";
  }

  // ---- sessions -----------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    const session = await this.http.req<{ id: string }>("POST", "/session", {
      parentID: input.parent,
      title: input.specId, // title encodes the spec_id so REST resync can recover ownership
    });
    this.store.upsert({
      sessionId: session.id,
      kind: input.parent ? "task" : "spec",
      specId: input.specId,
      parentSessionId: input.parent,
    });
    return { sessionId: session.id };
  }

  // ---- prompting ----------------------------------------------------------

  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    const correlationId = input.correlationId ?? `msg_${randomUUID()}`;
    this.activeTurn.set(input.sessionId, correlationId);
    try {
      await this.http.req(
        "POST",
        `/session/${input.sessionId}/message`,
        this.messageBody(input, correlationId),
      );
      return { sessionId: input.sessionId, correlationId };
    } finally {
      // Sync turn is done when the POST returns; idle event also clears this defensively.
      this.activeTurn.delete(input.sessionId);
    }
  }

  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    const correlationId = input.correlationId ?? `msg_${randomUUID()}`;
    // Stays set until session.idle: completion is signalled, never inferred by the caller.
    this.activeTurn.set(input.sessionId, correlationId);
    await this.http.req(
      "POST",
      `/session/${input.sessionId}/prompt_async`,
      this.messageBody(input, correlationId),
    );
    return { sessionId: input.sessionId, correlationId };
  }

  private messageBody(input: SendMessageInput, correlationId: string) {
    return {
      messageID: correlationId,
      agent: input.agent,
      model: this.resolveModel(input.tier),
      parts: input.parts.map((p) => ({ type: "text", text: p.text })),
    };
  }

  // ---- todos / diff / permissions / commands ------------------------------

  async getTodos(ref: SessionRef): Promise<TodoItem[]> {
    const todos = await this.http.req<Array<{ id: string; text: string; completed: boolean }>>(
      "GET",
      `/session/${ref.sessionId}/todo`,
    );
    return (todos ?? []).map((t) => ({ id: t.id, text: t.text, done: t.completed }));
  }

  async getDiff(ref: SessionRef): Promise<DiffSummary> {
    const files = await this.http.req<Array<{ additions?: number; deletions?: number }>>(
      "GET",
      `/session/${ref.sessionId}/diff`,
    );
    const list = files ?? [];
    return {
      files: list.length,
      added: list.reduce((n, f) => n + (f.additions ?? 0), 0),
      removed: list.reduce((n, f) => n + (f.deletions ?? 0), 0),
    };
  }

  respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    return this.permissions.decide(decision);
  }

  async runCommand(ref: SessionRef, command: string, args?: string[]): Promise<void> {
    await this.http.req("POST", `/session/${ref.sessionId}/command`, {
      command,
      arguments: args ?? [],
    });
  }

  // ---- event stream -------------------------------------------------------

  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    let attempt = 0;
    while (!signal?.aborted) {
      let body: ReadableStream<Uint8Array>;
      try {
        // (Re)connect: OpenCode cannot replay missed events, so rebuild ownership from REST
        // and reconcile in-flight decisions before trusting the live stream (D2/D4).
        await this.resyncViaRest();
        body = await this.http.openEventStream(signal);
      } catch {
        if (signal?.aborted) return;
        await this.backoff(attempt++);
        continue;
      }
      attempt = 0;
      // Re-fetch current todo/diff state so the read model re-converges after a reconnect.
      yield* this.snapshotEvents();
      try {
        for await (const raw of parseSse(body, signal)) {
          for (const event of await this.process(raw)) yield event;
        }
      } catch {
        // stream dropped — fall through to reconnect
      }
      if (signal?.aborted) return;
      await this.backoff(attempt++);
    }
  }

  /** Map → enrich → validate one raw frame; resolve unknown sessions; dead-letter the rest. */
  private async process(raw: unknown): Promise<DomainEvent[]> {
    let outcome = normalize(raw, (sid) => this.identityOf(sid), this.id);

    if (outcome.kind === "unknown-session") {
      const resolved = await this.resolveSession(outcome.sessionId);
      if (!resolved) {
        this.deadLetter(`unresolved session ownership: ${outcome.sessionId}`, raw);
        return [];
      }
      outcome = normalize(raw, (sid) => this.identityOf(sid), this.id);
    }

    switch (outcome.kind) {
      case "graph":
        this.store.upsert(outcome.record);
        return [];
      case "ignore":
      case "unknown-session": // still unresolved after a REST attempt
        if (outcome.kind === "unknown-session") {
          this.deadLetter(`unresolved session ownership: ${outcome.sessionId}`, raw);
        }
        return [];
      case "dead-letter":
        this.deadLetter(outcome.reason, raw);
        return [];
      case "event": {
        this.observe(outcome.event);
        const finished = this.finishEvent(outcome.event, raw);
        return finished ? [finished] : [];
      }
    }
  }

  /** Side effects an emitted event triggers in the adapter (not in the pure normaliser). */
  private observe(event: DomainEvent): void {
    if (event.type === "permission.replied") {
      this.permissions.onReplied(event.permissionId);
    } else if (event.type === "session.status" && event.status === "idle") {
      this.activeTurn.delete(event.sessionId); // turn quiescent → correlation closes
    }
  }

  /** Attach correlation id (where applicable) and validate at the boundary before emission. */
  private finishEvent(event: DomainEvent, raw: unknown): DomainEvent | null {
    let candidate: DomainEvent = event;
    // Attach the in-flight turn's correlation id, unless the event already carries one
    // (message.* events derive it from their own messageID in the normaliser).
    if ("sessionId" in event && !event.correlationId) {
      const corr = this.activeTurn.get(event.sessionId);
      if (corr) candidate = { ...event, correlationId: corr };
    }
    const parsed = DomainEvent.safeParse(candidate);
    if (!parsed.success) {
      this.deadLetter(`schema validation failed: ${parsed.error.message}`, raw);
      return null;
    }
    return parsed.data;
  }

  private identityOf(sessionId: string): EventIdentity | undefined {
    const rec = this.store.get(sessionId);
    return rec ? { specId: rec.specId, kind: rec.kind } : undefined;
  }

  private deadLetter(reason: string, raw: unknown): void {
    this.deadLetterCount += 1;
    void this.dlq.write({ kind: "dead-letter", reason, raw, seq: this.deadLetterCount, at: Date.now() });
  }

  // ---- REST recovery ------------------------------------------------------

  /** Rebuild the ownership graph from REST and reconcile in-flight permission decisions. */
  private async resyncViaRest(): Promise<void> {
    await this.rebuildSessionGraph();
    await this.permissions.reconcile();
  }

  /** List sessions, follow `parentID`, and record each session's ownership durably. */
  async rebuildSessionGraph(): Promise<void> {
    const list = await this.http
      .req<Array<{ id?: string; parentID?: string; title?: string }>>("GET", "/session")
      .catch(() => [] as Array<{ id?: string; parentID?: string; title?: string }>);
    for (const s of list ?? []) {
      if (!s?.id) continue;
      this.store.upsert({
        sessionId: s.id,
        kind: s.parentID ? "task" : "spec",
        specId: s.title ?? s.id,
        parentSessionId: s.parentID,
      });
    }
  }

  /** Targeted REST resolve for a session absent from the graph (and its parent). */
  async resolveSession(sessionId: string): Promise<SessionRecord | undefined> {
    try {
      const s = await this.http.req<{ id?: string; parentID?: string; title?: string }>(
        "GET",
        `/session/${sessionId}`,
      );
      if (!s?.id) return undefined;
      if (s.parentID && !this.store.get(s.parentID)) {
        await this.resolveSession(s.parentID).catch(() => undefined);
      }
      const record: SessionRecord = {
        sessionId: s.id,
        kind: s.parentID ? "task" : "spec",
        specId: s.title ?? s.id,
        parentSessionId: s.parentID,
      };
      this.store.upsert(record);
      return record;
    } catch {
      return undefined;
    }
  }

  /** Deterministic re-fetch of todo/diff state for each known session (re-convergence). */
  private async *snapshotEvents(): AsyncGenerator<DomainEvent> {
    for (const rec of this.store.all()) {
      if (this.caps.has("todos")) {
        try {
          const todos = await this.getTodos({ sessionId: rec.sessionId });
          const ev = this.finishEvent(
            { seq: 0, ts: 0, harness: this.id, type: "todo.updated", sessionId: rec.sessionId, todos },
            null,
          );
          if (ev) yield ev;
        } catch {
          /* session may be gone; skip */
        }
      }
      if (this.caps.has("diff")) {
        try {
          const d = await this.getDiff({ sessionId: rec.sessionId });
          const ev = this.finishEvent(
            {
              seq: 0,
              ts: 0,
              harness: this.id,
              type: "diff.finalized",
              sessionId: rec.sessionId,
              added: d.added,
              removed: d.removed,
              files: d.files,
            },
            null,
          );
          if (ev) yield ev;
        } catch {
          /* skip */
        }
      }
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const ms = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** attempt);
    await new Promise((r) => {
      const t = setTimeout(r, ms);
      if (typeof t.unref === "function") t.unref();
    });
  }
}

// Public surface for the coordinator and tests.
export { OpenCodeHttp, OpenCodeError } from "./http.js";
export { HarnessProcess, type HarnessProcessOptions } from "./harness-process.js";
export {
  type OpenCodeConfig,
  type ResolvedModel,
  type LoadConfigOptions,
  loadOpenCodeConfig,
  canonicalizeRoot,
  isWithinRoot,
  resolveDirectory,
  parseModelRef,
  DirectoryEscapeError,
  DEFAULT_RESOLVE_MODEL,
  DEFAULT_PERMISSION_TIMEOUT_MS,
} from "./config.js";
export {
  type SessionRecord,
  type SessionStore,
  InMemorySessionStore,
  FileSessionStore,
} from "./session-graph.js";
export { type DeadLetter, type DeadLetterSink, ArrayDeadLetterSink } from "./dead-letter.js";
export { type EventIdentity, type NormalizeOutcome, normalize } from "./normalize.js";
export { probeCapabilities, type ProbeResult, type ProbeClient } from "./capabilities.js";
export { PermissionCoordinator, type PermissionClient } from "./permissions.js";
export { parseSse } from "./sse.js";
