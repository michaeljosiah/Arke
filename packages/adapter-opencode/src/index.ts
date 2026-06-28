import {
  type Capability,
  type CreateSessionInput,
  type DiffSummary,
  type DomainEvent,
  type HarnessAdapter,
  type ModelTier,
  type PermissionDecision,
  type SendMessageInput,
  type SessionRef,
  type TodoItem,
} from "@arke/contracts";
import { parseSse } from "./sse.js";

/**
 * OpenCode adapter (PRD §15; see docs/analysis/opencode-integration-guide.md).
 *
 * Maps Arke capabilities onto OpenCode's headless server (`opencode serve`) and
 * normalizes its SSE events into the canonical {@link DomainEvent} model. Uses the global
 * `fetch` (Node 20+) so it carries no extra dependency; swap to `@opencode-ai/sdk` later if
 * typed coverage is wanted.
 *
 * Trust boundary: credentials (the server password) live on the host, never in the browser
 * (NFR-1). The adapter runs inside the coordinator, on the host.
 */
export interface OpenCodeConfig {
  /** Base URL of the OpenCode server, e.g. http://127.0.0.1:4096 */
  baseUrl: string;
  /** Server password for HTTP Basic auth (env OPENCODE_SERVER_PASSWORD on the host). */
  password?: string;
  /** Basic-auth username; OpenCode defaults to "opencode". */
  username?: string;
  /** Working directory to scope requests to (passed as ?directory=). */
  directory?: string;
  /**
   * Resolves a Arke logical tier to an OpenCode `provider/model` id (FR-4, D10). Default
   * targets a `gateway` provider configured in opencode.json with capable-tier/mid-tier models.
   */
  resolveModel?: (tier: ModelTier) => { provider: string; name: string };
}

const DEFAULT_RESOLVE = (tier: ModelTier) => ({
  provider: "gateway",
  name: tier === "capable" ? "capable-tier" : "mid-tier",
});

export class OpenCodeAdapter implements HarnessAdapter {
  readonly id = "OpenCode";
  private readonly caps = new Set<Capability>([
    "events",
    "todos",
    "diff",
    "permissions",
    "commands",
  ]);
  /** session id → derived (specId, kind), so SSE events can be enriched to DomainEvent. */
  private readonly sessions = new Map<string, { specId: string; kind: "spec" | "task" }>();
  private readonly resolveModel: NonNullable<OpenCodeConfig["resolveModel"]>;
  private readonly config: OpenCodeConfig;

  constructor(config: OpenCodeConfig) {
    this.config = config;
    this.resolveModel = config.resolveModel ?? DEFAULT_RESOLVE;
  }

  capabilities(): ReadonlySet<Capability> {
    return this.caps;
  }

  // ---- HTTP helpers -------------------------------------------------------

  private url(path: string): string {
    const u = new URL(path, this.config.baseUrl);
    if (this.config.directory) u.searchParams.set("directory", this.config.directory);
    return u.toString();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.password) {
      const user = this.config.username ?? "opencode";
      h.Authorization = "Basic " + Buffer.from(`${user}:${this.config.password}`).toString("base64");
    }
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenCode ${method} ${path} → ${res.status} ${res.statusText}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ---- core ---------------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    const session = await this.req<{ id: string }>("POST", "/session", {
      parentID: input.parent,
      title: input.specId,
    });
    this.sessions.set(session.id, {
      specId: input.specId,
      kind: input.parent ? "task" : "spec",
    });
    return { sessionId: session.id };
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    await this.req("POST", `/session/${input.sessionId}/message`, this.messageBody(input));
  }

  async dispatchAsync(input: SendMessageInput): Promise<SessionRef> {
    // Non-blocking prompt: returns 204, work continues in the background (FR-8).
    await this.req("POST", `/session/${input.sessionId}/prompt_async`, this.messageBody(input));
    return { sessionId: input.sessionId };
  }

  private messageBody(input: SendMessageInput) {
    return {
      agent: input.agent,
      model: this.resolveModel(input.tier),
      parts: input.parts.map((p) => ({ type: "text", text: p.text })),
    };
  }

  // ---- events -------------------------------------------------------------

  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    const res = await fetch(this.url("/global/event"), {
      headers: { ...this.headers(), Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`OpenCode SSE /global/event → ${res.status} ${res.statusText}`);
    }
    for await (const raw of parseSse(res.body, signal)) {
      const event = this.normalize(raw);
      if (event) yield event;
    }
  }

  /**
   * Normalize one OpenCode event into a Arke {@link DomainEvent}, or null to drop it.
   * Event property names vary by version (dot vs underscore casing — guide §4); read both.
   * Only events that map onto the current DomainEvent union are emitted; message.* streaming
   * is a follow-up once message events are added to @arke/contracts.
   */
  private normalize(raw: unknown): DomainEvent | null {
    const e = raw as { type?: string; properties?: Record<string, unknown> };
    const p = e.properties ?? {};
    const sid = (p.session_id ?? p.sessionID ?? p.sessionId) as string | undefined;
    const stamp = { seq: 0, ts: Date.now(), harness: this.id } as const;
    const ctx = sid ? this.sessions.get(sid) : undefined;
    const specId = ctx?.specId ?? sid ?? "unknown";
    const kind = ctx?.kind ?? "spec";

    switch (e.type) {
      case "session.created": {
        const s = p.session as { id?: string; parentID?: string; title?: string } | undefined;
        if (s?.id) {
          this.sessions.set(s.id, {
            specId: this.sessions.get(s.id)?.specId ?? s.title ?? s.id,
            kind: s.parentID ? "task" : "spec",
          });
        }
        return null;
      }
      case "session.idle":
        return sid ? { ...stamp, type: "session.status", sessionId: sid, specId, kind, status: "idle" } : null;
      case "session.error":
        return sid ? { ...stamp, type: "session.status", sessionId: sid, specId, kind, status: "error" } : null;
      case "session.status": {
        if (!sid) return null;
        const s = String(p.status ?? "");
        const status = s === "idle" ? "idle" : s === "error" ? "error" : "running";
        return { ...stamp, type: "session.status", sessionId: sid, specId, kind, status };
      }
      case "todo.updated": {
        if (!sid) return null;
        const list = (p.todos ?? (p.todo ? [p.todo] : [])) as Array<{ id?: string; text?: string; completed?: boolean; done?: boolean }>;
        return {
          ...stamp,
          type: "todo.updated",
          sessionId: sid,
          todos: list.map((t, i) => ({ id: t.id ?? String(i), text: t.text ?? "", done: Boolean(t.completed ?? t.done) })),
        };
      }
      case "permission.asked": {
        const reqId = (p.request_id ?? p.requestID ?? p.permissionID) as string | undefined;
        if (!sid || !reqId) return null;
        return { ...stamp, type: "permission.asked", sessionId: sid, permissionId: reqId, title: String(p.title ?? "Permission requested") };
      }
      case "permission.replied": {
        const permId = (p.permission_id ?? p.permissionID ?? p.request_id) as string | undefined;
        if (!sid || !permId) return null;
        const granted = String(p.response ?? "") === "approve";
        return { ...stamp, type: "permission.replied", sessionId: sid, permissionId: permId, granted };
      }
      // session.diff carries no counts; pair with GET /session/:id/diff in the coordinator
      // to emit diff.finalized. message.* / question.* are follow-ups.
      default:
        return null;
    }
  }

  // ---- todos / diff / permissions / commands ------------------------------

  async getTodos(ref: SessionRef): Promise<TodoItem[]> {
    const todos = await this.req<Array<{ id: string; text: string; completed: boolean }>>(
      "GET",
      `/session/${ref.sessionId}/todo`,
    );
    return (todos ?? []).map((t) => ({ id: t.id, text: t.text, done: t.completed }));
  }

  async getDiff(ref: SessionRef): Promise<DiffSummary> {
    const files = await this.req<Array<{ additions?: number; deletions?: number; patch?: string }>>(
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

  async respondToPermission(decision: PermissionDecision): Promise<void> {
    // NB: OpenCode returns 200 even for stale IDs (guide §9, issue #15386) — don't treat as proof.
    await this.req("POST", `/permission/${decision.permissionId}/reply`, {
      response: decision.granted ? "approve" : "deny",
    });
  }

  async runCommand(ref: SessionRef, command: string, args?: string[]): Promise<void> {
    await this.req("POST", `/session/${ref.sessionId}/command`, { command, arguments: args ?? [] });
  }
}
