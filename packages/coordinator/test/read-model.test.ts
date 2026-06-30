import assert from "node:assert/strict";
import { test } from "node:test";
import type { DomainEvent } from "@arke/contracts";
import { ReadModel } from "../src/read-model.js";

const base = { seq: 0, ts: 0, harness: "OpenCode" };

function withCard(rm: ReadModel, sessionId: string, specId = "SPEC-1") {
  rm.apply({ ...base, type: "session.status", sessionId, specId, kind: "task", status: "running" });
}

test("parts accumulate in partIndex order even when they arrive out of order", () => {
  const rm = new ReadModel();
  withCard(rm, "s1");
  const part = (partIndex: number, delta: string, done = false): DomainEvent => ({
    ...base,
    type: "message.part",
    sessionId: "s1",
    messageId: "m1",
    partIndex,
    delta,
    role: "assistant",
    done,
  });
  rm.apply(part(0, "Adding "));
  rm.apply(part(2, "column.", true));
  rm.apply(part(1, "the key "));

  const card = rm.snapshot().find((c) => c.id === "s1")!;
  const entry = card.transcript.find((t) => t.messageId === "m1")!;
  assert.equal(entry.text, "Adding the key column.");
});

test("message.updated replaces text, closes streaming, and discards buffered parts", () => {
  const rm = new ReadModel();
  withCard(rm, "s1");
  // a stray out-of-order part with no predecessor stays buffered (text empty so far)
  rm.apply({ ...base, type: "message.part", sessionId: "s1", messageId: "m1", partIndex: 5, delta: "ignored", role: "assistant", done: false });
  rm.apply({ ...base, type: "message.updated", sessionId: "s1", messageId: "m1", role: "assistant", text: "Final authoritative text.", toolCalls: [], isStreaming: false });

  const entry = rm.snapshot().find((c) => c.id === "s1")!.transcript.find((t) => t.messageId === "m1")!;
  assert.equal(entry.text, "Final authoritative text.");
  assert.equal(entry.isStreaming, false);
  // the buffered, never-drained part (index 5) was discarded — it did not corrupt the text
  assert.equal(entry.text.includes("ignored"), false);
});

test("transcript events do not change a card's column", () => {
  const rm = new ReadModel();
  rm.apply({ ...base, type: "spec.status", specId: "SPEC-1", status: "in-review" });
  rm.apply({ ...base, type: "session.status", sessionId: "SPEC-1", specId: "SPEC-1", kind: "spec", status: "running" });
  const before = rm.snapshot().find((c) => c.id === "SPEC-1")!.column;
  rm.apply({ ...base, type: "message.part", sessionId: "SPEC-1", messageId: "m1", partIndex: 0, delta: "x", role: "assistant", done: true });
  rm.apply({ ...base, type: "message.updated", sessionId: "SPEC-1", messageId: "m1", role: "assistant", text: "x", toolCalls: [], isStreaming: false });
  const after = rm.snapshot().find((c) => c.id === "SPEC-1")!.column;
  assert.equal(after, before);
});

test("a part for an unknown session is ignored (no card created)", () => {
  const rm = new ReadModel();
  rm.apply({ ...base, type: "message.part", sessionId: "ghost", messageId: "m1", partIndex: 0, delta: "x", role: "assistant", done: true });
  assert.equal(rm.snapshot().length, 0);
});

test("needsHuman is sticky while a permission is open — a running status does not clear it (SPEC-012)", () => {
  const rm = new ReadModel();
  withCard(rm, "s1");
  rm.apply({ ...base, type: "permission.asked", sessionId: "s1", permissionId: "p1", title: "Write file" } as DomainEvent);
  let card = rm.snapshot().find((c) => c.id === "s1")!;
  assert.equal(card.needsHuman, true);
  assert.equal(card.column, "needs-human");
  // An unrelated running status must NOT vacate needs-human while the permission is open.
  rm.apply({ ...base, type: "session.status", sessionId: "s1", specId: "SPEC-1", kind: "task", status: "running" });
  card = rm.snapshot().find((c) => c.id === "s1")!;
  assert.equal(card.needsHuman, true, "still needs human");
  assert.equal(card.column, "needs-human");
  // The reply clears it.
  rm.apply({ ...base, type: "permission.replied", sessionId: "s1", permissionId: "p1", granted: true } as DomainEvent);
  card = rm.snapshot().find((c) => c.id === "s1")!;
  assert.equal(card.needsHuman, false);
});

test("elicitation drives the same needs-human lifecycle (SPEC-012)", () => {
  const rm = new ReadModel();
  withCard(rm, "s2");
  rm.apply({ ...base, type: "elicitation.asked", sessionId: "s2", elicitationId: "q1", question: "Proceed?" } as DomainEvent);
  assert.equal(rm.snapshot().find((c) => c.id === "s2")!.needsHuman, true);
  rm.apply({ ...base, type: "elicitation.rejected", sessionId: "s2", elicitationId: "q1" } as DomainEvent);
  assert.equal(rm.snapshot().find((c) => c.id === "s2")!.needsHuman, false);
});

test("two concurrent gates: needs-human clears only when both resolve (SPEC-012)", () => {
  const rm = new ReadModel();
  withCard(rm, "s3");
  rm.apply({ ...base, type: "permission.asked", sessionId: "s3", permissionId: "p1", title: "A" } as DomainEvent);
  rm.apply({ ...base, type: "elicitation.asked", sessionId: "s3", elicitationId: "q1", question: "B" } as DomainEvent);
  rm.apply({ ...base, type: "permission.replied", sessionId: "s3", permissionId: "p1", granted: true } as DomainEvent);
  assert.equal(rm.snapshot().find((c) => c.id === "s3")!.needsHuman, true, "elicitation still open");
  rm.apply({ ...base, type: "elicitation.replied", sessionId: "s3", elicitationId: "q1", answer: "ok" } as DomainEvent);
  assert.equal(rm.snapshot().find((c) => c.id === "s3")!.needsHuman, false, "both resolved");
});

test("a permission.asked for an unknown session does not pin a later card in needs-human (SPEC-012)", () => {
  const rm = new ReadModel();
  // Permission arrives BEFORE any card exists for this session — it must be discarded, not tracked.
  rm.apply({ ...base, type: "permission.asked", sessionId: "ghost", permissionId: "p1", title: "x" } as DomainEvent);
  // The card is created later by a normal running status — it must NOT be stuck in needs-human.
  rm.apply({ ...base, type: "session.status", sessionId: "ghost", specId: "SPEC-1", kind: "task", status: "running" });
  const card = rm.snapshot().find((c) => c.id === "ghost")!;
  assert.equal(card.needsHuman, false, "no ghost gate pins the card");
  assert.notEqual(card.column, "needs-human");
});
