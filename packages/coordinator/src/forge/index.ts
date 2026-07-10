import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseRemote } from "./remote.js";
import { GitHubForge } from "./github.js";
import { AzureReposForge } from "./azure.js";
import type { ForgeAdapter } from "./types.js";

export * from "./types.js";
export { parseRemote } from "./remote.js";
export { GitHubForge } from "./github.js";
export { AzureReposForge, parseAzReposPrList, resolveAzureCoordinates } from "./azure.js";

export type ForgeId = "github" | "azure-repos";

/**
 * Optional `.arke/config.json` `forge` block — an explicit override of the remote-based detection (SPEC-038).
 * `id` is the direct toggle ("use this forge, period"); `host` forces detection by host. `owner`/`project`/
 * `repo` supply the Azure org/project/repo for the `az` board read when the git remote can't (a masked/mirror
 * remote a pinned `forge: azure-repos` points at) — see `resolveAzureCoordinates`.
 */
export interface ForgeConfig {
  id?: ForgeId;
  host?: string;
  owner?: string;
  project?: string;
  repo?: string;
}

/**
 * The forge id for a project (SPEC-038, board/delivery path). Precedence: an explicit `forge.id` toggle, else
 * a `forge.host` (or the git **remote** host) — `dev.azure.com` / `*.visualstudio.com` → azure-repos —
 * **defaulting to GitHub** so an unrecognised/absent remote keeps today's behaviour. Pure; no network.
 */
export function forgeIdForRemote(remoteUrl: string | undefined, config?: ForgeConfig): ForgeId {
  if (config?.id === "github" || config?.id === "azure-repos") return config.id; // the explicit toggle wins
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

/** Construct a forge adapter for an id. The Azure leaf takes the `forge` config so an explicit override can
 *  supply the org/project/repo its `az` board read needs when the git remote can't (a masked/mirror remote). */
export function makeForge(id: ForgeId, config?: ForgeConfig): ForgeAdapter {
  if (id === "github") return new GitHubForge();
  if (id === "azure-repos") return new AzureReposForge(config);
  throw new Error(`forge '${id}' is not available yet`);
}

/**
 * The forge for a project (board/delivery path, SPEC-038): an explicit `.arke/config.json` `forge` override
 * (a `forge.id` toggle, or a `forge.host`) takes precedence, else the git `origin` remote decides
 * (`dev.azure.com`/`*.visualstudio.com` → azure-repos, else GitHub). Reads the remote read-only via
 * `git remote get-url origin` ONLY when the config doesn't already pin the forge — so an explicit `forge.id`
 * needs no git at all. An absent/unreadable remote resolves GitHub (today's behaviour — no project regresses).
 */
export function resolveForge(root: string, config?: ForgeConfig): ForgeAdapter {
  if (config?.id === "github" || config?.id === "azure-repos") return makeForge(config.id, config); // explicit → no git
  let remoteUrl: string | undefined;
  if (!config?.host) {
    try {
      const res = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", timeout: 15_000 });
      if (res.status === 0) remoteUrl = (res.stdout ?? "").trim();
    } catch {
      /* no remote → GitHub default */
    }
  }
  return makeForge(forgeIdForRemote(remoteUrl, config), config);
}

/**
 * Read the optional `forge` override from a project's `.arke/config.json` (SPEC-038). Accepts either the
 * short toggle form (`"forge": "github" | "azure-repos"`) or the object form
 * (`"forge": { "id"?, "host"?, "owner"?, "project"?, "repo"? }`). A missing/unparseable file, absent `forge`
 * key, or unrecognised value → `undefined` (fall back to remote auto-detection — no regression). Never throws.
 */
export function loadForgeConfig(configPath: string): ForgeConfig | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined; // missing or invalid JSON → no override
  }
  const f = (raw as { forge?: unknown })?.forge;
  if (f === "github" || f === "azure-repos") return { id: f };
  if (!f || typeof f !== "object") return undefined;
  const o = f as Record<string, unknown>;
  const cfg: ForgeConfig = {};
  if (o.id === "github" || o.id === "azure-repos") cfg.id = o.id;
  if (typeof o.host === "string" && o.host.trim()) cfg.host = o.host.trim();
  if (typeof o.owner === "string" && o.owner.trim()) cfg.owner = o.owner.trim();
  if (typeof o.project === "string" && o.project.trim()) cfg.project = o.project.trim();
  if (typeof o.repo === "string" && o.repo.trim()) cfg.repo = o.repo.trim();
  return Object.keys(cfg).length ? cfg : undefined;
}
