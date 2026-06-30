import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type { Capability, CreateSessionInput, DomainEvent, HarnessAdapter, SendMessageInput, SendReceipt, SessionRef } from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

const BRANCH = "feat/parallel-demo";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function specDoc(): string {
  return `---
spec_id: SPEC-FAN
title: Fan demo
status: approved
branch: ${BRANCH}
owner: dana
---

# Fan demo

## Tasks
- [ ] Build the thing
- [x] Already done
- [ ] Test the thing

## Change history
- note
`;
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-fan-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", BRANCH);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "fan.md"), specDoc(), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Records dispatched sessions; lets a test push session.status events (e.g. idle) to drain the queue. */
class FanMockAdapter implements HarnessAdapter {
  readonly id = "FanMock";
  readonly dispatched: Array<{ sessionId: string; text: string }> = [];
  private q: DomainEvent[] = [];
  private n = 0;
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["events", "diff"]);
  }
  async createSession(i: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: `${i.specId}-task-${++this.n}` };
  }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    this.dispatched.push({ sessionId: i.sessionId, text: i.parts.map((p) => (p as any).text).join("") });
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  pushIdle(sessionId: string) {
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId, specId: "SPEC-FAN", kind: "task", status: "idle" } as DomainEvent);
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    while (!signal?.aborted) {
      const next = this.q.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 10);
        signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
      });
    }
  }
}

async function start(dir: string, adapter: FanMockAdapter) {
  const c = new Coordinator(adapter, new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir,
    registry: new ProjectRegistry({ persist: false }),
    idleTtlMs: 0,
  });
  const port = await c.start();
  return { c, port };
}

function op(port: number, op: string, args?: unknown): Promise<any> {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "request", id: "r1", op, args })));
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.type === "response" && f.id === "r1") {
        ws.close();
        resolveP(f);
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("op timeout")), 8000);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("fanOut dispatches only unchecked tasks, each in its own worktree, idempotently", async () => {
  const dir = repo();
  const adapter = new FanMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  const r = await op(port, "spec.fanout", { specId: "SPEC-FAN" });
  assert.equal(r.ok, true);
  assert.equal(r.result.dispatched, 2, "two unchecked tasks dispatched (the [x] one is skipped)");
  assert.equal(adapter.dispatched.length, 2);
  // Distinct worktrees exist on disk for task-0 and task-2.
  assert.ok(existsSync(resolve(dir, ".arke", "worktrees", "feat_parallel-demo--task-0")));
  assert.ok(existsSync(resolve(dir, ".arke", "worktrees", "feat_parallel-demo--task-2")));
  const branches = git(dir, "branch", "--list");
  assert.ok(branches.includes("feat/parallel-demo--task-0") && branches.includes("feat/parallel-demo--task-2"));

  // Idempotent: a second fan-out dispatches nothing new (FanOutRecord guards it).
  const r2 = await op(port, "spec.fanout", { specId: "SPEC-FAN" });
  assert.equal(r2.result.dispatched, 0);
  assert.equal(adapter.dispatched.length, 2, "no duplicate dispatch");
});

test("a worktree branch collision fails that task only; the other still dispatches", async () => {
  const dir = repo();
  // Pre-create the branch for task-0 → simulate an orphaned worktree from a prior run.
  git(dir, "branch", "feat/parallel-demo--task-0");
  const adapter = new FanMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  const r = await op(port, "spec.fanout", { specId: "SPEC-FAN" });
  assert.equal(r.result.dispatched, 1, "only task-2 dispatched; task-0 collided");
  assert.equal(adapter.dispatched.length, 1);
});

test("the concurrency cap queues the excess and drains it as tasks complete", async () => {
  const dir = repo();
  const adapter = new FanMockAdapter();
  process.env.ARKE_MAX_CONCURRENT_TASKS = "1";
  try {
    const { c, port } = await start(dir, adapter);
    after(() => c.stop());
    const r = await op(port, "spec.fanout", { specId: "SPEC-FAN" });
    assert.equal(r.result.dispatched, 1, "cap=1 → one dispatched");
    assert.equal(r.result.queued, 1, "one queued");
    const firstSession = adapter.dispatched[0]!.sessionId;
    // Complete the running task → the queued task drains.
    adapter.pushIdle(firstSession);
    await sleep(300);
    assert.equal(adapter.dispatched.length, 2, "queued task dispatched after the first completed");
  } finally {
    delete process.env.ARKE_MAX_CONCURRENT_TASKS;
  }
});

test("a spec with no actionable tasks fails gracefully (no dispatch)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arke-notasks-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", BRANCH);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "empty.md"), specDoc().replace(/## Tasks[\s\S]*?## Change history/, "## Change history"), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const adapter = new FanMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());
  const r = await op(port, "spec.fanout", { specId: "SPEC-FAN" });
  assert.equal(r.result.error, "no-tasks");
  assert.equal(adapter.dispatched.length, 0);
});
