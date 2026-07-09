import type { Capability } from "@arke/contracts";

/**
 * Capabilities the Codex app-server supports through this adapter (SPEC-034). Honest about differences
 * (HarnessAdapter contract): only what Codex delivers is advertised; the board/cockpit degrade to this.
 * - `events`      — the app-server notification stream (turn lifecycle, items, deltas).
 * - `permissions` — Codex's server→client `item/<kind>/requestApproval` round-trip (the propose·decide·execute gate).
 * - `diff`        — derived from git in the session's working directory (transport-independent truth).
 * - `todos`       — Codex `plan_update` items → a task checklist.
 * - `models`      — a config-driven / known catalog (Codex exposes NO enumeration API — Decision #3).
 *
 * Deliberately NOT advertised: `commands` (Codex has no external "run a slash command" surface), `revert`
 * (Codex `thread/fork` as a rescue primitive is deferred — Open questions).
 */
export const CODEX_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "events",
  "permissions",
  "diff",
  "todos",
  "models",
]);
