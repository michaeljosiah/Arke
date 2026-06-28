import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ModelTier } from "@arke/contracts";

/**
 * Adapter configuration, directory canonicalisation, and `.arke/config.json` loading
 * (SPEC-002).
 *
 * Trust boundary (NFR-1/5): the server password is read on the host from the environment,
 * lives only in this process, and is never placed in any value returned to the client. The
 * working `directory` is the canonicalised configured project root — never a value taken
 * from client or user input — and is validated against path traversal/escape.
 */

export interface ResolvedModel {
  provider: string;
  name: string;
}

export interface OpenCodeConfig {
  /** Base URL of the OpenCode server, e.g. http://127.0.0.1:4096 */
  baseUrl: string;
  /** HTTP Basic password, read on the host (env OPENCODE_SERVER_PASSWORD). Host-only. */
  password?: string;
  /** Basic-auth username; OpenCode defaults to "opencode". */
  username?: string;
  /** The configured workspace. Canonicalised + validated; scopes every request. */
  projectRoot: string;
  /** Resolves a logical tier to a concrete provider/model (FR-4, D10). */
  resolveModel?: (tier: ModelTier) => ResolvedModel;
  /** ms to await a `permission.replied` confirmation before marking unconfirmed. */
  permissionTimeoutMs?: number;
  /** Base reconnect backoff (ms). */
  reconnectBaseMs?: number;
  /** Max reconnect backoff (ms). */
  reconnectMaxMs?: number;
}

export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
export const DEFAULT_RECONNECT_BASE_MS = 500;
export const DEFAULT_RECONNECT_MAX_MS = 15_000;
export const DEFAULT_OPENCODE_PORT = 4096;

/** Default tier→model resolution: the internal gateway provider (NFR-5, FR-18). */
export const DEFAULT_RESOLVE_MODEL = (tier: ModelTier): ResolvedModel => ({
  provider: "gateway",
  name: tier === "capable" ? "capable-tier" : "mid-tier",
});

// ---- directory canonicalisation + validation -----------------------------------

/** Raised when a requested directory would resolve outside the configured project root. */
export class DirectoryEscapeError extends Error {
  constructor(
    readonly candidate: string,
    readonly root: string,
  ) {
    super(`directory '${candidate}' resolves outside the configured project root '${root}'`);
    this.name = "DirectoryEscapeError";
  }
}

/** Resolve to an absolute path, following symlinks when the path already exists. */
export function canonicalizeRoot(root: string): string {
  const abs = resolve(root);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs; // not yet on disk — the absolute form is the best we have
  }
}

/** True when `candidate` (already absolute) is the root itself or strictly inside it. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a request directory against the canonical project root, refusing any value that
 * would escape it (via `..`, an absolute override, or a symlink that points outside). With
 * no candidate, returns the root — the adapter's normal path, since the directory is never
 * taken from client input.
 */
export function resolveDirectory(root: string, candidate?: string): string {
  if (candidate === undefined || candidate === "") return root;
  const resolved = resolve(root, candidate);
  let real = resolved;
  try {
    real = realpathSync.native(resolved);
  } catch {
    // candidate not yet on disk — validate the lexical resolution only
  }
  if (!isWithinRoot(root, resolved) || !isWithinRoot(root, real)) {
    throw new DirectoryEscapeError(candidate, root);
  }
  return resolved;
}

// ---- .arke/config.json loading -------------------------------------------------

interface RegistryInstance {
  id?: string;
  driver?: string;
  host?: string;
  port?: number;
  baseUrl?: string;
  cwd?: string;
  credentialsRef?: string;
  serves?: Array<{ tier?: string; model?: string }>;
}

interface ArkeConfigFile {
  registry?: { instances?: RegistryInstance[] };
  settings?: { permissionTimeoutMs?: number };
}

/** Parse a model string into provider/name; bare names resolve to the gateway provider. */
export function parseModelRef(model: string): ResolvedModel {
  const slash = model.indexOf("/");
  if (slash > 0) {
    return { provider: model.slice(0, slash), name: model.slice(slash + 1) };
  }
  return { provider: "gateway", name: model };
}

function buildResolver(instance: RegistryInstance): (tier: ModelTier) => ResolvedModel {
  const byTier = new Map<string, ResolvedModel>();
  for (const s of instance.serves ?? []) {
    if (s.tier && s.model) byTier.set(s.tier, parseModelRef(s.model));
  }
  return (tier: ModelTier) => byTier.get(tier) ?? DEFAULT_RESOLVE_MODEL(tier);
}

function instanceBaseUrl(instance: RegistryInstance): string {
  if (instance.baseUrl) return instance.baseUrl;
  const host = instance.host && instance.host !== "localhost" ? instance.host : "127.0.0.1";
  const port = instance.port ?? DEFAULT_OPENCODE_PORT;
  return `http://${host}:${port}`;
}

export interface LoadConfigOptions {
  /** Path to .arke/config.json. */
  configPath: string;
  /** Directory the config's relative `cwd` is resolved against (usually the repo root). */
  baseDir: string;
  /** Environment for credential + override resolution (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build an {@link OpenCodeConfig} from `.arke/config.json`, or return null when no OpenCode
 * instance is configured (the coordinator then falls back to the mock). Vendor model ids
 * come only from the file's registry; the password comes only from the host environment.
 * `ARKE_*` env vars override individual keys.
 */
export function loadOpenCodeConfig(opts: LoadConfigOptions): OpenCodeConfig | null {
  const env = opts.env ?? process.env;
  let parsed: ArkeConfigFile;
  try {
    parsed = JSON.parse(readFileSync(opts.configPath, "utf8")) as ArkeConfigFile;
  } catch {
    return null;
  }
  const instance = (parsed.registry?.instances ?? []).find((i) => i.driver === "opencode");
  if (!instance) return null;

  const projectRoot = canonicalizeRoot(
    env.ARKE_OPENCODE_PROJECT_ROOT ?? resolve(opts.baseDir, instance.cwd ?? "."),
  );

  return {
    baseUrl: env.ARKE_OPENCODE_BASE_URL ?? instanceBaseUrl(instance),
    password: env.OPENCODE_SERVER_PASSWORD,
    username: env.OPENCODE_SERVER_USERNAME ?? "opencode",
    projectRoot,
    resolveModel: buildResolver(instance),
    permissionTimeoutMs: numberFrom(
      env.ARKE_PERMISSION_TIMEOUT_MS,
      parsed.settings?.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    ),
  };
}

function numberFrom(override: string | undefined, fallback: number): number {
  if (override === undefined) return fallback;
  const n = Number(override);
  return Number.isFinite(n) ? n : fallback;
}
