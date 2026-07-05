import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { Coordinator } from "../src/server.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

// SPEC-024 Phase C: the human manual-move op (`spec.transition`), host-optional governance, and the
// reopen/regression edges — one op, two triggers, one gate. These drive the command surface against a
// real git repo (with a `main` mainline + a feature branch) so the host-less local merge is exercised.

const BRANCH = "feat/x";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function specDoc(status = "draft", owner = "tester"): string {
  return `---
spec_id: SPEC-T
title: T
status: ${status}
branch: ${BRANCH}
owner: ${owner}
---

# T

## Requirements

### Requirement: A thing
The system SHALL do a thing.

#### Scenario: it works
- **WHEN** asked
- **THEN** it does

## Change history
- init
`;
}

/** A repo with a `main` mainline and a `${BRANCH}` feature branch carrying the spec at `status`. HEAD is
 *  left on the feature branch (as during authoring). `conflict` seeds a file that collides on merge. */
function repo(status = "in-review", conflict = false): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-tr-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@e.com");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", "main");
  writeFileSync(resolve(dir, "README.md"), "# repo\n", "utf8");
  if (conflict) writeFileSync(resolve(dir, "shared.txt"), "mainline value\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "main init");
  git(dir, "checkout", "-q", "-b", BRANCH);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "t.md"), specDoc(status), "utf8");
  if (conflict) writeFileSync(resolve(dir, "shared.txt"), "feature value\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "spec");
  if (conflict) {
    // Diverge the SAME file on main too, after the branch point, so merging the feature branch conflicts.
    git(dir, "checkout", "-q", "main");
    writeFileSync(resolve(dir, "shared.txt"), "mainline diverged\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "main diverge");
    git(dir, "checkout", "-q", BRANCH); // leave HEAD on the feature branch, as during authoring
  }
  return dir;
}

async function coord(dir: string) {
  const c = new Coordinator(
    new MockAdapter(),
    new Trace(join(dir, ".arke", "trace.ndjson")),
    new GrantStore(join(dir, ".arke", "grants.ndjson")),
    0,
    { projectRoot: dir, registry: new ProjectRegistry({ persist: false }), idleTtlMs: 0 },
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
  return { ws, ready, request, waitFor };
}

const traceKinds = (dir: string): string[] =>
  readFileSync(join(dir, ".arke", "trace.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).kind);

test("manual approve by a distinct actor advances in-review→approved with reason:manual + actor", async () => {
  const dir = repo("in-review");
  const { c, port } = await coord(dir);
  after(() => c.stop());
  const { ws, ready, request, waitFor } = connect(port);
  await ready;
  const res = await request("spec.transition", { specId: "SPEC-T", to: "approved", actor: "rae" });
  assert.equal(res.result.applied, "approved");
  const evt = await waitFor((f) => f.type === "event" && f.event?.type === "spec.status" && f.event.specId === "SPEC-T" && f.event.status === "approved");
  assert.equal(evt.event.reason, "manual");
  assert.equal(evt.event.actor, "rae");
  assert.ok(/status:\s*approved/.test(readFileSync(resolve(dir, "docs", "specifications", "t.md"), "utf8")));
  ws.close();
});

test("a non-adjacent manual transition (draft→approved) is refused server-side, no write", async () => {
  const dir = repo("draft");
  const { c, port } = await coord(dir);
  after(() => c.stop());
  const { ws, ready, request } = connect(port);
  await ready;
  const res = await request("spec.transition", { specId: "SPEC-T", to: "approved", actor: "rae" });
  assert.equal(res.result.applied, "illegal-transition");
  assert.match(res.result.error, /illegal transition 'draft' → 'approved'/);
  assert.ok(/status:\s*draft/.test(readFileSync(resolve(dir, "docs", "specifications", "t.md"), "utf8")));
  ws.close();
});

test("solo self-approval by the owner is allowed but flagged (host-less)", async () => {
  const dir = repo("in-review");
  const { c, port } = await coord(dir);
  after(() => c.stop());
  const { ws, ready, request, waitFor } = connect(port);
  await ready;
  const res = await request("spec.transition", { specId: "SPEC-T", to: "approved", actor: "tester" }); // actor == owner
  assert.equal(res.result.applied, "approved");
  const evt = await waitFor((f) => f.type === "event" && f.event?.type === "spec.status" && f.event.status === "approved");
  assert.equal(evt.event.reason, "manual-solo");
  assert.ok(traceKinds(dir).includes("governance.self-approval-allowed-solo"), "the solo self-approval is recorded distinctly");
  ws.close();
});

test("governance.status reports solo + hostConfigured=false when no webhook host is set", async () => {
  const dir = repo("draft");
  const { c, port } = await coord(dir);
  after(() => c.stop());
  const { ws, ready, request } = connect(port);
  await ready;
  const res = await request("governance.status");
  assert.equal(res.ok, true);
  assert.equal(res.result.level, "solo");
  assert.equal(res.result.hostConfigured, false);
  ws.close();
});

test("host-less deliver performs a local merge into main to reach delivered", async () => {
  const dir = repo("approved");
  const { c, port } = await coord(dir);
  after(() => c.stop());
  const { ws, ready, request, waitFor } = connect(port);
  await ready;
  const res = await request("spec.transition", { specId: "SPEC-T", to: "delivered", actor: "rae" });
  assert.equal(res.result.applied, "delivered", res.result.error);
  await waitFor((f) => f.type === "event" && f.event?.type === "spec.status" && f.event.status === "delivered");
  // The feature branch's spec is now on main (a real merge happened), and the frontmatter reads delivered.
  const mainLog = git(dir, "log", "--oneline", "main");
  assert.ok(mainLog.includes("local merge"), "a local merge commit landed on main");
  assert.ok(git(dir, "show", "main:docs/specifications/t.md").includes("status: delivered"));
  ws.close();
});

test("a conflicting local merge is rejected cleanly — spec stays approved, no half-merge", async () => {
  const dir = repo("approved", /* conflict */ true);
  const { c, port } = await coord(dir);
  after(() => c.stop());
  const { ws, ready, request } = connect(port);
  await ready;
  const res = await request("spec.transition", { specId: "SPEC-T", to: "delivered", actor: "rae" });
  assert.equal(res.result.applied, "merge-failed");
  assert.match(res.result.error, /conflict/i);
  // The merge was aborted: no merge is in progress and no path is left unmerged (only the untracked
  // `.arke/` state remains, which is expected and not a half-merge).
  assert.equal(spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir }).status !== 0, true, "no MERGE_HEAD — the merge was aborted");
  assert.equal(git(dir, "status", "--porcelain").split("\n").some((l) => /^(UU|AA|DD|U|.U)/.test(l)), false, "no unmerged paths");
  // The spec stays approved (the frontmatter on its branch is untouched).
  assert.ok(git(dir, "show", `${BRANCH}:docs/specifications/t.md`).includes("status: approved"));
  ws.close();
});

test("reopening a delivered spec regresses it to in-review (in-place)", async () => {
  const dir = repo("delivered");
  const { c, port } = await coord(dir);
  after(() => c.stop());
  const { ws, ready, request, waitFor } = connect(port);
  await ready;
  const res = await request("spec.transition", { specId: "SPEC-T", to: "in-review", actor: "rae" });
  assert.equal(res.result.applied, "in-review");
  const evt = await waitFor((f) => f.type === "event" && f.event?.type === "spec.status" && f.event.status === "in-review");
  assert.equal(evt.event.reason, "manual");
  ws.close();
});
