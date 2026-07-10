import type { NormalizedRemote } from "./types.js";

/** Build the normalised remote from a host + the repo path segments (`.git` already stripped). Azure Repos
 *  URLs carry an org + a `_git/<repo>` anchor with an optional collection between org and project; a GitHub
 *  or generic remote is just `owner/repo`. Returns null (rather than mangling) when an Azure URL is malformed
 *  or a generic URL has too few segments. */
function fromHostAndSegments(host: string, segs: string[]): NormalizedRemote | null {
  const h = host.toLowerCase();
  if (h === "dev.azure.com") {
    // dev.azure.com/{org}[/{collection}...]/{project}/_git/{repo}
    const gi = segs.indexOf("_git");
    if (gi >= 1 && gi + 1 < segs.length) return { host: h, owner: segs[0]!, project: segs[gi - 1]!, repo: segs[gi + 1]! };
    return null; // no `_git` anchor / no org → malformed, fail loud instead of resolving to junk
  }
  if (h.endsWith(".visualstudio.com")) {
    // {org}.visualstudio.com/[{collection}/]{project}/_git/{repo}
    const gi = segs.indexOf("_git");
    if (gi >= 1 && gi + 1 < segs.length) return { host: h, owner: h.replace(/\.visualstudio\.com$/, ""), project: segs[gi - 1]!, repo: segs[gi + 1]! };
    return null;
  }
  // GitHub + any other host: the first two path segments are owner/repo.
  if (segs.length >= 2) return { host: h, owner: segs[0]!, repo: segs[1]! };
  return null;
}

/**
 * Parse a git remote URL into `{ host, owner, repo, project? }` (SPEC-038). Handles GitHub (HTTPS + SSH),
 * Azure Repos (`dev.azure.com/{org}[/{collection}]/{project}/_git/{repo}`, the `{org}.visualstudio.com/...`
 * legacy form incl. a `DefaultCollection` segment, and the `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
 * SSH form), and a generic `host/owner/repo` fallback. HTTP(S) URLs are parsed with the WHATWG `URL` so a
 * `:port`, userinfo, trailing slash, or query string never corrupts the result. Pure; null when unrecognised.
 */
export function parseRemote(url: string | undefined): NormalizedRemote | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  const raw = url.trim();

  // HTTP(S): parse with URL — hostname drops any :port + userinfo, pathname drops the query/hash.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const segs = u.pathname.split("/").map((s) => s.replace(/\.git$/i, "")).filter(Boolean);
      return fromHostAndSegments(u.hostname, segs);
    } catch {
      return null;
    }
  }

  // Azure Repos SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  let m = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(raw);
  if (m) return { host: "dev.azure.com", owner: m[1]!, project: m[2]!, repo: m[3]! };

  // Generic SSH (incl. ssh:// and scp-like git@host:owner/repo). An `ssh.dev.azure.com` host that reaches
  // here did NOT match the v3 form above → refuse rather than mis-parse it as owner/repo.
  m = /^(?:ssh:\/\/)?git@([^/:]+):(.+?)(?:\.git)?\/?$/i.exec(raw);
  if (m) {
    const host = m[1]!.toLowerCase();
    if (host === "ssh.dev.azure.com") return null;
    const segs = m[2]!.split("/").map((s) => s.replace(/\.git$/i, "")).filter(Boolean);
    return fromHostAndSegments(host, segs);
  }
  return null;
}
