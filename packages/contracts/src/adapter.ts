import { z } from "zod";
import type { DomainEvent } from "./events.js";
import type { ModelTier } from "./spec.js";

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

export interface PermissionDecision {
  permissionId: string;
  granted: boolean;
}

/**
 * One interface, many harnesses, honest about differences. Methods beyond the `core`
 * set are gated by the capabilities the adapter reports from {@link capabilities}.
 */
export interface HarnessAdapter {
  /** Stable identifier shown on the board, e.g. "OpenCode". */
  readonly id: string;
  /** What this adapter supports; callers check before invoking gated methods. */
  capabilities(): ReadonlySet<Capability>;

  // ---- core ----
  createSession(input: CreateSessionInput): Promise<SessionRef>;
  sendMessage(input: SendMessageInput): Promise<void>;
  /** Fire-and-watch task execution; must not block while the task runs (FR-8). */
  dispatchAsync(input: SendMessageInput): Promise<SessionRef>;

  // ---- events ----
  /** Async iterator of normalized, validated domain events (capability: events). */
  streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent>;

  // ---- todos / diff / permissions / commands ----
  getTodos?(ref: SessionRef): Promise<TodoItem[]>;
  getDiff?(ref: SessionRef): Promise<DiffSummary>;
  respondToPermission?(decision: PermissionDecision): Promise<void>;
  runCommand?(ref: SessionRef, command: string, args?: string[]): Promise<void>;
}
