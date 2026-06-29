import type { DomainEvent, SessionKind, SessionStatus } from "@arke/contracts";
import type { SessionRecord } from "./session-graph.js";

/**
 * Pure translation of one OpenCode event into the canonical {@link DomainEvent} model
 * (SPEC-002). Kept side-effect-free and synchronous so it is exhaustively table-testable;
 * the adapter handles the I/O around it (REST resolves, dead-letter writes, envelope stamps).
 *
 * Outcomes:
 * - `event`           — a mapped, identity-attached domain event (envelope re-stamped upstream).
 * - `graph`           — a session lifecycle frame that updates the ownership graph, not emitted.
 * - `ignore`          — a known event the adapter deliberately does not map yet.
 * - `unknown-session` — a mappable event whose session is absent from the graph; resolve then retry.
 * - `dead-letter`     — a malformed or unrecognised event; contained, never silently dropped.
 */

export interface EventIdentity {
  specId: string;
  kind: SessionKind;
}

export type NormalizeOutcome =
  | { kind: "event"; event: DomainEvent }
  | { kind: "events"; events: DomainEvent[] } // one frame fanning to several (e.g. idle → finalize + quiescent)
  | { kind: "graph"; record: SessionRecord }
  | { kind: "ignore" }
  | { kind: "unknown-session"; sessionId: string }
  | { kind: "dead-letter"; reason: string };

/** Synchronous lookup of a session's canonical identity from the graph cache. */
export type IdentityLookup = (sessionId: string) => EventIdentity | undefined;

/**
 * Mutable correlation state the (otherwise pure) normaliser needs for OpenCode's split transcript
 * model: a message's role arrives on `message.updated` (`properties.info.role`) while its text
 * arrives on the `message.part.updated` frames — so we remember role per messageID, and the
 * last message per session so `session.idle` can finalise it (close streaming) and emit a
 * `turn.quiescent` receipt. Held by the adapter; tests pass a fresh one.
 */
export interface NormalizeState {
  roleByMessage: Map<string, "user" | "assistant" | "tool">;
  lastBySession: Map<string, { messageId: string; text: string; role: "user" | "assistant" | "tool" }>;
}

export function createNormalizeState(): NormalizeState {
  return { roleByMessage: new Map(), lastBySession: new Map() };
}

/** Known event types the adapter recognises but deliberately does not map (yet). */
const IGNORED_TYPES = new Set([
  "server.connected",
  "session.deleted",
  "session.compacted",
  "session.diff", // carries no counts; coordinator pairs with GET /diff → diff.finalized
  "message.part.delta", // incremental text; the message.part.updated snapshot carries the full text
  "message.removed",
  "question.asked",
  "question.replied",
  "question.rejected",
  "file.edited",
  "file.watcher.updated",
  "lsp.client.diagnostics",
  "lsp.updated",
]);

interface RawEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

function sessionIdOf(p: Record<string, unknown>): string | undefined {
  const v = p.session_id ?? p.sessionID ?? p.sessionId;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function blankEnvelope(harness: string) {
  // seq/ts are re-stamped by the coordinator; harness names the source.
  return { seq: 0, ts: 0, harness } as const;
}

export function normalize(
  raw: unknown,
  lookup: IdentityLookup,
  harness: string,
  state: NormalizeState = createNormalizeState(),
): NormalizeOutcome {
  if (typeof raw !== "object" || raw === null) {
    return { kind: "dead-letter", reason: "frame is not an object" };
  }
  const e = raw as RawEvent;
  if (typeof e.type !== "string") {
    return { kind: "dead-letter", reason: "missing event type" };
  }
  const p = e.properties ?? {};
  const env = blankEnvelope(harness);

  switch (e.type) {
    // ---- session lifecycle → graph maintenance ----
    case "session.created":
    case "session.updated": {
      const s = p.session as
        | { id?: string; parentID?: string; title?: string }
        | undefined;
      if (!s?.id) return { kind: "dead-letter", reason: `${e.type} without session.id` };
      const kind: SessionKind = s.parentID ? "task" : "spec";
      return {
        kind: "graph",
        record: {
          sessionId: s.id,
          kind,
          specId: s.title ?? s.id, // title encodes the spec_id at creation
          parentSessionId: s.parentID,
        },
      };
    }

    // ---- session status (requires identity) ----
    case "session.idle":
    case "session.error":
    case "session.status": {
      const sid = sessionIdOf(p);
      if (!sid) return { kind: "dead-letter", reason: `${e.type} without session id` };
      const identity = lookup(sid);
      if (!identity) return { kind: "unknown-session", sessionId: sid };

      let status: SessionStatus;
      if (e.type === "session.idle") status = "idle";
      else if (e.type === "session.error") status = "error";
      else {
        const raw = p.status;
        if (typeof raw !== "string") {
          return { kind: "dead-letter", reason: "session.status without status" };
        }
        status = raw === "idle" ? "idle" : raw === "error" ? "error" : "running";
      }

      const statusEvent: DomainEvent = {
        ...env,
        type: "session.status",
        sessionId: sid,
        specId: identity.specId,
        kind: identity.kind,
        status,
      };
      // session.idle is the turn-completion signal in OpenCode (no message.updated isStreaming:false
      // arrives): finalise the last message (close streaming) and emit the turn.quiescent receipt.
      if (e.type === "session.idle") {
        const events: DomainEvent[] = [statusEvent];
        const last = state.lastBySession.get(sid);
        if (last) {
          events.push({
            ...env,
            correlationId: last.messageId,
            type: "message.updated",
            sessionId: sid,
            messageId: last.messageId,
            role: last.role,
            text: last.text,
            toolCalls: [],
            isStreaming: false,
          });
        }
        events.push({
          ...env,
          ...(last ? { correlationId: last.messageId } : {}),
          type: "turn.quiescent",
          sessionId: sid,
          turnId: last?.messageId ?? sid,
        });
        state.lastBySession.delete(sid);
        return { kind: "events", events };
      }
      return { kind: "event", event: statusEvent };
    }

    // ---- todos (session id only) ----
    case "todo.updated": {
      const sid = sessionIdOf(p);
      if (!sid) return { kind: "dead-letter", reason: "todo.updated without session id" };
      const list = (p.todos ?? (p.todo ? [p.todo] : [])) as Array<{
        id?: string;
        text?: string;
        completed?: boolean;
        done?: boolean;
      }>;
      return {
        kind: "event",
        event: {
          ...env,
          type: "todo.updated",
          sessionId: sid,
          todos: list.map((t, i) => ({
            id: t.id ?? String(i),
            text: t.text ?? "",
            done: Boolean(t.completed ?? t.done),
          })),
        },
      };
    }

    // ---- permissions ----
    case "permission.asked": {
      const sid = sessionIdOf(p);
      const reqId = (p.request_id ?? p.requestID ?? p.permissionID) as string | undefined;
      if (!sid || !reqId) {
        return { kind: "dead-letter", reason: "permission.asked without session/request id" };
      }
      const detail = typeof p.detail === "string" ? p.detail : undefined;
      return {
        kind: "event",
        event: {
          ...env,
          type: "permission.asked",
          sessionId: sid,
          permissionId: reqId,
          title: typeof p.title === "string" ? p.title : "Permission requested",
          ...(detail ? { detail } : {}),
        },
      };
    }
    case "permission.replied": {
      const sid = sessionIdOf(p);
      const permId = (p.permission_id ?? p.permissionID ?? p.request_id) as string | undefined;
      if (!sid || !permId) {
        return { kind: "dead-letter", reason: "permission.replied without session/permission id" };
      }
      const granted = String(p.response ?? "") === "approve";
      return {
        kind: "event",
        event: {
          ...env,
          type: "permission.replied",
          sessionId: sid,
          permissionId: permId,
          granted,
        },
      };
    }

    // ---- streaming transcript (SPEC-003) ----
    case "message.part.updated": {
      // OpenCode 1.17.11: properties = { sessionID, part: { type, text, messageID, id } }. The part
      // carries the message's full current text (a snapshot, not a delta), so we map it to a
      // message.updated (replace) — the read model re-converges on the latest text. The role lives
      // on message.updated.info, remembered in state; absent that we assume assistant.
      const sid = sessionIdOf(p);
      const part = (p.part ?? {}) as { text?: string; type?: string; messageID?: string };
      const messageId = (part.messageID ?? p.message_id ?? p.messageID) as string | undefined;
      if (!sid || !messageId) {
        return { kind: "dead-letter", reason: "message.part.updated without session/message id" };
      }
      if (part.type !== "text") return { kind: "ignore" }; // tool / reasoning parts not mapped yet
      const role = state.roleByMessage.get(messageId) ?? "assistant";
      const text = String(part.text ?? "");
      state.lastBySession.set(sid, { messageId, text, role });
      return {
        kind: "event",
        event: {
          ...env,
          correlationId: messageId,
          type: "message.updated",
          sessionId: sid,
          messageId,
          role,
          text,
          toolCalls: [],
          isStreaming: role === "assistant", // closed by session.idle's finalising frame
        },
      };
    }
    case "message.updated": {
      // OpenCode 1.17.11: properties = { sessionID, info: { id, role, … } }. This frame carries the
      // message's identity/role but NOT its text (text streams via the parts). Record the role so
      // the part frames can attribute it correctly; emit nothing on its own.
      const sid = sessionIdOf(p);
      const info = (p.info ?? p.message ?? {}) as { id?: string; role?: string };
      const messageId = (info.id ?? p.message_id ?? p.messageID) as string | undefined;
      if (!sid || !messageId) {
        return { kind: "dead-letter", reason: "message.updated without session/message id" };
      }
      const role = info.role === "user" || info.role === "tool" ? info.role : "assistant";
      state.roleByMessage.set(messageId, role);
      return { kind: "ignore" };
    }

    default:
      if (IGNORED_TYPES.has(e.type)) return { kind: "ignore" };
      return { kind: "dead-letter", reason: `unrecognised event type: ${e.type}` };
  }
}
