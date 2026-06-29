import type {
  Capability,
  DomainEvent,
  HarnessAdapter,
  Readiness,
  SendReceipt,
  SessionRef,
} from "@arke/contracts";

/**
 * The honest "no harness" adapter — the real-mode default when none is configured or one failed
 * to start. Unlike {@link MockAdapter} it fabricates **nothing**: it streams no events, reports
 * `readiness.ready === false`, and refuses session/message operations with the configured reason.
 *
 * This is what keeps the coordinator truthful by default: with no OpenCode (or other harness)
 * configured, the client sees a real empty project and the SPEC-004 reachability gate, never a
 * scripted demo. The MockAdapter is opt-in via `ARKE_MOCK=1`.
 */
export class NullAdapter implements HarnessAdapter {
  readonly id = "none";
  private readonly reason: string;

  constructor(reason = "no harness configured — set one in .arke/config.json (or ARKE_MOCK=1 for demo data)") {
    this.reason = reason;
  }

  capabilities(): ReadonlySet<Capability> {
    return new Set();
  }

  readiness(): Readiness {
    return { ready: false, reason: this.reason };
  }

  async createSession(): Promise<SessionRef> {
    throw new Error(this.reason);
  }

  async sendMessage(): Promise<SendReceipt> {
    throw new Error(this.reason);
  }

  async dispatchAsync(): Promise<SendReceipt> {
    throw new Error(this.reason);
  }

  // No events are ever produced — the stream ends immediately, so the pump idles with no data.
  async *streamEvents(): AsyncIterable<DomainEvent> {
    // intentionally empty
  }
}
