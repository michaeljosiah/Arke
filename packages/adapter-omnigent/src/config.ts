/**
 * Configuration for the Omnigent v1 HTTP adapter (ADR-0002 spike).
 *
 * Trust boundary (mirrors the OpenCode adapter / NFR-1): the bearer token is read on the host and
 * lives only in this process — it is never returned from any method or placed in a value that
 * reaches the client. Against a local `omnigent server start` (single-user, no auth) the token is
 * simply absent.
 */
export interface OmnigentConfig {
  /** Base URL of the Omnigent server. `omnigent server start` serves http://localhost:6767. */
  baseUrl: string;
  /**
   * Bearer JWT for the v1 API (`Authorization: Bearer <jwt>`), or undefined for a local no-auth
   * server. Host-only. Omnigent has no first-class long-lived API token yet (ADR-0002 open
   * question) — this is the accounts/OIDC-minted JWT, or omitted behind a header proxy.
   */
  token?: string;
  /**
   * The Omnigent `agent_id` (their Agent Image) to run for a session. Omnigent's unit of identity
   * is the agent image; Arke selects one per project. Optional — the server may have a default.
   */
  agentId?: string;
  /** Per-request timeout (ms). */
  requestTimeoutMs?: number;
  /**
   * Path to a durable NDJSON session store (SPEC-037). When set, the session id → `{ specId, kind }`
   * mapping survives an adapter/coordinator restart so live sessions re-attach to their specs. Omitted →
   * in-memory only (the spike behaviour).
   */
  sessionStorePath?: string;
  /** Reconnect tuning for the per-session SSE pump (SPEC-037). Defaults to {@link DEFAULT_RECONNECT}. */
  reconnect?: ReconnectOptions;
}

export interface ReconnectOptions {
  /** Max reconnect attempts before a terminal degrade (SPEC-037 reconnect exhaustion). */
  maxAttempts?: number;
  /** Base backoff (ms); the delay is `min(base * 2^(attempt-1), max)`. */
  baseDelayMs?: number;
  /** Backoff ceiling (ms). */
  maxDelayMs?: number;
  /**
   * A stream must stay connected at least this long (ms), having delivered ≥1 frame, before its reconnect
   * counter resets — so an open-then-immediately-drop FLAP keeps accumulating toward the bound instead of
   * resetting on every cycle (a subtle unbounded-reconnect bug). A healthy long-lived stream that drops
   * after this window resets and reconnects fresh.
   */
  minHealthyMs?: number;
}

export const DEFAULT_RECONNECT: Required<ReconnectOptions> = { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 5000, minHealthyMs: 2000 };

export const DEFAULT_OMNIGENT_BASE_URL = "http://localhost:6767";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The Omnigent server version this adapter is pinned to and validated against (SPEC-037). Omnigent is an
 * alpha with a drifting API (ADR-0002), so `init()` reads `GET /api/version` and refuses to report ready
 * on an incompatible server rather than fail obscurely deep in a turn. Bump this deliberately when the
 * adapter is re-grounded against a new version's frames.
 */
export const OMNIGENT_TARGET_VERSION = "0.3.0";

/**
 * Whether a server version is compatible with the pinned target: same `major.minor` (a patch bump may
 * drift). A missing/unparseable version is treated as incompatible (fail loud, don't guess).
 */
export function isCompatibleOmnigentVersion(serverVersion: string | undefined, target = OMNIGENT_TARGET_VERSION): boolean {
  if (typeof serverVersion !== "string" || serverVersion.trim() === "") return false;
  const s = serverVersion.trim().split(".");
  const t = target.split(".");
  return s.length >= 2 && s[0] === t[0] && s[1] === t[1];
}
