import type { GlobalConfig, ProcessSettings } from "./global-config.js";
import type { InstanceConfig, RegistryConfig, RosterEntry } from "./registry.js";

/**
 * Resolve a project context's EFFECTIVE configuration (SPEC-019) by deep-merging the project's
 * `.arke/config.json` registry OVER the global (machine-level) config, project winning on conflicts.
 *
 * The grain of the split (SPEC-019):
 *  - `registry.instances` are machine-level — their canonical home is the global config. The merge
 *    keys them by `id`: a project instance with the same id REPLACES the global one (carrying its
 *    `credentialsRef`, so credential precedence is "project wins, else global" — decision #5), and
 *    non-conflicting instances from both files are retained. Global instances come first in config
 *    order (machine defaults), project-only instances appended — deterministic for the resolver.
 *  - the `roster` is strictly project-level (decision #9) — taken only from the project file.
 *  - process-wide `settings` come ONLY from the global file or `ARKE_*` env (env wins); a project
 *    `settings` block can never reach this function (the project type carries no settings), so it
 *    can never change a process-wide value (R3) — the boundary is structural.
 *
 * Pure and synchronous: no I/O, no throwing. Substrate exclusivity is checked separately via
 * {@link assertSubstrateExclusivity} so the merge itself stays total.
 */

/** The driver name a meta-harness substrate uses (ADR-0004); mutually exclusive with leaf instances. */
export const SUBSTRATE_DRIVER = "omnigent";

/** The effective config the rest of SPEC-005 consumes, plus the resolved process-wide settings. */
export interface EffectiveConfig extends RegistryConfig {
  settings?: ProcessSettings;
}

export function resolveEffectiveConfig(
  global: GlobalConfig | null | undefined,
  project: RegistryConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveConfig {
  // Instances keyed by id; insertion order = global first, then project-only appended. A same-id
  // project entry updates the value in place (Map.set keeps the original key position), so the
  // project's instance (and its credentialsRef) wins without disturbing config order.
  const byId = new Map<string, InstanceConfig>();
  for (const inst of global?.instances ?? []) byId.set(inst.id, inst);
  for (const inst of project?.instances ?? []) byId.set(inst.id, inst);

  const roster: Record<string, RosterEntry> = { ...(project?.roster ?? {}) }; // strictly project-level
  const settings = resolveProcessSettings(global?.settings, env);
  return { instances: [...byId.values()], roster, ...(settings ? { settings } : {}) };
}

/**
 * Resolve process-wide settings from the global file overlaid by `ARKE_*` env (env wins). A project
 * never participates — this takes only the global block. Returns undefined when neither supplies a
 * value, so the snapshot/launch source keeps its own defaults.
 */
export function resolveProcessSettings(
  global: ProcessSettings | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProcessSettings | undefined {
  const s: ProcessSettings = { ...(global ?? {}) };
  envNum(env.ARKE_COORDINATOR_PORT, (v) => (s.coordinatorPort = v));
  envNum(env.ARKE_MAX_PROJECTS, (v) => (s.maxProjects = v));
  envNum(env.ARKE_PROJECT_IDLE_MS, (v) => (s.idleTtlMs = v));
  envNum(env.ARKE_PROJECTION_QUERY_LIMIT, (v) => (s.projectionQueryLimit = v));
  envNum(env.ARKE_AUDIT_QUERY_LIMIT, (v) => (s.auditQueryLimit = v));
  if (typeof env.ARKE_OTLP_ENDPOINT === "string" && env.ARKE_OTLP_ENDPOINT.trim()) {
    s.otlpEndpoint = env.ARKE_OTLP_ENDPOINT;
  }
  return Object.keys(s).length > 0 ? s : undefined;
}

/** Raised when an effective config mixes a substrate with leaf instances (SPEC-019 / ADR-0004). */
export class SubstrateExclusivityError extends Error {
  constructor(readonly substrateIds: string[], readonly leafIds: string[]) {
    super(
      `substrate exclusivity violated: an Omnigent substrate (${substrateIds.join(", ")}) ` +
        `cannot coexist with leaf instances (${leafIds.join(", ")}) — a project's registry is either one or the other`,
    );
    this.name = "SubstrateExclusivityError";
  }
}

/**
 * Enforce substrate exclusivity on a (merged) config (SPEC-019 / ADR-0004): the registry is EITHER
 * leaf instances OR a single Omnigent substrate, never both. Throws {@link SubstrateExclusivityError}
 * on a mix so the caller can surface the conflict rather than silently routing against one.
 */
export function assertSubstrateExclusivity(config: { instances: InstanceConfig[] }): void {
  const substrate = config.instances.filter((i) => i.driver === SUBSTRATE_DRIVER);
  const leaf = config.instances.filter((i) => i.driver !== SUBSTRATE_DRIVER);
  if (substrate.length > 0 && leaf.length > 0) {
    throw new SubstrateExclusivityError(substrate.map((i) => i.id), leaf.map((i) => i.id));
  }
}

function envNum(v: string | undefined, set: (n: number) => void): void {
  if (v === undefined || v.trim() === "") return;
  const n = Number(v);
  if (Number.isFinite(n)) set(n);
}
