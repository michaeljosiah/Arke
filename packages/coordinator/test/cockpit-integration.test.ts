import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type {
  Capability,
  CreateSessionInput,
  DomainEvent,
  HarnessAdapter,
  SendMessageInput,
  SendReceipt,
  SessionRef,
} from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

const BRANCH = "feat/authoring-cockpit";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function specDoc(branch: string, status = "draft"): string {
  return `---
spec_id: SPEC-TEST
title: Test spec
status: ${status}
branch: ${branch}
owner: tester
---

# Test spec

## Requirements

### Requirement: A thing
\`capability: x\` · \`delta: ADDED (${branch})\`

The system SHALL do a thing.

## Change history
- 2026-06-28 · ${branch} · draft — ADDED x
`;
}

/** A git repo with one spec file committed on `branch` (HEAD), used as a project root. */
function repoWith(specBranch: string, headBranch = BRANCH): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-cockpit-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", headBranch);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "test.md"), specDoc(specBranch), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function coordinatorAt(root: string, adapter?: HarnessAdapter) {
  const c = new Coordinator(
    adapter ?? new MockAdapter(),
    new Trace(join(root, ".arke", "trace.ndjson")),
    new GrantStore(join(root, ".arke", "grants.ndjson")),
    0,
    { projectRoot: root, registry: new ProjectRegistry({ persist: false }), idleTtlMs: 0 },
  );
  const port = await c.start();
  return { c, port };
}

function connect(port: number) {
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
  const ready = new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });
  const waitFor = (pred: (f: any) => boolean, ms = 5000) =>
    new Promise<any>((res, rej) => {
      const existing = frames.find(pred);
      if (existing) return res(existing);
      const t = setTimeout(() => rej(new Error("frame not seen")), ms);
      waiters.push({ pred, resolve: res, t });
    });
  let n = 0;
  const request = (op: string, args?: unknown) => {
    const id = `r${++n}`;
    ws.send(JSON.stringify({ type: "request", id, op, args }));
    return waitFor((f) => f.type === "response" && f.id === id);
  };
  return { ws, ready, waitFor, request };
}

test("spec.file returns the working specification text + metadata", async () => {
  const { c, port } = await coordinatorAt(repoWith(BRANCH));
  after(() => c.stop());
  const { ws, ready, request } = connect(port);
  await ready;
  const res = await request("spec.file", { specId: "SPEC-TEST" });
  assert.equal(res.ok, true);
  assert.equal(res.result.exists, true);
  assert.equal(res.result.branch, BRANCH);
  assert.equal(res.result.status, "draft");
  assert.ok(res.result.text.includes("The system SHALL do a thing"));
  assert.equal(res.result.path, "docs/specifications/test.md");
  ws.close();
});

test("approveDraft on a matching HEAD commits and advances status", async () => {
  const dir = repoWith(BRANCH);
  const { c, port } = await coordinatorAt(dir);
  after(() => c.stop());
  const { ws, ready, request, waitFor } = connect(port);
  await ready;
  const res = await request("approveDraft", { specId: "SPEC-TEST", branch: BRANCH });
  assert.equal(res.ok, true);
  assert.equal(res.result.status, "in-review");
  // a spec.status event was emitted
  const evt = await waitFor((f) => f.type === "event" && f.event?.type === "spec.status" && f.event.specId === "SPEC-TEST");
  assert.equal(evt.event.status, "in-review");
  // the file on disk now reads in-review + a new change-history line, and was committed
  const onDisk = readFileSync(resolve(dir, "docs", "specifications", "test.md"), "utf8");
  assert.ok(/status:\s*in-review/.test(onDisk));
  assert.ok(onDisk.includes("in-review — approved via the authoring cockpit"));
  const log = git(dir, "log", "--oneline");
  assert.ok(log.includes("approve → in-review"));
  // the spec file is fully committed — no partial state left in the working tree for it
  assert.equal(git(dir, "status", "--porcelain", "--", "docs/specifications/test.md").trim(), "");
  ws.close();
});

test("approveDraft with a mismatched branch fails, emits spec.approval-failed, leaves status unchanged", async () => {
  // frontmatter says feat/other, but HEAD is feat/authoring-cockpit → branch guard must reject.
  const dir = repoWith("feat/other", BRANCH);
  const { c, port } = await coordinatorAt(dir);
  after(() => c.stop());
  const { ws, ready, request, waitFor } = connect(port);
  await ready;
  const res = await request("approveDraft", { specId: "SPEC-TEST" });
  assert.equal(res.ok, false);
  assert.match(res.error, /branch guard/i);
  const evt = await waitFor((f) => f.type === "event" && f.event?.type === "spec.approval-failed");
  assert.equal(evt.event.specId, "SPEC-TEST");
  // status on disk is unchanged (still draft) and nothing new was committed
  const onDisk = readFileSync(resolve(dir, "docs", "specifications", "test.md"), "utf8");
  assert.ok(/status:\s*draft/.test(onDisk));
  assert.equal(git(dir, "status", "--porcelain", "--", "docs/specifications/test.md").trim(), "");
  ws.close();
});

test("approveDraft refuses a spec that is not still a draft (no lifecycle regression)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arke-cockpit-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", BRANCH);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "test.md"), specDoc(BRANCH, "approved"), "utf8"); // already approved
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const { c, port } = await coordinatorAt(dir);
  after(() => c.stop());
  const { ws, ready, request } = connect(port);
  await ready;
  const res = await request("approveDraft", { specId: "SPEC-TEST" });
  assert.equal(res.ok, false);
  assert.match(res.error, /expected 'draft'/);
  ws.close();
});

test("approveDraft rolls back the working tree AND the index when the commit fails", async () => {
  const dir = repoWith(BRANCH);
  // Force `git commit` to fail deterministically by signing with a non-existent gpg program.
  git(dir, "config", "commit.gpgsign", "true");
  git(dir, "config", "gpg.program", "definitely-not-a-real-gpg-binary-xyz");
  const { c, port } = await coordinatorAt(dir);
  after(() => c.stop());
  const { ws, ready, request, waitFor } = connect(port);
  await ready;
  const res = await request("approveDraft", { specId: "SPEC-TEST" });
  assert.equal(res.ok, false);
  await waitFor((f) => f.type === "event" && f.event?.type === "spec.approval-failed");
  // status unchanged on disk AND nothing left staged/modified for the spec file (index + tree clean)
  const onDisk = readFileSync(resolve(dir, "docs", "specifications", "test.md"), "utf8");
  assert.ok(/status:\s*draft/.test(onDisk));
  assert.equal(git(dir, "status", "--porcelain", "--", "docs/specifications/test.md").trim(), "");
  ws.close();
});

test("convenePanel acks with the resolved branch reference (no file content)", async () => {
  const { c, port } = await coordinatorAt(repoWith(BRANCH));
  after(() => c.stop());
  const { ws, ready, request } = connect(port);
  await ready;
  const res = await request("convenePanel", { specId: "SPEC-TEST" });
  assert.equal(res.ok, true);
  assert.equal(res.result.convened, true);
  assert.equal(res.result.branch, BRANCH);
  ws.close();
});

/** An adapter that parks one session in `waiting` so the stale-session guard can be exercised. */
class WaitingAdapter implements HarnessAdapter {
  readonly id = "Waiting";
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["events"]);
  }
  async createSession(_i: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: "S1" };
  }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    yield { seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId: "S1", specId: "SPEC-TEST", kind: "task", status: "waiting" };
    await new Promise<void>((res) => signal?.addEventListener("abort", () => res(), { once: true }));
  }
}

test("stale-session guard rejects a prompt to a non-idle/running session", async () => {
  const { c, port } = await coordinatorAt(repoWith(BRANCH), new WaitingAdapter());
  after(() => c.stop());
  const { ws, ready, request, waitFor } = connect(port);
  await ready;
  await waitFor((f) => f.type === "event" && f.event?.type === "session.status" && f.event.status === "waiting");
  const res = await request("prompt.send", { sessionId: "S1", agent: "implementer", tier: "mid", message: "hi" });
  assert.equal(res.ok, false);
  assert.match(res.error, /waiting/);
  ws.close();
});
