import type { HarnessAdapter, ModelTier } from "@arke/contracts";
import {
  NoInstanceForTierError,
  RegistryResolver,
  blockKey,
  parseModel,
  type ModelSelection,
} from "./registry.js";

/**
 * Routes a role to the harness instance that serves the model it needs (SPEC-005). No caller names
 * a harness directly — routing is always a consequence of {@link RegistryResolver.resolve}. The
 * router also owns the runtime view the resolver (pure config) cannot: which instances are
 * reachable, which `(instance, tier)` slots are blocked by catalog validation, and which sessions
 * are in flight on each instance (so an instance loss marks them `interrupted` rather than silently
 * migrating them). Sessions from many instances aggregate on one board.
 */

/** The concrete model a single-tier `resolveModel` closure returns (matches the adapter shape). */
export interface ResolvedModelRef {
  provider: string;
  name: string;
}

/** A `resolveModel` closure was called for a tier other than the one its selection was made for. */
export class TierMismatchError extends Error {
  constructor(
    readonly expected: ModelTier,
    readonly actual: ModelTier,
  ) {
    super(`resolveModel closure is scoped to tier '${expected}' but was called for '${actual}'`);
    this.name = "TierMismatchError";
  }
}

/** A selection named an instance with no registered adapter (registry/runtime are out of sync). */
export class NoAdapterError extends Error {
  constructor(readonly instanceId: string) {
    super(`no adapter registered for instance '${instanceId}'`);
    this.name = "NoAdapterError";
  }
}

export interface RouteResult {
  adapter: HarnessAdapter;
  selection: ModelSelection;
  /** Single-tier closure for {@link HarnessAdapter} model resolution; throws on a tier mismatch. */
  resolveModel: (tier: ModelTier) => ResolvedModelRef;
}

/** Sink for the router's reachability + warning events (decoupled from the coordinator transport). */
export interface RouterEmitter {
  warn(reason: RegistryWarningReason, detail: string): void;
  reachability(instanceId: string, reachable: boolean, reason?: string): void;
  /**
   * One session was interrupted by an instance loss (SPEC-005, NFR-4). The integration layer turns
   * this into a `session.status` event with the `interrupted` status so the client can update the
   * affected card — the router never migrates the session itself.
   */
  sessionInterrupted(sessionId: string): void;
}

export type RegistryWarningReason =
  | "reviewer-models-identical"
  | "no-instance-for-tier"
  | "credential-missing"
  | "instance-failover"
  | "model-not-in-catalog";

/** What an instance loss did: which sessions were interrupted and where each tier failed over to. */
export interface FailoverSummary {
  interrupted: string[];
  fallbackByTier: Record<string, string | null>;
}

export class SessionRouter {
  private readonly unreachable = new Set<string>();
  private readonly blocked = new Set<string>(); // `${instanceId}::${tier}` from catalog validation
  private readonly sessionsByInstance = new Map<string, Set<string>>();
  private readonly interrupted = new Set<string>();

  constructor(
    private readonly resolver: RegistryResolver,
    private readonly adapters: ReadonlyMap<string, HarnessAdapter>,
    private readonly emit?: RouterEmitter,
  ) {}

  /**
   * Resolve a role to its adapter + selection. An unpinned role whose resolved instance is
   * unreachable or blocked fails over to the first available instance serving the tier; a pinned
   * role does not fail over (the pin is load-bearing — e.g. reviewer independence). Throws
   * {@link NoInstanceForTierError} when nothing available can serve the tier.
   */
  route(role: string): RouteResult {
    const selection = this.resolver.resolve(role);
    // The primary is routable (reachable + not catalog-blocked): it must have an adapter, else the
    // registry and the runtime adapter map are out of sync — a wiring bug worth surfacing distinctly.
    if (this.isRoutable(selection.instanceId, selection.tier)) {
      if (!this.adapters.has(selection.instanceId)) throw new NoAdapterError(selection.instanceId);
      return this.build(selection);
    }

    const pinned = this.resolver.roleEntry(role)?.instance !== undefined;
    if (pinned) throw new NoInstanceForTierError(role, selection.tier);

    const fallback = this.firstAvailableServing(selection.tier, selection.instanceId);
    if (!fallback) throw new NoInstanceForTierError(role, selection.tier);
    return this.build(fallback);
  }

  /** Record a created session against its instance so an instance loss can mark it interrupted. */
  trackSession(instanceId: string, sessionId: string): void {
    let set = this.sessionsByInstance.get(instanceId);
    if (!set) {
      set = new Set();
      this.sessionsByInstance.set(instanceId, set);
    }
    set.add(sessionId);
  }

  /** Drop a session from instance tracking once it has terminated normally. */
  releaseSession(instanceId: string, sessionId: string): void {
    this.sessionsByInstance.get(instanceId)?.delete(sessionId);
  }

  /** Sessions marked interrupted by an instance loss — surfaced to the client, never migrated. */
  interruptedSessions(): readonly string[] {
    return [...this.interrupted];
  }

  /** Apply the catalog-validation block set (SPEC-005): these `(instance, tier)` slots won't route. */
  setBlocked(blocked: Iterable<string>): void {
    this.blocked.clear();
    for (const k of blocked) this.blocked.add(k);
  }

  /**
   * Mark an instance unreachable after sessions may have started on it (SPEC-005, NFR-4). In-flight
   * sessions are marked `interrupted` (never migrated); new sessions for each tier it served fail
   * over to another reachable instance if one exists. Emits `harness.reachability` and a
   * `registry.warning` (`instance-failover` per recovered tier, `no-instance-for-tier` where none).
   */
  markInstanceUnreachable(instanceId: string): FailoverSummary {
    this.unreachable.add(instanceId);
    const lost = this.resolver.instance(instanceId);
    const interrupted: string[] = [];
    for (const sid of this.sessionsByInstance.get(instanceId) ?? []) {
      this.interrupted.add(sid);
      interrupted.push(sid);
      this.emit?.sessionInterrupted(sid); // → session.status 'interrupted' (never migrated)
    }
    this.emit?.reachability(instanceId, false, "instance became unreachable");

    const fallbackByTier: Record<string, string | null> = {};
    for (const served of lost?.serves ?? []) {
      const fallback = this.firstAvailableServing(served.tier, instanceId);
      fallbackByTier[served.tier] = fallback ? fallback.instanceId : null;
      if (fallback) {
        this.emit?.warn(
          "instance-failover",
          `instance '${instanceId}' lost; tier '${served.tier}' failing over to '${fallback.instanceId}'`,
        );
      } else {
        this.emit?.warn(
          "no-instance-for-tier",
          `instance '${instanceId}' lost; no fallback serves tier '${served.tier}'`,
        );
      }
    }
    return { interrupted, fallbackByTier };
  }

  // ---- internals -----------------------------------------------------------

  /** Reachable and not catalog-blocked for this tier (adapter presence is checked separately). */
  private isRoutable(instanceId: string, tier: ModelTier): boolean {
    return !this.unreachable.has(instanceId) && !this.blocked.has(blockKey(instanceId, tier));
  }

  /** First instance (config order) serving the tier that is routable AND has an adapter, skipping `exclude`. */
  private firstAvailableServing(tier: ModelTier, exclude?: string): ModelSelection | null {
    for (const inst of this.resolver.instances()) {
      if (inst.id === exclude) continue;
      const served = inst.serves.find((s) => s.tier === tier);
      if (served && this.isRoutable(inst.id, tier) && this.adapters.has(inst.id)) {
        return { instanceId: inst.id, tier, model: served.model };
      }
    }
    return null;
  }

  private build(selection: ModelSelection): RouteResult {
    const adapter = this.adapters.get(selection.instanceId);
    if (!adapter) throw new NoAdapterError(selection.instanceId);
    const resolveModel = (tier: ModelTier): ResolvedModelRef => {
      if (tier !== selection.tier) throw new TierMismatchError(selection.tier, tier);
      const { provider, name } = parseModel(selection.model);
      return { provider: provider ?? "gateway", name };
    };
    return { adapter, selection, resolveModel };
  }
}
