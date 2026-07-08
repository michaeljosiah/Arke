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
  // Split on CRLF *or* LF: a git worktree checkout on Windows (core.autocrlf) yields `\r\n`, and a
  // trailing `\r` breaks the task-line regex below (`.` never matches `\r`, and `$` won't match before
  // it) — so a delivery running in a CRLF worktree would parse zero tasks and never complete (SPEC-028).
  const lines = md.split(/\r?\n/);
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

/** Options shaping the delivery prompt (SPEC-030). */
export interface DeliveryPromptOptions {
  /**
   * Auto-PR (SPEC-030). When true, the prompt instructs the implementer to open a pull request itself
   * once every task is checked off — the engineer's STANDING, config-time pre-authorisation, which
   * relaxes SPEC-011's per-diff human gate for this project. When false (the default), the prompt says
   * nothing about PRs: the agent stops after implementing and the human reviews the diff and opens the
   * PR via the board's diff-review gate.
   *
   * The instruction deliberately does NOT hard-code a `--base`: the harness runs in the project's own
   * checkout on the feature branch (the delivery worktree is not wired into the harness cwd — a known
   * SPEC-028 gap), so `gh pr create --fill` opens the PR from the current (feature) branch against the
   * repository's default branch, which is exactly the SPEC-024 delivery PR (feature → mainline). Leaving
   * the base to `gh`'s default also keeps a spec branch name out of the shell command (no injection via a
   * crafted `branch:` frontmatter value).
   */
  autoOpenPr?: boolean;
}

/**
 * The prompt for the single delivery session: the FULL unchecked task list, not one task at a time —
 * the implementer decides how to sequence/parallelise its own tool calls, if at all. Tells the agent to
 * check off each item in the spec file's Tasks section as it completes it: that checklist is the
 * completion oracle the coordinator watches (there's no artificial "one dispatch, one turn, idle means
 * done" signal anymore, since a human may steer this session with follow-ups across several turns).
 * When `opts.autoOpenPr` is set (SPEC-030), a trailing instruction tells the agent to open the PR itself.
 */
export function buildDeliveryPrompt(specPath: string, tasks: ParsedTask[], opts: DeliveryPromptOptions = {}): string {
  const list = tasks.filter((t) => !t.done).map((t) => `- [ ] ${t.text}`).join("\n");
  const lines = [
    `Implement the specification at ${specPath}. Work through the tasks below in whatever order and`,
    "grouping makes sense to you — sequentially, or in parallel via your own tool calls, entirely your",
    "call. As you complete each task, check it off in the file's `## Tasks` section (`- [ ]` → `- [x]`)",
    "— that checklist is how the coordinator knows the delivery is complete, so keep it current rather",
    "than checking everything off at the end.",
  ];
  if (opts.autoOpenPr) {
    lines.push(
      "",
      "When every task is checked off, open a pull request for your changes so this delivery can be reviewed",
      "and merged: push your current branch if it has no remote yet, then run `gh pr create --fill` (it opens",
      "a PR from your current branch against the repository's default branch). This project is configured to",
      "open the PR automatically on delivery — the engineer has pre-authorised it, so do not stop to ask for a",
      "separate diff approval first.",
    );
  }
  lines.push("", "--- TASKS ---", list);
  return lines.join("\n");
}
