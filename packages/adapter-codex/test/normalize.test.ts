import assert from "node:assert/strict";
import { test } from "node:test";
import { createNormalizeState, normalize, type SessionIdentity } from "../src/index.js";

const IDENT: SessionIdentity = { specId: "SPEC-1", kind: "spec" };
const run = (method: string, params: Record<string, unknown>) =>
  normalize(method, params, "sess-1", IDENT, "Codex", createNormalizeState());

test("turn/started → session.status running (model from the turn object when present)", () => {
  const evs = run("turn/started", { threadId: "T1", turn: { id: "turn-1", model: "gpt-5.4" } });
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

test("item/completed agentMessage → a non-streaming message.updated snapshot", () => {
  // Real ThreadItem: { type: "agentMessage", id, text } (camelCase, verified against the generated protocol).
  const evs = run("item/completed", { threadId: "T1", item: { id: "m1", type: "agentMessage", text: "Done." } });
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, "message.updated");
  assert.equal((evs[0] as any).text, "Done.");
  assert.equal((evs[0] as any).isStreaming, false);
  assert.equal((evs[0] as any).role, "assistant");
});

test("turn/plan/updated → todo.updated with done derived from status", () => {
  // Real notification: TurnPlanUpdatedNotification = { threadId, turnId, explanation, plan: [{ step, status }] }.
  const evs = run("turn/plan/updated", {
    threadId: "T1",
    plan: [{ step: "Read spec", status: "completed" }, { step: "Implement", status: "inProgress" }],
  });
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, "todo.updated");
  assert.deepEqual((evs[0] as any).todos, [
    { id: "plan-0", text: "Read spec", done: true },
    { id: "plan-1", text: "Implement", done: false },
  ]);
});

test("turn/completed → session.status idle + turn.quiescent (turnId from the turn object)", () => {
  const evs = run("turn/completed", { threadId: "T1", turn: { id: "turn-9" } });
  assert.equal(evs.length, 2);
  assert.equal(evs[0]!.type, "session.status");
  assert.equal((evs[0] as any).status, "idle");
  assert.equal(evs[1]!.type, "turn.quiescent");
  assert.equal((evs[1] as any).turnId, "turn-9");
});

test("error → session.status error", () => {
  assert.equal((run("error", { threadId: "T1" })[0] as any).status, "error");
});

test("a FAILED turn/completed surfaces error, not idle (so it doesn't overwrite a prior error)", () => {
  const evs = run("turn/completed", { threadId: "T1", turn: { id: "turn-1", status: "failed" } });
  assert.equal((evs[0] as any).status, "error", "failed turn → error status");
  assert.equal(evs[1]!.type, "turn.quiescent", "still emits quiescence so the turn settles");
});

test("internal items and unknown notifications normalise to nothing", () => {
  assert.deepEqual(run("item/completed", { threadId: "T1", item: { type: "commandExecution", command: "ls" } }), []);
  assert.deepEqual(run("item/completed", { threadId: "T1", item: { type: "fileChange", changes: [] } }), []);
  assert.deepEqual(run("thread/started", { thread: { id: "T1" } }), []);
  assert.deepEqual(run("something/unmapped", {}), []);
});
