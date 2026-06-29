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
  | { kind: "graph"; record: SessionRecord }
  | { kind: "ignore" }
  | { kind: "unknown-session"; sessionId: string }
  | { kind: "dead-letter"; reason: string };

/** Synchronous lookup of a session's canonical identity from the graph cache. */
export type IdentityLookup = (sessionId: string) => EventIdentity | undefined;

/** Known event types the adapter recognises but deliberately does not map (yet). */
const IGNORED_TYPES = new Set([
  "server.connected",
  "session.deleted",
  "session.compacted",
  "session.diff", // carries no counts; coordinator pairs with GET /diff → diff.finalized
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

export function normalize(raw: unknown, lookup: IdentityLookup, harness: string): NormalizeOutcome {
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

      return {
        kind: "event",
        event: {
          ...env,
          type: "session.status",
          sessionId: sid,
          specId: identity.specId,
          kind: identity.kind,
          status,
        },
      };
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
      const sid = sessionIdOf(p);
      const messageId = (p.message_id ?? p.messageID ?? p.messageId) as string | undefined;
      if (!sid || !messageId) {
        return { kind: "dead-letter", reason: "message.part.updated without session/message id" };
      }
      const part = (p.part ?? {}) as { delta?: string; text?: string; type?: string; done?: boolean };
      const delta = String(p.delta ?? part.delta ?? part.text ?? "");
      const partIndex = Number(p.part_index ?? p.partIndex ?? 0);
      const role = part.type === "tool" ? "tool" : "assistant";
      return {
        kind: "event",
        event: {
          ...env,
          correlationId: messageId, // correlation = the OpenCode messageID
          type: "message.part",
          sessionId: sid,
          messageId,
          partIndex: Number.isFinite(partIndex) ? partIndex : 0,
          delta,
          role,
          done: Boolean(p.done ?? part.done ?? false),
        },
      };
    }
    case "message.updated": {
      const sid = sessionIdOf(p);
      const message = (p.message ?? {}) as {
        id?: string;
        role?: string;
        text?: string;
        isStreaming?: boolean;
      };
      const messageId = (p.message_id ?? p.messageID ?? message.id) as string | undefined;
      if (!sid || !messageId) {
        return { kind: "dead-letter", reason: "message.updated without session/message id" };
      }
      const role =
        message.role === "user" || message.role === "tool" ? message.role : "assistant";
      return {
        kind: "event",
        event: {
          ...env,
          correlationId: messageId,
          type: "message.updated",
          sessionId: sid,
          messageId,
          role,
          text: String(message.text ?? p.text ?? ""),
          toolCalls: [],
          isStreaming: Boolean(message.isStreaming ?? false),
        },
      };
    }

    default:
      if (IGNORED_TYPES.has(e.type)) return { kind: "ignore" };
      return { kind: "dead-letter", reason: `unrecognised event type: ${e.type}` };
  }
}
