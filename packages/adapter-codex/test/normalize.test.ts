import assert from "node:assert/strict";
import { test } from "node:test";
import { createNormalizeState, normalize, type SessionIdentity } from "../src/index.js";

const IDENT: SessionIdentity = { specId: "SPEC-1", kind: "spec" };
const run = (method: string, params: Record<string, unknown>) =>
  normalize(method, params, "sess-1", IDENT, "Codex", createNormalizeState());

test("turn/started → session.status running (with model when present)", () => {
  const evs = run("turn/started", { threadId: "T1", model: "gpt-5.4" });
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, "session.status");
  assert.equal((evs[0] as any).status, "running");
  assert.equal((evs[0] as any).model, "gpt-5.4");
  assert.equal((evs[0] as any).specId, "SPEC-1");
});

test("item/agentMessage/delta → a streaming message.part with a stable partIndex", () => {
  const state = createNormalizeState();
  const a = normalize("item/agentMessage/delta", { itemId: "m1", delta: { text: "Hel" } }, "s", IDENT, "Codex", state);
  const b = normalize("item/agentMessage/delta", { itemId: "m1", delta: "lo" }, "s", IDENT, "Codex", state);
  assert.equal(a[0]!.type, "message.part");
  assert.equal((a[0] as any).partIndex, 0);
  assert.equal((a[0] as any).delta, "Hel");
  assert.equal((b[0] as any).partIndex, 1, "partIndex increments per message id");
  assert.equal((b[0] as any).delta, "lo");
});

test("item/completed agent_message → a non-streaming message.updated snapshot", () => {
  const evs = run("item/completed", { item: { id: "m1", type: "agent_message", text: "Done." } });
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, "message.updated");
  assert.equal((evs[0] as any).text, "Done.");
  assert.equal((evs[0] as any).isStreaming, false);
  assert.equal((evs[0] as any).role, "assistant");
});

test("item/completed plan_update → todo.updated with done derived from status", () => {
  const evs = run("item/completed", {
    item: { type: "plan_update", plan: [{ step: "Read spec", status: "completed" }, { step: "Implement", status: "in_progress" }] },
  });
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, "todo.updated");
  assert.deepEqual((evs[0] as any).todos, [
    { id: "plan-0", text: "Read spec", done: true },
    { id: "plan-1", text: "Implement", done: false },
  ]);
});

test("turn/completed → session.status idle + turn.quiescent", () => {
  const evs = run("turn/completed", { threadId: "T1", turnId: "turn-9", usage: { output_tokens: 12 } });
  assert.equal(evs.length, 2);
  assert.equal(evs[0]!.type, "session.status");
  assert.equal((evs[0] as any).status, "idle");
  assert.equal(evs[1]!.type, "turn.quiescent");
  assert.equal((evs[1] as any).turnId, "turn-9");
});

test("turn/failed and error → session.status error", () => {
  assert.equal((run("turn/failed", { error: { message: "boom" } })[0] as any).status, "error");
  assert.equal((run("error", {})[0] as any).status, "error");
});

test("internal and unknown items normalise to nothing", () => {
  assert.deepEqual(run("item/completed", { item: { type: "command_execution", command: "ls" } }), []);
  assert.deepEqual(run("item/completed", { item: { type: "file_change", changes: [] } }), []);
  assert.deepEqual(run("thread/started", { threadId: "T1" }), []);
  assert.deepEqual(run("something/unmapped", {}), []);
});
