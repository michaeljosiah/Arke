import type { ModelTier } from "@arke/contracts";

/**
 * Registry TYPES (SPEC-016 revised). Two concerns live here:
 *
 *  1. The host-side **provider/harness config** persisted in `.arke/config.json` and the global
 *     config — `InstanceConfig` / `RegistryConfig` (+ `ServesEntry` / `RosterEntry`). These describe a
 *     connected harness endpoint + its `credentialsRef` (SPEC-019 "connect once"); credentials never
 *     reach the client. The `tier`-shaped `serves`/`roster` fields are legacy storage the global
 *     harness-connect flow still carries but nothing routes on — agents declare their own model now.
 *
 *  2. The client-safe **registry projection** on the snapshot — `HarnessStatus` (live harness
 *     endpoints) + `AgentRosterEntry` (each agent's DECLARED model) + `RegistryWarning`.
 *
 * (The logical-tier resolver — `RegistryResolver`, `SessionRouter`, catalog validation — was removed
 * when agents became self-describing. Dispatch now sends the agent's own model directly; see
 * `AgentRegistry` + `ProjectContext`.)
 */

// ---- host-side provider/harness config (SPEC-019 storage) -------------------

/** One entry an instance `serves` (legacy tier binding + model). The model string is host-only. */
export interface ServesEntry {
  tier: ModelTier;
  model: string; // concrete provider/model string; never sent to the client
  /** Reasoning effort for a reasoning-capable model (e.g. gpt-5.5 → "xhigh"). */
  reasoningEffort?: string;
}

/** A configured harness instance (registry entry). `credentialsRef` is resolved host-side only. */
export interface InstanceConfig {
  id: string;
  driver: string; // "opencode" | "claude-code" | "omnigent" | …
  host: string;
  cwd: string;
  credentialsRef: string; // resolved on host; the ref string itself never reaches the client
  serves: ServesEntry[];
  /** Optional explicit port (adapter endpoint). Preserved verbatim across load/upsert (SPEC-019). */
  port?: number;
  /** Optional explicit base URL (adapter endpoint, scheme-preserving). Preserved verbatim (SPEC-019). */
  baseUrl?: string;
}

/** A roster role binding (legacy tier + optional instance pin). */
export interface RosterEntry {
  tier: ModelTier;
  instance?: string; // when present, pins to this instanceId
}

/** The registry section of `.arke/config.json` / the global config (instances + roster bindings). */
export interface RegistryConfig {
  instances: InstanceConfig[];
  roster: Record<string, RosterEntry>;
}

// ---- client-safe registry projection (SPEC-016 revised) ---------------------

/** A registry health/config warning carried on the snapshot. Leak-free `detail`. */
export type RegistryWarningReason =
  | "reviewer-models-identical"
  | "no-instance-for-tier"
  | "credential-missing"
  | "instance-failover"
  | "model-not-in-catalog";
export interface RegistryWarning {
  reason: RegistryWarningReason;
  detail?: string;
}

/**
 * One live harness endpoint on the snapshot (SPEC-016 revised, Omnigent-shaped). A harness is a
 * host-side provider/auth profile the adapter talks to; the client sees its id, kind, endpoint,
 * reachability, and capability flags — never a `credentialsRef`.
 */
export interface HarnessStatus {
  id: string; // provider profile key (e.g. "opencode-local")
  harness: string; // the harness kind ("opencode", "claude-code", …)
  endpoint: string;
  reachable: boolean;
  caps: string[];
}

/**
 * One agent on the roster (SPEC-016 revised). The agent DECLARES its own model+provider in its image
 * `executor`, so the client shows the concrete `provider/model` and reasoning effort directly — the
 * model id is public; only the credential (referenced by `authProfile`) is host-side.
 */
export interface AgentRosterEntry {
  name: string;
  description?: string;
  harness: string;
  model?: string;
  reasoningEffort?: string;
  mode: string;
  authProfile?: string;
}

/**
 * The client-safe registry projection carried on the snapshot (SPEC-016 revised). Agents declare
 * their runtime, so this is the live harness endpoints + the agent roster (each agent's declared
 * model), plus config/health warnings — no logical-tier indirection.
 */
export interface RegistrySnapshot {
  harnesses: HarnessStatus[];
  agents: AgentRosterEntry[];
  /** Config/health warnings from the last refresh, so the opening client sees them on connect. */
  warnings: RegistryWarning[];
}
