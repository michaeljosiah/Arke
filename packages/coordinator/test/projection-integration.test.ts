import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type { Capability, CreateSessionInput, DomainEvent, HarnessAdapter, SendMessageInput, SendReceipt, SessionRef } from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

const BRANCH = "feat/proj-demo";
const ARTIFACTS = [{ target: "ticket", title: "Story", content: "do it", sorTarget: "github" }];

function git(cwd: string, ...a: string[]) { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); }
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-proj-"));
  git(dir, "init", "-q"); git(dir, "config", "user.email", "t@e.com"); git(dir, "config", "user.name", "T");
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "p.md"), "---\nspec_id: SPEC-PROJ\nstatus: approved\nbranch: " + BRANCH + "\n---\n# P\n## Requirements\n### Requirement: A\nThe system SHALL x.\n", "utf8");
  return dir;
}

class GenMockAdapter implements HarnessAdapter {
  readonly id = "GenMock";
  private q: DomainEvent[] = [];
  private n = 0;
  capabilities(): ReadonlySet<Capability> { return new Set<Capability>(["events"]); }
  async createSession(i: CreateSessionInput): Promise<SessionRef> { return { sessionId: `${i.specId}-gen-${++this.n}` }; }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> { return { sessionId: i.sessionId, correlationId: "c" }; }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "message.updated", sessionId: i.sessionId, messageId: `m-${i.sessionId}`, role: "assistant", text: "```json\n" + JSON.stringify(ARTIFACTS) + "\n```", toolCalls: [], isStreaming: false } as DomainEvent);
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    while (!signal?.aborted) { const next = this.q.shift(); if (next) { yield next; continue; } await new Promise<void>((r) => { const t = setTimeout(r, 10); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); }); }
  }
}

async function start(dir: string) {
  const c = new Coordinator(new GenMockAdapter(), new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, { projectRoot: dir, registry: new ProjectRegistry({ persist: false }), idleTtlMs: 0 });
  return { c, port: await c.start() };
}
function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); const frames: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void; t: any }> = [];
  ws.on("message", (d) => { const f = JSON.parse(d.toString()); frames.push(f); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.pred(f)) { clearTimeout(waiters[i]!.t); waiters[i]!.resolve(f); waiters.splice(i, 1); } });
  const ready = new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
  const waitFor = (pred: (f: any) => boolean, ms = 5000) => new Promise<any>((res, rej) => { const ex = frames.find(pred); if (ex) return res(ex); const t = setTimeout(() => rej(new Error("frame not seen")), ms); waiters.push({ pred, resolve: res, t }); });
  let n = 0; const request = (op: string, args?: unknown) => { const id = `r${++n}`; ws.send(JSON.stringify({ type: "request", id, op, args })); return waitFor((f) => f.type === "response" && f.id === id); };
  return { ws, ready, waitFor, request };
}

test("integration.status reflects the env and never returns a credential", async () => {
  process.env.GITHUB_TOKEN = "ghp_topsecret";
  try {
    const { c, port } = await start(repo());
    after(() => c.stop());
    const { ws, ready, request } = connect(port);
    await ready;
    const res = await request("integration.status");
    const gh = res.result.find((r: any) => r.id === "github");
    assert.equal(gh.status, "connected");
    assert.equal(JSON.stringify(res.result).includes("ghp_topsecret"), false, "no credential in the payload");
    ws.close();
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("approve → projection.write with idempotency key → projections.query lists it; retry verifies the approval", async () => {
  const { c, port } = await start(repo());
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await request("spec.generate", { specId: "SPEC-PROJ" });
  const proposed = await waitFor((f) => f.type === "event" && f.event?.type === "generation.proposed");
  const artId = proposed.event.artifacts[0].id;
  await request("generation.approve", { specId: "SPEC-PROJ", proposalId: proposed.event.sessionId });
  const pw = await waitFor((f) => f.type === "event" && f.event?.type === "projection.write");
  assert.equal(pw.event.target, "github");
  assert.ok(pw.event.idempotencyKey, "idempotency key present");

  const q = await request("projections.query", { specId: "SPEC-PROJ" });
  assert.ok(q.result.rows.length >= 1, "projections-status lists the write");

  const retry = await request("retry-projection", { specId: "SPEC-PROJ", artifactId: artId, target: "github" });
  assert.equal(retry.result.ok, true, "retry authorised by the original approval");
  const badRetry = await request("retry-projection", { specId: "SPEC-PROJ", artifactId: "art-nope", target: "github" });
  assert.equal(badRetry.result.ok, false, "retry refused without an approval record");

  // SPEC-015: the audit query returns the full causal chain for the spec, scoped to this project.
  const audit = await request("get-audit-records", { specId: "SPEC-PROJ" });
  assert.ok(audit.result.projectId, "response carries its projectId (SPEC-018 disambiguation)");
  const kinds = new Set(audit.result.records.map((r: any) => r.kind === "event" ? r.event.type : r.kind));
  assert.ok(kinds.has("generation.decision"), "approval decision is in the audit trace");
  assert.ok(kinds.has("projection.write") || [...kinds].some((k) => k === "projection.write"), "projection write is in the audit trace");
  const seqs = audit.result.records.map((r: any) => r.seq);
  assert.deepEqual([...seqs].sort((a, b) => b - a), seqs, "records are newest-first by monotonic seq");
  ws.close();
});
