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
  /** Simulate the harness resolving a still-live session's identity after a coordinator restart (mirrors
   *  adapter-opencode's `rebuildSessionGraph` + live reconnect) — a plain `session.status` catch-up event
   *  that lets the read model re-learn sessionId → specId with no dispatch ever having happened here. */
  pushRunning(sessionId: string, specId: string) {
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId, specId, kind: "task", status: "running" } as DomainEvent);
  }
  /** Simulate OpenCode's real turn-settle ordering: `session.status: idle` arrives BEFORE the finalising
   *  `message.updated` (normalize.ts) — pushed separately so a test can assert on the board column in the
   *  gap between the two, before the completion oracle has had a chance to see the settled turn. */
  pushIdle(sessionId: string, specId: string) {
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId, specId, kind: "task", status: "idle" } as DomainEvent);
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

test("a harness-reported error releases the delivery claim and cleans up the worktree/branch so a retry actually redispatches", async () => {
  const { dir } = repo();
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  const mine = implementerDispatches(adapter);
  assert.equal(mine.length, 1);
  const sessionId = mine[0]!.sessionId;
  assert.ok(git(dir, "branch", "--list").includes(DELIVERY_BRANCH), "the first delivery's branch exists");

  adapter.pushError(sessionId, "SPEC-DELIVER");
  await sleep(200);

  const r2 = await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  assert.equal(r2.result.ok, true, "the claim was released on error — a retry is not refused as 'already delivering'");
  await sleep(200);

  // The bug this guards: without cleanup, the deterministic `<featureBranch>--delivery` branch from the
  // errored attempt lingers, so the retry's `deliverImplementation` trips its OWN branch-collision guard
  // and silently dispatches nothing — `ok: true` above would be a false promise. Assert the retry actually
  // produced a SECOND implementer session, not just an accepted-but-inert op response.
  assert.equal(implementerDispatches(adapter).length, 2, "the retry actually redispatched a new implementer session, not silently blocked by a stale branch");
});

test("an idle delivery session with an incomplete checklist keeps the card in 'implementing', not the approved backlog", async () => {
  const { dir, specPath } = repo();
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  const sessionId = implementerDispatches(adapter)[0]!.sessionId;

  // OpenCode's real turn-settle ordering emits `session.status: idle` BEFORE the finalising
  // `message.updated` (normalize.ts) — simulate that ordering directly rather than via pushTurnSettled.
  writeFileSync(specPath, readFileSync(specPath, "utf8").replace("- [ ] Build the thing", "- [x] Build the thing"), "utf8");
  adapter.pushIdle(sessionId, "SPEC-DELIVER"); // one of two tasks checked — checklist still incomplete
  await sleep(200);

  const snap = await op(port, "session.list", {});
  const card = snap.result.find((c: any) => c.specId === "SPEC-DELIVER");
  assert.equal(card.column, "implementing", "idle-but-incomplete must not bounce the card back to the approved backlog lane");
});

test("delivery ownership survives a coordinator restart — the checklist oracle still resolves via the read model", async () => {
  const { dir, specPath } = repo();
  const adapterA = new DeliverMockAdapter();
  const { c: cA, port: portA } = await start(dir, adapterA);

  await op(portA, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  const sessionId = implementerDispatches(adapterA)[0]!.sessionId;
  await cA.stop(); // simulate the coordinator process going away mid-delivery

  // A fresh ProjectContext (a new Coordinator over the same repo) with its OWN mock adapter instance —
  // `deliverySessionOwner` starts empty, exactly like a real restart. Its event stream first resolves the
  // still-live session's identity via a `session.status` catch-up event, mirroring how adapter-opencode's
  // `rebuildSessionGraph()` + live reconnect recovers ownership from the harness's own durable state.
  const adapterB = new DeliverMockAdapter();
  const { c: cB, port: portB } = await start(dir, adapterB);
  after(() => cB.stop());
  adapterB.pushRunning(sessionId, "SPEC-DELIVER");
  await sleep(100);

  writeFileSync(specPath, readFileSync(specPath, "utf8").replace("- [ ] Build the thing", "- [x] Build the thing").replace("- [ ] Test the thing", "- [x] Test the thing"), "utf8");
  adapterB.pushTurnSettled(sessionId);
  await sleep(200);

  const snap = await op(portB, "session.list", {});
  const card = snap.result.find((c: any) => c.specId === "SPEC-DELIVER");
  const sess = card.sessions.find((s: any) => s.sessionId === sessionId);
  assert.equal(sess.status, "done", "the fresh coordinator recovered delivery ownership from the read model and completed the checklist oracle, despite never having dispatched this session itself");
});

// ---- SPEC-030: auto-PR configuration -------------------------------------------------------------

test("delivery.configure persists the auto-PR preference and delivery.settings reflects it (round-trip)", async () => {
  const { dir } = repo();
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  // Default: off.
  let settings = await op(port, "delivery.settings", {});
  assert.equal(settings.result.autoOpenPr, false, "auto-PR defaults off — the governed baseline");

  const set = await op(port, "delivery.configure", { autoOpenPr: true });
  assert.equal(set.result.ok, true);
  assert.equal(set.result.autoOpenPr, true);

  settings = await op(port, "delivery.settings", {});
  assert.equal(settings.result.autoOpenPr, true, "the preference persisted to .arke/config.json");

  // The write preserved a hand-editable JSON config on disk.
  const cfg = JSON.parse(readFileSync(join(dir, ".arke", "config.json"), "utf8"));
  assert.equal(cfg.delivery.autoOpenPr, true);
});

test("with auto-PR off (default), the delivery prompt says nothing about opening a PR", async () => {
  const { dir } = repo();
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  const text = implementerDispatches(adapter)[0]!.text;
  assert.ok(!/gh pr create/.test(text), "default delivery does not instruct a PR — it stops at the diff gate");
});

test("with auto-PR configured on, the delivery prompt instructs the implementer to open a PR", async () => {
  const { dir } = repo();
  const adapter = new DeliverMockAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());

  await op(port, "delivery.configure", { autoOpenPr: true });
  await op(port, "spec.deliver", { specId: "SPEC-DELIVER" });
  await sleep(200);
  const text = implementerDispatches(adapter)[0]!.text;
  assert.match(text, /open a pull request/i);
  assert.match(text, /gh pr create --fill/);
  assert.ok(!/--base/.test(text), "no branch interpolated into the shell command (injection-safe; base left to gh default)");
});
