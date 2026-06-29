import assert from "node:assert/strict";
import { test } from "node:test";
import { OutboundQueue } from "../src/outbound-queue";

test("accepts up to the bound, then refuses without dropping", () => {
  const q = new OutboundQueue<number>(50);
  for (let i = 0; i < 50; i++) assert.equal(q.enqueue(i), true);
  assert.equal(q.isFull, true);
  assert.equal(q.enqueue(999), false); // 51st refused
  assert.equal(q.size, 50);
});

test("drains in FIFO order and empties the queue", () => {
  const q = new OutboundQueue<string>(10);
  q.enqueue("a");
  q.enqueue("b");
  q.enqueue("c");
  const sent: string[] = [];
  const drained = q.drain((c) => sent.push(c));
  assert.deepEqual(sent, ["a", "b", "c"]);
  assert.deepEqual(drained, ["a", "b", "c"]);
  assert.equal(q.size, 0);
  assert.equal(q.isFull, false);
});

test("a refused enqueue can succeed again after a drain frees space", () => {
  const q = new OutboundQueue<number>(1);
  assert.equal(q.enqueue(1), true);
  assert.equal(q.enqueue(2), false); // full
  q.drain(() => {});
  assert.equal(q.enqueue(2), true); // space freed
});
