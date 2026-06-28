import { z } from "zod";
import { SpecStatus } from "./spec.js";

/**
 * The canonical, normalized domain-event model (PRD §8.5, §21.1).
 *
 * Provider-native events from each harness are normalized by the coordinator into
 * exactly these shapes, persisted, and pushed to the client ordered, monotonically
 * sequenced per connection, and schema-validated at the boundary (NFR-8). The board
 * reads from this model, never from raw provider output — which is what lets harness
 * capability differences be absorbed cleanly.
 */

/** A session is the unit of execution: parent = a spec, child = a task (FR-8). */
export const SessionKind = z.enum(["spec", "task"]);
export type SessionKind = z.infer<typeof SessionKind>;

export const SessionStatus = z.enum([
  "idle",
  "running",
  "waiting", // blocked on a human (permission/elicitation)
  "error",
  "done",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Envelope wrapping every pushed event: ordered + sequenced per connection (NFR-8). */
export const EventEnvelope = z.object({
  seq: z.number().int().nonnegative(), // monotonic per connection
  ts: z.number().int(), // epoch ms, stamped at the coordinator
  harness: z.string(), // e.g. "OpenCode", "Claude Code"
  // Correlation id (the harness messageID) attributing an event to the request that
  // produced it (SPEC-002). Optional on the envelope; the full domain-model treatment
  // — message/part events that always carry it — is SPEC-003. Landed early here so the
  // OpenCode adapter can attribute turn output to its originating send.
  correlationId: z.string().optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

const base = EventEnvelope;

export const SpecStatusEvent = base.extend({
  type: z.literal("spec.status"),
  specId: z.string(),
  status: SpecStatus,
});

export const SessionStatusEvent = base.extend({
  type: z.literal("session.status"),
  sessionId: z.string(),
  specId: z.string(),
  kind: SessionKind,
  status: SessionStatus,
  model: z.string().optional(),
});

export const TodoUpdatedEvent = base.extend({
  type: z.literal("todo.updated"),
  sessionId: z.string(),
  todos: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      done: z.boolean(),
    }),
  ),
});

export const DiffFinalizedEvent = base.extend({
  type: z.literal("diff.finalized"),
  sessionId: z.string(),
  added: z.number().int(),
  removed: z.number().int(),
  files: z.number().int(),
});

export const PermissionAskedEvent = base.extend({
  type: z.literal("permission.asked"),
  sessionId: z.string(),
  permissionId: z.string(),
  title: z.string(),
  detail: z.string().optional(),
});

export const PermissionRepliedEvent = base.extend({
  type: z.literal("permission.replied"),
  sessionId: z.string(),
  permissionId: z.string(),
  granted: z.boolean(),
});

/** A governed projection write to a system of record (FR-7, NFR-2): always logged. */
export const ProjectionWriteEvent = base.extend({
  type: z.literal("projection.write"),
  target: z.enum(["jira", "azure-devops", "github", "docs", "tests"]),
  specId: z.string(),
  trigger: z.string(), // the spec/status change that caused the write
  ok: z.boolean(),
});

/**
 * A streaming delta from an in-progress assistant turn (SPEC-003). Parts are folded into
 * per-session transcript state in `partIndex` order, not arrival order; `done: true` marks
 * the final part of a message.
 */
export const MessagePartEvent = base.extend({
  type: z.literal("message.part"),
  sessionId: z.string(),
  messageId: z.string(),
  partIndex: z.number().int().nonnegative(),
  delta: z.string(),
  role: z.enum(["assistant", "tool"]),
  done: z.boolean(),
});

/** A full turn-state snapshot once a message is complete (SPEC-003). */
export const MessageUpdatedEvent = base.extend({
  type: z.literal("message.updated"),
  sessionId: z.string(),
  messageId: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), result: z.string().optional() }))
    .default([]),
  isStreaming: z.boolean(),
});

/**
 * A typed runtime-signal receipt the coordinator emits when a session goes idle after a turn
 * (SPEC-003, D2). Consumers detect turn completion from this — never by polling or timeout.
 */
export const TurnQuiescentEvent = base.extend({
  type: z.literal("turn.quiescent"),
  sessionId: z.string(),
  turnId: z.string(),
});

/** Discriminated union of every normalized domain event. */
export const DomainEvent = z.discriminatedUnion("type", [
  SpecStatusEvent,
  SessionStatusEvent,
  TodoUpdatedEvent,
  DiffFinalizedEvent,
  PermissionAskedEvent,
  PermissionRepliedEvent,
  ProjectionWriteEvent,
  MessagePartEvent,
  MessageUpdatedEvent,
  TurnQuiescentEvent,
]);
export type DomainEvent = z.infer<typeof DomainEvent>;

/** One message in a session's transcript, accumulated from message.part/updated events. */
export interface TranscriptEntry {
  messageId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls: { id: string; name: string; result?: string }[];
  isStreaming: boolean;
}

/**
 * Board columns are computed from real signals (FR-9, Figure 4) — never hand-set.
 * A card moves because the work moved.
 */
export const BoardColumn = z.enum([
  "authoring",
  "review",
  "approved",
  "implementing",
  "needs-human",
  "diff",
  "merged",
]);
export type BoardColumn = z.infer<typeof BoardColumn>;
