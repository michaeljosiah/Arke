import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionKind } from "@arke/contracts";

/**
 * The session ownership graph (SPEC-002): `sessionId → { kind, parentSessionId, spec_id }`.
 *
 * Events carry only a harness session id, so enrichment to the canonical identity
 * (`specId`, `kind`) needs this mapping. It is **durable** — a file-backed log so a
 * coordinator restart recovers ownership without re-deriving it from chance event order —
 * and the in-memory map is a cache over it, never the source of truth (D4).
 */
export interface SessionRecord {
  /** Harness session id (OpenCode `POST /session` id); the board card id. */
  sessionId: string;
  /** `spec` (a parent session) or `task` (a child session). */
  kind: SessionKind;
  /** Owning specification's frontmatter id. */
  specId: string;
  /** For a task, its parent (the spec session). */
  parentSessionId?: string;
}

export interface SessionStore {
  /** Load durable state into the in-memory cache. Call before first use. */
  load(): void;
  /** Record (or update) a session's identity, persisting it durably. */
  upsert(record: SessionRecord): void;
  get(sessionId: string): SessionRecord | undefined;
  all(): SessionRecord[];
}

/** Non-durable store for tests and ephemeral use. */
export class InMemorySessionStore implements SessionStore {
  protected readonly map = new Map<string, SessionRecord>();

  load(): void {
    /* nothing to load */
  }

  upsert(record: SessionRecord): void {
    this.map.set(record.sessionId, { ...record });
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.map.get(sessionId);
  }

  all(): SessionRecord[] {
    return [...this.map.values()];
  }
}

/**
 * File-backed durable store. Each {@link upsert} appends one NDJSON line; {@link load}
 * folds the log last-write-wins. Append-only keeps writes cheap and crash-safe; the file
 * lives with the coordinator's state (`settings.sessionStorePath` in `.arke/config.json`).
 */
export class FileSessionStore extends InMemorySessionStore {
  private readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
  }

  override load(): void {
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
        const rec = JSON.parse(trimmed) as SessionRecord;
        if (rec.sessionId) this.map.set(rec.sessionId, rec);
      } catch {
        // skip a corrupt line rather than failing recovery
      }
    }
  }

  override upsert(record: SessionRecord): void {
    super.upsert(record);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
  }
}
