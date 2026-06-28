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

/** Discriminated union of every normalized domain event. */
export const DomainEvent = z.discriminatedUnion("type", [
  SpecStatusEvent,
  SessionStatusEvent,
  TodoUpdatedEvent,
  DiffFinalizedEvent,
  PermissionAskedEvent,
  PermissionRepliedEvent,
  ProjectionWriteEvent,
]);
export type DomainEvent = z.infer<typeof DomainEvent>;

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
