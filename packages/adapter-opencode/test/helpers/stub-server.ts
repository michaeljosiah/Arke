import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal in-process stand-in for `opencode serve`, exercising the adapter's real `fetch`
 * + SSE paths. It is intentionally small: just enough surface for SPEC-002's integration and
 * contract tests, with controls to push events, drop connections, and observe request counts.
 */
export interface StubSession {
  id: string;
  parentID?: string;
  title?: string;
}

export class StubOpenCodeServer {
  private server?: Server;
  private readonly sse = new Set<ServerResponse>();
  private readonly sessions = new Map<string, StubSession>();
  private readonly todos = new Map<string, Array<{ id: string; text: string; completed: boolean }>>();
  private readonly diffs = new Map<string, Array<{ additions: number; deletions: number }>>();
  private pendingPermissions: string[] = [];
  private seq = 0;

  /** Per-path request counts, e.g. counts.get("GET /session"). */
  readonly counts = new Map<string, number>();
  /** Last request body seen per route key, e.g. lastBodies.get("POST /session/:id/message"). */
  readonly lastBodies = new Map<string, unknown>();
  /** OpenAPI paths advertised at GET /doc (override to simulate older/forked servers). */
  docPaths: Record<string, unknown> = {
    "/global/health": {},
    "/global/event": {},
    "/doc": {},
    "/session": {},
    "/session/{id}": {},
    "/session/{id}/message": {},
    "/session/{id}/prompt_async": {},
    "/session/{id}/todo": {},
    "/session/{id}/diff": {},
    "/session/{id}/command": {},
    "/permission/": {},
    "/permission/{requestID}/reply": {},
  };

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.sse) res.end();
    this.sse.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  // ---- test controls ----

  addSession(session: StubSession): void {
    this.sessions.set(session.id, session);
  }

  setTodos(sessionId: string, todos: Array<{ id: string; text: string; completed: boolean }>): void {
    this.todos.set(sessionId, todos);
  }

  setDiff(sessionId: string, files: Array<{ additions: number; deletions: number }>): void {
    this.diffs.set(sessionId, files);
  }

  setPending(ids: string[]): void {
    this.pendingPermissions = ids;
  }

  /** Push a raw OpenCode event to all SSE subscribers. */
  push(event: unknown): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sse) res.write(frame);
  }

  /** Drop all SSE connections to simulate a stream disconnect. */
  dropConnections(): void {
    for (const res of this.sse) res.end();
    this.sse.clear();
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  get sseClientCount(): number {
    return this.sse.size;
  }

  // ---- request handling ----

  private bump(method: string, pathname: string): void {
    const key = `${method} ${pathname}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : undefined;
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    const payload = value === undefined ? "" : JSON.stringify(value);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // SSE
    if (method === "GET" && (path === "/global/event" || path === "/event")) {
      this.bump(method, "/global/event");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      this.sse.add(res);
      req.on("close", () => this.sse.delete(res));
      return;
    }

    if (method === "GET" && path === "/global/health") {
      this.bump(method, path);
      return this.json(res, 200, { status: "ok" });
    }

    if (method === "GET" && path === "/doc") {
      this.bump(method, path);
      return this.json(res, 200, { openapi: "3.1.0", paths: this.docPaths });
    }

    if (method === "POST" && path === "/session") {
      this.bump(method, "/session");
      const b = (await this.body(req)) as { parentID?: string; title?: string };
      const id = `ses_${++this.seq}`;
      const session: StubSession = { id, parentID: b?.parentID, title: b?.title };
      this.sessions.set(id, session);
      return this.json(res, 200, session);
    }

    if (method === "GET" && path === "/session") {
      this.bump(method, "/session");
      return this.json(res, 200, [...this.sessions.values()]);
    }

    const sessionMatch = /^\/session\/([^/]+)(\/(todo|diff|message|prompt_async|command))?$/.exec(path);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]!);
      const sub = sessionMatch[3];
      if (method === "GET" && !sub) {
        this.bump("GET", "/session/:id");
        const s = this.sessions.get(id);
        return s ? this.json(res, 200, s) : this.json(res, 404, { error: "not found" });
      }
      if (method === "GET" && sub === "todo") {
        this.bump("GET", "/session/:id/todo");
        return this.json(res, 200, this.todos.get(id) ?? []);
      }
      if (method === "GET" && sub === "diff") {
        this.bump("GET", "/session/:id/diff");
        return this.json(res, 200, this.diffs.get(id) ?? []);
      }
      if (method === "POST" && sub === "message") {
        this.bump("POST", "/session/:id/message");
        this.lastBodies.set("POST /session/:id/message", await this.body(req));
        return this.json(res, 200, { id: `msg_${++this.seq}`, role: "assistant" });
      }
      if (method === "POST" && sub === "prompt_async") {
        this.bump("POST", "/session/:id/prompt_async");
        await this.body(req);
        res.writeHead(204);
        return void res.end();
      }
      if (method === "POST" && sub === "command") {
        this.bump("POST", "/session/:id/command");
        await this.body(req);
        return this.json(res, 200, {});
      }
    }

    if (method === "GET" && path === "/permission/") {
      this.bump("GET", "/permission/");
      return this.json(res, 200, this.pendingPermissions.map((id) => ({ id })));
    }

    const replyMatch = /^\/permission\/([^/]+)\/reply$/.exec(path);
    if (method === "POST" && replyMatch) {
      this.bump("POST", "/permission/:id/reply");
      await this.body(req);
      // OpenCode returns 200 even for stale ids (issue #15386).
      return this.json(res, 200, {});
    }

    this.json(res, 404, { error: `no route for ${method} ${path}` });
  }
}
