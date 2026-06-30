import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type { Capability, CreateSessionInput, DiffSummary, DomainEvent, HarnessAdapter, SendMessageInput, SendReceipt, SessionRef } from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-rescue-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "s.md"), "---\nspec_id: SPEC-R\n---\n# s\n", "utf8");
  return dir;
}

/** Emits one running task session so a card exists; optionally advertises the revert capability. */
class RescueMockAdapter implements HarnessAdapter {
  readonly id = "RescueMock";
  readonly reverts: string[] = [];
  unrevs = 0;
  constructor(private readonly withRevert: boolean) {}
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(this.withRevert ? ["events", "diff", "revert"] : ["events", "diff"]);
  }
  async createSession(i: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: "S1" };
  }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async getDiff(_ref: SessionRef): Promise<DiffSummary> {
    return { files: 2, added: 10, removed: 3 };
  }
  async revert(_ref: SessionRef, messageId: string): Promise<void> {
    this.reverts.push(messageId);
  }
  async unrevert(_ref: SessionRef): Promise<void> {
    this.unrevs++;
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    yield { seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId: "S1", specId: "SPEC-R", kind: "task", status: "running" };
    await new Promise<void>((res) => signal?.addEventListener("abort", () => res(), { once: true }));
  }
}

async function start(dir: string, adapter: HarnessAdapter) {
  const c = new Coordinator(adapter, new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir,
    registry: new ProjectRegistry({ persist: false }),
    idleTtlMs: 0,
  });
  const port = await c.start();
  return { c, port };
}

function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void; t: any }> = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.pred(f)) { clearTimeout(waiters[i]!.t); waiters[i]!.resolve(f); waiters.splice(i, 1); }
  });
  const ready = new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
  const waitFor = (pred: (f: any) => boolean, ms = 5000) => new Promise<any>((res, rej) => {
    const ex = frames.find(pred); if (ex) return res(ex);
    const t = setTimeout(() => rej(new Error("frame not seen")), ms); waiters.push({ pred, resolve: res, t });
  });
  let n = 0;
  const request = (op: string, args?: unknown) => { const id = `r${++n}`; ws.send(JSON.stringify({ type: "request", id, op, args })); return waitFor((f) => f.type === "response" && f.id === id); };
  return { ws, ready, waitFor, request };
}

test("pr.approve is idempotent — the PR opens once", async () => {
  const adapter = new RescueMockAdapter(true);
  const { c, port } = await start(repo(), adapter);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "event" && f.event?.type === "session.status"); // card exists
  const first = await request("pr.approve", { sessionId: "S1" });
  assert.equal(first.result.opened, true);
  const second = await request("pr.approve", { sessionId: "S1" });
  assert.equal(second.result.ok, true);
  assert.equal(second.result.opened, false, "second approve does not open a second PR");
  ws.close();
});

test("revert routes to the adapter for a known session; unknown session is refused", async () => {
  const adapter = new RescueMockAdapter(true);
  const { c, port } = await start(repo(), adapter);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "event" && f.event?.type === "session.status");
  const ok = await request("revert", { sessionId: "S1", messageId: "m-7" });
  assert.equal(ok.result.ok, true);
  assert.deepEqual(adapter.reverts, ["m-7"]);
  const bad = await request("revert", { sessionId: "ghost", messageId: "m-7" });
  assert.equal(bad.result.ok, false);
  assert.match(bad.result.error, /unknown session/);
  ws.close();
});

test("revert is refused when the harness lacks the revert capability", async () => {
  const adapter = new RescueMockAdapter(false); // no 'revert' capability
  const { c, port } = await start(repo(), adapter);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "event" && f.event?.type === "session.status");
  const res = await request("revert", { sessionId: "S1", messageId: "m-1" });
  assert.equal(res.result.ok, false);
  assert.match(res.result.error, /does not support revert/);
  assert.equal(adapter.reverts.length, 0);
  ws.close();
});

test("revert without a target messageId is refused (checkpoint integrity)", async () => {
  const adapter = new RescueMockAdapter(true);
  const { c, port } = await start(repo(), adapter);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "event" && f.event?.type === "session.status");
  const res = await request("revert", { sessionId: "S1" }); // no messageId
  assert.equal(res.result.ok, false);
  assert.match(res.result.error, /messageId|checkpoint/i);
  assert.equal(adapter.reverts.length, 0);
  ws.close();
});

test("pr.approve idempotency survives a coordinator restart (durable via trace)", async () => {
  const dir = repo();
  const a1 = new RescueMockAdapter(true);
  const c1 = await start(dir, a1);
  const conn1 = connect(c1.port);
  await conn1.ready;
  await conn1.waitFor((f) => f.type === "event" && f.event?.type === "session.status");
  assert.equal((await conn1.request("pr.approve", { sessionId: "S1" })).result.opened, true);
  conn1.ws.close();
  await c1.c.stop();

  // Restart against the same project dir (same trace) — the approve must NOT re-open a second PR.
  const a2 = new RescueMockAdapter(true);
  const c2 = await start(dir, a2);
  after(() => c2.c.stop());
  const conn2 = connect(c2.port);
  await conn2.ready;
  await conn2.waitFor((f) => f.type === "event" && f.event?.type === "session.status");
  const after2 = await conn2.request("pr.approve", { sessionId: "S1" });
  assert.equal(after2.result.opened, false, "reconstructed from trace → no second PR after restart");
  conn2.ws.close();
});

test("diff.refresh re-emits diff.finalized from the adapter", async () => {
  const adapter = new RescueMockAdapter(true);
  const { c, port } = await start(repo(), adapter);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "event" && f.event?.type === "session.status");
  const res = await request("diff.refresh", { sessionId: "S1" });
  assert.equal(res.result.ok, true);
  const diff = await waitFor((f) => f.type === "event" && f.event?.type === "diff.finalized");
  assert.equal(diff.event.added, 10);
  assert.equal(diff.event.files, 2);
  ws.close();
});
