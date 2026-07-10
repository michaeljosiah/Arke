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

  async req<T>(method: string, path: string): Promise<T> {
    if (path === "/v1/sessions?limit=1") return {} as T;
    if (path === "/api/version") return { version: "0.3.0" } as T;
    if (path === "/v1/sessions") return { id: "conv_1" } as T;
    if (path.endsWith("/events")) return { queued: true, item_id: this.itemId } as T;
    if (method === "GET" && /\/v1\/sessions\/[^/]+$/.test(path)) return { status: this.sessionStatus } as T;
    return {} as T; // elicitation resolve, etc.
  }

  async openStream(): Promise<ReadableStream<Uint8Array>> {
    this.openCount++;
    const c = new Controllable();
    this.current = c;
    if (this.closeImmediately) queueMicrotask(() => c.close());
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
    { baseUrl: "http://x", agentId: "ag_1", reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 } },
    undefined,
    fake,
  );
  await a.createSession({ specId: "SPEC-1" });
  const events = await collect(a, 150);
  const terminal = events.filter((e) => e.type === "session.status" && (e as any).status === "error");
  assert.ok(terminal.length >= 1, "a terminal degraded status is emitted after reconnect exhaustion");
  assert.ok(fake.openCount >= 3, "the stream was retried (initial + 2 reconnects) before giving up");
  await a.stopServer();
});
