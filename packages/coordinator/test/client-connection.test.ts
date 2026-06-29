import assert from "node:assert/strict";
import { test } from "node:test";
import type { DomainEvent } from "@arke/contracts";
import { ClientConnection, type OutboundSocket } from "../src/client-connection.js";

class FakeSocket implements OutboundSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

const ev = (specId: string): DomainEvent => ({
  seq: 99,
  ts: 0,
  harness: "OpenCode",
  type: "spec.status",
  specId,
  status: "draft",
});

test("snapshot is the first frame, ahead of events queued during setup", () => {
  const sock = new FakeSocket();
  const conn = new ClientConnection(sock, { id: "c1" });
  // events pushed before the snapshot are buffered (connection not ready)
  conn.pushEvent(ev("SPEC-1"));
  conn.pushEvent(ev("SPEC-2"));
  conn.sendSnapshot(JSON.stringify({ type: "snapshot", cards: [] }));

  assert.equal(JSON.parse(sock.sent[0]!).type, "snapshot");
  assert.equal(JSON.parse(sock.sent[1]!).type, "event");
  assert.equal(sock.sent.length, 3);
});

test("each connection stamps its own per-connection seq starting at 1", () => {
  const a = new ClientConnection(new FakeSocket(), { id: "a" });
  const b = new ClientConnection(new FakeSocket(), { id: "b" });
  a.sendSnapshot("{}");
  b.sendSnapshot("{}");
  const sa = a as unknown as { socket: FakeSocket };
  const sb = b as unknown as { socket: FakeSocket };

  a.pushEvent(ev("X")); // a.seq -> 1
  a.pushEvent(ev("Y")); // a.seq -> 2
  b.pushEvent(ev("Z")); // b.seq -> 1, independent of a

  assert.equal(JSON.parse(sa.socket.sent.at(-1)!).event.seq, 2);
  assert.equal(JSON.parse(sb.socket.sent.at(-1)!).event.seq, 1);
});

test("a slow client drops oldest events when the buffer is full, and reports the drop", () => {
  const sock = new FakeSocket();
  sock.bufferedAmount = 5_000_000; // above high-water mark → flush stops, queue grows
  const drops: number[] = [];
  const conn = new ClientConnection(sock, {
    id: "slow",
    maxQueue: 3,
    onDrop: (_id, n) => drops.push(n),
  });
  conn.sendSnapshot("{}"); // queued (can't flush, socket slow)
  for (let i = 0; i < 6; i++) conn.pushEvent(ev("S" + i));

  assert.ok(drops.length > 0, "expected at least one drop");
  assert.ok(conn.dropped > 0);
  assert.equal(sock.sent.length, 0, "nothing sent while the socket is over the high-water mark");
});

test("once the slow client drains below the mark, buffered frames flush in order", () => {
  const sock = new FakeSocket();
  sock.bufferedAmount = 5_000_000;
  const conn = new ClientConnection(sock, { id: "slow", maxQueue: 10 });
  conn.sendSnapshot(JSON.stringify({ type: "snapshot" }));
  conn.pushEvent(ev("A"));
  assert.equal(sock.sent.length, 0);
  // socket catches up and a new event triggers a flush
  sock.bufferedAmount = 0;
  conn.pushEvent(ev("B"));
  assert.equal(JSON.parse(sock.sent[0]!).type, "snapshot");
  assert.equal(sock.sent.length, 3); // snapshot + A + B
});
