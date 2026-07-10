import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionKind } from "@arke/contracts";

/**
 * Maps an Omnigent session id to its Arke identity (spec/task). Omnigent's parent/child session graph is
 * the analog of our spec/task graph: a top-level session is a `spec`, a sub-agent session is a `task`. The
 * adapter records the identity at create time so the normaliser can attach `specId`/`kind` to every event.
 *
 * SPEC-037: the store is optionally **durable** — given a `persistPath`, each record is appended as an
 * NDJSON line and reloaded (last-write-wins) on construction, so an adapter/coordinator restart re-attaches
 * live sessions to their specs instead of losing the mapping (adopting the OpenCode `FileSessionStore`
 * pattern). Persistence is best-effort: a write failure never breaks the in-memory fast path.
 */
export interface SessionIdentity {
  specId: string;
  kind: SessionKind;
}

interface StoredRow {
  sessionId: string;
  specId: string;
  kind: SessionKind;
}

export class SessionGraph {
  private readonly byId = new Map<string, SessionIdentity>();

  constructor(private readonly persistPath?: string) {
    if (persistPath) this.load();
  }

  record(sessionId: string, identity: SessionIdentity): void {
    this.byId.set(sessionId, identity);
    this.persist(sessionId, identity);
  }

  get(sessionId: string): SessionIdentity | undefined {
    return this.byId.get(sessionId);
  }

  /** Every known session id (e.g. to re-attach streams after a restart). */
  ids(): string[] {
    return [...this.byId.keys()];
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const text = readFileSync(this.persistPath, "utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t) as StoredRow;
          if (row && typeof row.sessionId === "string") {
            this.byId.set(row.sessionId, { specId: row.specId, kind: row.kind }); // last write wins
          }
        } catch {
          /* skip a corrupt line — a partial append must not poison the whole store */
        }
      }
    } catch {
      /* unreadable store — start empty rather than crash the adapter */
    }
  }

  private persist(sessionId: string, identity: SessionIdentity): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      appendFileSync(this.persistPath, JSON.stringify({ sessionId, ...identity } satisfies StoredRow) + "\n", "utf8");
    } catch {
      /* best-effort durability — never break the live path on a disk error */
    }
  }
}
