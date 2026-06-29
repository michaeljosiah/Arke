import type { SessionKind } from "@arke/contracts";

/**
 * Maps an Omnigent session id to its Arke identity (spec/task). Omnigent's parent/child session
 * graph is the analog of our spec/task graph: a top-level session is a `spec`, a sub-agent session
 * (discovered via `kind=sub_agent` or a `session.created` frame carrying `child_conversation_id`)
 * is a `task`. The adapter records the identity at create time and on child-creation frames so the
 * normaliser can attach `specId`/`kind` to every emitted event (the conformance the ADR cares about).
 */
export interface SessionIdentity {
  specId: string;
  kind: SessionKind;
}

export class SessionGraph {
  private readonly byId = new Map<string, SessionIdentity>();

  record(sessionId: string, identity: SessionIdentity): void {
    this.byId.set(sessionId, identity);
  }

  get(sessionId: string): SessionIdentity | undefined {
    return this.byId.get(sessionId);
  }
}
