import { spawnSync } from "node:child_process";
import { parseRemote } from "./remote.js";
import { GitHubForge } from "./github.js";
import { AzureReposForge } from "./azure.js";
import type { ForgeAdapter } from "./types.js";

export * from "./types.js";
export { parseRemote } from "./remote.js";
export { GitHubForge } from "./github.js";
export { AzureReposForge, parseAzReposPrList } from "./azure.js";

export type ForgeId = "github" | "azure-repos";

/** Optional `.arke/config.json` `forge` block: an explicit override of the remote-based detection. */
export interface ForgeConfig {
  host?: string;
  owner?: string;
  project?: string;
  repo?: string;
}

/**
 * The forge id for a project (SPEC-038, board/delivery path) — from an explicit `forge` config, else the git
 * **remote** host (`dev.azure.com` / `*.visualstudio.com` → azure-repos), **defaulting to GitHub** so an
 * unrecognised/absent remote keeps today's behaviour. Pure over `(remoteUrl, config)`; no network.
 */
export function forgeIdForRemote(remoteUrl: string | undefined, config?: ForgeConfig): ForgeId {
  const host = (config?.host ?? parseRemote(remoteUrl)?.host ?? "").toLowerCase();
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) return "azure-repos";
  return "github"; // github.com, unknown, or absent → GitHub (no regression for existing projects)
}

/**
 * The forge id for a webhook request, selected by the ingress URL PATH (NOT a project remote) — the payload is
 * verified + mapped before any project/branch is known (SPEC-038 Decision #2). `/webhooks/github` → github,
 * `/webhooks/azure` → azure-repos; any other path → null (not a forge webhook).
 */
export function webhookForgeId(path: string | undefined): ForgeId | null {
  if (path === "/webhooks/github") return "github";
  if (path === "/webhooks/azure") return "azure-repos";
  return null;
}

/** Construct a forge adapter for an id. */
export function makeForge(id: ForgeId): ForgeAdapter {
  if (id === "github") return new GitHubForge();
  if (id === "azure-repos") return new AzureReposForge();
  throw new Error(`forge '${id}' is not available yet`);
}

/**
 * The forge for a project (board/delivery path, SPEC-038): an explicit `.arke/config.json` `forge.host`
 * takes precedence, else the git `origin` remote decides (`dev.azure.com`/`*.visualstudio.com` → azure-repos,
 * else GitHub). Reads the remote read-only via `git remote get-url origin`; an absent/unreadable remote
 * resolves GitHub (today's behaviour — no existing project regresses).
 */
export function resolveForge(root: string, config?: ForgeConfig): ForgeAdapter {
  let remoteUrl: string | undefined;
  if (!config?.host) {
    try {
      const res = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", timeout: 15_000 });
      if (res.status === 0) remoteUrl = (res.stdout ?? "").trim();
    } catch {
      /* no remote → GitHub default */
    }
  }
  return makeForge(forgeIdForRemote(remoteUrl, config));
}
