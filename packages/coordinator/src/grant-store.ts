import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { RememberedGrant } from "@arke/contracts";

/**
 * Durable remembered-grant store (SPEC-016). An `always` decision persists a grant here; a
 * later permission request whose (session, action-class) key matches is auto-resolved without
 * prompting a human — and every such auto-grant is recorded in the trace by the coordinator.
 *
 * Append-only NDJSON co-located with the trace/session store: a grant line adds, a `{id,
 * revoked:true}` tombstone removes. Survives coordinator restarts; grants are revocable.
 */
interface RevokeRecord {
  id: string;
  revoked: true;
}

export class GrantStore {
  private readonly path: string;
  private readonly map = new Map<string, RememberedGrant>();

  constructor(path: string) {
    this.path = path;
  }

  /** Match key: session-scoped, falling back to a wildcard session for the same action class. */
  static key(sessionId: string | undefined, actionClass: string): string {
    return `${sessionId ?? "*"}::${actionClass}`;
  }

  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return; // no file yet
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as RememberedGrant | RevokeRecord;
        if ("revoked" in rec && rec.revoked) this.map.delete(rec.id);
        else if ((rec as RememberedGrant).id) this.map.set(rec.id, rec as RememberedGrant);
      } catch {
        // skip a corrupt line rather than failing recovery
      }
    }
  }

  /** Persist a new grant for `always`. Returns the stored record (with its id). */
  remember(input: { sessionId?: string; actionClass: string; createdBy: string }): RememberedGrant {
    const grant: RememberedGrant = {
      id: `grant_${randomUUID()}`,
      key: GrantStore.key(input.sessionId, input.actionClass),
      sessionId: input.sessionId,
      actionClass: input.actionClass,
      createdAt: Date.now(),
      createdBy: input.createdBy,
    };
    this.map.set(grant.id, grant);
    this.append(grant);
    return grant;
  }

  /** Find a non-revoked grant matching this request: exact session first, then wildcard. */
  findMatch(sessionId: string | undefined, actionClass: string): RememberedGrant | undefined {
    const exact = GrantStore.key(sessionId, actionClass);
    const wildcard = GrantStore.key(undefined, actionClass);
    for (const g of this.map.values()) {
      if (g.key === exact) return g;
    }
    for (const g of this.map.values()) {
      if (g.key === wildcard) return g;
    }
    return undefined;
  }

  revoke(id: string): void {
    if (!this.map.delete(id)) return;
    this.append({ id, revoked: true });
  }

  all(): RememberedGrant[] {
    return [...this.map.values()];
  }

  private append(record: RememberedGrant | RevokeRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
  }
}
