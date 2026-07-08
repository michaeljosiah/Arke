import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeliveryPrompt, deliveryWorktreeBranch, parseTasks, shSingleQuote, specSlug, taskKey } from "../src/delivery.js";

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

test("parseTasks handles CRLF line endings (a git worktree checkout on Windows — SPEC-028)", () => {
  const crlf = TASKS_MD.replace(/\n/g, "\r\n");
  const tasks = parseTasks(crlf);
  assert.equal(tasks.length, 3, "CRLF must not swallow the task lines");
  assert.deepEqual(tasks.map((t) => t.done), [false, true, false]);
  assert.equal(tasks[0]!.text, "First task", "no trailing \\r leaks into the task text");
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

test("buildDeliveryPrompt appends a PR instruction when autoOpenPr is on, no baseBranch → plain --fill", () => {
  const prompt = buildDeliveryPrompt("docs/specifications/example.md", parseTasks(TASKS_MD), { autoOpenPr: true });
  assert.match(prompt, /open a pull request/i);
  assert.match(prompt, /gh pr create --fill/);
  assert.match(prompt, /pre-authorised/i);
  assert.ok(!/--base/.test(prompt), "no baseBranch given → no --base flag");
});

test("buildDeliveryPrompt auto-PR targets the feature branch when given, shell-quoted (SPEC-031)", () => {
  const prompt = buildDeliveryPrompt("docs/specifications/example.md", parseTasks(TASKS_MD), { autoOpenPr: true, baseBranch: "feat/x" });
  assert.match(prompt, /gh pr create --base 'feat\/x' --fill/, "targets the feature branch, single-quoted");
  assert.match(prompt, /the `feat\/x` branch/, "prose names the base branch");
});

test("shSingleQuote wraps in single quotes and POSIX-escapes an embedded quote", () => {
  assert.equal(shSingleQuote("feat/x"), "'feat/x'");
  assert.equal(shSingleQuote("feat/$(whoami)"), "'feat/$(whoami)'", "metacharacters stay inert inside single quotes");
  assert.equal(shSingleQuote("o'brien"), "'o'\\''brien'", "an embedded ' is closed, escaped, and reopened");
});

test("buildDeliveryPrompt shell-quotes a base branch containing shell metacharacters (injection-safe)", () => {
  // Git ref names can't contain spaces but DO allow `$()` — an unquoted `feat/$(whoami)` would execute.
  const prompt = buildDeliveryPrompt("docs/specifications/example.md", parseTasks(TASKS_MD), { autoOpenPr: true, baseBranch: "feat/$(whoami)" });
  assert.match(prompt, /gh pr create --base 'feat\/\$\(whoami\)' --fill/, "the metacharacters are inside single quotes — inert");
  const prompt2 = buildDeliveryPrompt("docs/specifications/example.md", parseTasks(TASKS_MD), { autoOpenPr: true, baseBranch: "o'brien" });
  assert.ok(prompt2.includes("--base 'o'\\''brien'"), "an embedded single quote is POSIX-escaped");
});
