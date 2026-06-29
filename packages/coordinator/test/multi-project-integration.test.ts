import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { Coordinator, type ContextDeps } from "../src/server.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

/** A context factory that gives every opened root its own MockAdapter + isolated stores. */
function mockFactory(): (root: string) => Promise<ContextDeps> {
  return async (root: string) => ({
    adapter: new MockAdapter(),
    trace: new Trace(join(root, ".arke", "trace.ndjson")),
    grants: new GrantStore(join(root, ".arke", "grants.ndjson")),
    endpoints: [],
    tierDefaults: {},
  });
}

async function supervisor(opts?: { maxProjects?: number }) {
  const dirA = mkdtempSync(join(tmpdir(), "arke-A-"));
  const dirB = mkdtempSync(join(tmpdir(), "arke-B-"));
  const c = new Coordinator(
    new MockAdapter(),
    new Trace(join(dirA, ".arke", "trace.ndjson")),
    new GrantStore(join(dirA, ".arke", "grants.ndjson")),
    0,
    {
      projectRoot: dirA,
      registry: new ProjectRegistry({ persist: false }),
      contextFactory: mockFactory(),
      idleTtlMs: 0, // disable the sweep in tests
      ...(opts?.maxProjects !== undefined ? { maxProjects: opts.maxProjects } : {}),
    },
  );
  const port = await c.start();
  return { c, port, dirA, dirB };
}

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void; t: ReturnType<typeof setTimeout> }> = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(f)) {
        clearTimeout(waiters[i]!.t);
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
      const t = setTimeout(() => rej(new Error("frame not seen")), ms);
      waiters.push({ pred, resolve: res, t });
    });
  const request = (() => {
    let n = 0;
    return (op: string, args?: unknown) => {
      const id = `r${++n}`;
      ws.send(JSON.stringify({ type: "request", id, op, args }));
      return waitFor((f) => f.type === "response" && f.id === id);
    };
  })();
  return { ws, frames, waitFor, request };
}

test("opening a second project yields two isolated contexts under one coordinator", async () => {
  const { c, port, dirA, dirB } = await supervisor();
  after(() => c.stop());
  const { ws, request, waitFor } = await connect(port);
  const snapA = await waitFor((f) => f.type === "snapshot");
  assert.equal(snapA.projectPath, resolve(dirA));

  const opened = await request("project.open", { path: dirB });
  assert.equal(opened.ok, true);
  assert.equal(opened.result.root, resolve(dirB));
  assert.notEqual(opened.result.projectId, snapA.projectId); // distinct context

  // switching re-snapshots to B
  const snapB = await waitFor((f) => f.type === "snapshot" && f.projectId === opened.result.projectId);
  assert.equal(snapB.projectPath, resolve(dirB));

  // both projects are now real recents
  const list = await request("project.list");
  assert.equal(list.result.length, 2);
  ws.close();
});

test("re-opening the same project reuses its context (no duplicate)", async () => {
  const { c, port, dirB } = await supervisor();
  after(() => c.stop());
  const { ws, request } = await connect(port);
  const a = await request("project.open", { path: dirB });
  const b = await request("project.open", { path: dirB });
  assert.equal(a.result.projectId, b.result.projectId);
  const list = await request("project.list");
  assert.equal(list.result.length, 2); // default + B only
  ws.close();
});

test("project.close stops a non-active project but never the default", async () => {
  const { c, port, dirA, dirB } = await supervisor();
  after(() => c.stop());
  const { ws, request, waitFor } = await connect(port);
  const snapA = await waitFor((f) => f.type === "snapshot");
  const b = await request("project.open", { path: dirB });
  // switch the connection back to A so B has no active clients
  await request("project.open", { projectId: snapA.projectId });
  const closed = await request("project.close", { projectId: b.result.projectId });
  assert.equal(closed.ok, true);
  assert.equal(closed.result.closed, b.result.projectId);
  // the default project cannot be closed
  const bad = await request("project.close", { projectId: snapA.projectId });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cannot close the default project/);
  ws.close();
});

test("pushed events carry the project id (SPEC-018, stale-frame guard)", async () => {
  const { c, port } = await supervisor();
  after(() => c.stop());
  const { ws, waitFor } = await connect(port);
  const snap = await waitFor((f) => f.type === "snapshot");
  const evt = await waitFor((f) => f.type === "event");
  assert.equal(evt.event.projectId, snap.projectId);
  ws.close();
});

test("project.open refuses a path that does not exist (no phantom project on disk)", async () => {
  const { c, port } = await supervisor();
  after(() => c.stop());
  const { ws, request, waitFor } = await connect(port);
  await waitFor((f) => f.type === "snapshot");
  const res = await request("project.open", { path: join(tmpdir(), "arke-nope-zzz-does-not-exist") });
  assert.equal(res.ok, false);
  assert.match(res.error, /does not exist/);
  ws.close();
});

test("the concurrency bound refuses opening beyond the maximum", async () => {
  const { c, port, dirB } = await supervisor({ maxProjects: 1 });
  after(() => c.stop());
  const { ws, request, waitFor } = await connect(port);
  await waitFor((f) => f.type === "snapshot");
  // default already fills the single slot; opening B has no idle non-default to evict → refused
  const res = await request("project.open", { path: dirB });
  assert.equal(res.ok, false);
  assert.match(res.error, /maximum of 1 concurrent projects/);
  ws.close();
});
