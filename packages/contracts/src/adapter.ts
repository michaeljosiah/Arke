import { z } from "zod";
import type { DomainEvent } from "./events.js";
import type { ModelTier } from "./spec.js";
import type { AgentImage } from "./agent-image.js";

/**
 * The backend-agnostic harness adapter (PRD §8.2, §12).
 *
 * The orchestration logic targets this interface so that no single harness is
 * load-bearing. The OpenCode adapter is the first and richest implementation; other
 * harnesses declare what they support through capability flags, and the board/cockpit
 * degrade to a backend's real surface rather than assuming the full contract.
 */

/** Capability flags an adapter advertises (PRD §12 interface table). */
export const Capability = z.enum([
  "events", // streamEvents()
  "todos", // getTodos()
  "diff", // getDiff()
  "permissions", // respondToPermission()
  "commands", // runCommand()
  "models", // listModels() — the backend exposes a model catalog (SPEC-005)
  "revert", // revert()/unrevert() — git-checkpoint rescue (SPEC-011)
]);
export type Capability = z.infer<typeof Capability>;

export interface SessionRef {
  sessionId: string;
}

export interface CreateSessionInput {
  /** Parent session id — a task is a child of its spec session (FR-8). */
  parent?: string;
  specId: string;
}

export interface MessagePart {
  type: "text";
  text: string;
}

export interface SendMessageInput {
  sessionId: string;
  /** Named agent role, e.g. "product-owner" | "technical-architect" | "engineering". */
  agent: string;
  /** Logical model tier; the router resolves tier → model → harness (FR-4, D11). */
  tier: ModelTier;
  parts: MessagePart[];
  /**
   * Caller-supplied correlation id (the harness `messageID`, SPEC-002). Lets the
   * coordinator attribute later events to the originating request. If omitted, the
   * adapter generates one and returns it on the {@link SendReceipt}.
   */
  correlationId?: string;
}

/** Receipt for a send/dispatch: the session it ran on and the correlation id used. */
export interface SendReceipt {
  sessionId: string;
  correlationId: string;
}

export interface DiffSummary {
  added: number;
  removed: number;
  files: number;
  patch?: string;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

/**
 * A human's decision on a gated action (SPEC-016, replacing the SPEC-002 `granted` boolean):
 * - `once`   — allow this single occurrence; a matching future request still prompts.
 * - `always` — allow and remember; matching future requests auto-resolve (see {@link RememberedGrant}).
 * - `reject` — deny.
 */
export const PermissionVerb = z.enum(["once", "always", "reject"]);
export type PermissionVerb = z.infer<typeof PermissionVerb>;

export interface PermissionDecision {
  permissionId: string;
  decision: PermissionVerb;
  /** Optional free-text rationale relayed to the harness. */
  message?: string;
}

/**
 * A remembered grant created by an `always` decision (SPEC-016). Durable across reconnects
 * and restarts; a later permission request whose `key` matches auto-resolves without prompting
 * a human, and every such auto-grant is recorded in the trace. Revocable.
 */
export interface RememberedGrant {
  id: string;
  /** Stable match key — the scope and action class this grant authorises. */
  key: string;
  sessionId?: string;
  actionClass: string;
  createdAt: number;
  createdBy: string;
  revoked?: boolean;
}

/**
 * The outcome of relaying a permission decision (SPEC-002). The reply endpoint can
 * return HTTP 200 even for stale ids, so success is never inferred from status — it is
 * confirmed only by the matching `permission.replied` event:
 * - `confirmed`   — the matching reply event arrived.
 * - `unconfirmed` — no reply within the timeout; the caller should surface "couldn't
 *                   confirm — retry" rather than reporting success.
 * - `stale`       — the server no longer lists the id as pending; offer to refresh.
 * - `duplicate`   — the same decision was already confirmed; the second call was a no-op.
 */
export const PermissionAckStatus = z.enum(["confirmed", "unconfirmed", "stale", "duplicate"]);
export type PermissionAckStatus = z.infer<typeof PermissionAckStatus>;

export interface PermissionAck {
  permissionId: string;
  status: PermissionAckStatus;
}

/** Whether the adapter is ready to serve, with a reason when it is not (SPEC-002). */
export interface Readiness {
  ready: boolean;
  reason?: string;
}

/**
 * One model in a harness backend's live catalog (SPEC-005, capability `models`). Public catalog
 * metadata only — never a credential, an endpoint secret, or a host path. The registry validates
 * configured `serves[].model` entries against the `{provider, id}` pairs `listModels` returns, so a
 * typo or an unsupported model is caught at config load, not at first dispatch.
 */
export interface ModelInfo {
  /** The model identifier the backend serves, e.g. "claude-opus-4.8". */
  id: string;
  /** Provider namespace, e.g. "anthropic", "github-copilot". */
  provider: string;
  /** Optional human-readable label from the catalog. */
  displayName?: string;
}

/**
 * One interface, many harnesses, honest about differences. Methods beyond the `core`
 * set are gated by the capabilities the adapter reports from {@link capabilities}.
 */
export interface HarnessAdapter {
  /** Stable identifier shown on the board, e.g. "OpenCode". */
  readonly id: string;
  /**
   * What this adapter supports; callers check before invoking gated methods. The set is
   * determined by probing the live server at {@link init}, not hard-coded (SPEC-002).
   */
  capabilities(): ReadonlySet<Capability>;

  // ---- lifecycle ----
  /**
   * Probe the server, derive capabilities, and build initial state. Idempotent. After it
   * resolves, {@link capabilities} and {@link readiness} reflect the live server. In managed
   * mode (SPEC-016) this also starts the harness process.
   */
  init?(): Promise<void>;
  /** Whether the adapter can serve, with a reason when it cannot (SPEC-002). */
  readiness?(): Readiness;
  /** Start a harness process this adapter owns (managed mode, SPEC-016). No-op in attach mode. */
  startServer?(): Promise<void>;
  /** Stop a harness process this adapter started. SHALL NOT stop a server it did not start. */
  stopServer?(): Promise<void>;
  /** Materialise a portable agent image into the harness's native agent convention (SPEC-016). */
  materializeAgent?(image: AgentImage): Promise<void>;

  // ---- core ----
  createSession(input: CreateSessionInput): Promise<SessionRef>;
  /** Synchronous send: resolves when the turn completes. Returns the correlation id used. */
  sendMessage(input: SendMessageInput): Promise<SendReceipt>;
  /** Fire-and-watch task execution; must not block while the task runs (FR-8). */
  dispatchAsync(input: SendMessageInput): Promise<SendReceipt>;

  // ---- events ----
  /** Async iterator of normalized, validated domain events (capability: events). */
  streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent>;

  /**
   * The live model catalog the connected backend can serve (capability: models, SPEC-005). Present
   * only when the backend exposes a catalog; absent adapters degrade to trusting configured `serves`.
   */
  listModels?(): Promise<ModelInfo[]>;

  // ---- todos / diff / permissions / commands ----
  getTodos?(ref: SessionRef): Promise<TodoItem[]>;
  getDiff?(ref: SessionRef): Promise<DiffSummary>;
  /**
   * Relay a human decision and confirm it via the matching `permission.replied` event —
   * never by HTTP status. See {@link PermissionAck} for the outcomes (SPEC-002).
   */
  respondToPermission?(decision: PermissionDecision): Promise<PermissionAck>;
  runCommand?(ref: SessionRef, command: string, args?: string[]): Promise<void>;

  // ---- rescue (capability: revert, SPEC-011) ----
  /** Roll a session back to the git checkpoint before `messageId`'s turn. */
  revert?(ref: SessionRef, messageId: string): Promise<void>;
  /** Undo the most recent revert. */
  unrevert?(ref: SessionRef): Promise<void>;
}
