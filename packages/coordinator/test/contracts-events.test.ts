import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainEvent } from "@arke/contracts";

const base = { seq: 1, ts: 1, harness: "OpenCode" };

test("message.part parses and carries a correlationId on the envelope", () => {
  const ev = DomainEvent.parse({
    ...base,
    correlationId: "m1",
    type: "message.part",
    sessionId: "s1",
    messageId: "m1",
    partIndex: 0,
    delta: "hi",
    role: "assistant",
    done: false,
  });
  assert.equal(ev.type, "message.part");
  assert.equal(ev.correlationId, "m1");
});

test("message.part rejects a negative partIndex", () => {
  const bad = { ...base, type: "message.part", sessionId: "s1", messageId: "m1", partIndex: -1, delta: "x", role: "assistant", done: false };
  assert.equal(DomainEvent.safeParse(bad).success, false);
});

test("message.updated defaults toolCalls and requires isStreaming", () => {
  const ev = DomainEvent.parse({
    ...base,
    type: "message.updated",
    sessionId: "s1",
    messageId: "m1",
    role: "assistant",
    text: "done",
    isStreaming: false,
  });
  if (ev.type !== "message.updated") return assert.fail();
  assert.deepEqual(ev.toolCalls, []);
  assert.equal(ev.isStreaming, false);
});

test("turn.quiescent parses with sessionId + turnId", () => {
  const ev = DomainEvent.parse({ ...base, type: "turn.quiescent", sessionId: "s1", turnId: "m1" });
  assert.equal(ev.type, "turn.quiescent");
});

test("EventEnvelope correlationId is optional", () => {
  const ev = DomainEvent.parse({ ...base, type: "spec.status", specId: "SPEC-1", status: "draft" });
  assert.equal(ev.correlationId, undefined);
});

test("an unknown event type is rejected by the union", () => {
  assert.equal(DomainEvent.safeParse({ ...base, type: "bogus.event" }).success, false);
});
