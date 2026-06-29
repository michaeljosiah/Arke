import { readFileSync } from "node:fs";
import type { ModelTier } from "@arke/contracts";
import type { InstanceConfig, RegistryConfig, RosterEntry, ServesEntry } from "./registry.js";

/**
 * Loads the full harness/model registry (instances + roster) from a project's `.arke/config.json`
 * (SPEC-005). This is the host-side read of the same file `loadOpenCodeConfig` parses for the live
 * adapter; here we read the WHOLE registry so the coordinator can project every configured instance
 * (not just the one with a running adapter) and resolve the roster. Parsing is lenient: an entry
 * missing required fields is dropped rather than throwing, so a partially-edited config still yields
 * a usable projection. Vendor model strings stay in the returned config (host-only) and never reach
 * the client — the projection layer emits tier labels only.
 */

const KNOWN_TIERS: ReadonlySet<string> = new Set<ModelTier>(["capable", "mid", "fast"]);

interface RawInstance {
  id?: unknown;
  driver?: unknown;
  host?: unknown;
  cwd?: unknown;
  credentialsRef?: unknown;
  serves?: unknown;
}

interface RawConfig {
  registry?: { instances?: unknown; roster?: unknown };
}

export interface LoadedRegistry {
  config: RegistryConfig;
  /** The instance the live adapter serves (first `opencode` driver), matching loadOpenCodeConfig. */
  connectedInstanceId?: string;
}

/** Parse `.arke/config.json` into a {@link RegistryConfig}, or null when no registry is configured. */
export function loadRegistryConfig(configPath: string): LoadedRegistry | null {
  let parsed: RawConfig;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as RawConfig;
  } catch {
    return null;
  }
  const rawInstances = parsed.registry?.instances;
  if (!Array.isArray(rawInstances)) return null;

  const instances: InstanceConfig[] = [];
  for (const raw of rawInstances as RawInstance[]) {
    const id = str(raw?.id);
    const driver = str(raw?.driver);
    if (!id || !driver) continue; // an instance with no identity/driver can't be projected or routed
    instances.push({
      id,
      driver,
      host: str(raw?.host) ?? "localhost",
      cwd: str(raw?.cwd) ?? ".",
      credentialsRef: str(raw?.credentialsRef) ?? "",
      serves: parseServes(raw?.serves),
    });
  }
  if (instances.length === 0) return null;

  const roster = parseRoster(parsed.registry?.roster);
  const connectedInstanceId = instances.find((i) => i.driver === "opencode")?.id;
  return {
    config: { instances, roster },
    ...(connectedInstanceId ? { connectedInstanceId } : {}),
  };
}

function parseServes(raw: unknown): ServesEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ServesEntry[] = [];
  for (const s of raw as Array<{ tier?: unknown; model?: unknown }>) {
    const tier = str(s?.tier);
    const model = str(s?.model);
    if (tier && model && KNOWN_TIERS.has(tier)) out.push({ tier: tier as ModelTier, model });
  }
  return out;
}

function parseRoster(raw: unknown): Record<string, RosterEntry> {
  const roster: Record<string, RosterEntry> = {};
  if (!raw || typeof raw !== "object") return roster;
  for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as { tier?: unknown; instance?: unknown };
    const tier = str(v?.tier);
    if (!tier || !KNOWN_TIERS.has(tier)) continue;
    const instance = str(v?.instance);
    roster[role] = { tier: tier as ModelTier, ...(instance ? { instance } : {}) };
  }
  return roster;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
