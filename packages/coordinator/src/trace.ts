import { appendFile, mkdir } from "node:fs/promises";
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
}
