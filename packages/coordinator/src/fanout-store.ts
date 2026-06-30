import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FanOutRecord } from "./fanout.js";

/**
 * Durable fan-out record store (SPEC-009). One record per spec tracks which task indices have been
 * dispatched and their outcome, so a coordinator restart mid-fan-out does not re-dispatch
 * already-running tasks. Append-only NDJSON, last-write-wins per specId — co-located with the
 * project's trace/session/grant stores under `.arke/`.
 */
export class FanOutStore {
  private readonly path: string;
  private readonly map = new Map<string, FanOutRecord>();

  constructor(path: string) {
    this.path = path;
  }

  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return; // no file yet
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as FanOutRecord;
        if (rec?.specId) this.map.set(rec.specId, rec);
      } catch {
        /* skip malformed */
      }
    }
  }

  get(specId: string): FanOutRecord | undefined {
    return this.map.get(specId);
  }

  /** Persist (append + cache) the current record for a spec. */
  put(record: FanOutRecord): void {
    this.map.set(record.specId, record);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
    } catch {
      /* best-effort durability; the in-memory cache still guards within this process */
    }
  }

  /** Task indices already present for a spec (dispatched on a prior run) — the idempotency guard. */
  dispatchedIndices(specId: string): Set<number> {
    const rec = this.map.get(specId);
    return new Set((rec?.tasks ?? []).filter((t) => t.status !== "queued").map((t) => t.taskIndex));
  }
}
