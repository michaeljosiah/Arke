import assert from "node:assert/strict";
import { test } from "node:test";
import type { DomainEvent } from "@arke/contracts";
import { OmnigentAdapter, type OmnigentTransport } from "../src/index.js";

/**
 * SPEC-037 Increment 3b: end-to-end resilience through the real adapter, driven by a FAKE transport
 * (mirroring adapter-codex's fake app-server) — correlation, confirm-by-event approvals, dead-letter, and
 * reconnect + terminal degrade. No network; the fake scripts the HTTP responses + a controllable SSE stream.
 */

const enc = new TextEncoder();

/** A per-session SSE stream the test can push frames into and close on demand. */
class Controllable {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly stream = new ReadableStream<Uint8Array>({ start: (c) => { this.controller = c; } });
  push(frame: unknown): void {
    this.controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
  }
  close(): void {
    try { this.controller.close(); } catch { /* already closed */ }
  }
}

class FakeTransport implements OmnigentTransport {
  itemId = "msg_ABC";
  sessionStatus: string | undefined = undefined;
  current: Controllable | null = null;
  openCount = 0;
  /** When true, every openStream closes immediately (drives reconnect). */
  closeImmediately = false;
  /** When true, each openStream emits one frame then drops (a FLAP). */
  flapWithFrame = false;
  /** When true, the elicitation-resolve POST rejects. */
  failResolve = false;
  /** When true, the /events POST triggers a fast `session.status: idle` on the stream. */
  quiesceOnPost = false;

  async req<T>(method: string, path: string): Promise<T> {
    if (path === "/v1/sessions?limit=1") return {} as T;
    if (path === "/api/version") return { version: "0.3.0" } as T;
    if (path === "/v1/sessions") return { id: "conv_1" } as T;
    if (/\/elicitations\/[^/]+\/resolve$/.test(path)) {
      if (this.failResolve) throw new Error("resolve POST failed (503)");
      return {} as T;
    }
    if (path.endsWith("/events")) {
      if (this.quiesceOnPost) {
        // The turn completes during the POST round-trip: push idle right after we return the receipt.
        queueMicrotask(() => this.current?.push({ sequence_number: 9, type: "session.status", conversation_id: "conv_1", status: "idle", response_id: "r1" }));
      }
      return { queued: true, item_id: this.itemId } as T;
    }
    if (method === "GET" && /\/v1\/sessions\/[^/]+$/.test(path)) return { status: this.sessionStatus } as T;
    return {} as T;
  }

  async openStream(): Promise<ReadableStream<Uint8Array>> {
    this.openCount++;
    const c = new Controllable();
    this.current = c;
    if (this.closeImmediately) queueMicrotask(() => c.close());
    else if (this.flapWithFrame) queueMicrotask(() => { c.push({ sequence_number: 1, type: "session.heartbeat", server_time: 1 }); c.close(); });
    return c.stream;
  }
}

/** Drain streamEvents for `ms`, collecting events. */
async function collect(adapter: OmnigentAdapter, ms: number): Promise<DomainEvent[]> {
  const out: DomainEvent[] = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  try {
    for await (const ev of adapter.streamEvents(ac.signal)) out.push(ev);
  } catch { /* aborted */ }
  clearTimeout(timer);
  return out;
}

test("dispatchAsync correlates on the server-echoed item_id (not pending_id)", async () => {
  const fake = new FakeTransport();
  const a = new OmnigentAdapter({ baseUrl: "http://x", agentId: "ag_1" }, undefined, fake);
  const receipt = await a.dispatchAsync({ sessionId: "conv_1", agent: "spec-author", parts: [{ text: "hi" }] });
  assert.equal(receipt.correlationId, "msg_ABC");
  await a.stopServer();
});

test("a caller-supplied correlationId is preserved over the item_id", async () => {
  const fake = new FakeTransport();
  const a = new OmnigentAdapter({ baseUrl: "http://x", agentId: "ag_1" }, undefined, fake);
  const receipt = await a.dispatchAsync({ sessionId: "conv_1", agent: "x", correlationId: "mine", parts: [{ text: "hi" }] });
  assert.equal(receipt.correlationId, "mine");
  await a.stopServer();
});

test("an elicitation approval confirms on the resolution EVENT, not the 202", async () => {
  const fake = new FakeTransport();
  const a = new OmnigentAdapter({ baseUrl: "http://x", agentId: "ag_1" }, undefined, fake);
  await a.createSession({ specId: "SPEC-1" });
  await new Promise((r) => setTimeout(r, 10)); // let the pump open the stream
  fake.current!.push({ sequence_number: 1, type: "response.elicitation_request", data: { elicitation_id: "el_1", title: "Write?" } });
  await new Promise((r) => setTimeout(r, 10)); // let permission.asked register the permId→session mapping

  const decisionP = a.respondToPermission({ permissionId: "el_1", decision: "once" });
  await new Promise((r) => setTimeout(r, 10));
  fake.current!.push({ sequence_number: 2, type: "elicitation.resolved", data: { elicitation_id: "el_1" } });
  const ack = await decisionP;
  assert.equal(ack.status, "confirmed");
  await a.stopServer();
});

test("respondToPermission is stale for an unknown elicitation id", async () => {
  const a = new OmnigentAdapter({ baseUrl: "http://x", agentId: "ag_1" }, undefined, new FakeTransport());
  const ack = await a.respondToPermission({ permissionId: "never-seen", decision: "once" });
  assert.equal(ack.status, "stale");
  await a.stopServer();
});

test("an unmapped frame is dead-lettered; a heartbeat is not", async () => {
  const fake = new FakeTransport();
  const seen: string[] = [];
  const a = new OmnigentAdapter({ baseUrl: "http://x", agentId: "ag_1" }, (d) => seen.push(d.type ?? "?"), fake);
  await a.createSession({ specId: "SPEC-1" });
  await new Promise((r) => setTimeout(r, 10));
  fake.current!.push({ sequence_number: 1, type: "session.heartbeat", server_time: 1 });
  fake.current!.push({ sequence_number: 2, type: "session.some_future_frame", foo: 1 });
  await new Promise((r) => setTimeout(r, 10));
  const entries = a.deadLetterEntries();
  assert.ok(entries.some((e) => e.type === "session.some_future_frame"), "unmapped frame dead-lettered");
  assert.ok(!entries.some((e) => e.type === "session.heartbeat"), "heartbeat NOT dead-lettered");
  assert.deepEqual(seen, ["session.some_future_frame"]);
  await a.stopServer();
});

test("reconnect is bounded — on exhaustion the adapter emits a terminal degraded session.status: error", async () => {
  const fake = new FakeTransport();
  fake.closeImmediately = true; // every stream drops at once → drives reconnect
  const a = new OmnigentAdapter(
    { baseUrl: "http://x", agentId: "ag_1", reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, minHealthyMs: 5 } },
    undefined,
    fake,
  );
  await a.createSession({ specId: "SPEC-1" });
  const events = await collect(a, 150);
  const terminal = events.filter((e) => e.type === "session.status" && (e as any).status === "error");
  assert.equal(terminal.length, 1, "exactly one terminal degraded status after reconnect exhaustion");
  assert.ok(fake.openCount >= 3, "the stream was retried (initial + 2 reconnects) before giving up");
  await a.stopServer();
});

test("reconnect stays bounded under a FLAP — open, deliver one frame, drop, repeat (SPEC-037 review P1)", async () => {
  // The dangerous case the earlier test missed: a stream that makes ≥1 frame of 'progress' each cycle. With
  // a high minHealthyMs the flap never resets the counter, so it still exhausts to a terminal degrade.
  const fake = new FakeTransport();
  fake.flapWithFrame = true; // each open emits one frame then drops (< minHealthyMs)
  const a = new OmnigentAdapter(
    { baseUrl: "http://x", agentId: "ag_1", reconnect: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, minHealthyMs: 10_000 } },
    undefined,
    fake,
  );
  await a.createSession({ specId: "SPEC-1" });
  const events = await collect(a, 200);
  const terminal = events.filter((e) => e.type === "session.status" && (e as any).status === "error");
  assert.equal(terminal.length, 1, "the flap is bounded — one terminal degrade, not an infinite reconnect");
  assert.ok(fake.openCount <= 6, `bounded open count (was ${fake.openCount}); an unbounded flap would climb into the dozens`);
  await a.stopServer();
});

test("respondToPermission does not leave a leaked waiter when the resolve POST fails — a retry is not 'duplicate'", async () => {
  const fake = new FakeTransport();
  fake.failResolve = true; // the elicitation-resolve POST rejects
  const a = new OmnigentAdapter({ baseUrl: "http://x", agentId: "ag_1" }, undefined, fake);
  await a.createSession({ specId: "SPEC-1" });
  await new Promise((r) => setTimeout(r, 10));
  fake.current!.push({ sequence_number: 1, type: "response.elicitation_request", data: { elicitation_id: "el_1", title: "Write?" } });
  await new Promise((r) => setTimeout(r, 10));

  await assert.rejects(a.respondToPermission({ permissionId: "el_1", decision: "once" }), "the POST failure propagates");
  fake.failResolve = false; // the retry's POST succeeds
  const retryP = a.respondToPermission({ permissionId: "el_1", decision: "once" });
  await new Promise((r) => setTimeout(r, 10));
  fake.current!.push({ sequence_number: 2, type: "elicitation.resolved", data: { elicitation_id: "el_1" } });
  const ack = await retryP;
  assert.notEqual(ack.status, "duplicate", "the retry is NOT rejected as duplicate (the failed waiter was cancelled)");
  assert.equal(ack.status, "confirmed");
  await a.stopServer();
});

test("completion-aware sendMessage resolves promptly when the turn quiesces during the /events POST (no lost wakeup)", async () => {
  // The /events POST triggers a fast `session.status: idle` on the stream. Because sendMessage registers the
  // turn waiter BEFORE the POST, the quiesce is caught — sendMessage resolves fast, not after the 30s timeout.
  const fake = new FakeTransport();
  fake.quiesceOnPost = true;
  const a = new OmnigentAdapter({ baseUrl: "http://x", agentId: "ag_1" }, undefined, fake);
  await a.createSession({ specId: "SPEC-1" });
  await new Promise((r) => setTimeout(r, 10));
  const t0 = Date.now();
  await a.sendMessage({ sessionId: "conv_1", agent: "x", parts: [{ text: "ping" }] });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `sendMessage resolved promptly (${elapsed}ms), not via the 30s timeout`);
  await a.stopServer();
});
