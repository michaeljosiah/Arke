import type {
  Capability,
  CreateSessionInput,
  DiffSummary,
  DomainEvent,
  HarnessAdapter,
  PermissionAck,
  PermissionDecision,
  Readiness,
  SendMessageInput,
  SendReceipt,
  SessionRef,
  TodoItem,
} from "@arke/contracts";

/**
 * A mock harness adapter so the coordinator runs end-to-end without a live OpenCode
 * server. It emits a scripted sequence of normalized domain events on a timer. Replace
 * with `@arke/adapter-opencode` once a harness host is available.
 */
export class MockAdapter implements HarnessAdapter {
  readonly id = "Mock";
  private caps = new Set<Capability>(["events", "todos", "diff", "permissions", "commands"]);

  capabilities(): ReadonlySet<Capability> {
    return this.caps;
  }

  readiness(): Readiness {
    return { ready: true };
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: `${input.specId}-s${Date.now() % 10000}` };
  }

  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: input.sessionId, correlationId: input.correlationId ?? "mock-corr" };
  }

  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    return {
      sessionId: `${input.sessionId}-child`,
      correlationId: input.correlationId ?? "mock-corr",
    };
  }

  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    // seq/ts are re-stamped by the coordinator; harness identifies the source.
    const base = { seq: 0, ts: 0, harness: this.id };

    // One-time board setup: the specs and their sessions.
    const setup: DomainEvent[] = [
      { ...base, type: "spec.status", specId: "SPEC-016", status: "draft" },
      { ...base, type: "session.status", sessionId: "SPEC-016", specId: "SPEC-016", kind: "spec", status: "running", model: "capable" },
      { ...base, type: "spec.status", specId: "SPEC-014", status: "in-review" },
      { ...base, type: "session.status", sessionId: "T-3", specId: "SPEC-014", kind: "task", status: "running", model: "mid" },
      { ...base, type: "session.status", sessionId: "T-5", specId: "SPEC-014", kind: "task", status: "running", model: "mid" },
    ];
    for (const ev of setup) {
      if (signal?.aborted) return;
      await this.wait(500, signal);
      yield { ...ev, ts: Date.now() };
    }

    // Then loop: each cycle streams a *distinct* assistant turn on T-3 (parts arrive out of
    // order to exercise partIndex ordering; message.updated closes it → the coordinator
    // emits turn.quiescent) and drives T-5 through a needs-human permission and back.
    // Distinct content per turn so the transcript reads like real, ongoing work.
    const TURNS: Array<[string, string, string]> = [
      ["Reading ", "the spec ", "and repo context."],
      ["Writing ", "migration ", "0042_add_idempotency_key.sql."],
      ["Guarding ", "handle_retry ", "on the idempotency key."],
      ["Running ", "typecheck ", "and the test suite."],
    ];
    let cycle = 0;
    while (!signal?.aborted) {
      const [a, b, c] = TURNS[cycle % TURNS.length]!;
      cycle += 1;
      const mid = `m${cycle}`;
      const full = a + b + c;
      // emit parts out of order (0, 2, 1) — the read model re-orders by partIndex
      const turn: DomainEvent[] = [
        { ...base, correlationId: mid, type: "message.part", sessionId: "T-3", messageId: mid, partIndex: 0, delta: a, role: "assistant", done: false },
        { ...base, correlationId: mid, type: "message.part", sessionId: "T-3", messageId: mid, partIndex: 2, delta: c, role: "assistant", done: true },
        { ...base, correlationId: mid, type: "message.part", sessionId: "T-3", messageId: mid, partIndex: 1, delta: b, role: "assistant", done: false },
        { ...base, correlationId: mid, type: "message.updated", sessionId: "T-3", messageId: mid, role: "assistant", text: full, toolCalls: [], isStreaming: false },
      ];
      for (const ev of turn) {
        if (signal?.aborted) return;
        await this.wait(800, signal);
        yield { ...ev, ts: Date.now() };
      }

      await this.wait(900, signal);
      if (signal?.aborted) return;
      yield { ...base, type: "permission.asked", sessionId: "T-5", permissionId: `p${cycle}`, title: "Write migration file", ts: Date.now() };
      await this.wait(2600, signal);
      if (signal?.aborted) return;
      yield { ...base, type: "permission.replied", sessionId: "T-5", permissionId: `p${cycle}`, granted: true, ts: Date.now() };
      await this.wait(1600, signal);
    }
  }

  /** Resolves after `ms`, or immediately when the stream is aborted. */
  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  async getTodos(_ref: SessionRef): Promise<TodoItem[]> {
    return [];
  }

  async getDiff(_ref: SessionRef): Promise<DiffSummary> {
    return { added: 0, removed: 0, files: 0 };
  }

  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    return { permissionId: decision.permissionId, status: "confirmed" };
  }
  async runCommand(): Promise<void> {}
}
