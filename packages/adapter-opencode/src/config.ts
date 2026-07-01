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
  /**
   * Managed mode (SPEC-016): when true the adapter spawns and owns the harness process; when
   * false (default) it attaches to an already-running server and never stops it.
   */
  manageHarness?: boolean;
  /** Override the spawn argv; defaults to `opencode serve --hostname <h> --port <p>` from baseUrl. */
  harnessCommand?: string[];
}

export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
export const DEFAULT_RECONNECT_BASE_MS = 500;
export const DEFAULT_RECONNECT_MAX_MS = 15_000;
export const DEFAULT_OPENCODE_PORT = 4096;

/** Default tier→model resolution: the internal gateway provider (NFR-5, FR-18). */
export const DEFAULT_RESOLVE_MODEL = (tier: ModelTier): ResolvedModel => ({
  provider: "gateway",
  name: `${tier}-tier`, // capable-tier | mid-tier | fast-tier
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
  settings?: { permissionTimeoutMs?: number; manageHarness?: boolean };
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
  // A host that already carries a port (e.g. "localhost:4096" written by SPEC-019 quick setup) is a
  // full authority — use it as-is rather than appending the default port a second time.
  if (/:\d+$/.test(host)) return `http://${host}`;
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
  /**
   * SPEC-019: path to the machine-level GLOBAL config. Its instances are merged UNDER the project's
   * (project wins by id), so a globally-configured OpenCode harness is picked up by a project that
   * has no local instance. When omitted, only the project file is read (back-compatible).
   */
  globalConfigPath?: string;
}

function tryParseConfig(path: string): ArkeConfigFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ArkeConfigFile;
  } catch {
    return null;
  }
}

/**
 * Build an {@link OpenCodeConfig} from `.arke/config.json` merged over the global config (SPEC-019),
 * or return null when no OpenCode instance is configured in either (the coordinator then falls back
 * to the mock / NullAdapter). Vendor model ids come only from the registry; the password comes only
 * from the host environment. `ARKE_*` env vars override individual keys.
 */
export function loadOpenCodeConfig(opts: LoadConfigOptions): OpenCodeConfig | null {
  const env = opts.env ?? process.env;
  const project = tryParseConfig(opts.configPath);
  const global = opts.globalConfigPath ? tryParseConfig(opts.globalConfigPath) : null;
  if (!project && !global) return null;

  // Merge instances by id, project winning; global entries first for a deterministic order. Id-less
  // entries (older minimal configs) are preserved in file order after the keyed ones.
  const byId = new Map<string, RegistryInstance>();
  const idless: RegistryInstance[] = [];
  for (const i of global?.registry?.instances ?? []) i.id ? byId.set(i.id, i) : idless.push(i);
  for (const i of project?.registry?.instances ?? []) i.id ? byId.set(i.id, i) : idless.push(i);
  const instances = [...byId.values(), ...idless];
  const instance = instances.find((i) => i.driver === "opencode");
  if (!instance) return null;

  const settings = project?.settings ?? global?.settings; // project advisory settings win
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
      settings?.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    ),
    manageHarness: boolFrom(env.ARKE_MANAGE_HARNESS, settings?.manageHarness ?? false),
  };
}

function boolFrom(override: string | undefined, fallback: boolean): boolean {
  if (override === undefined) return fallback;
  return override === "1" || override.toLowerCase() === "true";
}

function numberFrom(override: string | undefined, fallback: number): number {
  if (override === undefined) return fallback;
  const n = Number(override);
  return Number.isFinite(n) ? n : fallback;
}
