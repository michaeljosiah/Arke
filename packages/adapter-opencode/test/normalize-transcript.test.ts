import assert from "node:assert/strict";
import { test } from "node:test";
import { type EventIdentity, createNormalizeState, normalize } from "../src/index.js";

const HARNESS = "OpenCode";
const noIdentity = (_sid: string): EventIdentity | undefined => undefined;
const withIdentity = (_sid: string): EventIdentity | undefined => ({ specId: "SPEC-1", kind: "spec" });

/**
 * OpenCode 1.17.11 splits a turn's transcript across frames: the role arrives on
 * `message.updated` (`properties.info.role`) while the text arrives on `message.part.updated`
 * (`properties.part.text`, a full snapshot), and `session.idle` signals completion. These tests
 * pin the normaliser against the real captured shapes.
 */

test("message.updated records the role and emits nothing (text comes via the parts)", () => {
  const state = createNormalizeState();
  const out = normalize(
    { type: "message.updated", properties: { sessionID: "s1", info: { id: "m9", role: "assistant" } } },
    noIdentity,
    HARNESS,
    state,
  );
  assert.equal(out.kind, "ignore");
  assert.equal(state.roleByMessage.get("m9"), "assistant");
});

test("message.part.updated maps to message.updated with the recorded role + full snapshot text", () => {
  const state = createNormalizeState();
  // role first (message.updated.info), then the text part
  normalize({ type: "message.updated", properties: { sessionID: "s1", info: { id: "m9", role: "assistant" } } }, noIdentity, HARNESS, state);
  const out = normalize(
    {
      type: "message.part.updated",
      properties: { sessionID: "s1", part: { type: "text", text: "PONG", messageID: "m9", id: "prt_1" } },
    },
    noIdentity,
    HARNESS,
    state,
  );
  if (out.kind !== "event" || out.event.type !== "message.updated") return assert.fail();
  assert.equal(out.event.messageId, "m9");
  assert.equal(out.event.text, "PONG");
  assert.equal(out.event.role, "assistant");
  assert.equal(out.event.correlationId, "m9");
  assert.equal(out.event.isStreaming, true);
});

test("a user message's part is attributed to the user role, not assistant", () => {
  const state = createNormalizeState();
  normalize({ type: "message.updated", properties: { sessionID: "s1", info: { id: "mU", role: "user" } } }, noIdentity, HARNESS, state);
  const out = normalize(
    { type: "message.part.updated", properties: { sessionID: "s1", part: { type: "text", text: "hi", messageID: "mU" } } },
    noIdentity,
    HARNESS,
    state,
  );
  if (out.kind !== "event" || out.event.type !== "message.updated") return assert.fail();
  assert.equal(out.event.role, "user");
  assert.equal(out.event.isStreaming, false); // user turns aren't streaming
});

test("message.part.delta is ignored (the part.updated snapshot carries full text)", () => {
  const out = normalize(
    { type: "message.part.delta", properties: { sessionID: "s1", messageID: "m9", partID: "prt_1", field: "text", delta: "PO" } },
    noIdentity,
    HARNESS,
  );
  assert.equal(out.kind, "ignore");
});

test("a non-text part (tool/reasoning) is ignored for now", () => {
  const out = normalize(
    { type: "message.part.updated", properties: { sessionID: "s1", part: { type: "tool", messageID: "m9" } } },
    noIdentity,
    HARNESS,
  );
  assert.equal(out.kind, "ignore");
});

test("session.idle finalises the last message (closes streaming) and emits turn.quiescent", () => {
  const state = createNormalizeState();
  // assistant turn: role + text part recorded into state
  normalize({ type: "message.updated", properties: { sessionID: "s1", info: { id: "m9", role: "assistant" } } }, withIdentity, HARNESS, state);
  normalize({ type: "message.part.updated", properties: { sessionID: "s1", part: { type: "text", text: "PONG", messageID: "m9" } } }, withIdentity, HARNESS, state);
  const out = normalize({ type: "session.idle", properties: { sessionID: "s1" } }, withIdentity, HARNESS, state);
  if (out.kind !== "events") return assert.fail("expected multiple events on idle");
  const types = out.events.map((e) => e.type);
  assert.deepEqual(types, ["session.status", "message.updated", "turn.quiescent"]);
  const status = out.events[0]!;
  if (status.type !== "session.status") return assert.fail();
  assert.equal(status.status, "idle");
  const finalize = out.events[1]!;
  if (finalize.type !== "message.updated") return assert.fail();
  assert.equal(finalize.text, "PONG");
  assert.equal(finalize.isStreaming, false); // streaming closed
  const quies = out.events[2]!;
  if (quies.type !== "turn.quiescent") return assert.fail();
  assert.equal(quies.turnId, "m9");
});

// ---- backward-compat across OpenCode versions (PR #8 review) ----

test("an older message.updated carrying full text + isStreaming:false is emitted, not dropped", () => {
  const state = createNormalizeState();
  const out = normalize(
    {
      type: "message.updated",
      properties: { sessionID: "s1", message: { id: "m1", role: "assistant", text: "done", isStreaming: false } },
    },
    noIdentity,
    HARNESS,
    state,
  );
  if (out.kind !== "event" || out.event.type !== "message.updated") return assert.fail();
  assert.equal(out.event.text, "done");
  assert.equal(out.event.role, "assistant");
  assert.equal(out.event.isStreaming, false);
  assert.equal(out.event.correlationId, "m1");
});

test("message.part.updated accepts lower-camel ids (properties.sessionId + properties.messageId)", () => {
  const out = normalize(
    { type: "message.part.updated", properties: { sessionId: "s1", messageId: "m2", part: { type: "text", text: "hi" } } },
    noIdentity,
    HARNESS,
  );
  if (out.kind !== "event" || out.event.type !== "message.updated") return assert.fail();
  assert.equal(out.event.messageId, "m2");
  assert.equal(out.event.text, "hi");
});

test("an older delta-shaped message.part.updated accumulates instead of clobbering with empty text", () => {
  const state = createNormalizeState();
  normalize({ type: "message.updated", properties: { sessionID: "s1", info: { id: "m3", role: "assistant" } } }, noIdentity, HARNESS, state);
  const a = normalize({ type: "message.part.updated", properties: { sessionID: "s1", part: { type: "text", delta: "PO", messageID: "m3" } } }, noIdentity, HARNESS, state);
  const b = normalize({ type: "message.part.updated", properties: { sessionID: "s1", part: { type: "text", delta: "NG", messageID: "m3" } } }, noIdentity, HARNESS, state);
  if (a.kind !== "event" || a.event.type !== "message.updated") return assert.fail();
  if (b.kind !== "event" || b.event.type !== "message.updated") return assert.fail();
  assert.equal(a.event.text, "PO");
  assert.equal(b.event.text, "PONG"); // accumulated, not "NG"
});

test("a message.part.updated with neither text nor delta is ignored (never coerced to empty)", () => {
  const out = normalize(
    { type: "message.part.updated", properties: { sessionID: "s1", part: { type: "text", messageID: "m4" } } },
    noIdentity,
    HARNESS,
  );
  assert.equal(out.kind, "ignore");
});

test("message.part.updated without ids is dead-lettered", () => {
  const out = normalize({ type: "message.part.updated", properties: { sessionID: "s1", part: {} } }, noIdentity, HARNESS);
  assert.equal(out.kind, "dead-letter");
});

test("message.removed is still deliberately ignored", () => {
  const out = normalize({ type: "message.removed", properties: { sessionID: "s1" } }, noIdentity, HARNESS);
  assert.equal(out.kind, "ignore");
});
