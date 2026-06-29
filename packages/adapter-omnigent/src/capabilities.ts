import type { Capability } from "@arke/contracts";

/**
 * Capabilities the Omnigent v1 HTTP API supports through this spike adapter (ADR-0002).
 *
 * Honest about differences (HarnessAdapter contract): only the capabilities we can map cleanly are
 * advertised.
 * - `events`      — `GET /v1/sessions/{id}/stream` (per-session SSE).
 * - `permissions` — Omnigent *elicitations* are the per-turn approval analog of OpenCode's
 *   `permission.replied`; resolved via `POST /v1/sessions/{id}/elicitations/{id}/resolve`.
 *
 * Deliberately NOT advertised:
 * - `diff`     — Omnigent exposes no REST diff endpoint; diffs surface via the git workspace/comments.
 * - `todos`    — `/v1/conversations/{id}/items` is transcript history, not a todo list.
 * - `commands` — not mapped in the spike.
 */
export const OMNIGENT_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "events",
  "permissions",
]);
