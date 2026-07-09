import type { DomainEvent } from "@arke/contracts";
import type { SessionIdentity } from "./session-map.js";

/**
 * Pure translation of one Codex app-server notification into canonical {@link DomainEvent}s (SPEC-034),
 * mirroring `adapter-opencode/normalize.ts`. Codex's app-server streams `turn/*` lifecycle notifications
 * and `item/*` items (agent_message, plan_update, command_execution, file_change, …); the thread the
 * notification belongs to is resolved to an Arke `sessionId` by the adapter (which holds the thread map),
 * so this stays a pure function of `(method, params, sessionId, identity)`. One notification can fan out
 * to several events (turn completion → idle + quiescence). Restamps seq/ts to 0 (the coordinator restamps)
 * and returns an array (empty for structural/unmapped frames). The adapter validates at the boundary.
 *
 * Method names are canonicalised `slash → dot` so the app-server's `item/agentMessage/delta` and the
 * exec-mode `item.completed` forms both resolve — the two Codex surfaces differ only in that separator.
 */

export interface NormalizeState {
  /** Monotonic part counter per message id, so partIndex is stable regardless of provider fields. */
  partByMessage: Map<string, number>;
}

export function createNormalizeState(): NormalizeState {
  return { partByMessage: new Map() };
}

function env(harness: string) {
  return { seq: 0, ts: 0, harness } as const;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Extract the delta text from an `item/agentMessage/delta` params in any of its documented shapes. */
function deltaText(params: Record<string, unknown>): string {
  const d = params.delta;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && typeof (d as { text?: unknown }).text === "string") return (d as { text: string }).text;
  return typeof params.text === "string" ? params.text : "";
}

/** Map a Codex `plan_update`/`todo_list` item's steps into Arke {@link DomainEvent} todo items. */
function planTodos(item: Record<string, unknown>): { id: string; text: string; done: boolean }[] {
  const steps =
    (Array.isArray(item.plan) && item.plan) ||
    (Array.isArray(item.steps) && item.steps) ||
    (Array.isArray(item.items) && item.items) ||
    [];
  return (steps as unknown[]).map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const text = str(o.step) ?? str(o.text) ?? str(o.title) ?? String(s ?? "");
    const status = str(o.status);
    return { id: str(o.id) ?? `plan-${i}`, text, done: status === "completed" || o.done === true };
  });
}

export function normalize(
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
  identity: SessionIdentity,
  harness: string,
  state: NormalizeState,
): DomainEvent[] {
  const m = method.replace(/\//g, ".");
  const e = env(harness);
  const base = { ...e, sessionId, specId: identity.specId, kind: identity.kind } as const;
  const item = (params.item ?? {}) as Record<string, unknown>;
  const itemType = str(item.type);

  switch (m) {
    case "turn.started": {
      const model = str(params.model) ?? str((params.turn as { model?: string } | undefined)?.model);
      return [{ ...base, type: "session.status", status: "running", ...(model ? { model } : {}) }];
    }

    case "item.agentMessage.delta":
    case "item.agent_message.delta": {
      const messageId = str(params.itemId) ?? str(params.item_id) ?? str(item.id) ?? sessionId;
      const delta = deltaText(params);
      if (!delta) return [];
      const next = state.partByMessage.get(messageId) ?? 0;
      state.partByMessage.set(messageId, next + 1);
      return [{ ...e, correlationId: messageId, type: "message.part", sessionId, messageId, partIndex: next, delta, role: "assistant", done: false }];
    }

    case "item.started":
    case "item.updated":
    case "item.completed": {
      if (itemType === "agent_message") {
        // Only a COMPLETED agent message carries the full text — emit a non-streaming snapshot so the
        // read model converges even if deltas were missed (live-tail has no replay).
        if (m !== "item.completed") return [];
        const messageId = str(item.id) ?? sessionId;
        const text = str(item.text) ?? "";
        return [{ ...e, correlationId: messageId, type: "message.updated", sessionId, messageId, role: "assistant", text, toolCalls: [], isStreaming: false }];
      }
      if (itemType === "plan_update" || itemType === "todo_list") {
        return [{ ...e, type: "todo.updated", sessionId, todos: planTodos(item) }];
      }
      // command_execution / file_change / reasoning / mcp_tool_call / web_search — internal to Codex;
      // file changes surface through git-derived getDiff, not an event (Decision #4).
      return [];
    }

    case "turn.completed": {
      const turnId = str(params.turnId) ?? str(params.turn_id) ?? str(params.threadId) ?? sessionId;
      return [
        { ...base, type: "session.status", status: "idle" },
        { ...e, correlationId: turnId, type: "turn.quiescent", sessionId, turnId },
      ];
    }

    case "turn.failed":
    case "error": {
      return [{ ...base, type: "session.status", status: "error" }];
    }

    default:
      return []; // structural / unmapped notifications are ignored, not errored
  }
}
