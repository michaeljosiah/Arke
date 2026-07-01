import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { arkeHome } from "./project-registry.js";
import { parseInstances } from "./registry-config.js";
import type { InstanceConfig } from "./registry.js";

/**
 * The GLOBAL (machine-level) configuration (SPEC-019). It lives next to the project registry under
 * `arkeHome()` (`ARKE_HOME` ?? OS default) as `config.json`, and is the canonical home for
 * `registry.instances` — your harnesses, configured once — plus the process-wide `settings` block.
 *
 * The roster is **strictly project-level** (SPEC-019 decision #9): the global config carries NO
 * roster, so no role→tier default leaks across repositories. That is enforced structurally here —
 * {@link GlobalConfig} has no roster field and {@link loadGlobalConfig} never reads one.
 *
 * Like the project config, vendor model strings and the `credentialsRef` *pointer* stay host-side;
 * the secret itself is never written here (SPEC-019 / NFR-1).
 */

/** Process-wide settings — authoritative only from the global file or `ARKE_*` env (never a project). */
export interface ProcessSettings {
  coordinatorPort?: number;
  maxProjects?: number;
  idleTtlMs?: number;
  projectionQueryLimit?: number;
  auditQueryLimit?: number;
  otlpEndpoint?: string | null;
  /**
   * Whether Arke owns (spawns) the OpenCode harness process rather than attaching to a running one
   * (SPEC-016). Set true by a SPEC-019 managed "Start OpenCode" connect so the coordinator brings the
   * harness up on reload. `ARKE_MANAGE_HARNESS` env still overrides at load time.
   */
  manageHarness?: boolean;
  /**
   * The directory that bounds all folder browsing / cloning / project creation from the client
   * (SPEC-018). Defaults to the user's home; `ARKE_WORKSPACE_ROOT` overrides. The browser can only
   * navigate within this root — it never enumerates the whole disk.
   */
  workspaceRoot?: string;
}

/** The machine-level global config: instances (+ optional process-wide settings). No roster. */
export interface GlobalConfig {
  instances: InstanceConfig[];
  settings?: ProcessSettings;
}

interface RawGlobal {
  registry?: { instances?: unknown };
  settings?: Record<string, unknown>;
}

/** The resolved path of the global config: `ARKE_GLOBAL_CONFIG_PATH` if set, else `arkeHome()/config.json`. */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ARKE_GLOBAL_CONFIG_PATH && env.ARKE_GLOBAL_CONFIG_PATH.trim()) {
    return resolve(env.ARKE_GLOBAL_CONFIG_PATH);
  }
  return resolve(arkeHome(env), "config.json");
}

/**
 * Load the global config, or `null` when the file is absent/unreadable/unparseable. Parsing is
 * lenient (mirrors the project loader): malformed instances are dropped rather than throwing, so a
 * partially-edited file still yields a usable config. A file that parses but has no instances is a
 * valid settings-only config (`{ instances: [] }`), not `null`.
 */
export function loadGlobalConfig(path: string = globalConfigPath()): GlobalConfig | null {
  let parsed: RawGlobal;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as RawGlobal;
  } catch {
    return null;
  }
  const instances = parseInstances(parsed.registry?.instances);
  const settings = parseSettings(parsed.settings);
  return { instances, ...(settings ? { settings } : {}) };
}

/**
 * Upsert a harness instance into the global config (SPEC-019 first-run write), creating the file and
 * its directory when absent and replacing any same-id entry. Writes atomically (temp + rename). Only
 * the descriptor the caller supplies is persisted — a `credentialsRef` pointer, never a secret.
 */
export function upsertGlobalInstance(
  descriptor: InstanceConfig,
  path: string = globalConfigPath(),
): GlobalConfig {
  const existing = loadGlobalConfig(path) ?? { instances: [] };
  const instances = existing.instances.filter((i) => i.id !== descriptor.id);
  instances.push(descriptor);
  const next: GlobalConfig = { instances, ...(existing.settings ? { settings: existing.settings } : {}) };
  writeGlobalConfig(next, path);
  return next;
}

/**
 * Capture the raw global-config file bytes (or `null` when absent) so a caller can roll back an
 * upsert that turns out not to bring a harness live (SPEC-019 connect verification).
 */
export function snapshotGlobalConfigRaw(path: string = globalConfigPath()): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Restore a {@link snapshotGlobalConfigRaw} capture: rewrite the prior bytes, or delete if it was absent. */
export function restoreGlobalConfigRaw(snapshot: string | null, path: string = globalConfigPath()): void {
  if (snapshot === null) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
    return;
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, snapshot, "utf8");
  renameSync(tmp, path);
}

/** Serialise the global config to disk atomically (temp + rename), creating parent dirs as needed. */
function writeGlobalConfig(config: GlobalConfig, path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Persist under the `registry.instances` shape the project config uses, so the file is hand-editable
  // with the same mental model. No roster key is ever written.
  const body = {
    registry: { instances: config.instances },
    ...(config.settings ? { settings: config.settings } : {}),
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Parse the process-wide `settings` block leniently; returns undefined when nothing usable is present. */
function parseSettings(raw: Record<string, unknown> | undefined): ProcessSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s: ProcessSettings = {};
  num(raw.coordinatorPort, (v) => (s.coordinatorPort = v));
  num(raw.maxProjects, (v) => (s.maxProjects = v));
  num(raw.idleTtlMs, (v) => (s.idleTtlMs = v));
  num(raw.projectionQueryLimit, (v) => (s.projectionQueryLimit = v));
  num(raw.auditQueryLimit, (v) => (s.auditQueryLimit = v));
  if (typeof raw.otlpEndpoint === "string") s.otlpEndpoint = raw.otlpEndpoint;
  else if (raw.otlpEndpoint === null) s.otlpEndpoint = null;
  if (typeof raw.manageHarness === "boolean") s.manageHarness = raw.manageHarness;
  if (typeof raw.workspaceRoot === "string" && raw.workspaceRoot.trim()) s.workspaceRoot = raw.workspaceRoot;
  return Object.keys(s).length > 0 ? s : undefined;
}

/**
 * Set (or clear) the `settings.manageHarness` flag in the global config, preserving instances and
 * every other setting (SPEC-019 managed connect). Creates the file if absent; writes atomically.
 */
export function setGlobalManageHarness(value: boolean, path: string = globalConfigPath()): void {
  const existing = loadGlobalConfig(path) ?? { instances: [] };
  const settings: ProcessSettings = { ...(existing.settings ?? {}), manageHarness: value };
  writeGlobalConfig({ instances: existing.instances, settings }, path);
}

function num(v: unknown, set: (n: number) => void): void {
  if (typeof v === "number" && Number.isFinite(v)) set(v);
}
