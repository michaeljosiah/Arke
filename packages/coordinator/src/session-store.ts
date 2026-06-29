import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRecord, SessionStore } from "@arke/adapter-opencode";

/**
 * The durable session ownership store (SPEC-003, D7; closes SPEC-002's durability question).
 *
 * Maps `sessionId → ownership` and is the single source of truth for spec/task ownership
 * across coordinator restarts. It is a co-located append-only NDJSON file — no database —
 * read on startup before any event is processed. It implements the adapter's `SessionStore`
 * port (`load`/`upsert`/`get`/`all`), so SPEC-002's adapter writes *through* this store rather
 * than keeping its own; the coordinator-only superset (`harness`, `createdAt`) is added here.
 */
export interface OwnershipRecord extends SessionRecord {
  harness: string;
  createdAt: number; // epoch ms — creation time, preserved across updates
}

export class CoordinatorSessionStore implements SessionStore {
  private readonly path: string;
  private readonly harness: string;
  private readonly map = new Map<string, OwnershipRecord>();

  constructor(path: string, harness: string) {
    this.path = path;
    this.harness = harness;
  }

  /** Read the NDJSON log into the in-memory map (last-write-wins). Call on startup. */
  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return; // no file yet — a crash before the first write yields an empty map, not an error
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as OwnershipRecord;
        if (rec.sessionId) this.map.set(rec.sessionId, rec);
      } catch {
        // skip a corrupt line rather than failing recovery
      }
    }
  }

  /** Adapter port: record ownership, enriching with harness + creation time, durably. */
  upsert(record: SessionRecord): void {
    const createdAt = this.map.get(record.sessionId)?.createdAt ?? Date.now();
    this.write({ ...record, harness: this.harness, createdAt });
  }

  /** Persist a full ownership record (append + in-memory), synchronous with creation. */
  write(record: OwnershipRecord): void {
    this.map.set(record.sessionId, record);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
  }

  get(sessionId: string): OwnershipRecord | undefined {
    return this.map.get(sessionId);
  }

  all(): OwnershipRecord[] {
    return [...this.map.values()];
  }

  /** All ownership records currently known (coordinator-side view). */
  loadAll(): OwnershipRecord[] {
    return this.all();
  }
}
