import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeliveryPrompt, deliveryWorktreeBranch, parseTasks, specSlug, taskKey } from "../src/delivery.js";

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
  assert.equal(specSlug("SPEC-2026-06-28-single-session-delivery"), "spec-2026-06-28-single-session-delivery");
  assert.equal(specSlug("Foo Bar!"), "foo-bar");
});

test("taskKey is a stable content hash, invariant to position", () => {
  assert.equal(taskKey("First task"), taskKey("First task"));
  assert.notEqual(taskKey("First task"), taskKey("Other task"));
});

test("task keys are stable when a task is inserted (the completion check survives list edits)", () => {
  const before = parseTasks(TASKS_MD);
  const after = parseTasks(TASKS_MD.replace("## Tasks\n", "## Tasks\n- [ ] Inserted at top\n"));
  const firstBefore = before.find((t) => t.text === "First task")!;
  const firstAfter = after.find((t) => t.text === "First task")!;
  assert.notEqual(firstBefore.index, firstAfter.index, "positional index shifted");
  assert.equal(firstBefore.key, firstAfter.key, "stable key unchanged");
});

test("deliveryWorktreeBranch is deterministic, one per spec — sibling form (no git D/F conflict, and never collides with the feature branch itself)", () => {
  assert.equal(deliveryWorktreeBranch("feat/x"), "feat/x--delivery");
  assert.equal(deliveryWorktreeBranch("feat/x"), deliveryWorktreeBranch("feat/x"));
  assert.notEqual(deliveryWorktreeBranch("feat/x"), "feat/x", "never the feature branch itself — avoids 'already checked out' conflicts");
});

test("buildDeliveryPrompt lists every unchecked task and omits already-checked ones", () => {
  const tasks = parseTasks(TASKS_MD);
  const prompt = buildDeliveryPrompt("docs/specifications/example.md", tasks);
  assert.ok(prompt.includes("docs/specifications/example.md"), "references the spec file");
  assert.ok(prompt.includes("First task"));
  assert.ok(prompt.includes("Third task"));
  assert.ok(!prompt.includes("Already done"), "checked-off tasks are not re-prompted");
});

test("buildDeliveryPrompt tells the agent the checklist itself is the completion signal", () => {
  const prompt = buildDeliveryPrompt("docs/specifications/example.md", parseTasks(TASKS_MD));
  assert.match(prompt, /check it off/i);
});

test("buildDeliveryPrompt omits any PR instruction by default (SPEC-030 auto-PR off)", () => {
  const prompt = buildDeliveryPrompt("docs/specifications/example.md", parseTasks(TASKS_MD));
  assert.ok(!/pull request/i.test(prompt), "default prompt says nothing about PRs — delivery stops at the diff gate");
  assert.ok(!/gh pr create/.test(prompt));
});

test("buildDeliveryPrompt appends a PR instruction when autoOpenPr is on, targeting the base branch", () => {
  const prompt = buildDeliveryPrompt("docs/specifications/example.md", parseTasks(TASKS_MD), { autoOpenPr: true, baseBranch: "feat/x" });
  assert.match(prompt, /open a pull request/i);
  assert.match(prompt, /gh pr create --base feat\/x --fill/);
  assert.match(prompt, /pre-authorised/i);
});

test("buildDeliveryPrompt auto-PR without a base branch omits --base (agent falls back to the repo default)", () => {
  const prompt = buildDeliveryPrompt("docs/specifications/example.md", parseTasks(TASKS_MD), { autoOpenPr: true });
  assert.match(prompt, /gh pr create --fill/);
  assert.ok(!/--base/.test(prompt), "no base branch → no --base flag");
});
