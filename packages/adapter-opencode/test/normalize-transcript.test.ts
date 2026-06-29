import assert from "node:assert/strict";
import { test } from "node:test";
import { type EventIdentity, normalize } from "../src/index.js";

const HARNESS = "OpenCode";
const lookup = (_sid: string): EventIdentity | undefined => undefined; // transcript events need no identity

test("message.part.updated maps to message.part with correlationId = messageID", () => {
  const out = normalize(
    {
      type: "message.part.updated",
      properties: {
        session_id: "s1",
        message_id: "m9",
        part_index: 2,
        part: { delta: "hello", type: "text" },
      },
    },
    lookup,
    HARNESS,
  );
  assert.equal(out.kind, "event");
  if (out.kind !== "event" || out.event.type !== "message.part") return assert.fail();
  assert.equal(out.event.messageId, "m9");
  assert.equal(out.event.partIndex, 2);
  assert.equal(out.event.delta, "hello");
  assert.equal(out.event.role, "assistant");
  assert.equal(out.event.correlationId, "m9");
});

test("message.updated maps to message.updated, closing the stream", () => {
  const out = normalize(
    {
      type: "message.updated",
      properties: {
        session_id: "s1",
        message_id: "m9",
        message: { role: "assistant", text: "All done.", isStreaming: false },
      },
    },
    lookup,
    HARNESS,
  );
  if (out.kind !== "event" || out.event.type !== "message.updated") return assert.fail();
  assert.equal(out.event.text, "All done.");
  assert.equal(out.event.isStreaming, false);
  assert.equal(out.event.correlationId, "m9");
});

test("message.part.updated without ids is dead-lettered", () => {
  const out = normalize({ type: "message.part.updated", properties: { session_id: "s1" } }, lookup, HARNESS);
  assert.equal(out.kind, "dead-letter");
});

test("message.removed is still deliberately ignored", () => {
  const out = normalize({ type: "message.removed", properties: { session_id: "s1" } }, lookup, HARNESS);
  assert.equal(out.kind, "ignore");
});
