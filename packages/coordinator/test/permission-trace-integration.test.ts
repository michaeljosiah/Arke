import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type { Capability, CreateSessionInput, DomainEvent, HarnessAdapter, PermissionAck, PermissionDecision, SendMessageInput, SendReceipt, SessionRef } from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-perm-"));
  mkdirSync(resolve(dir, ".arke"), { recursive: true });
  return dir;
}

class PermMockAdapter implements HarnessAdapter {
  readonly id = "PermMock";
  readonly responded: PermissionDecision[] = [];
  readonly elicited: Array<{ verb: string; q: string; answer?: string }> = [];
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["events", "permissions"]);
  }
  async createSession(i: CreateSessionInput): Promise<SessionRef> { return { sessionId: "S1" }; }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> { return { sessionId: i.sessionId, correlationId: "c" }; }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> { return { sessionId: i.sessionId, correlationId: "c" }; }
  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    this.responded.push(decision);
    return { permissionId: decision.permissionId, status: "ok" } as PermissionAck;
  }
  async respondToElicitation(q: string, answer: string): Promise<void> { this.elicited.push({ verb: "reply", q, answer }); }
  async rejectElicitation(q: string): Promise<void> { this.elicited.push({ verb: "reject", q }); }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    yield { seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId: "S1", specId: "SPEC-P", kind: "task", status: "running" };
    yield { seq: 0, ts: 0, harness: this.id, type: "permission.asked", sessionId: "S1", permissionId: "perm-1", title: "Write file" } as DomainEvent;
    yield { seq: 0, ts: 0, harness: this.id, type: "elicitation.asked", sessionId: "S1", elicitationId: "q-1", question: "Proceed?" } as DomainEvent;
    await new Promise<void>((res) => signal?.addEventListener("abort", () => res(), { once: true }));
  }
}

async function start(dir: string, adapter: HarnessAdapter) {
  const c = new Coordinator(adapter, new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir, registry: new ProjectRegistry({ persist: false }), idleTtlMs: 0,
  });
  return { c, port: await c.start() };
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
  return { ws, ready, waitFor, request, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

const traceLines = (dir: string) => readFileSync(resolve(dir, ".arke", "trace.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("a permission decision is traced (permission.decision) BEFORE it is relayed to the adapter", async () => {
  const dir = repo();
  const adapter = new PermMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());
  const { ws, ready, waitFor, send } = connect(port);
  await ready;
  await waitFor((f) => f.type === "event" && f.event?.type === "permission.asked");
  send({ type: "respondToPermission", permissionId: "perm-1", decision: "once" });
  await waitFor((f) => f.type === "permission.ack");
  assert.deepEqual(adapter.responded.map((d) => d.permissionId), ["perm-1"], "relayed once");
  const lines = traceLines(dir);
  const decisionIdx = lines.findIndex((l) => l.kind === "permission.decision" && l.permissionId === "perm-1");
  const ackIdx = lines.findIndex((l) => l.kind === "permission.ack");
  assert.ok(decisionIdx >= 0, "permission.decision recorded");
  assert.ok(decisionIdx < ackIdx, "decision is traced before the relay ack");
  assert.equal(lines[decisionIdx].identity, "anonymous");
  ws.close();
});

test("a decision for an unknown permission id is rejected with a warn trace and no relay", async () => {
  const dir = repo();
  const adapter = new PermMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());
  const { ws, ready, waitFor, send } = connect(port);
  await ready;
  await waitFor((f) => f.type === "event" && f.event?.type === "permission.asked");
  send({ type: "respondToPermission", permissionId: "does-not-exist", decision: "once" });
  await waitFor((f) => f.type === "permission.error" && f.permissionId === "does-not-exist");
  assert.equal(adapter.responded.length, 0, "no relay for an unknown permission");
  assert.ok(traceLines(dir).some((l) => l.kind === "permission.warn" && l.permissionId === "does-not-exist"));
  ws.close();
});

test("elicitation.reply / reject route to the adapter and are traced before relay", async () => {
  const dir = repo();
  const adapter = new PermMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "event" && f.event?.type === "elicitation.asked");
  const res = await request("elicitation.reply", { sessionId: "S1", questionId: "q-1", answer: "yes" });
  assert.equal(res.result.ok, true);
  assert.deepEqual(adapter.elicited, [{ verb: "reply", q: "q-1", answer: "yes" }]);
  assert.ok(traceLines(dir).some((l) => l.kind === "elicitation.decision" && l.questionId === "q-1" && l.identity === "anonymous"));
  ws.close();
});
