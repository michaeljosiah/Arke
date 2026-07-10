import { parseRemote } from "./remote.js";
import { GitHubForge } from "./github.js";
import type { ForgeAdapter } from "./types.js";

export * from "./types.js";
export { parseRemote } from "./remote.js";
export { GitHubForge } from "./github.js";

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

/** Construct a forge adapter for an id. (The Azure Repos leaf lands in the next increment.) */
export function makeForge(id: ForgeId): ForgeAdapter {
  if (id === "github") return new GitHubForge();
  throw new Error(`forge '${id}' is not available yet`);
}
