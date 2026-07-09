import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  /** threadId → resolvers for a synchronous sendMessage awaiting that thread's next `turn/completed`. */
  private readonly turnWaiters = new Map<string, Array<() => void>>();

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
      // Close the spawned app-server so a failed init doesn't leak the child process (review): the
      // coordinator degrades to NullAdapter, and a retry must not stack orphaned Codex processes.
      try {
        server.close();
      } catch {
        /* already gone */
      }
      this.server = null;
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
    })) as { thread?: { id?: string } } | undefined;
    // Real shape: ThreadStartResponse = { thread: Thread, … } where Thread.id is the thread id.
    const threadId = strOf(res?.thread?.id);
    if (threadId) this.sessions.bindThread(sessionId, threadId);
    return { sessionId };
  }

  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    // Synchronous send (HarnessAdapter contract): resolve when the TURN COMPLETES, not when `turn/start`
    // is merely accepted — else the cockpit's prompt.send re-enables input mid-turn (review).
    return this.startTurn(input, true);
  }

  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    // Fire-and-watch (FR-8): `turn/start` returns as soon as the turn is accepted; the turn streams via
    // notifications. dispatchAsync must NOT block on completion.
    return this.startTurn(input, false);
  }

  private async startTurn(input: SendMessageInput, awaitCompletion: boolean): Promise<SendReceipt> {
    if (!this.sessions.get(input.sessionId)) {
      this.sessions.record(input.sessionId, { specId: input.sessionId, kind: "spec" });
    }
    this.lastSession = input.sessionId;
    const threadId = this.sessions.threadFor(input.sessionId) ?? input.sessionId;
    const text = input.parts.map((p) => p.text).join("");
    const params: Record<string, unknown> = {
      threadId,
      // Real shape: TurnStartParams.input is UserInput[]; the text variant carries `text_elements`.
      input: [{ type: "text", text, text_elements: [] }],
      // The agent pins its own model (SPEC-016 revised); Codex serves the OpenAI id (the model `name`).
      ...(input.model ? { model: input.model.name } : {}),
    };
    const res = (await this.srv().request("turn/start", params)) as { turn?: { id?: string } } | undefined;
    const correlationId = input.correlationId ?? strOf(res?.turn?.id) ?? `turn_${threadId}_${++this.n}`;
    if (awaitCompletion) await this.awaitTurnCompletion(threadId);
    return { sessionId: input.sessionId, correlationId };
  }

  /** Resolve when this thread's next `turn/completed` arrives — or on a bounded timeout / server close. */
  private awaitTurnCompletion(threadId: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, TURN_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      const arr = this.turnWaiters.get(threadId) ?? [];
      arr.push(finish);
      this.turnWaiters.set(threadId, arr);
    });
  }

  streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    return this.channel.drain(signal);
  }

  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    const pending = this.approvals.take(decision.permissionId);
    if (!pending) return { permissionId: decision.permissionId, status: "stale" };
    // Answer the exact open JSON-RPC approval request; then confirm with a permission.replied event.
    // Real response shape: `{ decision }` (e.g. CommandExecutionRequestApprovalResponse), not a bare string.
    this.srv().respond(pending.jsonRpcId, { decision: codexDecision(decision.decision) });
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
    // The app-server DOES expose a catalog via `model/list` (verified against the real protocol — the
    // Codex CLI can't enumerate, but the app-server can). Use it, falling back to the config-driven /
    // known list when unavailable (not yet initialised, offline, unauthenticated, or an older server).
    if (this.server) {
      try {
        const res = (await this.server.request("model/list", {})) as { data?: Array<{ id?: string; model?: string; displayName?: string }> } | undefined;
        const data = res?.data;
        if (Array.isArray(data) && data.length > 0) {
          const mapped = data
            .map((m) => ({ id: strOf(m.model) ?? strOf(m.id) ?? "", provider: "openai", ...(strOf(m.displayName) ? { displayName: m.displayName as string } : {}) }))
            .filter((m) => m.id);
          if (mapped.length > 0) return mapped;
        }
      } catch {
        /* fall through to the config catalog */
      }
    }
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
    // The app-server process exiting must be observed — else readiness() keeps reporting ready and
    // streamEvents() stays open while every request silently times out (review). Release any awaiting
    // sendMessage so it can't hang on a turn that will never complete.
    server.onClose(() => {
      this.ready = false;
      for (const arr of this.turnWaiters.values()) for (const r of arr) r();
      this.turnWaiters.clear();
      this.channel.close();
    });
  }

  /** Resolve the Arke session a thread-scoped notification belongs to. */
  private sessionForParams(params: Record<string, unknown>): string | null {
    const threadId = strOf(params.threadId) ?? strOf((params.item as { threadId?: string } | undefined)?.threadId);
    if (threadId) return this.sessions.arkeForThread(threadId);
    // No thread id on the frame (rare — real notifications carry one). Fall back to the active session
    // ONLY when there is exactly one, so a stray frame can't be misattributed across concurrent sessions.
    return this.sessions.size === 1 ? this.lastSession : null;
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
    // A completed turn releases any synchronous sendMessage awaiting it (keyed by the Codex thread).
    if (method.replace(/\//g, ".") === "turn.completed") {
      const threadId = strOf(params.threadId) ?? this.sessions.threadFor(sessionId);
      const waiters = threadId ? this.turnWaiters.get(threadId) : undefined;
      if (threadId && waiters) {
        this.turnWaiters.delete(threadId);
        for (const r of waiters) r();
      }
    }
  }

  private onServerRequest(method: string, params: Record<string, unknown>, id: number | string): void {
    if (!isApprovalRequest(method)) {
      // Any other server-initiated request (permissions-scope grant, MCP elicitation, tool user-input, …)
      // is not something Arke's decision gate can answer — reply with a JSON-RPC error so Codex isn't left
      // waiting on it forever (review). Declining-by-default is the safe posture.
      this.srv().respondError(id, -32601, `Arke does not handle the '${method}' server request`);
      return;
    }
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

/** Upper bound on how long a synchronous `sendMessage` waits for a turn to complete before resolving. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Derive a {@link DiffSummary} from git in `cwd` — the on-disk truth (SPEC-034 Decision #4). Diffs the
 * working tree against HEAD (so STAGED + unstaged tracked changes both count) and adds UNTRACKED files —
 * a plain `git diff` misses both, which would show an empty diff for a Codex turn that stages or creates
 * files (review). Best-effort: any git failure degrades to zeros rather than throwing.
 */
function gitDiffSummary(cwd: string): DiffSummary {
  try {
    let added = 0;
    let removed = 0;
    const files = new Set<string>();
    const numstat = spawnSync("git", ["diff", "--numstat", "HEAD"], { cwd, encoding: "utf8" });
    if (numstat.status === 0) {
      for (const line of numstat.stdout.split("\n")) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (!m) continue;
        files.add(m[3]!);
        if (m[1] !== "-") added += Number(m[1]);
        if (m[2] !== "-") removed += Number(m[2]);
      }
    }
    // Untracked files (git diff ignores them): count each new file's lines as additions.
    const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" });
    if (untracked.status === 0) {
      for (const f of untracked.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
        files.add(f);
        try {
          added += readFileSync(resolve(cwd, f), "utf8").split("\n").length;
        } catch {
          /* binary/unreadable — the file still counts, just not its line delta */
        }
      }
    }
    const patch = spawnSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8" });
    return { added, removed, files: files.size, ...(patch.status === 0 && patch.stdout ? { patch: patch.stdout } : {}) };
  } catch {
    return { added: 0, removed: 0, files: 0 };
  }
}
