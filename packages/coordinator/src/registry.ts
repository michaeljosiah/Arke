import type { ModelInfo, ModelTier } from "@arke/contracts";

/**
 * The harness & model registry (SPEC-005). The single place vendor model identifiers live —
 * loaded from a project's `.arke/config.json` on the host, accessed only by this resolver. Roles
 * ask for a logical tier; the resolver maps role → `ModelSelection {instanceId, tier, model}`
 * deterministically (config order), enforces reviewer-distinct independence, and validates the
 * configured `serves` against each instance's live model catalog (`listModels()`). The client only
 * ever sees the projection from {@link RegistryResolver.listInstances} — tier labels, never the
 * concrete model strings or any `credentialsRef`.
 */

// ---- configuration types ----------------------------------------------------

/** One tier → concrete model binding an instance serves. The model string is host-only. */
export interface ServesEntry {
  tier: ModelTier;
  model: string; // concrete provider/model string; never sent to the client
}

/** A configured harness instance (registry entry). `credentialsRef` is resolved host-side only. */
export interface InstanceConfig {
  id: string;
  driver: string; // "opencode" | "claude-code" | "omnigent" | …
  host: string;
  cwd: string;
  credentialsRef: string; // resolved on host; the ref string itself never reaches the client
  serves: ServesEntry[];
}

/** A roster role binding: a logical tier, optionally pinned to a specific instance. */
export interface RosterEntry {
  tier: ModelTier;
  instance?: string; // when present, pins to this instanceId
}

/** The registry section of `.arke/config.json` (instances + roster bindings). */
export interface RegistryConfig {
  instances: InstanceConfig[];
  roster: Record<string, RosterEntry>;
}

/** The result of resolving a role: which instance, which tier, and the concrete model (host-only). */
export interface ModelSelection {
  instanceId: string;
  tier: ModelTier;
  model: string; // concrete provider/model string for the adapter; never sent to the client
}

/**
 * Client-safe projection of one instance (SPEC-005). Carries NO `credentialsRef`, NO credential
 * value, and NO vendor model string — only the id, driver, host, and tier *labels* it serves.
 * Runtime fields (caps, reachability, catalog availability) are merged in by the integration layer.
 */
export interface InstanceProjection {
  id: string;
  driver: string;
  host: string;
  serves: { tier: ModelTier; label: string }[];
}

/**
 * A client-facing instance projection enriched with runtime state (SPEC-005). Built by the
 * integration layer from {@link InstanceProjection} + the live adapter; still leak-free (tier
 * labels only, no model strings, no credentialsRef). Mirrors the `registry.updated` event shape.
 */
export interface RegistryInstanceStatus {
  id: string;
  driver: string;
  endpoint: string;
  reachable: boolean;
  caps: string[];
  serves: { tier: ModelTier; label: string }[];
  /** True when the backend exposes no catalog, so its serves were trusted unvalidated. */
  catalogUnavailable?: boolean;
}

/** One role's resolution for the harnesses screen's roster table (no model string). */
export interface RosterResolution {
  role: string;
  instanceId?: string;
  tier?: ModelTier;
  label?: string;
  /** True when no instance serves the role's tier (the registry is incomplete for this role). */
  unresolved?: boolean;
}

/** A registry health/config warning carried on the snapshot (SPEC-005). Leak-free `detail`. */
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

/** The full client-safe registry projection carried on the snapshot (SPEC-005). */
export interface RegistrySnapshot {
  instances: RegistryInstanceStatus[];
  tierResolution: { tier: ModelTier; label: string }[];
  roster: RosterResolution[];
  /** Config/health warnings from the last refresh, so the opening client sees them on connect. */
  warnings: RegistryWarning[];
}

/** One configured model that is absent from its instance's live catalog (SPEC-005). */
export interface CatalogValidationProblem {
  instanceId: string;
  tier: ModelTier;
  /** A human-readable label for the offending entry — the tier + driver, not a leaked vendor id. */
  label: string;
}

/** The outcome of validating configured `serves` against the live catalogs (SPEC-005). */
export interface CatalogValidationResult {
  ok: boolean;
  problems: CatalogValidationProblem[];
  /** Instance ids whose backend exposed no catalog; their `serves` were trusted unvalidated. */
  catalogUnavailable: string[];
  /** `${instanceId}::${tier}` keys whose routing must be blocked until the config is corrected. */
  blocked: Set<string>;
}

// ---- typed errors -----------------------------------------------------------

/** No registered instance serves the tier a role requires (SPEC-005). Surfaced; not defaulted. */
export class NoInstanceForTierError extends Error {
  constructor(
    readonly role: string,
    readonly tier: ModelTier,
  ) {
    super(`no registered instance serves tier '${tier}' required by role '${role}'`);
    this.name = "NoInstanceForTierError";
  }
}

/** The registry configuration is internally inconsistent (e.g. reviewers resolve to one model). */
export class RegistryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryConfigError";
  }
}

/** A role is referenced that the roster does not define (SPEC-005). */
export class UnknownRoleError extends Error {
  constructor(readonly role: string) {
    super(`unknown roster role '${role}'`);
    this.name = "UnknownRoleError";
  }
}

// ---- model-string parsing + catalog matching --------------------------------

/** Split a configured model string into `{provider, name}`; a bare name has no explicit provider. */
export function parseModel(model: string): { provider?: string; name: string } {
  const slash = model.indexOf("/");
  if (slash > 0) return { provider: model.slice(0, slash), name: model.slice(slash + 1) };
  return { name: model };
}

/**
 * True when a configured `serves[].model` string is present in a backend's live catalog. Matching is
 * provider-qualified: a `provider/name` form must match both fields, and a bare `name` resolves to
 * the implicit `gateway` provider — the same default {@link SessionRouter} routing applies. A bare
 * name therefore does NOT match a provider-qualified catalog entry (e.g. `gpt-5.5` does not match a
 * `github-copilot/gpt-5.5` catalog), so a model that would dispatch as `gateway/gpt-5.5` is caught
 * at config load rather than at first run.
 */
export function modelMatchesCatalog(model: string, catalog: ModelInfo[]): boolean {
  const { provider, name } = parseModel(model);
  const effectiveProvider = provider ?? "gateway"; // matches SessionRouter.build's bare-name default
  return catalog.some((m) => m.provider === effectiveProvider && m.id === name);
}

// ---- resolver ---------------------------------------------------------------

const REVIEWER_A = "reviewer-a";
const REVIEWER_B = "reviewer-b";

/** A human-readable, leak-free description of a selection's model for the trace/projection. */
function tierLabelFor(tier: ModelTier, driver: string): string {
  return `${tier} — ${driver}`;
}

/**
 * Resolves roles to model selections and validates the registry (SPEC-005). Pure and synchronous:
 * tracing and routing side effects live in the SessionRouter / RegistryLoader that wrap it.
 */
export class RegistryResolver {
  private readonly byId: Map<string, InstanceConfig>;

  constructor(private readonly config: RegistryConfig) {
    // Duplicate ids would let the Map keep the last entry while unpinned resolution iterates the
    // array and selects the first — routing one instance's model on another's adapter state. Reject
    // the ambiguous registry deterministically instead.
    this.byId = new Map();
    for (const inst of config.instances) {
      if (this.byId.has(inst.id)) {
        throw new RegistryConfigError(`duplicate instance id '${inst.id}' in the registry`);
      }
      this.byId.set(inst.id, inst);
    }
  }

  /**
   * Map a role to a {@link ModelSelection}. A pinned role uses its instance; an unpinned role takes
   * the first instance in **config order** whose `serves` includes the tier (deterministic, so the
   * same registry always yields the same selection). Throws rather than silently defaulting.
   */
  resolve(role: string): ModelSelection {
    const entry = this.config.roster[role];
    if (!entry) throw new UnknownRoleError(role);

    if (entry.instance !== undefined) {
      const inst = this.byId.get(entry.instance);
      if (!inst) {
        throw new RegistryConfigError(
          `role '${role}' pins instance '${entry.instance}', which is not in the registry`,
        );
      }
      const served = inst.serves.find((s) => s.tier === entry.tier);
      if (!served) throw new NoInstanceForTierError(role, entry.tier);
      return { instanceId: inst.id, tier: entry.tier, model: served.model };
    }

    // Unpinned: first instance in config order serving the tier (host/cwd locality is the documented
    // tie-breaker; config order already yields a unique first, so it is decisive here).
    for (const inst of this.config.instances) {
      const served = inst.serves.find((s) => s.tier === entry.tier);
      if (served) return { instanceId: inst.id, tier: entry.tier, model: served.model };
    }
    throw new NoInstanceForTierError(role, entry.tier);
  }

  /** A leak-free label for a resolved selection — used in the trace (never the vendor model string). */
  labelFor(selection: ModelSelection): string {
    const driver = this.byId.get(selection.instanceId)?.driver ?? "unknown";
    return tierLabelFor(selection.tier, driver);
  }

  /**
   * Enforce reviewer independence (SPEC-005): `reviewer-a` and `reviewer-b` must resolve to distinct
   * model strings. Compares model strings (not family names, which are not machine-readable). A
   * registry missing either reviewer is left to role-level resolution to surface; only a genuine
   * same-model collision is rejected here. Throws {@link RegistryConfigError} on collision.
   */
  assertReviewersDistinct(): void {
    const a = this.config.roster[REVIEWER_A];
    const b = this.config.roster[REVIEWER_B];
    if (!a || !b) return; // not a two-reviewer roster; nothing to enforce
    const sa = this.resolve(REVIEWER_A);
    const sb = this.resolve(REVIEWER_B);
    if (sa.model === sb.model) {
      throw new RegistryConfigError(
        `reviewer-a and reviewer-b resolve to the same model — review independence requires distinct models`,
      );
    }
  }

  /**
   * Validate configured `serves` against each instance's live catalog (SPEC-005). `catalogs` maps an
   * instance id to its `listModels()` result, or `null`/absent when the backend exposes no catalog
   * (capability `models` absent) — those instances are skipped and recorded as `catalogUnavailable`,
   * never failed. Any configured model absent from a present catalog is a problem and blocks routing
   * for that `${instanceId}::${tier}` until corrected.
   */
  validateServesAgainstCatalog(
    catalogs: ReadonlyMap<string, ModelInfo[] | null | undefined>,
  ): CatalogValidationResult {
    const problems: CatalogValidationProblem[] = [];
    const catalogUnavailable: string[] = [];
    const blocked = new Set<string>();
    for (const inst of this.config.instances) {
      const catalog = catalogs.get(inst.id);
      if (catalog === null || catalog === undefined) {
        catalogUnavailable.push(inst.id);
        continue;
      }
      for (const s of inst.serves) {
        if (!modelMatchesCatalog(s.model, catalog)) {
          problems.push({ instanceId: inst.id, tier: s.tier, label: tierLabelFor(s.tier, inst.driver) });
          blocked.add(blockKey(inst.id, s.tier));
        }
      }
    }
    return { ok: problems.length === 0, problems, catalogUnavailable, blocked };
  }

  /** Client-safe projection: ids, drivers, hosts, tier labels. No credentials, no model strings. */
  listInstances(): InstanceProjection[] {
    return this.config.instances.map((inst) => ({
      id: inst.id,
      driver: inst.driver,
      host: inst.host,
      serves: inst.serves.map((s) => ({ tier: s.tier, label: tierLabelFor(s.tier, inst.driver) })),
    }));
  }

  /**
   * The default tier → label resolution for the UI (SPEC-005): for each tier any instance serves,
   * the label of the first instance (config order) serving it. Labels only — no model string.
   */
  tierResolution(): { tier: ModelTier; label: string }[] {
    const seen = new Map<ModelTier, string>();
    for (const inst of this.config.instances) {
      for (const s of inst.serves) {
        if (!seen.has(s.tier)) seen.set(s.tier, tierLabelFor(s.tier, inst.driver));
      }
    }
    return [...seen].map(([tier, label]) => ({ tier, label }));
  }

  /**
   * Resolve every roster role for the harnesses screen's roster table (SPEC-005). A role whose tier
   * no instance serves is returned `unresolved` rather than throwing. No model string is included.
   */
  rosterResolution(): RosterResolution[] {
    return Object.keys(this.config.roster).map((role) => {
      try {
        const sel = this.resolve(role);
        return { role, instanceId: sel.instanceId, tier: sel.tier, label: this.labelFor(sel) };
      } catch {
        return { role, unresolved: true };
      }
    });
  }

  /** The roster binding for a role (its tier + optional instance pin), or undefined if absent. */
  roleEntry(role: string): RosterEntry | undefined {
    return this.config.roster[role];
  }

  /** The instance config for an id (host-side use only — carries the credentialsRef and models). */
  instance(id: string): InstanceConfig | undefined {
    return this.byId.get(id);
  }

  /** Every configured instance, in config order (host-side use only). */
  instances(): readonly InstanceConfig[] {
    return this.config.instances;
  }
}

/** The block-set key for one `(instance, tier)` routing slot. */
export function blockKey(instanceId: string, tier: ModelTier): string {
  return `${instanceId}::${tier}`;
}
