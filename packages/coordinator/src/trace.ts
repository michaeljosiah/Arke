import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only local trace — the persisted audit source of truth (NFR-7, D13; promoted to an
 * observability layer in SPEC-015).
 *
 * Every normalized domain event, governed decision, and (SPEC-015) completed span is written here as
 * one NDJSON line. All appends are serialised through a {@link WriteQueue} so concurrent writers never
 * interleave a partial line, and every record carries a file-level monotonic `seq` (resumed from the
 * tail on restart) so records order unambiguously. `query()` filters by spec across the three places a
 * specId can live. OTLP export (Jaeger/Tempo/Honeycomb) is a secondary, best-effort path layered on top;
 * this file is the durability guarantee.
 */

/** Serialises appendFile calls into a single chain so lines are never interleaved; drains on shutdown. */
export class WriteQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task); // run regardless of a prior task's outcome
    this.chain = run.catch(() => {}); // a failed write must not poison the chain
    return run;
  }

  /** Wait for all currently-enqueued writes to complete (call on coordinator shutdown). */
  drain(): Promise<void> {
    return this.chain;
  }
}

export interface TraceRecord {
  at: number;
  seq: number;
  kind: string;
  [k: string]: unknown;
}

/** Span attribute allowlist (SPEC-015) — anything else is dropped before a span is persisted. */
const SPAN_ATTR_ALLOWLIST = ["arke.specId", "arke.sessionId", "arke.harness", "arke.operation", "arke.target", "http.status_code", "error.type", "error.message"] as const;

/** Apply the allowlist + truncate error.message to 256 chars (no spec content / secrets leak). */
export function sanitizeSpanAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SPAN_ATTR_ALLOWLIST) {
    if (attrs[k] === undefined) continue;
    out[k] = k === "error.message" ? String(attrs[k]).slice(0, 256) : attrs[k];
  }
  return out;
}

export class Trace {
  private readonly path: string;
  private readonly queue = new WriteQueue();
  private seq = 0;
  private seqLoaded = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Lazily resume the monotonic seq from the tail of the existing file (restart resilience). */
  private async ensureSeq(): Promise<void> {
    if (this.seqLoaded) return;
    this.seqLoaded = true;
    try {
      const raw = await readFile(this.path, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const s = (JSON.parse(t) as { seq?: number }).seq;
          if (typeof s === "number" && s > this.seq) this.seq = s;
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* no file yet, or unreadable → start a new trace from seq 0 (do not crash) */
    }
  }

  private enqueueWrite(record: Record<string, unknown>, throwOnFail: boolean): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.ensureSeq();
      const line = JSON.stringify({ at: Date.now(), seq: ++this.seq, ...record }) + "\n";
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      } catch (err) {
        this.seq--; // the write didn't land — don't burn the sequence number
        if (throwOnFail) throw err; // fail-safe callers MUST learn the audit record didn't persist
        /* else degraded audit, never a crash (SPEC-015) */
      }
    });
  }

  /**
   * Append a record (best-effort): assigns a file-level monotonic `seq`, serialised through the queue.
   * NEVER rejects — an unwritable trace degrades audit but does not crash the hot pump, and a
   * fire-and-forget `void trace.write(...)` can't raise an unhandled rejection.
   */
  async write(record: Record<string, unknown>): Promise<void> {
    return this.enqueueWrite(record, false);
  }

  /**
   * Append a record, REJECTING if it can't be persisted. The trace-before-action fail-safe
   * (SPEC-006/012/013): a governed action that must not proceed without a durable audit record awaits
   * this and aborts on rejection. The queue chain is not poisoned by the rejection.
   */
  async writeOrThrow(record: Record<string, unknown>): Promise<void> {
    return this.enqueueWrite(record, true);
  }

  /** Wait for all enqueued writes to land (shutdown). */
  drain(): Promise<void> {
    return this.queue.drain();
  }

  async readAll(): Promise<TraceRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const out: TraceRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TraceRecord);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  /**
   * The audit query (SPEC-015): records for a spec, matched at any of the three places a specId can
   * live — the top-level field, a wrapped `event.specId`, or a span's `attributes["arke.specId"]`.
   * `since` excludes older records; results are capped (most-recent-first when capped) and `total` is
   * the full match count so the client can show a truncation hint.
   */
  async query(specId: string, since = 0, limit = 500): Promise<{ records: TraceRecord[]; total: number }> {
    const all = await this.readAll();
    const matched = all.filter((r) => {
      if (since && typeof r.at === "number" && r.at < since) return false;
      const ev = r.event as { specId?: string } | undefined;
      const attrs = r.attributes as Record<string, unknown> | undefined;
      return r.specId === specId || ev?.specId === specId || attrs?.["arke.specId"] === specId;
    });
    // Always newest-first (consistent whether or not the cap bites — the surface/CLI promise this).
    const newestFirst = matched.slice().reverse();
    return { records: newestFirst.slice(0, limit), total: matched.length };
  }
}
