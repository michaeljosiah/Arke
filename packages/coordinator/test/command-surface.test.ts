import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { Coordinator } from "../src/server.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";

/** Open a client, returning a `request(op, args)` helper that resolves the matching response. */
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const pending = new Map<string, (r: any) => void>();
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    if (f.type === "response" && pending.has(f.id)) {
      pending.get(f.id)!(f);
      pending.delete(f.id);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  let n = 0;
  const request = (op: string, args?: unknown) =>
    new Promise<any>((resolve) => {
      const id = `r${++n}`;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: "request", id, op, args }));
    });
  return { ws, request };
}

async function coordinator() {
  const dir = mkdtempSync(join(tmpdir(), "arke-cmd-"));
  const c = new Coordinator(new MockAdapter(), new Trace(join(dir, "trace.ndjson")), new GrantStore(join(dir, "grants.ndjson")), 0);
  const port = await c.start();
  return { c, port };
}

test("session.create returns a session id over the command surface", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, request } = await connect(port);
  const res = await request("session.create", { specId: "SPEC-X" });
  assert.equal(res.ok, true);
  assert.equal(typeof res.result.sessionId, "string");
  assert.ok(res.result.sessionId.includes("SPEC-X"));
  ws.close();
});

test("a created session immediately appears in session.list", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, request } = await connect(port);
  const created = await request("session.create", { specId: "SPEC-NEW" });
  assert.equal(created.ok, true);
  const id = created.result.sessionId;
  const list = await request("session.list");
  assert.ok(
    list.result.some((card: { id: string }) => card.id === id),
    "session.list should include the just-created session",
  );
  ws.close();
});

test("an unknown op returns a structured error, not a crash", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, request } = await connect(port);
  const res = await request("does.not.exist", {});
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown op/);
  ws.close();
});

test("permission.decide rejects an invalid verb (fails closed, no allow-once coercion)", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, request } = await connect(port);
  const res = await request("permission.decide", { permissionId: "p1", decision: "reject " }); // trailing space
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid permission decision/);
  ws.close();
});

test("agents.list refuses a directory that escapes the project root", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, request } = await connect(port);
  const res = await request("agents.list", { dir: "../../etc" });
  assert.equal(res.ok, false);
  assert.match(res.error, /outside the configured project root/);
  ws.close();
});

test("permission.list and grant.list respond with arrays", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, request } = await connect(port);
  const perms = await request("permission.list");
  const grants = await request("grant.list");
  assert.equal(perms.ok, true);
  assert.ok(Array.isArray(perms.result));
  assert.equal(grants.ok, true);
  assert.ok(Array.isArray(grants.result));
  ws.close();
});
