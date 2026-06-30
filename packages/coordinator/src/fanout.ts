/**
 * Parallel task fan-out (SPEC-009): the pure decider + helpers that turn an approved spec's task
 * list into dispatch commands. Side effects (git worktrees, createSession, dispatchAsync, trace)
 * live in the Dispatcher on ProjectContext; this module is deterministic and unit-testable.
 */

export interface ParsedTask {
  index: number; // position among ALL task lines (stable across runs → deterministic worktree branch)
  text: string;
  done: boolean;
}

export interface TaskCommand {
  kind: "dispatch-task";
  specId: string;
  specSessionId: string;
  taskIndex: number;
  taskText: string;
  featureBranch: string;
  worktreeBranch: string;
}

export type FanOutTaskStatus = "queued" | "dispatching" | "running" | "done" | "failed";

export interface FanOutTask {
  taskIndex: number;
  taskText: string;
  status: FanOutTaskStatus;
  sessionId?: string;
  worktreeBranch?: string;
  error?: string;
}

export interface FanOutRecord {
  specId: string;
  specSessionId: string;
  featureBranch: string;
  tasks: FanOutTask[];
  startedAt: number;
}

export const DEFAULT_MAX_CONCURRENT_TASKS = 10;

/** The configured concurrency cap (`ARKE_MAX_CONCURRENT_TASKS`, default 10), clamped to ≥1. */
export function maxConcurrentTasks(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.ARKE_MAX_CONCURRENT_TASKS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_CONCURRENT_TASKS;
}

/**
 * Parse the `## Tasks` section into tasks with STABLE indices (position among all task lines), so a
 * retry for the same task always maps to the same worktree branch. Returns [] when the section is
 * absent or has no `- [ ]` / `- [x]` items.
 */
export function parseTasks(md: string): ParsedTask[] {
  const lines = md.split("\n");
  let inTasks = false;
  const out: ParsedTask[] = [];
  let idx = 0;
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2 && !line.startsWith("###")) {
      inTasks = h2[1]!.trim().toLowerCase() === "tasks";
      continue;
    }
    if (!inTasks) continue;
    const m = /^- \[([ xX~])\]\s+(.+)$/.exec(line);
    if (m) {
      const mark = m[1]!;
      out.push({ index: idx++, text: m[2]!.trim(), done: mark.toLowerCase() === "x" });
    }
  }
  return out;
}

/** Derive a filesystem/branch-safe slug from a spec id (alphanumeric + hyphen, lowercased). */
export function specSlug(specId: string): string {
  return specId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "spec";
}

/**
 * Deterministic worktree branch for a task — same task index always yields the same name. Uses a
 * `--task-N` SIBLING suffix rather than a `/task-N` child path: git refs are files, so a child path
 * under the feature branch (`feat/x/task-0` when `feat/x` exists) is a directory/file conflict that
 * `git branch`/`worktree add` reject. The sibling form stays tied to the feature branch and is valid.
 */
export function worktreeBranch(featureBranch: string, taskIndex: number): string {
  return `${featureBranch}--task-${taskIndex}`;
}

export interface PlanInput {
  specId: string;
  specSessionId: string;
  featureBranch: string;
  tasks: ParsedTask[];
  /** Task indices already present in the durable FanOutRecord (dispatched on a prior run/restart). */
  alreadyDispatched?: ReadonlySet<number>;
  /** How many task sessions are already running for this spec (counts toward the concurrency cap). */
  runningCount?: number;
  limit?: number;
}

export interface FanOutPlan {
  /** Commands to dispatch immediately (within the concurrency cap). */
  dispatch: TaskCommand[];
  /** Commands to hold in the queue and drain as running tasks complete. */
  queued: TaskCommand[];
}

/**
 * Pure decider: map an approved spec's parsed tasks (+ idempotency/concurrency state) to a plan.
 * Only unchecked tasks not already dispatched are considered; the first `limit - runningCount` go
 * out immediately and the rest are queued (never dropped). Deterministic worktree branch per index.
 */
export function planFanOut(input: PlanInput): FanOutPlan {
  const limit = input.limit ?? maxConcurrentTasks();
  const already = input.alreadyDispatched ?? new Set<number>();
  const running = input.runningCount ?? 0;
  const candidates = input.tasks
    .filter((t) => !t.done && !already.has(t.index))
    .map<TaskCommand>((t) => ({
      kind: "dispatch-task",
      specId: input.specId,
      specSessionId: input.specSessionId,
      taskIndex: t.index,
      taskText: t.text,
      featureBranch: input.featureBranch,
      worktreeBranch: worktreeBranch(input.featureBranch, t.index),
    }));
  const room = Math.max(0, limit - running);
  return { dispatch: candidates.slice(0, room), queued: candidates.slice(room) };
}
