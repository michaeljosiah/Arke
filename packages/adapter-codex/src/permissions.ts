import type { PermissionVerb } from "@arke/contracts";

/**
 * The Codex approval round-trip (SPEC-034). Codex's app-server issues **server→client requests** —
 * `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
 * `item/permissions/requestApproval` — each carrying a JSON-RPC `id` the client MUST answer. The adapter
 * surfaces each as a `permission.asked` domain event and holds the request open; `respondToPermission`
 * answers the exact `id` with the mapped decision. This is Codex's only interactive-approval surface —
 * `codex exec` cannot do it — which is why the adapter integrates via the app-server (Decision #1).
 */

const APPROVAL_METHODS = new Set([
  "item.commandExecution.requestApproval",
  "item.fileChange.requestApproval",
  "item.permissions.requestApproval",
]);

/** Whether a server→client request method is one of Codex's approval requests (slash- or dot-form). */
export function isApprovalRequest(method: string): boolean {
  return APPROVAL_METHODS.has(method.replace(/\//g, "."));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** A human-readable title + detail for the `permission.asked` event, per approval kind. */
export function approvalTitle(method: string, params: Record<string, unknown>): { title: string; detail?: string } {
  const m = method.replace(/\//g, ".");
  const reason = str(params.reason);
  if (m === "item.commandExecution.requestApproval") {
    const command = str(params.command) ?? str((params.item as { command?: string } | undefined)?.command);
    return { title: command ? `Run command: ${command}` : "Run a command", ...(reason ? { detail: reason } : {}) };
  }
  if (m === "item.fileChange.requestApproval") {
    const changes = Array.isArray(params.changes) ? (params.changes as Array<{ path?: string }>) : [];
    const paths = changes.map((c) => c?.path).filter(Boolean).join(", ");
    return { title: paths ? `Apply file changes: ${paths}` : "Apply file changes", ...(reason ? { detail: reason } : {}) };
  }
  // item.permissions.requestApproval — a scope grant (network / filesystem).
  return { title: str(params.title) ?? "Grant permissions", ...(reason ? { detail: reason } : {}) };
}

/**
 * Map an Arke {@link PermissionVerb} to Codex's decision string. `reject → "decline"`; `once`/`always →
 * "accept"` (Arke's own grant store remembers an `always`, so a per-request `accept` is correct here).
 */
export function codexDecision(verb: PermissionVerb): "accept" | "decline" {
  return verb === "reject" ? "decline" : "accept";
}

interface Pending {
  /** The JSON-RPC id of the open server→client approval request to answer. */
  jsonRpcId: number | string;
  sessionId: string;
}

/** Tracks open Codex approval requests so a human decision routes back to the right JSON-RPC id. */
export class Approvals {
  private readonly byPermissionId = new Map<string, Pending>();

  /** Register an open approval request; returns the Arke permission id surfaced on `permission.asked`. */
  register(jsonRpcId: number | string, sessionId: string): string {
    const permissionId = `codex-approval-${jsonRpcId}`;
    this.byPermissionId.set(permissionId, { jsonRpcId, sessionId });
    return permissionId;
  }

  /** Resolve + REMOVE a pending approval (a decision is one-shot); undefined when unknown/stale. */
  take(permissionId: string): Pending | undefined {
    const p = this.byPermissionId.get(permissionId);
    if (p) this.byPermissionId.delete(permissionId);
    return p;
  }
}
