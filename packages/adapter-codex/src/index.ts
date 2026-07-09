import { spawnSync } from "node:child_process";
import {
  type Capability,
  type CreateSessionInput,
  type DiffSummary,
  DomainEvent,
  type HarnessAdapter,
  type ModelInfo,
  type PermissionAck,
  type PermissionDecision,
  type Readiness,
  type SendMessageInput,
  type SendReceipt,
  type SessionRef,
  type TodoItem,
} from "@arke/contracts";
import { CODEX_CAPABILITIES } from "./capabilities.js";
import { type CodexConfig } from "./config.js";
import { CodexAppServer, StdioTransport } from "./app-server.js";
import { createNormalizeState, normalize, type NormalizeState } from "./normalize.js";
import { SessionMap } from "./session-map.js";
import { Approvals, approvalTitle, codexDecision, isApprovalRequest } from "./permissions.js";
import { codexModelCatalog } from "./models.js";

export * from "./config.js";
export * from "./capabilities.js";
export * from "./models.js";
export { CodexAppServer, StdioTransport, type CodexTransport, type JsonRpcMessage } from "./app-server.js";
export { normalize, createNormalizeState, type NormalizeState } from "./normalize.js";
export { SessionMap, type SessionIdentity } from "./session-map.js";

/**
 * A multi-producer / single-consumer channel: the single app-server pump (and the approval hook) push
 * normalised events; the adapter's one `streamEvents()` drains them (mirrors the Omnigent adapter).
 */
class EventChannel {
  private queue: DomainEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(ev: DomainEvent): void {
    if (this.closed) return;
    this.queue.push(ev);
    this.wake?.();
    this.wake = null;
  }
  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }
  async *drain(signal?: AbortSignal): AsyncGenerator<DomainEvent> {
    while (true) {
      if (signal?.aborted) return;
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((res) => {
        this.wake = res;
        signal?.addEventListener("abort", () => res(), { once: true });
      });
    }
  }
}

/**
 * The OpenAI Codex leaf adapter (SPEC-034). Drives Codex over `codex app-server` (JSON-RPC 2.0/stdio) —
 * a transport that shares nothing with OpenCode's HTTP/SSE, which is the point: it proves the neutral
 * `HarnessAdapter` seam. One long-lived server; one Codex **thread** per Arke session (`thread/start`);
 * one **turn** per prompt (`turn/start`); streaming `item/*` notifications fanned into one channel; and
 * Codex's server→client `item/<kind>/requestApproval` routed through Arke's human gate.
 *
 * The app-server is created lazily in {@link init}; tests inject a factory returning a server over a fake
 * in-process transport (Codex is not installed / needs OpenAI auth here — the live smoke test is a DoD
 * follow-up, SPEC-034).
 */
export class CodexAdapter implements HarnessAdapter {
  readonly id = "Codex";
  private server: CodexAppServer | null = null;
  private ready = false;
  private n = 0;
  private lastSession: string | null = null;
  private readonly sessions = new SessionMap();
  private readonly normState: NormalizeState = createNormalizeState();
  private readonly channel = new EventChannel();
  private readonly approvals = new Approvals();
  private readonly lastTodos = new Map<string, TodoItem[]>();

  constructor(
    private readonly config: CodexConfig,
    private readonly makeServer: () => CodexAppServer = () => new CodexAppServer(new StdioTransport(config), config.requestTimeoutMs),
  ) {}

  capabilities(): ReadonlySet<Capability> {
    return CODEX_CAPABILITIES;
  }

  /** Spawn + handshake the app-server and wire the notification / approval handlers. Idempotent. */
  async init(): Promise<void> {
    if (this.server) return;
    const server = this.makeServer();
    this.wireHandlers(server);
    this.server = server;
    try {
      await server.initialize();
      this.ready = true;
    } catch (err) {
      this.ready = false;
      throw err;
    }
  }

  readiness(): Readiness {
    return this.ready ? { ready: true } : { ready: false, reason: "codex app-server not reachable" };
  }

  private srv(): CodexAppServer {
    if (!this.server) throw new Error("codex adapter not initialised — call init() first");
    return this.server;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    const sessionId = `${input.specId}-cx-${++this.n}`;
    this.sessions.record(sessionId, { specId: input.specId, kind: input.parent ? "task" : "spec" }, input.cwd);
    this.lastSession = sessionId;
    // Start a Codex thread for this session. Approval policy defaults to `on-request` (NOT `never`) so a
    // gated action round-trips through Arke's human gate rather than auto-approving (config.ts).
    const cwd = input.cwd ?? this.config.cwd;
    const res = (await this.srv().request("thread/start", {
      cwd,
      approvalPolicy: this.config.approvalPolicy ?? "on-request",
      sandbox: this.config.sandbox ?? "workspace-write",
    })) as { threadId?: string; thread_id?: string; id?: string } | undefined;
    const threadId = strOf(res?.threadId) ?? strOf(res?.thread_id) ?? strOf(res?.id);
    if (threadId) this.sessions.bindThread(sessionId, threadId);
    return { sessionId };
  }

  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    return this.startTurn(input);
  }

  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    // `turn/start` is already fire-and-stream (the turn executes via notifications), so send + dispatch
    // share a path — mirrors the Omnigent adapter.
    return this.startTurn(input);
  }

  private async startTurn(input: SendMessageInput): Promise<SendReceipt> {
    if (!this.sessions.get(input.sessionId)) {
      this.sessions.record(input.sessionId, { specId: input.sessionId, kind: "spec" });
    }
    this.lastSession = input.sessionId;
    const threadId = this.sessions.threadFor(input.sessionId) ?? input.sessionId;
    const text = input.parts.map((p) => p.text).join("");
    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text }],
      // The agent pins its own model (SPEC-016 revised); Codex serves the OpenAI id (the model `name`).
      ...(input.model ? { model: input.model.name } : {}),
    };
    const res = (await this.srv().request("turn/start", params)) as { turnId?: string; turn_id?: string } | undefined;
    const correlationId = input.correlationId ?? strOf(res?.turnId) ?? strOf(res?.turn_id) ?? `turn_${threadId}_${++this.n}`;
    return { sessionId: input.sessionId, correlationId };
  }

  streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    return this.channel.drain(signal);
  }

  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    const pending = this.approvals.take(decision.permissionId);
    if (!pending) return { permissionId: decision.permissionId, status: "stale" };
    // Answer the exact open JSON-RPC approval request; then confirm with a permission.replied event.
    this.srv().respond(pending.jsonRpcId, codexDecision(decision.decision));
    this.pushEvent({
      seq: 0,
      ts: 0,
      harness: this.id,
      type: "permission.replied",
      sessionId: pending.sessionId,
      permissionId: decision.permissionId,
      granted: decision.decision !== "reject",
    });
    return { permissionId: decision.permissionId, status: "confirmed" };
  }

  async getTodos(ref: SessionRef): Promise<TodoItem[]> {
    return this.lastTodos.get(ref.sessionId) ?? [];
  }

  async getDiff(ref: SessionRef): Promise<DiffSummary> {
    const cwd = this.sessions.get(ref.sessionId)?.cwd ?? this.config.cwd;
    return gitDiffSummary(cwd);
  }

  async listModels(): Promise<ModelInfo[]> {
    // Config-driven / known catalog — Codex has no enumeration API (SPEC-034 Decision #3).
    return codexModelCatalog(this.config.models);
  }

  async stopServer(): Promise<void> {
    this.server?.close();
    this.server = null;
    this.ready = false;
    this.channel.close();
  }

  // ---- internals -------------------------------------------------------------

  private wireHandlers(server: CodexAppServer): void {
    server.onNotification((method, params) => this.onNotification(method, params));
    server.onServerRequest((method, params, id) => this.onServerRequest(method, params, id));
  }

  /** Resolve the Arke session a thread-scoped notification belongs to (falling back to the last session). */
  private sessionForParams(params: Record<string, unknown>): string | null {
    const threadId = strOf(params.threadId) ?? strOf(params.thread_id) ?? strOf((params.item as { threadId?: string } | undefined)?.threadId);
    if (threadId) return this.sessions.arkeForThread(threadId);
    return this.lastSession;
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const sessionId = this.sessionForParams(params);
    if (!sessionId) return;
    const identity = this.sessions.identity(sessionId);
    for (const ev of normalize(method, params, sessionId, identity, this.id, this.normState)) {
      const parsed = DomainEvent.safeParse(ev);
      if (!parsed.success) continue; // boundary validation
      if (parsed.data.type === "todo.updated") this.lastTodos.set(sessionId, parsed.data.todos);
      this.channel.push(parsed.data);
    }
  }

  private onServerRequest(method: string, params: Record<string, unknown>, id: number | string): void {
    if (!isApprovalRequest(method)) return; // unknown server request — not answerable here; leave it
    const sessionId = this.sessionForParams(params) ?? this.lastSession ?? "";
    const permissionId = this.approvals.register(id, sessionId);
    const { title, detail } = approvalTitle(method, params);
    this.pushEvent({ seq: 0, ts: 0, harness: this.id, type: "permission.asked", sessionId, permissionId, title, ...(detail ? { detail } : {}) });
  }

  /** Validate at the boundary + enqueue; an event that fails the schema is dropped, never thrown. */
  private pushEvent(raw: unknown): void {
    const parsed = DomainEvent.safeParse(raw);
    if (parsed.success) this.channel.push(parsed.data);
  }
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Derive a {@link DiffSummary} from git in `cwd` — the on-disk truth (SPEC-034 Decision #4). Best-effort. */
function gitDiffSummary(cwd: string): DiffSummary {
  try {
    const numstat = spawnSync("git", ["diff", "--numstat"], { cwd, encoding: "utf8" });
    if (numstat.status !== 0) return { added: 0, removed: 0, files: 0 };
    let added = 0;
    let removed = 0;
    let files = 0;
    for (const line of numstat.stdout.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      files++;
      if (m[1] !== "-") added += Number(m[1]);
      if (m[2] !== "-") removed += Number(m[2]);
    }
    const patch = spawnSync("git", ["diff"], { cwd, encoding: "utf8" });
    return { added, removed, files, ...(patch.status === 0 && patch.stdout ? { patch: patch.stdout } : {}) };
  } catch {
    return { added: 0, removed: 0, files: 0 };
  }
}
