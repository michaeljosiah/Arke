import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createNormalizeState, normalize, isRecognizedFrameType, IGNORED_FRAME_TYPES } from "../src/normalize.js";
import type { SessionIdentity } from "../src/session-graph.js";

const HARNESS = "Omnigent";
const SID = "conv_abc";
const ID: SessionIdentity = { specId: "SPEC-1", kind: "spec" };

/**
 * SPEC-037: fixtures are REAL frames captured live from Omnigent 0.3.0 (a `{ sequence_number, type }`
 * envelope with a `session.*` / `response.*` vocabulary) — NOT the spike's synthetic OpenAI-Responses shapes.
 * The control-plane mappings are asserted against the captured fixture; the assistant-content mappings are
 * PROVISIONAL (Requirement 2), tested against the prior spike shape pending the live-acceptance capture.
 */
const dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE: Array<Record<string, unknown>> = readFileSync(join(dir, "fixtures/omnigent-0.3.0-control-plane.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

function frameOfType(t: string): Record<string, unknown> {
  const f = FIXTURE.find((x) => x.type === t);
  assert.ok(f, `fixture has a ${t} frame`);
  return f!;
}

// ---- control plane, asserted against the LIVE fixture ----

test("the captured fixture is the real 0.3.0 envelope (flat { sequence_number, type })", () => {
  for (const f of FIXTURE) assert.ok("type" in f && "sequence_number" in f, "flat envelope with type + sequence_number");
  // The spike's OpenAI-Responses types are absent from a real capture.
  assert.ok(!FIXTURE.some((f) => f.type === "response.created" || f.type === "response.completed"));
});

test("session.heartbeat / presence / changed_files / terminal_pending are ignored, not dead-lettered", () => {
  for (const t of ["session.heartbeat", "session.presence", "session.changed_files.invalidated", "session.terminal_pending"]) {
    const f = FIXTURE.find((x) => x.type === t);
    if (!f) continue;
    assert.deepEqual(normalize(f, SID, ID, HARNESS, createNormalizeState()), [], `${t} yields no events`);
    assert.ok(isRecognizedFrameType(t), `${t} is recognized (won't be dead-lettered)`);
    assert.ok(IGNORED_FRAME_TYPES.has(t));
  }
});

test("session.input.consumed is ignored by normalize (correlation is bound by the pump)", () => {
  const f = frameOfType("session.input.consumed");
  assert.deepEqual(normalize(f, SID, ID, HARNESS, createNormalizeState()), []);
  assert.ok(isRecognizedFrameType("session.input.consumed"));
  // The frame carries the correlatable item id the pump binds.
  assert.ok(typeof (f.data as any)?.item_id === "string");
});

test("response.error maps to session.status: error (detail routed to the pump, not the event)", () => {
  const f = frameOfType("response.error");
  const out = normalize(f, SID, ID, HARNESS, createNormalizeState());
  assert.equal(out.length, 1);
  const ev = out[0]!;
  assert.equal(ev.type, "session.status");
  if (ev.type === "session.status") {
    assert.equal(ev.status, "error");
    assert.equal(ev.sessionId, SID);
    assert.equal((ev as any).specId, "SPEC-1");
    assert.ok(!("error" in ev), "no error field asserted onto the event (contract has none)");
  }
});

test("session.status: failed maps to error (from the captured fixture)", () => {
  const f = frameOfType("session.status");
  assert.equal(f.status, "failed"); // the captured turn failed
  const out = normalize(f, SID, ID, HARNESS, createNormalizeState());
  assert.equal(out[0]?.type, "session.status");
  if (out[0]?.type === "session.status") assert.equal(out[0].status, "error");
});

// ---- session.status transitions (envelope live-confirmed; running/idle status values exercised) ----

test("session.status running/idle map to running and idle+turn.quiescent", () => {
  const running = normalize({ sequence_number: 1, type: "session.status", conversation_id: SID, status: "running", model: "openai/gpt-5.5-fast" }, SID, ID, HARNESS, createNormalizeState());
  assert.equal(running[0]?.type, "session.status");
  if (running[0]?.type === "session.status") { assert.equal(running[0].status, "running"); assert.equal(running[0].model, "openai/gpt-5.5-fast"); }

  const idle = normalize({ sequence_number: 9, type: "session.status", conversation_id: SID, status: "idle", response_id: "resp_1" }, SID, ID, HARNESS, createNormalizeState());
  assert.equal(idle.length, 2);
  assert.equal(idle[0]?.type, "session.status");
  if (idle[0]?.type === "session.status") assert.equal(idle[0].status, "idle");
  assert.equal(idle[1]?.type, "turn.quiescent");
  if (idle[1]?.type === "turn.quiescent") assert.equal(idle[1].turnId, "resp_1");
});

test("an elicitation request maps to permission.asked", () => {
  const out = normalize({ sequence_number: 3, type: "response.elicitation_request", data: { elicitation_id: "el_1", title: "Write file?" } }, SID, ID, HARNESS, createNormalizeState());
  assert.equal(out[0]?.type, "permission.asked");
  if (out[0]?.type === "permission.asked") { assert.equal(out[0].permissionId, "el_1"); assert.equal(out[0].title, "Write file?"); }
});

test("an unrecognised frame type produces no events AND is not recognised (pump dead-letters it)", () => {
  assert.deepEqual(normalize({ sequence_number: 1, type: "session.some_future_frame" }, SID, ID, HARNESS, createNormalizeState()), []);
  assert.equal(isRecognizedFrameType("session.some_future_frame"), false);
  assert.equal(isRecognizedFrameType(undefined), false);
});

// ---- assistant content (PROVISIONAL — from the prior spike capture; confirmed at the live run) ----

test("PROVISIONAL: output_text.delta → message.part with a monotonic partIndex", () => {
  const state = createNormalizeState();
  const a = normalize({ type: "response.output_text.delta", data: { item_id: "msg_1", delta: "Hel" } }, SID, ID, HARNESS, state);
  const b = normalize({ type: "response.output_text.delta", data: { item_id: "msg_1", delta: "lo" } }, SID, ID, HARNESS, state);
  if (a[0]?.type !== "message.part" || b[0]?.type !== "message.part") return assert.fail();
  assert.equal(a[0].partIndex, 0);
  assert.equal(a[0].delta, "Hel");
  assert.equal(b[0].partIndex, 1);
});

test("PROVISIONAL: output_item.done → message.updated (text nested in item.content[])", () => {
  const out = normalize({ type: "response.output_item.done", data: { item: { id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "PONG" }] } } }, SID, ID, HARNESS, createNormalizeState());
  assert.equal(out[0]?.type, "message.updated");
  if (out[0]?.type === "message.updated") { assert.equal(out[0].text, "PONG"); assert.equal(out[0].role, "assistant"); }
});
