import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionCoordinator, type PermissionClient } from "../src/index.js";

interface Recorder extends PermissionClient {
  replies: Array<{ id: string; granted: boolean }>;
  pendingCalls: number;
}

function recorder(pending: string[]): Recorder {
  const r: Recorder = {
    replies: [],
    pendingCalls: 0,
    async reply(id, granted) {
      r.replies.push({ id, granted });
    },
    async pending() {
      r.pendingCalls += 1;
      return pending;
    },
  };
  return r;
}

test("a decision is confirmed only by the matching replied event", async () => {
  const client = recorder(["perm_1"]);
  const pc = new PermissionCoordinator(client, 1000);
  const decision = pc.decide({ permissionId: "perm_1", granted: true });
  // simulate the SSE-driven confirmation
  pc.onReplied("perm_1");
  const ack = await decision;
  assert.deepEqual(ack, { permissionId: "perm_1", status: "confirmed" });
  assert.deepEqual(client.replies, [{ id: "perm_1", granted: true }]);
});

test("no replied event within the timeout yields unconfirmed (not success)", async () => {
  const client = recorder(["perm_1"]);
  const pc = new PermissionCoordinator(client, 20);
  const ack = await pc.decide({ permissionId: "perm_1", granted: true });
  assert.equal(ack.status, "unconfirmed");
  // the timeout path re-fetches pending state (pre-check + re-fetch)
  assert.ok(client.pendingCalls >= 2);
});

test("a decision for an id the server no longer lists as pending is stale", async () => {
  const client = recorder([]); // nothing pending
  const pc = new PermissionCoordinator(client, 1000);
  const ack = await pc.decide({ permissionId: "stale_perm", granted: false });
  assert.equal(ack.status, "stale");
  assert.equal(client.replies.length, 0, "must not POST a reply for a stale id");
});

test("a duplicate decision after confirmation is an idempotent no-op", async () => {
  const client = recorder(["perm_1"]);
  const pc = new PermissionCoordinator(client, 1000);
  const first = pc.decide({ permissionId: "perm_1", granted: true });
  pc.onReplied("perm_1");
  await first;
  const second = await pc.decide({ permissionId: "perm_1", granted: true });
  assert.equal(second.status, "duplicate");
  assert.equal(client.replies.length, 1, "second decision must not POST again");
});

test("concurrent duplicate decisions ride the same in-flight promise", async () => {
  const client = recorder(["perm_1"]);
  const pc = new PermissionCoordinator(client, 1000);
  const a = pc.decide({ permissionId: "perm_1", granted: true });
  const b = pc.decide({ permissionId: "perm_1", granted: true });
  pc.onReplied("perm_1");
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, "confirmed");
  assert.equal(rb.status, "confirmed");
  assert.equal(client.replies.length, 1, "only one reply POST for concurrent duplicates");
});

test("reconnect reconciles an in-flight decision the server no longer lists as pending", async () => {
  const client = recorder(["perm_1"]);
  const pc = new PermissionCoordinator(client, 60_000); // long timeout — reconcile must resolve it
  const decision = pc.decide({ permissionId: "perm_1", granted: true });
  // give decide() a tick to register its waiter
  await new Promise((r) => setTimeout(r, 5));
  // server forgot the permission across the reconnect
  client.pending = async () => [];
  await pc.reconcile();
  const ack = await decision;
  assert.equal(ack.status, "unconfirmed");
});
