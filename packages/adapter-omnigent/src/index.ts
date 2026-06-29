import { randomUUID } from "node:crypto";
import {
  type Capability,
  type CreateSessionInput,
  DomainEvent,
  type HarnessAdapter,
  type PermissionAck,
  type PermissionDecision,
  type Readiness,
  type SendMessageInput,
  type SendReceipt,
  type SessionRef,
} from "@arke/contracts";
import { OMNIGENT_CAPABILITIES } from "./capabilities.js";
import { type OmnigentConfig } from "./config.js";
import { OmnigentHttp } from "./http.js";
import { parseOmnigentSse } from "./sse.js";
import { SessionGraph } from "./session-graph.js";
import { createNormalizeState, normalize, type NormalizeState } from "./normalize.js";

export * from "./config.js";
export * from "./capabilities.js";
export { OmnigentError } from "./http.js";
export { normalize, createNormalizeState, type NormalizeState } from "./normalize.js";
export { SessionGraph, type SessionIdentity } from "./session-graph.js";

/**
 * A multi-producer / single-consumer channel: each per-session SSE pump pushes normalised events;
 * the adapter's single `streamEvents()` drains them. Omnigent streams are per-session, so the
 * adapter fans many session streams into this one channel (ADR-0002: "the adapter fans in").
 */
class EventChannel {
  private queue: DomainEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(ev: DomainEvent): void {
    if (this.closed) return;
    this.queue.push(ev);
    this.wake?.();
    this.wake = null;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *drain(signal?: AbortSignal): AsyncGenerator<DomainEvent> {
    while (true) {
      if (signal?.aborted) return;
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((res) => {
        this.wake = res;
        signal?.addEventListener("abort", () => res(), { once: true });
      });
    }
  }
}

/**
 * Omnigent v1 HTTP adapter (ADR-0002 spike). Maps Arke's {@link HarnessAdapter} onto Omnigent — the
 * meta-harness substrate one level up from OpenCode:
 * - createSession → `POST /v1/sessions`
 * - send a turn  → `POST /v1/sessions/{id}/events` `{type:"message", …}` (there is no `/prompt`)
 * - events       → `GET /v1/sessions/{id}/stream` (per-session SSE), fanned into one channel
 * - approvals    → elicitations: `POST /v1/sessions/{id}/elicitations/{id}/resolve`
 *
 * Spike limitations (recorded for ADR-0002): correlation is best-effort (Omnigent's `/events` does
 * not echo a client message id, so a generated correlationId won't match stream item ids); and the
 * elicitation resolve is acknowledged by HTTP 202, not yet confirmed by a reply event the way the
 * OpenCode adapter confirms permissions.
 */
export class OmnigentAdapter implements HarnessAdapter {
  readonly id = "Omnigent";
  private readonly http: OmnigentHttp;
  private readonly graph = new SessionGraph();
  private readonly normState: NormalizeState = createNormalizeState();
  private readonly channel = new EventChannel();
  private readonly streams = new Map<string, AbortController>();
  /** permissionId → sessionId, recorded as elicitations stream in so a decision can be routed back. */
  private readonly permSession = new Map<string, string>();
  private ready = false;

  constructor(private readonly config: OmnigentConfig) {
    this.http = new OmnigentHttp(config);
  }

  capabilities(): ReadonlySet<Capability> {
    return OMNIGENT_CAPABILITIES;
  }

  /** Probe the server (a cheap authenticated list) to confirm reachability + auth. */
  async init(): Promise<void> {
    try {
      await this.http.req("GET", "/v1/sessions?limit=1");
      this.ready = true;
    } catch (err) {
      this.ready = false;
      throw err;
    }
  }

  readiness(): Readiness {
    return this.ready ? { ready: true } : { ready: false, reason: "Omnigent server not reachable" };
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    // Live-confirmed (ADR-0002 spike): POST /v1/sessions REQUIRES agent_id (the Agent Image to run);
    // the recon's "optional" reading was wrong — the server returns 422 without it.
    if (!this.config.agentId) {
      throw new Error(
        "OmnigentConfig.agentId is required — Omnigent's POST /v1/sessions mandates agent_id (the Agent Image to run)",
      );
    }
    const body = {
      agent_id: this.config.agentId,
      title: input.specId, // the title encodes the spec id (mirrors the OpenCode adapter)
    };
    // The 201 body returns the session/conversation id under `id` (a `conv_…`); accept `session_id` too.
    const res = await this.http.req<{ session_id?: string; id?: string }>("POST", "/v1/sessions", body);
    const sessionId = res.session_id ?? res.id;
    if (!sessionId) throw new Error("Omnigent createSession returned no session id");
    this.graph.record(sessionId, { specId: input.specId, kind: input.parent ? "task" : "spec" });
    this.openStream(sessionId);
    return { sessionId };
  }

  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    return this.postMessage(input);
  }

  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    // Omnigent's /events is already fire-and-queue (202 Accepted), so send and dispatch share a path.
    return this.postMessage(input);
  }

  private async postMessage(input: SendMessageInput): Promise<SendReceipt> {
    if (!this.streams.has(input.sessionId)) {
      if (!this.graph.get(input.sessionId)) {
        this.graph.record(input.sessionId, { specId: input.sessionId, kind: "spec" });
      }
      this.openStream(input.sessionId);
    }
    const override = this.config.modelForTier?.(input.tier);
    const body = {
      type: "message",
      ...(override ? { model_override: override } : {}),
      data: {
        role: "user",
        content: input.parts.map((p) => ({ type: "input_text", text: p.text })),
      },
    };
    // Live-confirmed (ADR-0002 spike): this body shape is accepted. A turn only EXECUTES once a
    // runner/host is bound to the session (`omnigent host`); against a control-plane-only `omnigent
    // server`, /events returns 503 `runner_unavailable` — the server/runner split, the same shape
    // Arke's own coordinator/runner model takes (SPEC-018).
    const res = await this.http.req<{ queued?: boolean; pending_id?: string }>(
      "POST",
      `/v1/sessions/${input.sessionId}/events`,
      body,
    );
    // Best-effort correlation: Omnigent doesn't echo a client message id (ADR-0002 gap).
    const correlationId = input.correlationId ?? res.pending_id ?? `msg_${randomUUID()}`;
    return { sessionId: input.sessionId, correlationId };
  }

  streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    return this.channel.drain(signal);
  }

  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    const sessionId = this.permSession.get(decision.permissionId);
    if (!sessionId) return { permissionId: decision.permissionId, status: "stale" };
    const action = decision.decision === "reject" ? "decline" : "accept"; // once/always → accept
    await this.http.req(
      "POST",
      `/v1/sessions/${sessionId}/elicitations/${decision.permissionId}/resolve`,
      { action, ...(decision.message ? { content: { message: decision.message } } : {}) },
    );
    // Spike: 202 is the only signal — no reply event to confirm against (unlike the OpenCode adapter).
    return { permissionId: decision.permissionId, status: "confirmed" };
  }

  /** Stop all per-session pumps and close the channel. */
  async stopServer(): Promise<void> {
    for (const ctrl of this.streams.values()) ctrl.abort();
    this.streams.clear();
    this.channel.close();
  }

  private openStream(sessionId: string): void {
    if (this.streams.has(sessionId)) return;
    const ctrl = new AbortController();
    this.streams.set(sessionId, ctrl);
    void this.pump(sessionId, ctrl.signal);
  }

  private async pump(sessionId: string, signal: AbortSignal): Promise<void> {
    const identity = this.graph.get(sessionId) ?? { specId: sessionId, kind: "spec" as const };
    try {
      const body = await this.http.openStream(`/v1/sessions/${sessionId}/stream`, signal);
      for await (const frame of parseOmnigentSse(body, signal)) {
        for (const ev of normalize(frame, sessionId, identity, this.id, this.normState)) {
          const parsed = DomainEvent.safeParse(ev);
          if (!parsed.success) continue; // boundary validation; spike drops invalid frames
          if (parsed.data.type === "permission.asked") {
            this.permSession.set(parsed.data.permissionId, sessionId);
          }
          this.channel.push(parsed.data);
        }
      }
    } catch {
      /* stream ended or aborted — the spike does not reconnect (the live run drives a single turn) */
    } finally {
      this.streams.delete(sessionId);
    }
  }
}
