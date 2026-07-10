import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionCoordinator, TurnWaiters, DeadLetterSink } from "../src/index.js";

/** SPEC-037 Increment 2: the resilience primitives — event-confirmed approvals, completion-aware send,
 *  and the dead-letter sink — tested directly (the fake-transport end-to-end lands with reconnect). */

// ---- PermissionCoordinator: confirmed / unconfirmed(timeout) / duplicate ----

test("a decision confirms when the stream reflects the resolution", async () => {
  const c = new PermissionCoordinator(1000);
  const p = c.decide("el_1");
  assert.equal(c.pending("el_1"), true);
  c.confirm("el_1");
  assert.equal(await p, "confirmed");
  assert.equal(c.pending("el_1"), false);
});

test("a decision times out to unconfirmed — never a false confirmed — and a late confirm is a safe no-op", async () => {
  const c = new PermissionCoordinator(20); // tiny timeout
  const p = c.decide("el_2");
  assert.equal(await p, "unconfirmed");
  assert.doesNotThrow(() => c.confirm("el_2")); // arrives after timeout → reconciled, no throw
});

test("a second in-flight decision on the same id is a duplicate", async () => {
  const c = new PermissionCoordinator(1000);
  const first = c.decide("el_3");
  assert.equal(await c.decide("el_3"), "duplicate"); // while the first is still pending
  c.confirm("el_3");
  assert.equal(await first, "confirmed");
});

test("confirm for an unknown id is a no-op (does not throw)", () => {
  const c = new PermissionCoordinator(1000);
  assert.doesNotThrow(() => c.confirm("never-registered"));
});

// ---- TurnWaiters: quiesce settles waiters; timeout resolves ----

test("a turn waiter resolves when the session quiesces", async () => {
  const w = new TurnWaiters();
  const waited = w.wait("s1", 1000);
  w.quiesce("s1");
  await waited; // resolves (no assertion needed — a hang would fail the test)
});

test("a turn waiter resolves on timeout if quiescence never arrives (send never hangs)", async () => {
  const w = new TurnWaiters();
  await w.wait("s2", 20); // resolves via timeout
});

test("quiesce settles ALL waiters for a session and none for another", async () => {
  const w = new TurnWaiters();
  const a = w.wait("s3", 1000);
  const b = w.wait("s3", 1000);
  let otherDone = false;
  const other = w.wait("s4", 1000).then(() => { otherDone = true; });
  w.quiesce("s3");
  await Promise.all([a, b]);
  assert.equal(otherDone, false, "s4's waiter is untouched by an s3 quiesce");
  w.quiesce("s4");
  await other;
});

// ---- DeadLetterSink: records, caps, notifies ----

test("the dead-letter sink records type + reason and notifies", () => {
  const seen: string[] = [];
  const sink = new DeadLetterSink((d) => seen.push(d.type ?? "(none)"));
  sink.record("s1", { type: "session.mystery", foo: 1 }, "unmapped-frame");
  const entries = sink.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.type, "session.mystery");
  assert.equal(entries[0]!.reason, "unmapped-frame");
  assert.equal(entries[0]!.sessionId, "s1");
  assert.deepEqual(seen, ["session.mystery"]);
});

test("the dead-letter ring is bounded (oldest dropped past the cap)", () => {
  const sink = new DeadLetterSink();
  for (let i = 0; i < 250; i++) sink.record("s", { type: `t${i}` }, "unmapped-frame");
  const entries = sink.entries();
  assert.ok(entries.length <= 200, "ring capped at 200");
  assert.equal(entries[entries.length - 1]!.type, "t249", "newest retained");
});

test("an unserialisable frame still records (no throw)", () => {
  const sink = new DeadLetterSink();
  const circular: any = { type: "loop" };
  circular.self = circular;
  assert.doesNotThrow(() => sink.record("s", circular, "unmapped-frame"));
  assert.equal(sink.entries()[0]!.snapshot, "[unserialisable frame]");
});
