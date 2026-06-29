import type { ModelTier } from "@arke/contracts";

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
  /**
   * Logical tier → Omnigent `model_override`. Omnigent resolves the concrete model from the agent
   * image plus this override; unmapped tiers leave the agent's default model in place.
   */
  modelForTier?: (tier: ModelTier) => string | undefined;
  /** Per-request timeout (ms). */
  requestTimeoutMs?: number;
}

export const DEFAULT_OMNIGENT_BASE_URL = "http://localhost:6767";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
