import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type { Capability, CreateSessionInput, DomainEvent, HarnessAdapter, SendMessageInput, SendReceipt, SessionRef } from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

const BRANCH = "feat/gen-demo";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-gen-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "g.md"), "---\nspec_id: SPEC-GEN\nstatus: approved\nbranch: " + BRANCH + "\n---\n# Gen\n## Requirements\n### Requirement: A\nThe system SHALL x.\n", "utf8");
  return dir;
}

const ARTIFACTS = [
  { target: "docs", title: "Feature doc", content: "# Feature" },
  { target: "ticket", title: "Story", content: "implement", sorTarget: "jira" },
];

/** On a generation dispatch, emits a message.updated carrying the JSON artefact proposal. */
class GenMockAdapter implements HarnessAdapter {
  readonly id = "GenMock";
  private q: DomainEvent[] = [];
  private n = 0;
  capabilities(): ReadonlySet<Capability> { return new Set<Capability>(["events"]); }
  async createSession(i: CreateSessionInput): Promise<SessionRef> { return { sessionId: `${i.specId}-gen-${++this.n}` }; }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> { return { sessionId: i.sessionId, correlationId: "c" }; }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId: i.sessionId, specId: "SPEC-GEN", kind: "task", status: "running" } as DomainEvent);
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "message.updated", sessionId: i.sessionId, messageId: `m-${i.sessionId}`, role: "assistant", text: "```json\n" + JSON.stringify(ARTIFACTS) + "\n```", toolCalls: [], isStreaming: false } as DomainEvent);
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    while (!signal?.aborted) {
      const next = this.q.shift();
      if (next) { yield next; continue; }
      await new Promise<void>((r) => { const t = setTimeout(r, 10); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
    }
  }
}

async function start(dir: string) {
  const c = new Coordinator(new GenMockAdapter(), new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir, registry: new ProjectRegistry({ persist: false }), idleTtlMs: 0,
  });
  return { c, port: await c.start() };
}

function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void; t: any }> = [];
  ws.on("message", (d) => { const f = JSON.parse(d.toString()); frames.push(f); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.pred(f)) { clearTimeout(waiters[i]!.t); waiters[i]!.resolve(f); waiters.splice(i, 1); } });
  const ready = new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
  const waitFor = (pred: (f: any) => boolean, ms = 5000) => new Promise<any>((res, rej) => { const ex = frames.find(pred); if (ex) return res(ex); const t = setTimeout(() => rej(new Error("frame not seen")), ms); waiters.push({ pred, resolve: res, t }); });
  let n = 0;
  const request = (op: string, args?: unknown) => { const id = `r${++n}`; ws.send(JSON.stringify({ type: "request", id, op, args })); return waitFor((f) => f.type === "response" && f.id === id); };
  return { ws, ready, waitFor, request };
}

const traceLines = (dir: string) => readFileSync(resolve(dir, ".arke", "trace.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("generate → generation.proposed; partial approve records the decision in the trace before any write", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  const gen = await request("spec.generate", { specId: "SPEC-GEN" });
  assert.equal(gen.ok, true);
  const proposed = await waitFor((f) => f.type === "event" && f.event?.type === "generation.proposed");
  const proposalId = proposed.event.sessionId;
  assert.equal(proposed.event.artifacts.length, 2);
  assert.equal(proposed.event.artifacts[1].sorTarget, "jira");

  // Partial approve: only the docs artefact, with an edit.
  const docId = proposed.event.artifacts[0].id;
  const decided = await request("generation.approve", { specId: "SPEC-GEN", proposalId, approvedArtifactIds: [docId], edits: [{ id: docId, content: "# Edited doc" }] });
  assert.equal(decided.result.ok, true);
  assert.equal(decided.result.written, 1);

  const lines = traceLines(dir);
  const decisionIdx = lines.findIndex((l) => l.kind === "generation.decision" && l.decision === "approved");
  const writeIdx = lines.findIndex((l) => l.kind === "event" && l.event?.type === "projection.write");
  assert.ok(decisionIdx >= 0, "approval recorded");
  assert.ok(decisionIdx < writeIdx, "decision traced before the write");
  assert.equal(lines[decisionIdx].finalContent.find((a: any) => a.id === docId).content, "# Edited doc", "edited content recorded");
});

test("a stale proposalId is rejected and writes nothing", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await request("spec.generate", { specId: "SPEC-GEN" });
  await waitFor((f) => f.type === "event" && f.event?.type === "generation.proposed");
  const res = await request("generation.approve", { specId: "SPEC-GEN", proposalId: "not-the-real-id" });
  assert.equal(res.result.ok, false);
  assert.match(res.result.error, /stale/);
});

test("reject discards the proposal", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await request("spec.generate", { specId: "SPEC-GEN" });
  const proposed = await waitFor((f) => f.type === "event" && f.event?.type === "generation.proposed");
  const res = await request("generation.reject", { specId: "SPEC-GEN", proposalId: proposed.event.sessionId });
  assert.equal(res.result.ok, true);
  // A second decision on the discarded proposal is refused.
  const again = await request("generation.reject", { specId: "SPEC-GEN", proposalId: proposed.event.sessionId });
  assert.equal(again.result.ok, false);
});
