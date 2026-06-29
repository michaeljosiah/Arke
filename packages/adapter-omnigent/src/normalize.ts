import type { DomainEvent } from "@arke/contracts";
import type { SessionIdentity } from "./session-graph.js";

/**
 * Pure translation of one Omnigent SSE frame into canonical {@link DomainEvent}s (ADR-0002 spike).
 *
 * Omnigent's stream is OpenAI-Responses-shaped: `response.created`, `response.output_text.delta`,
 * `response.completed`, plus an `response.elicitation_request` for human approvals. Unlike OpenCode,
 * the session id is NOT in the frame (the stream is already per-session), so the adapter passes it in
 * alongside the resolved {@link SessionIdentity}. One frame can fan out to several events (completion
 * → status idle + turn.quiescent), so this always returns an array (possibly empty for ignored frames).
 *
 * Kept side-effect-free and table-testable; the adapter restamps seq/ts and validates at the boundary.
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
  // Omnigent nests payload under `data`, but the discriminator `type` sits on the outer frame; some
  // fields may also appear flattened, so read from both.
  const d = (f.data ?? {}) as Record<string, unknown>;
  const type = f.type ?? (typeof d.type === "string" ? d.type : undefined);
  if (!type) return [];
  const e = env(harness);
  const base = { ...e, sessionId, specId: identity.specId, kind: identity.kind } as const;

  switch (type) {
    case "response.created":
    case "response.in_progress": {
      const model = str(d.model) ?? str((d.response as { model?: string } | undefined)?.model);
      return [{ ...base, type: "session.status", status: "running", ...(model ? { model } : {}) }];
    }

    case "response.output_text.delta": {
      const messageId = str(d.item_id) ?? str(d.message_id) ?? str(d.response_id) ?? sessionId;
      const delta = typeof d.delta === "string" ? d.delta : "";
      if (!delta) return [];
      const next = (state.partByMessage.get(messageId) ?? 0);
      state.partByMessage.set(messageId, next + 1);
      return [
        {
          ...e,
          correlationId: messageId,
          type: "message.part",
          sessionId,
          messageId,
          partIndex: next,
          delta,
          role: "assistant",
          done: false,
        },
      ];
    }

    case "response.output_text.done":
    case "response.output_item.done": {
      // A completed content item carries the full text — emit a non-streaming snapshot so the read
      // model converges even if some deltas were missed (live-tail has no replay). Live-verified
      // shape (OpenCode turn): `item: { id, role, content: [{ type:"output_text", text }] }` — the
      // text is nested in item.content[], NOT item.text; `output_text.done` carries top-level text.
      const item = (d.item ?? {}) as {
        id?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      };
      const messageId =
        str(item.id) ?? str(d.item_id) ?? str(d.message_id) ?? str(d.response_id) ?? sessionId;
      const fromContent = Array.isArray(item.content)
        ? item.content
            .filter((c) => c?.type === "output_text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("")
        : "";
      const text = str(d.text) ?? (fromContent || "");
      const role = item.role === "user" || item.role === "tool" ? item.role : "assistant";
      return [
        {
          ...e,
          correlationId: messageId,
          type: "message.updated",
          sessionId,
          messageId,
          role,
          text,
          toolCalls: [],
          isStreaming: false,
        },
      ];
    }

    case "response.completed": {
      // Turn done: go idle and emit the quiescence receipt (consumers detect completion from this).
      const turnId = str(d.response_id) ?? str((d.response as { id?: string } | undefined)?.id) ?? sessionId;
      return [
        { ...base, type: "session.status", status: "idle" },
        { ...e, correlationId: turnId, type: "turn.quiescent", sessionId, turnId },
      ];
    }

    case "response.failed":
    case "response.errored":
    case "error": {
      return [{ ...base, type: "session.status", status: "error" }];
    }

    case "response.elicitation_request":
    case "elicitation.requested": {
      const permissionId = str(d.elicitation_id) ?? str(d.id);
      if (!permissionId) return [];
      const title = str(d.title) ?? str(d.message) ?? str(d.prompt) ?? "Approval requested";
      const detail = str(d.detail) ?? str(d.description);
      return [
        {
          ...e,
          type: "permission.asked",
          sessionId,
          permissionId,
          title,
          ...(detail ? { detail } : {}),
        },
      ];
    }

    default:
      return []; // structural / unmapped frames are ignored, not errored
  }
}
