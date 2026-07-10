import type { DomainEvent } from "@arke/contracts";
import type { SessionIdentity } from "./session-graph.js";

/**
 * Pure translation of one Omnigent SSE frame into canonical {@link DomainEvent}s (SPEC-037).
 *
 * Re-grounded on the REAL Omnigent 0.3.0 stream envelope — a flat frame `{ sequence_number, type, … }`
 * with a `session.*` / `response.*` vocabulary — captured live (see
 * `test/fixtures/omnigent-0.3.0-control-plane.jsonl`). The spike's OpenAI-Responses mapping matched shapes
 * the server does not emit for the control plane; this rewrites the control-plane path against reality.
 *
 * Grounding boundary (SPEC-037 Requirement 2): the **control-plane** frames below (`session.status`,
 * `response.error`, the elicitation request, and the known-ignored control frames) are LIVE-CONFIRMED. The
 * **assistant-content** frames (`response.output_text.delta` → `message.part`, `…output_item.done` →
 * `message.updated`) are **PROVISIONAL** — the live probe never captured a successful turn (the runner failed
 * on an expired credential), so their shape is carried over from the 2026-06-29 spike capture and is only
 * *confirmed* by the live-acceptance turn. They are kept, clearly marked, so a real turn renders while the
 * confirmed shape is pending.
 *
 * The session id is NOT in the frame (the stream is already per-session), so the adapter passes it in with
 * the resolved {@link SessionIdentity}. One frame can fan out to several events, so this always returns an
 * array (empty for ignored/unmapped frames — the pump decides dead-letter via {@link isRecognizedFrameType}).
 * Side-effect-free and table-testable; the adapter restamps seq/ts and validates at the boundary.
 */

export interface NormalizeState {
  /** Monotonic part counter per message id, so partIndex is stable regardless of provider fields. */
  partByMessage: Map<string, number>;
}

export function createNormalizeState(): NormalizeState {
  return { partByMessage: new Map() };
}

interface Frame {
  type?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Control-plane frames the normalizer knowingly ignores (no domain meaning). NOT dead-lettered. */
export const IGNORED_FRAME_TYPES: ReadonlySet<string> = new Set([
  "session.heartbeat",
  "session.presence",
  "session.changed_files.invalidated",
  "session.terminal_pending",
  "session.input.consumed", // correlation is bound by the pump from this frame's data.item_id, not here
]);

/** Frame types the normalizer maps to domain events (control-plane confirmed + provisional assistant). */
export const MAPPED_FRAME_TYPES: ReadonlySet<string> = new Set([
  "session.status",
  "response.error",
  "response.elicitation_request",
  "elicitation.requested",
  // PROVISIONAL assistant-content (SPEC-037 Requirement 2) — pending the live-acceptance capture:
  "response.output_text.delta",
  "response.output_text.done",
  "response.output_item.done",
]);

/** True when the pump should NOT dead-letter a frame that produced no events (it is a known control frame). */
export function isRecognizedFrameType(type: string | undefined): boolean {
  return typeof type === "string" && (IGNORED_FRAME_TYPES.has(type) || MAPPED_FRAME_TYPES.has(type));
}

function env(harness: string) {
  return { seq: 0, ts: 0, harness } as const; // seq/ts restamped by the coordinator
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function normalize(
  raw: unknown,
  sessionId: string,
  identity: SessionIdentity,
  harness: string,
  state: NormalizeState,
): DomainEvent[] {
  if (typeof raw !== "object" || raw === null) return [];
  const f = raw as Frame;
  const d = (f.data ?? {}) as Record<string, unknown>;
  const type = f.type ?? (typeof d.type === "string" ? d.type : undefined);
  if (!type) return [];
  if (IGNORED_FRAME_TYPES.has(type)) return []; // known control frame — ignored, not dead-lettered
  const e = env(harness);
  const base = { ...e, sessionId, specId: identity.specId, kind: identity.kind } as const;

  switch (type) {
    // ---- control plane (LIVE-CONFIRMED against Omnigent 0.3.0) ----
    case "session.status": {
      // `{ type:"session.status", conversation_id, status: "running"|"idle"|"failed"|…, response_id, error }`.
      // Map ONLY known status values; an UNKNOWN value returns [] (it must NOT be asserted as `running` —
      // a stopped/`cancelled` session would then show as live work; SPEC-037 review P3).
      const status = (str(f.status) ?? str(d.status) ?? "").toLowerCase();
      const model = str(f.model) ?? str(d.model);
      if (status === "running" || status === "in_progress") {
        return [{ ...base, type: "session.status", status: "running", ...(model ? { model } : {}) }];
      }
      if (status === "waiting" || status === "pending" || status === "blocked") {
        return [{ ...base, type: "session.status", status: "waiting" }];
      }
      if (status === "failed" || status === "errored" || status === "error") {
        return [{ ...base, type: "session.status", status: "error" }];
      }
      if (status === "cancelled" || status === "canceled" || status === "aborted" || status === "interrupted" || status === "stopped" || status === "terminated") {
        return [{ ...base, type: "session.status", status: "interrupted" }]; // terminal, but NOT an error
      }
      if (status === "idle" || status === "completed" || status === "done" || status === "complete") {
        // Turn quiescence: consumers (and the completion-aware send) detect a finished turn here.
        const turnId = str(f.response_id) ?? str(d.response_id) ?? sessionId;
        return [
          { ...base, type: "session.status", status: "idle" },
          { ...e, correlationId: turnId, type: "turn.quiescent", sessionId, turnId },
        ];
      }
      return []; // unknown status value — do not fabricate a state (the pump dead-letters it, below)
    }

    case "response.error": {
      // `{ type:"response.error", source, tool_name, error:{ code, message, detail } }`. SessionStatusEvent
      // carries no error field, so the code/message is routed to the trace/dead-letter by the PUMP; here we
      // emit only the status transition (SPEC-037 Requirement 1 / Decision #8).
      return [{ ...base, type: "session.status", status: "error" }];
    }

    case "response.elicitation_request":
    case "elicitation.requested": {
      const permissionId = str(f.elicitation_id) ?? str(d.elicitation_id) ?? str(f.id) ?? str(d.id);
      if (!permissionId) return [];
      const title = str(d.title) ?? str(d.message) ?? str(d.prompt) ?? str(f.title) ?? "Approval requested";
      const detail = str(d.detail) ?? str(d.description);
      return [
        { ...e, type: "permission.asked", sessionId, permissionId, title, ...(detail ? { detail } : {}) },
      ];
    }

    // ---- assistant content (PROVISIONAL — SPEC-037 Requirement 2; confirmed at the live-acceptance run) ----
    case "response.output_text.delta": {
      const messageId = str(d.item_id) ?? str(d.message_id) ?? str(d.response_id) ?? sessionId;
      const delta = typeof d.delta === "string" ? d.delta : typeof f.delta === "string" ? f.delta : "";
      if (!delta) return [];
      const next = state.partByMessage.get(messageId) ?? 0;
      state.partByMessage.set(messageId, next + 1);
      return [
        { ...e, correlationId: messageId, type: "message.part", sessionId, messageId, partIndex: next, delta, role: "assistant", done: false },
      ];
    }

    case "response.output_text.done":
    case "response.output_item.done": {
      // The prior spike capture nested assistant text in `item.content[].text` (`output_text` parts).
      const item = (d.item ?? {}) as { id?: string; role?: string; content?: Array<{ type?: string; text?: string }> };
      const messageId = str(item.id) ?? str(d.item_id) ?? str(d.message_id) ?? str(d.response_id) ?? sessionId;
      const fromContent = Array.isArray(item.content)
        ? item.content.filter((c) => c?.type === "output_text" && typeof c.text === "string").map((c) => c.text as string).join("")
        : "";
      const text = str(d.text) ?? (fromContent || "");
      const role = item.role === "user" || item.role === "tool" ? item.role : "assistant";
      return [
        { ...e, correlationId: messageId, type: "message.updated", sessionId, messageId, role, text, toolCalls: [], isStreaming: false },
      ];
    }

    default:
      return []; // unmapped → the pump dead-letters (isRecognizedFrameType(type) === false)
  }
}
