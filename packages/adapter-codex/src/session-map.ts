/**
 * Maps Arke's session identity onto Codex's (SPEC-034). A Codex **thread** (its resumable conversation)
 * is created lazily on the first turn, so an Arke `sessionId` is minted up front and bound to the Codex
 * `thread_id` once the app-server reports it (`thread.started`). Also carries the working directory a
 * thread runs in (the SPEC-028 delivery worktree, or the project root) and the spec identity every
 * normalized event needs. Pure in-memory state; the adapter owns the lifecycle.
 */

export interface SessionIdentity {
  specId: string;
  kind: "spec" | "task";
}

interface Entry extends SessionIdentity {
  /** The Codex thread this session drives; set once the app-server reports it. */
  threadId?: string;
  /** The working directory turns on this session run in; omitted → the adapter's default cwd. */
  cwd?: string;
}

export class SessionMap {
  private readonly byArke = new Map<string, Entry>();
  private readonly arkeByThread = new Map<string, string>();

  record(arkeId: string, identity: SessionIdentity, cwd?: string): void {
    const existing = this.byArke.get(arkeId);
    this.byArke.set(arkeId, { ...identity, ...(cwd ? { cwd } : {}), ...(existing?.threadId ? { threadId: existing.threadId } : {}) });
  }

  get(arkeId: string): Entry | undefined {
    return this.byArke.get(arkeId);
  }

  /** How many sessions are recorded — lets a thread-less frame fall back safely only when unambiguous. */
  get size(): number {
    return this.byArke.size;
  }

  identity(arkeId: string): SessionIdentity {
    const e = this.byArke.get(arkeId);
    return e ? { specId: e.specId, kind: e.kind } : { specId: arkeId, kind: "spec" };
  }

  /** Bind an Arke session to its Codex thread (idempotent); lets a thread-scoped notification route back. */
  bindThread(arkeId: string, threadId: string): void {
    const e = this.byArke.get(arkeId);
    if (e) e.threadId = threadId;
    this.arkeByThread.set(threadId, arkeId);
  }

  threadFor(arkeId: string): string | undefined {
    return this.byArke.get(arkeId)?.threadId;
  }

  /** The Arke session a Codex thread belongs to (falls back to the thread id itself if unmapped). */
  arkeForThread(threadId: string): string {
    return this.arkeByThread.get(threadId) ?? threadId;
  }
}
