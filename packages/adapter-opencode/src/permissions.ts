import type { PermissionAck, PermissionDecision, PermissionVerb } from "@arke/contracts";

/**
 * Relays a human's decision and confirms it the only honest way (SPEC-002, D3): by the
 * matching `permission.replied` event, never by HTTP status — the reply endpoint returns 200
 * even for stale ids (issue #15386). It defines what happens when confirmation does not arrive
 * (timeout → unconfirmed + re-fetch), refuses stale ids, is idempotent under duplicate
 * decisions, and reconciles in-flight decisions across a reconnect. The decision vocabulary is
 * `once | always | reject` (+ optional message) per SPEC-016; the adapter maps it onto the
 * server's reply shape.
 */

/** The minimal server surface the coordinator needs (stubbed in tests). */
export interface PermissionClient {
  /** POST the decision (verb + optional message). Confirmation is via the event, not status. */
  reply(permissionId: string, decision: PermissionVerb, message?: string): Promise<void>;
  /** Ids the server currently lists as pending (GET /permission/). */
  pending(): Promise<string[]>;
}

interface Waiter {
  resolve: (ack: PermissionAck) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionCoordinator {
  private readonly client: PermissionClient;
  private readonly timeoutMs: number;
  /** Ids confirmed by a `permission.replied` event. */
  private readonly confirmed = new Set<string>();
  /** Decisions awaiting their confirming event. */
  private readonly waiters = new Map<string, Waiter>();
  /** In-flight decide() calls, so a duplicate submission rides the same promise. */
  private readonly inflight = new Map<string, Promise<PermissionAck>>();

  constructor(client: PermissionClient, timeoutMs: number) {
    this.client = client;
    this.timeoutMs = timeoutMs;
  }

  /** Called by the event loop when a `permission.replied` arrives — confirms the decision. */
  onReplied(permissionId: string): void {
    this.confirmed.add(permissionId);
    const w = this.waiters.get(permissionId);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(permissionId);
      w.resolve({ permissionId, status: "confirmed" });
    }
  }

  async decide(decision: PermissionDecision): Promise<PermissionAck> {
    const id = decision.permissionId;
    // Idempotent: a decision already confirmed is a no-op second time.
    if (this.confirmed.has(id)) return { permissionId: id, status: "duplicate" };
    // Idempotent: a concurrent duplicate rides the same in-flight promise.
    const existing = this.inflight.get(id);
    if (existing) return existing;

    const run = this.run(decision);
    this.inflight.set(id, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(id);
    }
  }

  private async run(decision: PermissionDecision): Promise<PermissionAck> {
    const id = decision.permissionId;

    // Stale pre-check: a decision for an id the server no longer lists as pending is stale.
    const before = await this.client.pending().catch(() => null);
    if (before && !before.includes(id) && !this.confirmed.has(id)) {
      return { permissionId: id, status: "stale" };
    }

    await this.client.reply(id, decision.decision, decision.message);

    return await new Promise<PermissionAck>((resolve) => {
      // The confirming event may have raced ahead of the reply round-trip.
      if (this.confirmed.has(id)) {
        resolve({ permissionId: id, status: "confirmed" });
        return;
      }
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        // Re-fetch pending state, then surface "could not confirm — retry".
        void this.client.pending().catch(() => null);
        resolve({ permissionId: id, status: "unconfirmed" });
      }, this.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.waiters.set(id, { resolve, timer });
    });
  }

  /**
   * On reconnect, reconcile decisions still awaiting confirmation: any whose id the server no
   * longer lists as pending (and which never produced a reply event) is resolved unconfirmed
   * rather than left hung.
   */
  async reconcile(): Promise<void> {
    if (this.waiters.size === 0) return;
    const pendingIds = await this.client.pending().catch(() => null);
    if (!pendingIds) return;
    for (const [id, w] of [...this.waiters]) {
      if (!pendingIds.includes(id) && !this.confirmed.has(id)) {
        clearTimeout(w.timer);
        this.waiters.delete(id);
        w.resolve({ permissionId: id, status: "unconfirmed" });
      }
    }
  }
}
