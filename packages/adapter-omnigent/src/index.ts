import { randomUUID } from "node:crypto";
import {
  type AgentModel,
  type Capability,
  type CreateSessionInput,
  DomainEvent,
  type HarnessAdapter,
  type PermissionAck,
  type PermissionAckStatus,
  type PermissionDecision,
  type Readiness,
  type SendMessageInput,
  type SendReceipt,
  type SessionRef,
} from "@arke/contracts";
import { OMNIGENT_CAPABILITIES } from "./capabilities.js";
import { type OmnigentConfig, OMNIGENT_TARGET_VERSION, isCompatibleOmnigentVersion, DEFAULT_RECONNECT } from "./config.js";
import { OmnigentHttp } from "./http.js";
import { parseOmnigentSse } from "./sse.js";
import { SessionGraph } from "./session-graph.js";
import { createNormalizeState, normalize, isRecognizedFrameType, type NormalizeState } from "./normalize.js";

export * from "./config.js";
export * from "./capabilities.js";
export { OmnigentError } from "./http.js";
export { normalize, createNormalizeState, isRecognizedFrameType, IGNORED_FRAME_TYPES, MAPPED_FRAME_TYPES, type NormalizeState } from "./normalize.js";
export { SessionGraph, type SessionIdentity } from "./session-graph.js";

/** Default bounded wait (ms) for an event to confirm a permission decision / a turn's quiescence. */
const CONFIRM_TIMEOUT_MS = 30_000;
/** Cap on retained dead-letter records (diagnostic ring; oldest dropped). */
const DEAD_LETTER_CAP = 200;

/** The HTTP surface the adapter needs — injectable so a fake transport can drive the pump in tests (SPEC-037). */
export interface OmnigentTransport {
  req<T>(method: string, path: string, body?: unknown): Promise<T>;
  openStream(path: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/**
 * A multi-producer / single-consumer channel: each per-session SSE pump pushes normalised events;
 * the adapter's single `streamEvents()` drains them. Omnigent streams are per-session, so the
 * adapter fans many session streams into this one channel.
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

/** A frame the normalizer could not map and that is not a known-ignored control frame (SPEC-037). */
export interface DeadLetter {
  type: string | undefined;
  sessionId: string;
  /** Bounded snapshot of the frame for diagnosis (not the whole payload). */
  snapshot: string;
  reason: string;
}

/** Records unmapped frames + `response.error` detail so nothing is silently swallowed (SPEC-015/037). */
export class DeadLetterSink {
  private readonly ring: DeadLetter[] = [];
  constructor(private readonly onRecord?: (d: DeadLetter) => void) {}
  record(sessionId: string, frame: unknown, reason: string): void {
    const type = (frame as { type?: string } | null)?.type;
    let snapshot = "";
    try {
      snapshot = JSON.stringify(frame).slice(0, 500);
    } catch {
      snapshot = "[unserialisable frame]";
    }
    const d: DeadLetter = { type, sessionId, snapshot, reason };
    this.ring.push(d);
    if (this.ring.length > DEAD_LETTER_CAP) this.ring.shift();
    this.onRecord?.(d);
  }
  /** The retained dead-letter records (diagnostic; newest last). */
  entries(): readonly DeadLetter[] {
    return this.ring;
  }
}

/**
 * Confirm a permission decision by an EVENT, not the HTTP 202 (SPEC-037 Requirement 3; SPEC-002 — only
 * events are authoritative). `decide()` registers a waiter and posts nothing itself; the caller posts the
 * resolve, then awaits the returned promise. The pump calls `confirm()` when the stream reflects the
 * elicitation resolved. Dispositions mirror the OpenCode adapter: `confirmed` (event arrived),
 * `unconfirmed` (bounded timeout), `stale` (unknown id), `duplicate` (a decision already in flight).
 */
export class PermissionCoordinator {
  private readonly waiters = new Map<string, { resolve: (s: PermissionAckStatus) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly timeoutMs = CONFIRM_TIMEOUT_MS) {}

  /** Register a waiter for `permissionId`; resolves `confirmed` on `confirm()`, else `unconfirmed` on timeout. */
  decide(permissionId: string): Promise<PermissionAckStatus> {
    if (this.waiters.has(permissionId)) return Promise.resolve("duplicate");
    return new Promise<PermissionAckStatus>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(permissionId);
        resolve("unconfirmed");
      }, this.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.waiters.set(permissionId, { resolve, timer });
    });
  }

  /** The stream reflected the resolution — settle the waiter `confirmed`. A late confirm is a safe no-op. */
  confirm(permissionId: string): void {
    const w = this.waiters.get(permissionId);
    if (!w) return; // arrived after the timeout / for an id we're not waiting on — reconciled, never throws
    clearTimeout(w.timer);
    this.waiters.delete(permissionId);
    w.resolve("confirmed");
  }

  /** True while a decision for this id is in flight (used to answer `duplicate`). */
  pending(permissionId: string): boolean {
    return this.waiters.has(permissionId);
  }
}

/** Per-session waiters that resolve when a turn reaches quiescence (`session.status: idle`), so a
 *  synchronous `sendMessage()` can await completion (SPEC-037 Requirement — completion-aware send). */
export class TurnWaiters {
  private readonly bySession = new Map<string, Array<() => void>>();
  wait(sessionId: string, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.remove(sessionId, done);
        resolve();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const list = this.bySession.get(sessionId) ?? [];
      list.push(done);
      this.bySession.set(sessionId, list);
    });
  }
  /** A turn reached quiescence for this session — settle all its waiters. */
  quiesce(sessionId: string): void {
    const list = this.bySession.get(sessionId);
    if (!list) return;
    this.bySession.delete(sessionId);
    for (const done of list) done();
  }
  private remove(sessionId: string, done: () => void): void {
    const list = this.bySession.get(sessionId);
    if (!list) return;
    const i = list.indexOf(done);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.bySession.delete(sessionId);
  }
}

/**
 * Omnigent v1 HTTP adapter (SPEC-037 — production substrate). Maps Arke's {@link HarnessAdapter} onto
 * Omnigent, the meta-harness one level up from OpenCode: createSession → `POST /v1/sessions`; a turn →
 * `POST /v1/sessions/{id}/events`; events → `GET /v1/sessions/{id}/stream` (per-session SSE, fanned into
 * one channel); approvals → elicitations `POST …/elicitations/{id}/resolve`, **confirmed by event**.
 *
 * SPEC-037 hardening delivered here (Increment 2): correlation on the server-echoed `item_id` (superseding
 * the spike's `pending_id`), event-confirmed approvals, completion-aware `sendMessage`, and a dead-letter
 * sink. Reconnect+resync, the durable session store, and version pinning land in the following increments;
 * default-composition entry is gated on the live-acceptance run (SPEC-037 Decision #7).
 */
export class OmnigentAdapter implements HarnessAdapter {
  readonly id = "Omnigent";
  private readonly http: OmnigentTransport;
  private readonly graph: SessionGraph;
  private readonly normState: NormalizeState = createNormalizeState();
  private readonly channel = new EventChannel();
  private readonly streams = new Map<string, AbortController>();
  /** permissionId → sessionId, recorded as elicitations stream in so a decision can be routed back. */
  private readonly permSession = new Map<string, string>();
  private readonly perms = new PermissionCoordinator();
  private readonly turns = new TurnWaiters();
  private readonly deadLetters: DeadLetterSink;
  /** sessionId → the current turn's correlationId (the server-echoed item_id), for stamping/diagnostics. */
  private readonly turnCorrelation = new Map<string, string>();
  private ready = false;
  private versionReason: string | undefined;

  constructor(
    private readonly config: OmnigentConfig,
    onDeadLetter?: (d: DeadLetter) => void,
    transport?: OmnigentTransport, // injected in tests; defaults to the real HTTP surface
  ) {
    this.http = transport ?? new OmnigentHttp(config);
    this.deadLetters = new DeadLetterSink(onDeadLetter);
    this.graph = new SessionGraph(config.sessionStorePath); // durable when a store path is configured
  }

  capabilities(): ReadonlySet<Capability> {
    return OMNIGENT_CAPABILITIES;
  }

  /** Probe the server (reachability + auth) AND validate its version against the pinned target (SPEC-037):
   *  an incompatible alpha is surfaced as NOT ready (fail loud) rather than driven into an obscure failure. */
  async init(): Promise<void> {
    try {
      await this.http.req("GET", "/v1/sessions?limit=1");
      try {
        const v = await this.http.req<{ version?: string }>("GET", "/api/version");
        this.versionReason = isCompatibleOmnigentVersion(v?.version)
          ? undefined
          : `Omnigent server version ${v?.version ?? "unknown"} is incompatible with the adapter's target ${OMNIGENT_TARGET_VERSION}`;
      } catch {
        this.versionReason = `could not read the Omnigent server version (/api/version); expected ${OMNIGENT_TARGET_VERSION}`;
      }
      this.ready = !this.versionReason;
    } catch (err) {
      this.ready = false;
      throw err;
    }
  }

  readiness(): Readiness {
    if (this.versionReason) return { ready: false, reason: this.versionReason };
    return this.ready ? { ready: true } : { ready: false, reason: "Omnigent server not reachable" };
  }

  /** Diagnostic accessor: frames the normalizer could not map (SPEC-037 dead-letter sink). */
  deadLetterEntries(): readonly DeadLetter[] {
    return this.deadLetters.entries();
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    // Live-confirmed: POST /v1/sessions REQUIRES agent_id (the Agent Image to run); the server 422s without.
    if (!this.config.agentId) {
      throw new Error(
        "OmnigentConfig.agentId is required — Omnigent's POST /v1/sessions mandates agent_id (the Agent Image to run)",
      );
    }
    const body = { agent_id: this.config.agentId, title: input.specId };
    const res = await this.http.req<{ session_id?: string; id?: string }>("POST", "/v1/sessions", body);
    const sessionId = res.session_id ?? res.id;
    if (!sessionId) throw new Error("Omnigent createSession returned no session id");
    this.graph.record(sessionId, { specId: input.specId, kind: input.parent ? "task" : "spec" });
    this.openStream(sessionId);
    return { sessionId };
  }

  /** Synchronous turn: post, then AWAIT the turn's quiescence (SPEC-037 completion-aware send). */
  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    const receipt = await this.postMessage(input);
    await this.turns.wait(receipt.sessionId); // resolves on session.status: idle, or a bounded timeout
    return receipt;
  }

  /** Fire-and-watch: post and return; the caller observes completion on the event stream. */
  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    return this.postMessage(input);
  }

  private async postMessage(input: SendMessageInput): Promise<SendReceipt> {
    if (!this.streams.has(input.sessionId)) {
      if (!this.graph.get(input.sessionId)) this.graph.record(input.sessionId, { specId: input.sessionId, kind: "spec" });
      this.openStream(input.sessionId);
    }
    const override = modelOverride(input.model);
    const body = {
      type: "message",
      ...(override ? { model_override: override } : {}),
      data: { role: "user", content: input.parts.map((p) => ({ type: "input_text", text: p.text })) },
    };
    // Live-confirmed: POST /events returns `{ queued, item_id }` (0.3.0), and `session.input.consumed`
    // echoes that item_id — so it is a real correlation handle, superseding the spike's `pending_id`
    // (SPEC-037 Requirement — correlation). Fall back to best-effort only if a build omits the echo.
    const res = await this.http.req<{ queued?: boolean; item_id?: string; pending_id?: string }>(
      "POST",
      `/v1/sessions/${input.sessionId}/events`,
      body,
    );
    const correlationId = input.correlationId ?? res.item_id ?? res.pending_id ?? `msg_${randomUUID()}`;
    this.turnCorrelation.set(input.sessionId, correlationId);
    return { sessionId: input.sessionId, correlationId };
  }

  streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    return this.channel.drain(signal);
  }

  /** Resolve an elicitation, then return `confirmed` ONLY once the stream reflects it (SPEC-037/SPEC-002). */
  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    const sessionId = this.permSession.get(decision.permissionId);
    if (!sessionId) return { permissionId: decision.permissionId, status: "stale" };
    if (this.perms.pending(decision.permissionId)) return { permissionId: decision.permissionId, status: "duplicate" };
    const confirm = this.perms.decide(decision.permissionId); // register the waiter BEFORE posting
    const action = decision.decision === "reject" ? "decline" : "accept"; // once/always → accept
    await this.http.req(
      "POST",
      `/v1/sessions/${sessionId}/elicitations/${decision.permissionId}/resolve`,
      { action, ...(decision.message ? { content: { message: decision.message } } : {}) },
    );
    const status = await confirm; // confirmed (event) | unconfirmed (timeout) — never a bare 202 "confirmed"
    return { permissionId: decision.permissionId, status };
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

  /**
   * Per-session SSE pump with bounded reconnect (SPEC-037 Requirement — reconnect). On a stream close/error
   * (not an abort) it re-syncs the session's current state via REST — the proven OpenCode pattern, since the
   * stream is live-tail (no replay); `sequence_number` gap-dedup stays live-gated as the capture showed it
   * null — then reconnects with exponential backoff. On exhausting the attempt window it emits a terminal
   * degraded `session.status: error` rather than hang. A successful open resets the attempt counter.
   */
  private async pump(sessionId: string, signal: AbortSignal): Promise<void> {
    const identity = this.graph.get(sessionId) ?? { specId: sessionId, kind: "spec" as const };
    const cfg = { ...DEFAULT_RECONNECT, ...(this.config.reconnect ?? {}) };
    let attempt = 0;
    try {
      while (!signal.aborted) {
        let receivedAny = false;
        try {
          const body = await this.http.openStream(`/v1/sessions/${sessionId}/stream`, signal);
          for await (const frame of parseOmnigentSse(body, signal)) {
            receivedAny = true;
            this.handleFrame(sessionId, identity, frame);
          }
        } catch {
          /* connection error — fall through to reconnect */
        }
        if (signal.aborted) break;
        // Reset the backoff only after REAL progress (≥1 frame). A stream that merely opens then drops at
        // once is a flap — the attempt counter must keep climbing so reconnect stays bounded.
        if (receivedAny) attempt = 0;
        attempt++;
        if (attempt > cfg.maxAttempts) {
          this.channel.push({ seq: 0, ts: 0, harness: this.id, sessionId, specId: identity.specId, kind: identity.kind, type: "session.status", status: "error" });
          break; // terminal degrade, not a silent hang
        }
        await this.resync(sessionId, identity); // REST re-sync of state missed during the gap (idempotent)
        await delay(Math.min(cfg.baseDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs), signal);
      }
    } finally {
      this.streams.delete(sessionId);
    }
  }

  /** Best-effort REST re-sync after a disconnect: read the session's current status and re-emit it, so a
   *  terminal transition that happened during the gap is not lost (the stream itself has no replay). */
  private async resync(sessionId: string, identity: { specId: string; kind: "spec" | "task" }): Promise<void> {
    try {
      const s = await this.http.req<{ status?: string }>("GET", `/v1/sessions/${sessionId}`);
      if (typeof s?.status === "string" && s.status) {
        this.handleFrame(sessionId, identity, { type: "session.status", conversation_id: sessionId, status: s.status });
      }
    } catch {
      /* resync is best-effort; a failure just means we reconnect the stream and carry on */
    }
  }

  /** Process one raw frame: bind correlation, feed waiters, dead-letter the unmapped, push domain events. */
  private handleFrame(sessionId: string, identity: { specId: string; kind: "spec" | "task" }, frame: unknown): void {
    const type = (frame as { type?: string } | null)?.type;
    const data = (frame as { data?: Record<string, unknown> } | null)?.data;

    // Correlation: session.input.consumed echoes the outbound item_id — confirm the turn's binding.
    if (type === "session.input.consumed") {
      const itemId = typeof data?.item_id === "string" ? data.item_id : undefined;
      if (itemId) this.turnCorrelation.set(sessionId, itemId);
    }
    // response.error detail has no home on SessionStatusEvent → route it to the dead-letter sink (diagnostic).
    if (type === "response.error") {
      this.deadLetters.record(sessionId, frame, "response.error");
    }
    // An elicitation resolved on the stream confirms a pending decision (provisional frame name; the
    // coordinator is a safe no-op if the id isn't awaited).
    if (type === "elicitation.resolved" || type === "session.elicitation.resolved" || type === "response.elicitation_resolved") {
      const id = (typeof data?.elicitation_id === "string" && data.elicitation_id) ||
        (typeof (frame as any)?.elicitation_id === "string" && (frame as any).elicitation_id) || undefined;
      if (id) this.perms.confirm(id);
    }

    const events = normalize(frame, sessionId, identity, this.id, this.normState);
    if (events.length === 0 && !isRecognizedFrameType(type)) {
      this.deadLetters.record(sessionId, frame, "unmapped-frame");
      return;
    }
    for (const ev of events) {
      const parsed = DomainEvent.safeParse(ev);
      if (!parsed.success) {
        this.deadLetters.record(sessionId, ev, "invalid-domain-event");
        continue;
      }
      if (parsed.data.type === "permission.asked") this.permSession.set(parsed.data.permissionId, sessionId);
      if (parsed.data.type === "session.status" && parsed.data.status === "idle") this.turns.quiesce(sessionId);
      this.channel.push(parsed.data);
    }
  }
}

/** Render an {@link AgentModel} as an Omnigent `model_override`: `provider/name`, or bare for gateway. */
function modelOverride(m?: AgentModel): string | undefined {
  if (!m) return undefined;
  return m.provider === "gateway" ? m.name : `${m.provider}/${m.name}`;
}

/** An abortable sleep — resolves after `ms`, or immediately when the pump is aborted (stopServer). */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
