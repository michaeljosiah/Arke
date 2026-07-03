import type { ProcessSettings } from "./global-config.js";

/**
 * Resolve process-wide settings from the global config overlaid by `ARKE_*` env (env wins), SPEC-019
 * R3. A project never participates — this takes only the global block — so a project can never change
 * a process-wide value; the boundary is structural (the project config type carries no settings).
 *
 * (The logical-tier config-merge/resolver that used to live here — `resolveEffectiveConfig`,
 * `assertSubstrateExclusivity` — was removed with the rest of the tier machinery when agents became
 * self-describing: SPEC-016 revised. Agents declare their own model+provider now.)
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

function envNum(v: string | undefined, set: (n: number) => void): void {
  if (v === undefined || v.trim() === "") return;
  const n = Number(v);
  if (Number.isFinite(n)) set(n);
}
