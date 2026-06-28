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
    const script: DomainEvent[] = [
      { ...base, type: "spec.status", specId: "SPEC-016", status: "draft" },
      { ...base, type: "session.status", sessionId: "SPEC-016", specId: "SPEC-016", kind: "spec", status: "running", model: "capable" },
      { ...base, type: "spec.status", specId: "SPEC-014", status: "in-review" },
      { ...base, type: "session.status", sessionId: "T-3", specId: "SPEC-014", kind: "task", status: "running", model: "mid" },
      { ...base, type: "permission.asked", sessionId: "T-5", permissionId: "p1", title: "Write migration file" },
    ];
    for (const ev of script) {
      if (signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 800));
      yield { ...ev, ts: Date.now() };
    }
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
