/**
 * Configuration for the Codex leaf adapter (SPEC-034).
 *
 * Trust boundary (NFR-1, mirrors the OpenCode/Omnigent adapters): Codex authentication is host-side —
 * `codex login` writes `~/.codex/auth.json`, or `OPENAI_API_KEY` is read from the host environment when
 * the app-server process is spawned. NO credential is held here, returned from any method, or placed in a
 * value that reaches the client. This config carries only non-secret operational settings.
 */
export interface CodexConfig {
  /** The `codex` binary/command to spawn the app-server (default {@link DEFAULT_CODEX_BIN}). */
  bin?: string;
  /** The project root — the default working directory a Codex thread runs in. */
  cwd: string;
  /**
   * Approval policy for threads. Default is `on-request` (NOT `never`): Codex SHALL ask before a gated
   * action so the request round-trips through Arke's human gate (propose · decide · execute). `never`
   * would auto-approve and bypass the gate — never the default.
   */
  approvalPolicy?: "untrusted" | "on-request" | "never";
  /** Sandbox mode for threads (default `workspace-write`). */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * The model catalog to advertise (SPEC-034 Decision #3). Codex exposes no enumeration API, so this is
   * a config-driven / known list; omitted → {@link CODEX_KNOWN_MODELS}.
   */
  models?: string[];
  /** Per-request timeout (ms) for a JSON-RPC call awaiting its response. */
  requestTimeoutMs?: number;
}

export const DEFAULT_CODEX_BIN = "codex";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
