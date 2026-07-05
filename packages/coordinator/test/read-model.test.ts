import assert from "node:assert/strict";
import { test } from "node:test";
import type { DomainEvent } from "@arke/contracts";
import { ReadModel } from "../src/read-model.js";

const base = { seq: 0, ts: 0, harness: "OpenCode" };

/** A folded card is keyed on its spec id. */
function cardFor(rm: ReadModel, specId = "SPEC-1") {
  return rm.snapshot().find((c) => c.id === specId)!;
}
function sessionIn(rm: ReadModel, sessionId: string, specId = "SPEC-1") {
  return cardFor(rm, specId).sessions.find((s) => s.sessionId === sessionId)!;
}
/** Register a running task session under a spec (folds a session onto the spec's card). */
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

  const entry = sessionIn(rm, "s1").transcript.find((t) => t.messageId === "m1")!;
  assert.equal(entry.text, "Adding the key column.");
});

test("message.updated replaces text, closes streaming, and discards buffered parts", () => {
  const rm = new ReadModel();
  withCard(rm, "s1");
  // a stray out-of-order part with no predecessor stays buffered (text empty so far)
  rm.apply({ ...base, type: "message.part", sessionId: "s1", messageId: "m1", partIndex: 5, delta: "ignored", role: "assistant", done: false });
  rm.apply({ ...base, type: "message.updated", sessionId: "s1", messageId: "m1", role: "assistant", text: "Final authoritative text.", toolCalls: [], isStreaming: false });

  const entry = sessionIn(rm, "s1").transcript.find((t) => t.messageId === "m1")!;
  assert.equal(entry.text, "Final authoritative text.");
  assert.equal(entry.isStreaming, false);
  assert.equal(entry.text.includes("ignored"), false);
});

test("transcript events do not change a card's column", () => {
  const rm = new ReadModel();
  rm.apply({ ...base, type: "spec.status", specId: "SPEC-1", status: "in-review" });
  rm.apply({ ...base, type: "session.status", sessionId: "auth-1", specId: "SPEC-1", kind: "spec", status: "running" });
  const before = cardFor(rm).column;
  rm.apply({ ...base, type: "message.part", sessionId: "auth-1", messageId: "m1", partIndex: 0, delta: "x", role: "assistant", done: true });
  rm.apply({ ...base, type: "message.updated", sessionId: "auth-1", messageId: "m1", role: "assistant", text: "x", toolCalls: [], isStreaming: false });
  assert.equal(cardFor(rm).column, before);
});

test("a part for an unknown session is ignored (no card created)", () => {
  const rm = new ReadModel();
  rm.apply({ ...base, type: "message.part", sessionId: "ghost", messageId: "m1", partIndex: 0, delta: "x", role: "assistant", done: true });
  assert.equal(rm.snapshot().length, 0);
});

// ---- SPEC-023: one card per specification ----

test("SPEC-023: multiple sessions fold into ONE card per spec (no duplicate session cards)", () => {
  const rm = new ReadModel();
  rm.apply({ ...base, type: "spec.status", specId: "SPEC-1", status: "approved" });
  rm.apply({ ...base, type: "session.status", sessionId: "ses_auth", specId: "SPEC-1", kind: "spec", status: "idle" });
  rm.apply({ ...base, type: "session.status", sessionId: "ses_a", specId: "SPEC-1", kind: "task", status: "running" });
  rm.apply({ ...base, type: "session.status", sessionId: "ses_b", specId: "SPEC-1", kind: "task", status: "running" });

  const snap = rm.snapshot();
  assert.equal(snap.length, 1, "exactly one card");
  assert.equal(snap[0].id, "SPEC-1", "card is keyed on the spec id");
  assert.equal(snap[0].sessions.length, 3, "all three sessions folded in");
  // No card is titled/keyed by a raw session id.
  assert.equal(snap.some((c) => c.id.startsWith("ses_")), false);
});

test("SPEC-023: column aggregates sessions — any running task ⇒ implementing", () => {
  const rm = new ReadModel();
  rm.apply({ ...base, type: "spec.status", specId: "SPEC-1", status: "approved" });
  rm.apply({ ...base, type: "session.status", sessionId: "ses_a", specId: "SPEC-1", kind: "task", status: "running" });
  rm.apply({ ...base, type: "session.status", sessionId: "ses_b", specId: "SPEC-1", kind: "task", status: "done" });
  assert.equal(cardFor(rm).column, "implementing", "any-running wins over any-done");
});

test("SPEC-023: an interrupted delivery surfaces as needs-human, not a silent revert to approved", () => {
  const rm = new ReadModel();
  rm.apply({ ...base, type: "spec.status", specId: "SPEC-1", status: "approved" });
  rm.apply({ ...base, type: "session.status", sessionId: "ses_a", specId: "SPEC-1", kind: "task", status: "interrupted" });
  const card = cardFor(rm);
  assert.equal(card.column, "needs-human");
  assert.notEqual(card.column, "approved");
});

// ---- SPEC-012 gate lifecycle (now on the folded card's aggregate) ----

test("needsHuman is sticky while a permission is open — a running status does not clear it (SPEC-012)", () => {
  const rm = new ReadModel();
  withCard(rm, "s1");
  rm.apply({ ...base, type: "permission.asked", sessionId: "s1", permissionId: "p1", title: "Write file" } as DomainEvent);
  assert.equal(cardFor(rm).needsHuman, true);
  assert.equal(cardFor(rm).column, "needs-human");
  // An unrelated running status must NOT vacate needs-human while the permission is open.
  rm.apply({ ...base, type: "session.status", sessionId: "s1", specId: "SPEC-1", kind: "task", status: "running" });
  assert.equal(cardFor(rm).needsHuman, true, "still needs human");
  assert.equal(cardFor(rm).column, "needs-human");
  // The reply clears it.
  rm.apply({ ...base, type: "permission.replied", sessionId: "s1", permissionId: "p1", granted: true } as DomainEvent);
  assert.equal(cardFor(rm).needsHuman, false);
});

test("elicitation drives the same needs-human lifecycle (SPEC-012)", () => {
  const rm = new ReadModel();
  withCard(rm, "s2");
  rm.apply({ ...base, type: "elicitation.asked", sessionId: "s2", elicitationId: "q1", question: "Proceed?" } as DomainEvent);
  assert.equal(cardFor(rm).needsHuman, true);
  rm.apply({ ...base, type: "elicitation.rejected", sessionId: "s2", elicitationId: "q1" } as DomainEvent);
  assert.equal(cardFor(rm).needsHuman, false);
});

test("two concurrent gates: needs-human clears only when both resolve (SPEC-012)", () => {
  const rm = new ReadModel();
  withCard(rm, "s3");
  rm.apply({ ...base, type: "permission.asked", sessionId: "s3", permissionId: "p1", title: "A" } as DomainEvent);
  rm.apply({ ...base, type: "elicitation.asked", sessionId: "s3", elicitationId: "q1", question: "B" } as DomainEvent);
  rm.apply({ ...base, type: "permission.replied", sessionId: "s3", permissionId: "p1", granted: true } as DomainEvent);
  assert.equal(cardFor(rm).needsHuman, true, "elicitation still open");
  rm.apply({ ...base, type: "elicitation.replied", sessionId: "s3", elicitationId: "q1", answer: "ok" } as DomainEvent);
  assert.equal(cardFor(rm).needsHuman, false, "both resolved");
});

test("SPEC-023: two gates on DIFFERENT sessions of one spec — card clears only when both resolve", () => {
  const rm = new ReadModel();
  rm.apply({ ...base, type: "spec.status", specId: "SPEC-1", status: "approved" });
  rm.apply({ ...base, type: "session.status", sessionId: "ses_a", specId: "SPEC-1", kind: "task", status: "running" });
  rm.apply({ ...base, type: "session.status", sessionId: "ses_b", specId: "SPEC-1", kind: "task", status: "running" });
  rm.apply({ ...base, type: "permission.asked", sessionId: "ses_a", permissionId: "pa", title: "A" } as DomainEvent);
  rm.apply({ ...base, type: "permission.asked", sessionId: "ses_b", permissionId: "pb", title: "B" } as DomainEvent);
  rm.apply({ ...base, type: "permission.replied", sessionId: "ses_a", permissionId: "pa", granted: true } as DomainEvent);
  assert.equal(cardFor(rm).needsHuman, true, "the other session's gate is still open");
  rm.apply({ ...base, type: "permission.replied", sessionId: "ses_b", permissionId: "pb", granted: true } as DomainEvent);
  assert.equal(cardFor(rm).needsHuman, false, "both sessions' gates resolved");
});

test("a permission.asked for an unknown session does not pin a later card in needs-human (SPEC-012)", () => {
  const rm = new ReadModel();
  // Permission arrives BEFORE any card/session exists — it must be discarded, not tracked.
  rm.apply({ ...base, type: "permission.asked", sessionId: "ghost", permissionId: "p1", title: "x" } as DomainEvent);
  // The session is registered later by a normal running status — it must NOT be stuck in needs-human.
  rm.apply({ ...base, type: "session.status", sessionId: "ghost", specId: "SPEC-1", kind: "task", status: "running" });
  const card = cardFor(rm);
  assert.equal(card.needsHuman, false, "no ghost gate pins the card");
  assert.notEqual(card.column, "needs-human");
});
