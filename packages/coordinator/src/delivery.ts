/**
 * Single-session delivery (SPEC-009 revised): an approved spec's `## Tasks` checklist is handed to
 * ONE implementer session as a single prompt, and the agent decides how to sequence/tackle the list
 * itself — the coordinator no longer forces the tasks into concurrent child sessions. Side effects
 * (the worktree, `createSession`, `dispatchAsync`, trace) live on `ProjectContext`; this module is the
 * pure, deterministic, unit-testable piece: parsing the checklist and building the dispatch prompt.
 */
import { createHash } from "node:crypto";

export interface ParsedTask {
  /** Display ordinal (position among task lines) — for readable logs, NOT identity. */
  index: number;
  /** STABLE identity: a short hash of the task text, invariant under insert/delete/reorder. */
  key: string;
  text: string;
  done: boolean;
}

/**
 * Parse the `## Tasks` section into tasks with STABLE indices (position among all task lines), so a
 * completion check is invariant to reordering/edits. Returns [] when the section is absent or has no
 * `- [ ]` / `- [x]` items.
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
      const text = m[2]!.trim();
      out.push({ index: idx++, key: taskKey(text), text, done: mark.toLowerCase() === "x" });
    }
  }
  return out;
}

/** Stable identity for a task: a short SHA-1 of its trimmed text — invariant under list edits. */
export function taskKey(text: string): string {
  return createHash("sha1").update(text.trim(), "utf8").digest("hex").slice(0, 8);
}

/** Derive a filesystem/branch-safe slug from a spec id (alphanumeric + hyphen, lowercased). */
export function specSlug(specId: string): string {
  return specId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "spec";
}

/**
 * Deterministic worktree branch for a delivery — ONE per spec (not one per task, since there is now
 * exactly one implementer session per delivery). A `--delivery` SIBLING suffix, not a `/delivery`
 * child path: git refs are files, so a child path under an existing feature branch is a directory/file
 * conflict `git branch`/`worktree add` reject. The sibling form stays tied to the feature branch, is
 * always valid, and — critically — avoids the "branch already checked out" conflict that would occur
 * if the delivery worktree tried to check out the ACTUAL feature branch while the human's own working
 * directory (`this.root`) is already on it, which is common (approving a spec requires being on it).
 */
export function deliveryWorktreeBranch(featureBranch: string): string {
  return `${featureBranch}--delivery`;
}

/**
 * The prompt for the single delivery session: the FULL unchecked task list, not one task at a time —
 * the implementer decides how to sequence/parallelise its own tool calls, if at all. Tells the agent to
 * check off each item in the spec file's Tasks section as it completes it: that checklist is the
 * completion oracle the coordinator watches (there's no artificial "one dispatch, one turn, idle means
 * done" signal anymore, since a human may steer this session with follow-ups across several turns).
 */
export function buildDeliveryPrompt(specPath: string, tasks: ParsedTask[]): string {
  const list = tasks.filter((t) => !t.done).map((t) => `- [ ] ${t.text}`).join("\n");
  return [
    `Implement the specification at ${specPath}. Work through the tasks below in whatever order and`,
    "grouping makes sense to you — sequentially, or in parallel via your own tool calls, entirely your",
    "call. As you complete each task, check it off in the file's `## Tasks` section (`- [ ]` → `- [x]`)",
    "— that checklist is how the coordinator knows the delivery is complete, so keep it current rather",
    "than checking everything off at the end.",
    "",
    "--- TASKS ---",
    list,
  ].join("\n");
}
