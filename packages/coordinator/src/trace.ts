import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only local trace — the persisted audit source of truth (NFR-7, D13).
 *
 * Every normalized domain event and governed decision is written here as one NDJSON
 * line. This is the durable record of what every agent did, including approvals and
 * projections, and is exportable over OTLP to a standard backend. The skeleton writes
 * NDJSON; OTLP export is a later addition.
 */
export class Trace {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async write(record: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify({ at: Date.now(), ...record }) + "\n", "utf8");
  }

  /**
   * Read every trace record (best-effort): skips malformed lines, returns `[]` when the file is
   * absent. The single reader of the trace, so callers never re-derive or hardcode the path/format.
   */
  async readAll(): Promise<Record<string, unknown>[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const out: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* skip malformed trace lines */
      }
    }
    return out;
  }
}
