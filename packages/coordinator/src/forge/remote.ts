import type { NormalizedRemote } from "./types.js";

/**
 * Parse a git remote URL into `{ host, owner, repo, project? }` (SPEC-038). Handles GitHub (HTTPS + SSH),
 * Azure Repos (`dev.azure.com/{org}/{project}/_git/{repo}`, the `{org}.visualstudio.com/{project}/_git/{repo}`
 * legacy form, and the `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}` SSH form), and a generic
 * two-segment `host/owner/repo` fallback for any other host. Pure; null when unrecognisable.
 */
export function parseRemote(url: string | undefined): NormalizedRemote | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  const raw = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");

  // Azure Repos — HTTPS: https://dev.azure.com/{org}/{project}/_git/{repo}  (userinfo tolerated + stripped)
  let m = /^https?:\/\/(?:[^@/]+@)?(dev\.azure\.com)\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i.exec(raw);
  if (m) return { host: m[1]!.toLowerCase(), owner: m[2]!, project: m[3]!, repo: m[4]! };

  // Azure Repos — legacy: https://{org}.visualstudio.com/{project}/_git/{repo}
  m = /^https?:\/\/(?:[^@/]+@)?([^/]+\.visualstudio\.com)\/([^/]+)\/_git\/([^/]+)$/i.exec(raw);
  if (m) {
    const org = m[1]!.replace(/\.visualstudio\.com$/i, "");
    return { host: m[1]!.toLowerCase(), owner: org, project: m[2]!, repo: m[3]! };
  }

  // Azure Repos — SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  m = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(raw);
  if (m) return { host: "dev.azure.com", owner: m[1]!, project: m[2]!, repo: m[3]! };

  // GitHub + generic HTTPS/SSH `host[:/]owner/repo` (owner/repo only — two segments).
  m = /^(?:git@|https?:\/\/(?:[^@/]+@)?)([^/:]+)[/:]([^/]+)\/(.+)$/i.exec(raw);
  if (m) {
    const repo = m[3]!.replace(/\/.*$/, ""); // keep only the first path segment as the repo
    if (m[2] && repo) return { host: m[1]!.toLowerCase(), owner: m[2]!, repo };
  }
  return null;
}
