import assert from "node:assert/strict";
import { test } from "node:test";
import { ArkeTransport, type WebSocketLike } from "../src/transport";

/** A controllable fake socket: tests drive open/close/message explicitly. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  // helpers
  open(): void {
    this.onopen?.();
  }
  message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function makeTransport(received: unknown[] = []) {
  FakeSocket.instances = [];
  const t = new ArkeTransport({
    url: "ws://test",
    onMessage: (f) => received.push(f),
    createSocket: (url) => new FakeSocket(url),
    baseDelayMs: 10,
    maxDelayMs: 40,
  });
  return { t, received, sock: () => FakeSocket.instances.at(-1)! };
}

test("transitions connecting → open and queues outbound until open", () => {
  const { t, sock } = makeTransport();
  assert.equal(t.state, "connecting");
  t.send({ a: 1 }); // queued (not open)
  assert.equal(sock().sent.length, 0);
  sock().open();
  assert.equal(t.state, "open");
});

test("queue drains in order after the first (snapshot) frame, exactly once", () => {
  const { t, sock } = makeTransport();
  t.send({ n: 1 });
  t.send({ n: 2 });
  sock().open();
  // not drained yet — waiting for the first inbound frame
  assert.equal(sock().sent.length, 0);
  sock().message({ type: "snapshot" });
  assert.deepEqual(sock().sent.map((s) => JSON.parse(s).n), [1, 2]);
  // a second frame does not re-drain
  sock().message({ type: "event" });
  assert.equal(sock().sent.length, 2);
});

test("reconnects with capped back-off after an unexpected close", async () => {
  const { t, sock } = makeTransport();
  sock().open();
  sock().message({ type: "snapshot" });
  const firstSocket = sock();
  firstSocket.close(); // triggers reconnect
  assert.equal(t.state, "reconnecting");
  await new Promise((r) => setTimeout(r, 60));
  // a new socket was created by the reconnect attempt
  assert.ok(FakeSocket.instances.length >= 2, "expected a reconnect attempt");
});

test("a disposed transport does not reconnect and discards the queue", async () => {
  const { t, sock } = makeTransport();
  sock().open();
  t.send({ x: 1 });
  const count = FakeSocket.instances.length;
  t.dispose();
  assert.equal(t.state, "disposed");
  sock().close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(FakeSocket.instances.length, count, "must not reconnect after dispose");
});

test("state changes are observable", () => {
  const states: string[] = [];
  const { t, sock } = makeTransport();
  t.subscribe((s) => states.push(s));
  sock().open();
  sock().close();
  assert.ok(states.includes("open"));
  assert.ok(states.includes("reconnecting"));
});

test("attempt count is emitted so a sustained failure can be surfaced (coordinator unreachable)", async () => {
  const attempts: number[] = [];
  const { t, sock } = makeTransport();
  t.subscribe((_s, a) => attempts.push(a));
  // Fail three consecutive (re)connects: each schedules a reconnect and re-emits with a higher count,
  // even though the state stays "reconnecting".
  for (let i = 0; i < 3; i++) {
    sock().close();
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(t.attempts >= 3, `expected >=3 attempts, got ${t.attempts}`);
  assert.ok(Math.max(...attempts) >= 3, "listener should observe the rising attempt count");
});

test("a successful open resets the attempt count to zero", () => {
  const { t, sock } = makeTransport();
  sock().close(); // attempt 1
  assert.ok(t.attempts >= 1);
  sock().open(); // recovered
  assert.equal(t.attempts, 0);
});
