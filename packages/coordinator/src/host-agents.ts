/**
 * Host-agent catalog (launch screen, SPEC-019 follow-up). Answers a host-level question that is NOT
 * project-specific: which coding agents are present on this machine, and which are running. The
 * launch picker uses it to (a) render each agent tile's status — "Not installed" vs "Not running" vs
 * a live endpoint — and (b) know a harness is available host-wide so the project picker enables
 * itself, WITHOUT depending on the neutral default context's NullAdapter (whose `readiness()` is
 * always false by design, so it can never report an already-running host harness).
 *
 * Detection is two independent signals per agent:
 *   - `installed` — the CLI binary is resolvable on PATH (a pure, testable filesystem scan).
 *   - `running`   — a server for the agent answers on the host (only OpenCode runs a local server in
 *                   this build; the others have no adapter yet, so `running` is structurally false).
 * Neither reads or returns any credential (NFR-1): only presence + reachability.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { HarnessReachabilityProbe } from "./reachability.js";

export interface HostAgent {
  id: string;
  name: string;
  /** CLI binary is on PATH. Absent for URL-substrate agents (Omnigent) that have no binary. */
  installed?: boolean;
  /** A server for this agent is answering on the host. Only meaningful for agents with a local server. */
  running: boolean;
  /** The endpoint confirmed reachable, when running (never carries userinfo). */
  endpoint?: string;
}

interface AgentSpec {
  id: string;
  name: string;
  /** CLI binary to resolve on PATH; omitted for URL-substrate agents (no binary to detect). */
  binary?: string;
  /** Whether the agent runs a local server Arke can probe (only OpenCode in this build). */
  hasServer?: boolean;
}

/**
 * The agents shown on the launch screen. OpenCode is the only one with a runnable adapter; Claude
 * Code and Codex are detected for presence (so a user sees "installed, not yet supported") but have
 * no server to probe. Omnigent is a URL substrate — no binary, so no `installed` signal.
 */
export const KNOWN_HOST_AGENTS: readonly AgentSpec[] = [
  { id: "opencode", name: "OpenCode", binary: "opencode", hasServer: true },
  { id: "claude-code", name: "Claude Code", binary: "claude" },
  { id: "codex", name: "Codex", binary: "codex" },
  { id: "omnigent", name: "Omnigent" },
];

/** The documented local OpenCode endpoint (the desktop pre-warm + the scaffold default both use it). */
export const DEFAULT_OPENCODE_ENDPOINT = "http://127.0.0.1:4096";

/**
 * Resolve whether `binary` is an executable on PATH. Honours Windows PATHEXT (a bare `opencode`
 * resolves to `opencode.cmd`/`.exe`); on POSIX the name is exact. Pure over its `env`/`platform`
 * inputs so tests can exercise both platforms deterministically without touching the real filesystem
 * layout — inject a fake `existsSync` via {@link detectInstalledWith}.
 */
export function detectInstalled(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return detectInstalledWith(existsSync, binary, env, platform);
}

/** {@link detectInstalled} with an injectable `exists` predicate (test seam). */
export function detectInstalledWith(
  exists: (p: string) => boolean,
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathVar = env.PATH ?? env.Path ?? "";
  if (!pathVar) return false;
  const dirs = pathVar.split(delimiter).filter(Boolean);
  // Windows resolves a bare name through PATHEXT; "" first so an extension-carrying name still matches.
  const exts =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (exists(join(dir, binary + ext))) return true;
    }
  }
  return false;
}

/**
 * Build the host-agent catalog: for each known agent, whether its binary is installed and (for
 * OpenCode) whether a server answers. The OpenCode endpoint defaults to the documented local port
 * but can be overridden to match a host that configured a different one. Probing is skipped for an
 * agent whose binary is absent (nothing to be running) so an empty host resolves fast.
 */
export async function hostAgentCatalog(opts?: {
  probe?: HarnessReachabilityProbe;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  opencodeEndpoint?: string;
  /** Injectable existence predicate for the PATH scan (test seam); defaults to real `existsSync`. */
  exists?: (p: string) => boolean;
}): Promise<HostAgent[]> {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const probe = opts?.probe ?? new HarnessReachabilityProbe();
  const opencodeEndpoint = opts?.opencodeEndpoint ?? DEFAULT_OPENCODE_ENDPOINT;
  const exists = opts?.exists ?? existsSync;

  return Promise.all(
    KNOWN_HOST_AGENTS.map(async (spec): Promise<HostAgent> => {
      const installed = spec.binary ? detectInstalledWith(exists, spec.binary, env, platform) : undefined;
      let running = false;
      let endpoint: string | undefined;
      if (spec.hasServer && installed) {
        const { reachable } = await probe.anyReachable([opencodeEndpoint]);
        running = reachable;
        if (reachable) endpoint = opencodeEndpoint;
      }
      return {
        id: spec.id,
        name: spec.name,
        ...(installed !== undefined ? { installed } : {}),
        running,
        ...(endpoint ? { endpoint } : {}),
      };
    }),
  );
}
