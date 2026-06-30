import assert from "node:assert/strict";
import { test } from "node:test";
import { type EventIdentity, normalize } from "../src/index.js";

const HARNESS = "OpenCode";

/** Identity table: a spec session and one of its tasks. */
const identities: Record<string, EventIdentity> = {
  "ses_spec": { specId: "SPEC-2026-06-28-x", kind: "spec" },
  "ses_task": { specId: "SPEC-2026-06-28-x", kind: "task" },
};
const lookup = (sid: string): EventIdentity | undefined => identities[sid];

test("session.idle emits session.status idle + a turn.quiescent receipt (with resolved identity)", () => {
  const out = normalize(
    { type: "session.idle", properties: { session_id: "ses_spec" } },
    lookup,
    HARNESS,
  );
  // session.idle now fans out: status(idle) + turn.quiescent (and a finalise frame when a message
  // was in flight). With no prior message in state here, it's status + quiescent.
  assert.equal(out.kind, "events");
  if (out.kind !== "events") return;
  const status = out.events.find((e) => e.type === "session.status");
  if (!status || status.type !== "session.status") return assert.fail("expected a session.status");
  assert.equal(status.status, "idle");
  assert.equal(status.specId, "SPEC-2026-06-28-x");
  assert.equal(status.kind, "spec");
  assert.ok(out.events.some((e) => e.type === "turn.quiescent"), "expected a turn.quiescent receipt");
});

test("session.error maps to session.status error", () => {
  const out = normalize(
    { type: "session.error", properties: { sessionID: "ses_task" } },
    lookup,
    HARNESS,
  );
  assert.equal(out.kind, "event");
  if (out.kind !== "event" || out.event.type !== "session.status") return assert.fail();
  assert.equal(out.event.status, "error");
  assert.equal(out.event.kind, "task");
});

test("session.status busy maps to running", () => {
  const out = normalize(
    { type: "session.status", properties: { session_id: "ses_spec", status: "busy" } },
    lookup,
    HARNESS,
  );
  if (out.kind !== "event" || out.event.type !== "session.status") return assert.fail();
  assert.equal(out.event.status, "running");
});

test("session.created updates the ownership graph (spec)", () => {
  const out = normalize(
    { type: "session.created", properties: { session: { id: "ses_new", title: "SPEC-9" } } },
    lookup,
    HARNESS,
  );
  assert.equal(out.kind, "graph");
  if (out.kind !== "graph") return;
  assert.deepEqual(out.record, {
    sessionId: "ses_new",
    kind: "spec",
    specId: "SPEC-9",
    parentSessionId: undefined,
  });
});

test("session.created with parentID is a task in the graph", () => {
  const out = normalize(
    {
      type: "session.created",
      properties: { session: { id: "ses_kid", parentID: "ses_spec", title: "SPEC-9" } },
    },
    lookup,
    HARNESS,
  );
  if (out.kind !== "graph") return assert.fail();
  assert.equal(out.record.kind, "task");
  assert.equal(out.record.parentSessionId, "ses_spec");
});

test("todo.updated maps with todo completion flattened to done", () => {
  const out = normalize(
    {
      type: "todo.updated",
      properties: {
        session_id: "ses_task",
        todos: [
          { id: "t1", text: "write tests", completed: true },
          { id: "t2", text: "ship", completed: false },
        ],
      },
    },
    lookup,
    HARNESS,
  );
  if (out.kind !== "event" || out.event.type !== "todo.updated") return assert.fail();
  assert.deepEqual(out.event.todos, [
    { id: "t1", text: "write tests", done: true },
    { id: "t2", text: "ship", done: false },
  ]);
});

test("permission.asked maps with request id and title", () => {
  const out = normalize(
    {
      type: "permission.asked",
      properties: { session_id: "ses_task", request_id: "perm_1", title: "Write file" },
    },
    lookup,
    HARNESS,
  );
  if (out.kind !== "event" || out.event.type !== "permission.asked") return assert.fail();
  assert.equal(out.event.permissionId, "perm_1");
  assert.equal(out.event.title, "Write file");
});

test("permission.replied maps approve to granted", () => {
  const out = normalize(
    {
      type: "permission.replied",
      properties: { session_id: "ses_task", permission_id: "perm_1", response: "approve" },
    },
    lookup,
    HARNESS,
  );
  if (out.kind !== "event" || out.event.type !== "permission.replied") return assert.fail();
  assert.equal(out.event.granted, true);
});

test("an event for an unknown session signals unknown-session, not a guess", () => {
  const out = normalize(
    { type: "session.idle", properties: { session_id: "ses_unknown" } },
    lookup,
    HARNESS,
  );
  assert.equal(out.kind, "unknown-session");
  if (out.kind !== "unknown-session") return;
  assert.equal(out.sessionId, "ses_unknown");
});

test("a deliberately-unmapped known event is ignored, not dead-lettered", () => {
  for (const type of ["message.removed", "file.edited", "server.connected", "session.diff"]) {
    const out = normalize({ type, properties: {} }, lookup, HARNESS);
    assert.equal(out.kind, "ignore", `${type} should be ignored`);
  }
});

test("an unrecognised event type is dead-lettered", () => {
  const out = normalize({ type: "totally.unknown", properties: {} }, lookup, HARNESS);
  assert.equal(out.kind, "dead-letter");
});

test("a non-object frame is dead-lettered", () => {
  assert.equal(normalize("not an object", lookup, HARNESS).kind, "dead-letter");
  assert.equal(normalize(null, lookup, HARNESS).kind, "dead-letter");
});

test("a mapped event missing required fields is dead-lettered", () => {
  // session.idle with no session id
  assert.equal(normalize({ type: "session.idle", properties: {} }, lookup, HARNESS).kind, "dead-letter");
  // permission.asked with no request id
  assert.equal(
    normalize({ type: "permission.asked", properties: { session_id: "ses_task" } }, lookup, HARNESS).kind,
    "dead-letter",
  );
});

test("question.asked maps to elicitation.asked (SPEC-011)", () => {
  const out = normalize(
    { type: "question.asked", properties: { session_id: "ses_task", question_id: "q1", question: "Proceed?", options: ["yes", "no"] } },
    lookup,
    HARNESS,
  );
  assert.equal(out.kind, "event");
  if (out.kind !== "event") return;
  assert.equal(out.event.type, "elicitation.asked");
  assert.equal((out.event as any).elicitationId, "q1");
  assert.equal((out.event as any).question, "Proceed?");
  assert.deepEqual((out.event as any).options, ["yes", "no"]);
});

test("question.replied / question.rejected map to elicitation.replied / .rejected (SPEC-011)", () => {
  const replied = normalize({ type: "question.replied", properties: { session_id: "ses_task", question_id: "q1", answer: "yes" } }, lookup, HARNESS);
  assert.equal(replied.kind, "event");
  if (replied.kind === "event") assert.equal(replied.event.type, "elicitation.replied");
  const rejected = normalize({ type: "question.rejected", properties: { session_id: "ses_task", question_id: "q1" } }, lookup, HARNESS);
  assert.equal(rejected.kind, "event");
  if (rejected.kind === "event") assert.equal(rejected.event.type, "elicitation.rejected");
});
