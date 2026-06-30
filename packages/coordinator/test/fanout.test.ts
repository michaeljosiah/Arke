import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTasks, specSlug, worktreeBranch, planFanOut, maxConcurrentTasks } from "../src/fanout.js";

const TASKS_MD = `# Spec

## Tasks
- [ ] First task
- [x] Already done
- [ ] Third task

## Change history
- note
`;

test("parseTasks reads checked/unchecked items with stable indices", () => {
  const tasks = parseTasks(TASKS_MD);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.index), [0, 1, 2]);
  assert.deepEqual(tasks.map((t) => t.done), [false, true, false]);
  assert.equal(tasks[0]!.text, "First task");
});

test("parseTasks returns [] when there is no Tasks section", () => {
  assert.deepEqual(parseTasks("# Spec\n\n## Design\nstuff\n"), []);
});

test("parseTasks ignores list items outside the Tasks section", () => {
  const md = "## Requirements\n- [ ] not a task\n\n## Tasks\n- [ ] real task\n";
  const t = parseTasks(md);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.text, "real task");
});

test("specSlug is branch-safe", () => {
  assert.equal(specSlug("SPEC-2026-06-28-parallel-task-execution"), "spec-2026-06-28-parallel-task-execution");
  assert.equal(specSlug("Foo Bar!"), "foo-bar");
});

test("worktreeBranch is deterministic, sibling form (no git D/F conflict with the feature branch)", () => {
  assert.equal(worktreeBranch("feat/x", 2), "feat/x--task-2");
  assert.equal(worktreeBranch("feat/x", 2), worktreeBranch("feat/x", 2));
});

test("planFanOut dispatches only unchecked, not-already-dispatched tasks", () => {
  const tasks = parseTasks(TASKS_MD);
  const plan = planFanOut({ specId: "S", specSessionId: "s0", featureBranch: "feat/x", tasks, limit: 10 });
  assert.deepEqual(plan.dispatch.map((c) => c.taskIndex), [0, 2], "skips the checked task");
  assert.equal(plan.queued.length, 0);
  assert.equal(plan.dispatch[0]!.worktreeBranch, "feat/x--task-0");
});

test("planFanOut is idempotent against alreadyDispatched", () => {
  const tasks = parseTasks(TASKS_MD);
  const plan = planFanOut({ specId: "S", specSessionId: "s0", featureBranch: "feat/x", tasks, alreadyDispatched: new Set([0]), limit: 10 });
  assert.deepEqual(plan.dispatch.map((c) => c.taskIndex), [2]);
});

test("planFanOut respects the concurrency cap, queueing the excess", () => {
  const tasks = Array.from({ length: 15 }, (_, i) => ({ index: i, text: `t${i}`, done: false }));
  const plan = planFanOut({ specId: "S", specSessionId: "s0", featureBranch: "feat/x", tasks, limit: 10 });
  assert.equal(plan.dispatch.length, 10);
  assert.equal(plan.queued.length, 5);
  assert.deepEqual(plan.queued.map((c) => c.taskIndex), [10, 11, 12, 13, 14]);
});

test("planFanOut accounts for already-running tasks against the cap", () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({ index: i, text: `t${i}`, done: false }));
  const plan = planFanOut({ specId: "S", specSessionId: "s0", featureBranch: "feat/x", tasks, limit: 10, runningCount: 8 });
  assert.equal(plan.dispatch.length, 2, "only 2 slots left under the cap");
  assert.equal(plan.queued.length, 3);
});

test("maxConcurrentTasks reads env with a default and clamp", () => {
  assert.equal(maxConcurrentTasks({}), 10);
  assert.equal(maxConcurrentTasks({ ARKE_MAX_CONCURRENT_TASKS: "3" }), 3);
  assert.equal(maxConcurrentTasks({ ARKE_MAX_CONCURRENT_TASKS: "0" }), 10, "invalid → default");
});
