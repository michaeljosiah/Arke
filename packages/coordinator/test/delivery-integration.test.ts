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
import { deliveryWorktreeBranch } from "../src/delivery.js";

const BRANCH = "feat/single-session-demo";
const DELIVERY_BRANCH = deliveryWorktreeBranch(BRANCH);

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function specDoc(tasksSection: string): string {
  return `---
spec_id: SPEC-DELIVER
title: Delivery demo
status: approved
branch: ${BRANCH}
owner: dana
---

# Delivery demo

${tasksSection}

## Change history
- note
`;
}

const DEFAULT_TASKS = `## Tasks
- [ ] Build the thing
- [x] Already done
- [ ] Test the thing`;

function repo(tasksSection: string = DEFAULT_TASKS): { dir: string; specPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "arke-deliver-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", BRANCH);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  const specPath = resolve(dir, "docs", "specifications", "deliver.md");
  writeFileSync(specPath, specDoc(tasksSection), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return { dir, specPath };
}

/** Records dispatched sessions; lets a test push events to simulate a settled turn or a harness error. */
class DeliverMockAdapter implements HarnessAdapter {
  readonly id = "DeliverMock";
  readonly dispatched: Array<{ sessionId: string; agent?: string; text: string }> = [];
  private q: DomainEvent[] = [];
  private n = 0;
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["events", "diff"]);
  }
  async createSession(i: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: `${i.specId}-delivery-${++this.n}` };
  }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    this.dispatched.push({ sessionId: i.sessionId, agent: i.agent, text: i.parts.map((p) => (p as any).text).join("") });
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  /** Simulate the implementer's turn settling — the completion oracle re-reads the spec file at this point. */
  pushTurnSettled(sessionId: string) {
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "message.updated", sessionId, messageId: `m${this.n}`, role: "assistant", text: "turn settled", toolCalls: [], isStreaming: false } as DomainEvent);
  }
  pushError(sessionId: string, specId: string) {
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId, specId, kind: "task", status: "error" } as DomainEvent);
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

async function start(dir: string, adapter: DeliverMockAdapter) {
  const c = new Coordinator(adapter, new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir,
    registry: new ProjectRegistry({ persist: false }),
    idleTtlMs: 0,
  });
  const port = await c.start();
  return { c, port };
}

function op(port: number, opName: string, args?: unknown): Promise<any> {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "request", id: "r1", op: opName, args })));
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

// spec.deliver ALSO fires generate() (SPEC-013, unchanged/pre-existing behaviour) alongside the
// delivery dispatch, and it lands in this same mock's `dispatched` array under agent:'spec-author' —
// filter to the delivery-specific dispatch so that concurrent, unrelated dispatch isn't miscounted.
const implementerDispatches = (adapter: DeliverMockAdapter) => adapter.dispatched.filter((d) => d.agent === "implementer");

test("spec.deliver dispatches ONE implementer session with every unchecked task, in one worktree", async () => {
  const { dir } = repo();
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  const r = await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  assert.equal(r.ok, true);
  await sleep(200);

  const mine = implementerDispatches(adapter);
  assert.equal(mine.length, 1, "exactly one session dispatched, not one per task");
  assert.ok(mine[0]!.text.includes("Build the thing"));
  assert.ok(mine[0]!.text.includes("Test the thing"));
  assert.ok(!mine[0]!.text.includes("Already done"), "checked-off tasks are not re-prompted");

  const branches = git(dir, "branch", "--list");
  assert.ok(branches.includes(DELIVERY_BRANCH), "one delivery branch for the whole spec");
  assert.ok(!branches.includes(`${BRANCH}--task-`), "no per-task branches");
});

test("re-delivering while a delivery session is live is refused, not double-dispatched", async () => {
  const { dir } = repo();
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  assert.equal(implementerDispatches(adapter).length, 1);

  const r2 = await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  assert.equal(r2.result.ok, false);
  assert.match(r2.result.error, /already delivering/);
  await sleep(100);
  assert.equal(implementerDispatches(adapter).length, 1, "no duplicate dispatch");
});

test("a delivery branch collision fails cleanly with no dispatch", async () => {
  const { dir } = repo();
  git(dir, "branch", DELIVERY_BRANCH); // simulate an orphaned worktree branch from a prior run
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  assert.equal(implementerDispatches(adapter).length, 0, "collision refuses the dispatch");
});

test("a spec with no actionable tasks dispatches nothing", async () => {
  const { dir } = repo("## Tasks\n- [x] Already done");
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  assert.equal(implementerDispatches(adapter).length, 0);
});

test("the delivery session is marked done only once every task is checked off — not on every idle turn", async () => {
  const { dir, specPath } = repo();
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  const mine = implementerDispatches(adapter);
  assert.equal(mine.length, 1);
  const sessionId = mine[0]!.sessionId;

  // First turn: the agent checks off one of the two remaining tasks. The session stays steerable —
  // there is no artificial "one turn = done" signal, unlike the old one-shot fan-out task dispatch.
  writeFileSync(specPath, readFileSync(specPath, "utf8").replace("- [ ] Build the thing", "- [x] Build the thing"), "utf8");
  adapter.pushTurnSettled(sessionId);
  await sleep(200);
  let snap = await op(port, "session.list", {});
  let card = snap.result.find((c: any) => c.specId === "SPEC-DELIVER");
  let sess = card.sessions.find((s: any) => s.sessionId === sessionId);
  assert.equal(sess.status, "running", "one task still unchecked — not done yet");

  // Second turn: the last task is checked off — NOW the checklist is complete.
  writeFileSync(specPath, readFileSync(specPath, "utf8").replace("- [ ] Test the thing", "- [x] Test the thing"), "utf8");
  adapter.pushTurnSettled(sessionId);
  await sleep(200);
  snap = await op(port, "session.list", {});
  card = snap.result.find((c: any) => c.specId === "SPEC-DELIVER");
  sess = card.sessions.find((s: any) => s.sessionId === sessionId);
  assert.equal(sess.status, "done", "all tasks checked → board surfaces diff review");
});

test("a harness-reported error releases the delivery claim so a fresh deliver() can retry", async () => {
  const { dir } = repo();
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  const mine = implementerDispatches(adapter);
  assert.equal(mine.length, 1);
  const sessionId = mine[0]!.sessionId;

  adapter.pushError(sessionId, "SPEC-DELIVER");
  await sleep(200);

  const r2 = await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  assert.equal(r2.result.ok, true, "the claim was released on error — a retry is not refused as 'already delivering'");
});
