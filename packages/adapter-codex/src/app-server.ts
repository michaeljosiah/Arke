import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DEFAULT_CODEX_BIN, DEFAULT_REQUEST_TIMEOUT_MS, type CodexConfig } from "./config.js";

/**
 * The `codex app-server` JSON-RPC 2.0 client over stdio (SPEC-034). Codex's app-server is the only
 * headless surface that issues **server→client approval requests** the host answers — the precondition
 * for the propose·decide·execute gate — so the adapter integrates here, not via `codex exec` (Decision #1).
 *
 * This module owns the wire protocol: framing, the `initialize`/`initialized` handshake, id-correlated
 * requests, notifications, and the server→client request hook (approvals). It is decoupled from the
 * process by {@link CodexTransport}, so tests drive a FAKE in-process transport with scripted frames
 * rather than spawning a real Codex (which is not installed / needs OpenAI auth — see the spec's DoD).
 *
 * FRAMING NOTE (SPEC-034 open question): built to the documented protocol as **newline-delimited JSON**
 * (one JSON-RPC message per line), the same shape `codex exec --json` uses. If a live smoke test finds
 * the app-server uses Content-Length/LSP framing instead, only {@link StdioTransport} changes.
 */

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A bidirectional framed message channel to a Codex app-server. Abstracted for testability. */
export interface CodexTransport {
  send(message: JsonRpcMessage): void;
  onMessage(cb: (m: JsonRpcMessage) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** The default transport: spawn `codex app-server` and frame JSON-RPC as newline-delimited JSON on stdio. */
export class StdioTransport implements CodexTransport {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private messageCb: ((m: JsonRpcMessage) => void) | null = null;
  private closeCb: (() => void) | null = null;

  constructor(config: CodexConfig) {
    const bin = config.bin ?? DEFAULT_CODEX_BIN;
    // `codex app-server` speaks JSON-RPC on stdio by default. Auth is host-side (NFR-1): the child
    // inherits the host environment (OPENAI_API_KEY / ~/.codex/auth.json) — no credential is passed here.
    this.proc = spawn(bin, ["app-server"], { cwd: config.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.on("close", () => this.closeCb?.());
    this.proc.on("error", () => this.closeCb?.());
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        this.messageCb?.(JSON.parse(line) as JsonRpcMessage);
      } catch {
        /* a non-JSON line (e.g. a stray log) is ignored, not fatal */
      }
    }
  }

  send(message: JsonRpcMessage): void {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }
  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.messageCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

/** A pending client→server request awaiting its response. */
interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
/** A server→client request the client MUST answer (e.g. an approval). Reply via {@link CodexAppServer.respond}. */
export type ServerRequestHandler = (method: string, params: Record<string, unknown>, id: number | string) => void;

/** JSON-RPC 2.0 client over a {@link CodexTransport}: requests, notifications, and server-request routing. */
export class CodexAppServer {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;

  constructor(private readonly transport: CodexTransport, private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    transport.onMessage((m) => this.route(m));
    transport.onClose(() => this.onClose());
  }

  /** JSON-RPC handshake: `initialize` request → then the `initialized` notification (SPEC-034). */
  async initialize(clientInfo: { name: string; version: string } = { name: "arke", version: "0.1.0" }): Promise<unknown> {
    const result = await this.request("initialize", { clientInfo });
    this.notify("initialized", {});
    return result;
  }

  /** Send a request and resolve with its `result` (or reject on `error`/timeout). */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("codex app-server is closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex request '${method}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  /** Send a notification (no id, no response expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    this.transport.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  /** Answer a server→client request (e.g. an approval decision) by its id. */
  respond(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.transport.send({ jsonrpc: "2.0", id, result });
  }

  onNotification(cb: NotificationHandler): void {
    this.notificationHandler = cb;
  }
  onServerRequest(cb: ServerRequestHandler): void {
    this.serverRequestHandler = cb;
  }
  onClose(cb?: () => void): void {
    if (cb) this.closeHandler = cb;
    else {
      // internal: transport closed — reject all pending and notify.
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("codex app-server closed"));
      }
      this.pending.clear();
      this.closeHandler?.();
    }
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("codex app-server closed"));
    }
    this.pending.clear();
    this.transport.close();
  }

  /** Route an incoming JSON-RPC message: response → pending; id+method → server request; method-only → notification. */
  private route(m: JsonRpcMessage): void {
    if (m == null || typeof m !== "object") return;
    const hasId = m.id !== undefined && m.id !== null;
    const hasMethod = typeof m.method === "string";
    if (hasId && !hasMethod) {
      // Response to one of our requests.
      const p = this.pending.get(m.id!);
      if (!p) return;
      this.pending.delete(m.id!);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || "codex request failed"));
      else p.resolve(m.result);
      return;
    }
    if (hasId && hasMethod) {
      // Server→client REQUEST (needs a response) — e.g. item/<kind>/requestApproval.
      this.serverRequestHandler?.(m.method!, (m.params ?? {}) as Record<string, unknown>, m.id!);
      return;
    }
    if (hasMethod) {
      // Notification (no id).
      this.notificationHandler?.(m.method!, (m.params ?? {}) as Record<string, unknown>);
    }
  }
}
