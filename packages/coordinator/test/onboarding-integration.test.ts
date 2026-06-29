import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { Coordinator } from "../src/server.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";

/** Spin a coordinator rooted at a fresh temp dir (the safe root for path validation). */
async function coordinator(opts?: { tierDefaults?: { capable?: string; mid?: string } }) {
  const dir = mkdtempSync(join(tmpdir(), "arke-onb-"));
  const c = new Coordinator(
    new MockAdapter(),
    new Trace(join(dir, "trace.ndjson")),
    new GrantStore(join(dir, "grants.ndjson")),
    0,
    { projectRoot: dir, tierDefaults: opts?.tierDefaults ?? { capable: "capable-tier", mid: "mid-tier" } },
  );
  const port = await c.start();
  return { c, port, dir };
}

/** Open a socket and collect every framed message, exposing helpers to await frames and snapshots. */
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(f)) {
        waiters[i]!.resolve(f);
        waiters.splice(i, 1);
      }
    }
  });
  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });
  const waitFor = (pred: (f: any) => boolean, ms = 4000) =>
    new Promise<any>((res, rej) => {
      const existing = frames.find(pred);
      if (existing) return res(existing);
      const t = setTimeout(() => rej(new Error("frame not seen in time")), ms);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); res(f); } });
    });
  return { ws, frames, waitFor };
}

test("the snapshot frame carries onboarding state (reachable, projectState, tierDefaults)", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, waitFor } = await connect(port);
  const snap = await waitFor((f) => f.type === "snapshot");
  assert.equal(snap.harnessReachable, true); // mock is always ready
  assert.equal(snap.projectState, "empty"); // fresh temp dir
  assert.deepEqual(snap.tierDefaults, { capable: "capable-tier", mid: "mid-tier" });
  ws.close();
});

test("folder.inspect with a traversal path is rejected before any filesystem access", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, waitFor } = await connect(port);
  await waitFor((f) => f.type === "snapshot");
  ws.send(JSON.stringify({ type: "folder.inspect", path: "../../etc" }));
  const err = await waitFor((f) => f.type === "validation-error");
  assert.equal(err.field, "path");
  ws.close();
});

test("scaffold.run streams scaffold.step events then scaffold.done, and writes artefacts", async () => {
  const { c, port, dir } = await coordinator();
  after(() => c.stop());
  const { ws, frames, waitFor } = await connect(port);
  await waitFor((f) => f.type === "snapshot");
  ws.send(JSON.stringify({ type: "scaffold.run", path: "." }));
  const done = await waitFor((f) => f.type === "event" && f.event?.type === "scaffold.done");
  assert.equal(done.event.projectPath, resolve(dir));
  // at least the agents step ran and was reported
  const stepFrames = frames.filter((f) => f.type === "event" && f.event?.type === "scaffold.step");
  assert.ok(stepFrames.some((f) => f.event.step === "agents"));
  assert.ok(existsSync(resolve(dir, ".opencode/agents/spec-author.md")));
  ws.close();
});

test("scaffold.run with a missing tier default is blocked (no artefacts written)", async () => {
  const { c, port, dir } = await coordinator({ tierDefaults: {} });
  after(() => c.stop());
  const { ws, waitFor } = await connect(port);
  await waitFor((f) => f.type === "snapshot");
  ws.send(JSON.stringify({ type: "scaffold.run", path: "." }));
  const err = await waitFor((f) => f.type === "error" || f.type === "validation-error");
  assert.match(err.reason, /tier defaults not configured/);
  assert.ok(!existsSync(resolve(dir, ".opencode/agents/spec-author.md")));
  ws.close();
});

test("scaffold.run over the op surface returns a structured result", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, waitFor } = await connect(port);
  await waitFor((f) => f.type === "snapshot");
  ws.send(JSON.stringify({ type: "request", id: "r1", op: "scaffold.run", args: { path: "." } }));
  const res = await waitFor((f) => f.type === "response" && f.id === "r1");
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.result.stepsRun));
  assert.ok(res.result.stepsRun.includes("agents"));
  ws.close();
});

test("the snapshot carries a projectId (SPEC-018)", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, waitFor } = await connect(port);
  const snap = await waitFor((f) => f.type === "snapshot");
  assert.equal(typeof snap.projectId, "string");
  assert.ok(snap.projectId.length > 0);
  ws.close();
});

test("project.list returns the active project as a real recent (SPEC-018)", async () => {
  const { c, port, dir } = await coordinator();
  after(() => c.stop());
  const { ws, waitFor } = await connect(port);
  const snap = await waitFor((f) => f.type === "snapshot");
  ws.send(JSON.stringify({ type: "request", id: "pl", op: "project.list" }));
  const res = await waitFor((f) => f.type === "response" && f.id === "pl");
  assert.equal(res.ok, true);
  assert.equal(res.result.length, 1);
  assert.equal(res.result[0].projectId, snap.projectId);
  assert.equal(res.result[0].root, resolve(dir));
  ws.close();
});

test("project.open resolves the active project; a different id is refused (SPEC-018)", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, waitFor } = await connect(port);
  const snap = await waitFor((f) => f.type === "snapshot");
  ws.send(JSON.stringify({ type: "request", id: "o1", op: "project.open", args: { projectId: snap.projectId } }));
  const ok = await waitFor((f) => f.type === "response" && f.id === "o1");
  assert.equal(ok.ok, true);
  assert.equal(ok.result.projectId, snap.projectId);
  ws.send(JSON.stringify({ type: "request", id: "o2", op: "project.open", args: { projectId: "deadbeefdeadbeef" } }));
  const err = await waitFor((f) => f.type === "response" && f.id === "o2");
  assert.equal(err.ok, false);
  assert.match(err.error, /unknown project/);
  ws.close();
});

test("project.forget refuses an open project (must close first) (SPEC-018)", async () => {
  const { c, port } = await coordinator();
  after(() => c.stop());
  const { ws, waitFor } = await connect(port);
  const snap = await waitFor((f) => f.type === "snapshot");
  // the default project is open, so it cannot be forgotten
  ws.send(JSON.stringify({ type: "request", id: "f1", op: "project.forget", args: { projectId: snap.projectId } }));
  const res = await waitFor((f) => f.type === "response" && f.id === "f1");
  assert.equal(res.ok, false);
  assert.match(res.error, /close the project before forgetting/);
  ws.close();
});
