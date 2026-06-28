/**
 * Dead-letter containment (SPEC-002, D7). An event the adapter cannot map or validate is
 * excluded from the read model and the client — but never silently dropped. It is written
 * here with its raw payload, the reason, and a monotonic sequence, and counted, so the gap
 * is actionable rather than invisible. SPEC-015 canonicalises this as a trace record type;
 * this is the shape the adapter emits in the meantime.
 */
export interface DeadLetter {
  kind: "dead-letter";
  /** Why the event could not be mapped/validated. */
  reason: string;
  /** The raw provider payload, retained for diagnosis. */
  raw: unknown;
  /** Per-adapter monotonic counter value at the time of the drop. */
  seq: number;
  /** Epoch ms when dead-lettered (the coordinator may re-stamp on persist). */
  at: number;
}

export interface DeadLetterSink {
  write(record: DeadLetter): void | Promise<void>;
}

/** Collects dead letters in memory — used by tests and as a default. */
export class ArrayDeadLetterSink implements DeadLetterSink {
  readonly records: DeadLetter[] = [];
  write(record: DeadLetter): void {
    this.records.push(record);
  }
}
