import assert from "node:assert/strict";
import { test } from "node:test";
import { createNormalizeState, normalize, type SessionIdentity } from "../src/index.js";

const HARNESS = "Omnigent";
const SID = "ses_abc";
const ID: SessionIdentity = { specId: "SPEC-1", kind: "spec" };

/**
 * Fixtures mirror Omnigent's OpenAI-Responses-shaped per-session stream frames (ADR-0002 recon):
 * `response.created`, `response.output_text.delta`, `response.output_text.done`,
 * `response.completed`, and `response.elicitation_request`.
 */

test("response.created maps to session.status running and carries identity", () => {
  const out = normalize({ type: "response.created", data: { model: "claude-sonnet" } }, SID, ID, HARNESS, createNormalizeState());
  assert.equal(out.length, 1);
  const ev = out[0]!;
  if (ev.type !== "session.status") return assert.fail();
  assert.equal(ev.status, "running");
  assert.equal(ev.sessionId, SID);
  assert.equal(ev.specId, "SPEC-1");
  assert.equal(ev.kind, "spec");
  assert.equal(ev.model, "claude-sonnet");
});

test("output_text.delta maps to message.part with a monotonic partIndex per message", () => {
  const state = createNormalizeState();
  const a = normalize({ type: "response.output_text.delta", data: { item_id: "msg_1", delta: "Hel" } }, SID, ID, HARNESS, state);
  const b = normalize({ type: "response.output_text.delta", data: { item_id: "msg_1", delta: "lo" } }, SID, ID, HARNESS, state);
  if (a[0]?.type !== "message.part" || b[0]?.type !== "message.part") return assert.fail();
  assert.equal(a[0].messageId, "msg_1");
  assert.equal(a[0].partIndex, 0);
  assert.equal(a[0].delta, "Hel");
  assert.equal(a[0].role, "assistant");
  assert.equal(a[0].correlationId, "msg_1");
  assert.equal(b[0].partIndex, 1); // monotonic for the same message
});

test("an empty delta is dropped (no zero-length part)", () => {
  const out = normalize({ type: "response.output_text.delta", data: { item_id: "msg_1", delta: "" } }, SID, ID, HARNESS, createNormalizeState());
  assert.deepEqual(out, []);
});

test("output_text.done maps to a non-streaming message.updated snapshot", () => {
  const out = normalize({ type: "response.output_text.done", data: { item_id: "msg_1", text: "Hello" } }, SID, ID, HARNESS, createNormalizeState());
  if (out[0]?.type !== "message.updated") return assert.fail();
  assert.equal(out[0].messageId, "msg_1");
  assert.equal(out[0].text, "Hello");
  assert.equal(out[0].role, "assistant");
  assert.equal(out[0].isStreaming, false);
});

test("response.completed fans out to session.status idle + turn.quiescent", () => {
  const out = normalize({ type: "response.completed", data: { response_id: "resp_9" } }, SID, ID, HARNESS, createNormalizeState());
  assert.deepEqual(out.map((e) => e.type), ["session.status", "turn.quiescent"]);
  const status = out[0]!;
  if (status.type !== "session.status") return assert.fail();
  assert.equal(status.status, "idle");
  const quies = out[1]!;
  if (quies.type !== "turn.quiescent") return assert.fail();
  assert.equal(quies.turnId, "resp_9");
});

test("response.failed maps to session.status error", () => {
  const out = normalize({ type: "response.failed", data: {} }, SID, ID, HARNESS, createNormalizeState());
  if (out[0]?.type !== "session.status") return assert.fail();
  assert.equal(out[0].status, "error");
});

test("an elicitation_request maps to permission.asked with the elicitation id", () => {
  const out = normalize(
    { type: "response.elicitation_request", data: { elicitation_id: "el_1", title: "Run tests?", detail: "npm test" } },
    SID,
    ID,
    HARNESS,
    createNormalizeState(),
  );
  if (out[0]?.type !== "permission.asked") return assert.fail();
  assert.equal(out[0].permissionId, "el_1");
  assert.equal(out[0].title, "Run tests?");
  assert.equal(out[0].detail, "npm test");
});

test("an unmapped frame and a non-object are ignored (empty array), never thrown", () => {
  assert.deepEqual(normalize({ type: "response.content_part.added", data: {} }, SID, ID, HARNESS, createNormalizeState()), []);
  assert.deepEqual(normalize(null, SID, ID, HARNESS, createNormalizeState()), []);
  assert.deepEqual(normalize({ data: {} }, SID, ID, HARNESS, createNormalizeState()), []); // no type
});
