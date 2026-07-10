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

// The webhook endpoint fails closed without a secret; opt into unsigned for these local tests.
process.env.ARKE_WEBHOOK_ALLOW_UNSIGNED = "1";

const BRANCH = "feat/lifecycle-demo";
const OWNER = "dana";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function specDoc(status = "draft"): string {
  return `---
spec_id: SPEC-LIFE
title: Lifecycle demo
status: ${status}
branch: ${BRANCH}
owner: ${OWNER}
capabilities: [demo]
updated: 2026-06-01
---

# Lifecycle demo

## Requirements

### Requirement: A thing
\`capability: demo\` · \`delta: ADDED (${BRANCH})\`

The system SHALL do a thing.

## Design
Simple.

## Change history
- 2026-06-01 · ${BRANCH} · draft — ADDED demo
`;
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-life-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", BRANCH);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "life.md"), specDoc(), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

class SilentAdapter implements HarnessAdapter {
  readonly id = "Silent";
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["events"]);
  }
  async createSession(i: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: `${i.specId}-s` };
  }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    await new Promise<void>((res) => signal?.addEventListener("abort", () => res(), { once: true }));
  }
}

async function start(dir: string) {
  const c = new Coordinator(new SilentAdapter(), new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir,
    registry: new ProjectRegistry({ persist: false }),
    idleTtlMs: 0,
  });
  const port = await c.start();
  return { c, port };
}

function hook(port: number, eventName: string, payload: unknown) {
  return fetch(`http://127.0.0.1:${port}/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": eventName },
    body: JSON.stringify(payload),
  }).then((r) => r.json() as Promise<any>);
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
    setTimeout(() => reject(new Error("op timeout")), 6000);
  });
}

function libraryVia(port: number): Promise<any[]> {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let id = 0;
    ws.on("open", () => ws.send(JSON.stringify({ type: "request", id: `r${++id}`, op: "spec.library" })));
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.type === "response" && f.ok) {
        ws.close();
        resolveP(f.result);
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("library timeout")), 5000);
  });
}

const pr = (action: string, merged = false) => ({ action, pull_request: { number: 3, merged, head: { ref: BRANCH } } });
const review = (login: string) => ({ review: { state: "approved", user: { login } }, pull_request: { number: 3, head: { ref: BRANCH } } });

test("health endpoint responds", async () => {
  const { c, port } = await start(repo());
  after(() => c.stop());
  const r = await fetch(`http://127.0.0.1:${port}/health`).then((x) => x.json() as Promise<any>);
  assert.equal(r.ok, true);
});

test("spec.library lists the project's specs from frontmatter", async () => {
  const { c, port } = await start(repo());
  after(() => c.stop());
  const lib = await libraryVia(port);
  assert.equal(lib.length, 1);
  assert.equal(lib[0].specId, "SPEC-LIFE");
  assert.equal(lib[0].status, "draft");
  assert.deepEqual(lib[0].capabilities, ["demo"]);
});

test("PR opened → in-review; non-self approval → approved; merge → flatten + delivered", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());

  let r = await hook(port, "pull_request", pr("opened"));
  assert.equal(r.routed[0].applied, "in-review");
  assert.equal((await libraryVia(port))[0].status, "in-review");

  r = await hook(port, "pull_request_review", review("rae")); // not the owner
  assert.equal(r.routed[0].applied, "approved");
  assert.equal((await libraryVia(port))[0].status, "approved");

  r = await hook(port, "pull_request", pr("closed", true)); // merged
  assert.equal(r.routed[0].applied, "delivered"); // SPEC-024: the git merge lands the spec as `delivered`
  const onDisk = readFileSync(resolve(dir, "docs", "specifications", "life.md"), "utf8");
  assert.ok(!/delta:/i.test(onDisk), "delta tags flattened on merge");
  assert.ok(/approved — ADDED: 1/.test(onDisk), "Change history line appended");
});

test("self-approval is rejected at the coordinator and does not advance status", async () => {
  const { c, port } = await start(repo());
  after(() => c.stop());
  await hook(port, "pull_request", pr("opened"));
  const r = await hook(port, "pull_request_review", review(OWNER)); // the owner self-approves
  assert.equal(r.routed[0].applied, "self-approval-rejected");
  assert.equal((await libraryVia(port))[0].status, "in-review", "status stays in-review on self-approval");
});

test("PR closed without merge regresses status to draft", async () => {
  const { c, port } = await start(repo());
  after(() => c.stop());
  await hook(port, "pull_request", pr("opened"));
  const r = await hook(port, "pull_request", pr("closed", false));
  assert.equal(r.routed[0].applied, "draft");
  assert.equal((await libraryVia(port))[0].status, "draft");
});

test("a status transition is persisted to frontmatter, so no false divergence warning", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());
  await hook(port, "pull_request", pr("opened"));
  const onDisk = readFileSync(resolve(dir, "docs", "specifications", "life.md"), "utf8");
  assert.ok(/status:\s*in-review/.test(onDisk), "frontmatter status follows PR state");
  assert.equal((await libraryVia(port))[0].hasDivergence, false, "no divergence: read model and file agree");
});

test("synchronize regresses an approved spec only on a MATERIAL change", async () => {
  const dir = repo();
  const file = resolve(dir, "docs", "specifications", "life.md");
  const { c, port } = await start(dir);
  after(() => c.stop());
  await hook(port, "pull_request", pr("opened"));
  await hook(port, "pull_request_review", review("rae")); // approved, baseline hash captured
  assert.equal((await libraryVia(port))[0].status, "approved");

  // Trivial push (Change history only) → stays approved.
  writeFileSync(file, readFileSync(file, "utf8") + "- trivial note\n", "utf8");
  let r = await hook(port, "pull_request", pr("synchronize"));
  assert.equal(r.routed[0]?.applied ?? "no-op", "no-op");
  assert.equal((await libraryVia(port))[0].status, "approved", "trivial push keeps approval");

  // Material push (Design section changed) → regresses to in-review.
  writeFileSync(file, readFileSync(file, "utf8").replace("Simple.", "A materially different design."), "utf8");
  r = await hook(port, "pull_request", pr("synchronize"));
  assert.equal(r.routed[0].applied, "material-change");
  assert.equal((await libraryVia(port))[0].status, "in-review");
});

test("approval is rejected (fail closed) when the spec has no owner to verify against", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arke-noowner-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", BRANCH);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "no.md"), specDoc("draft").replace(/owner: .*\n/, ""), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const { c, port } = await start(dir);
  after(() => c.stop());
  await hook(port, "pull_request", pr("opened"));
  const r = await hook(port, "pull_request_review", review("anyone"));
  assert.equal(r.routed[0].applied, "approval-rejected-no-owner");
  assert.equal((await libraryVia(port))[0].status, "in-review", "ungovernable approval does not advance");
});

test("SPEC-024: the ungated spec.promote door is deleted — no path to in-review skips the gate", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());
  // The old ungated `spec.promote` op no longer exists: there is exactly one door to `in-review`
  // (the gated `approveDraft`). A caller reaching for the removed op gets a structured unknown-op error.
  const r = await op(port, "spec.promote", { specId: "SPEC-LIFE" });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown op/);
  // The spec is untouched — no ungated write advanced it.
  assert.ok(/status:\s*draft/.test(readFileSync(resolve(dir, "docs", "specifications", "life.md"), "utf8")));
  assert.equal((await libraryVia(port))[0].status, "draft");
});

test("an empty-branch payload is ignored, not routed to an unrelated spec", async () => {
  const { c, port } = await start(repo());
  after(() => c.stop());
  const r = await hook(port, "pull_request", { action: "opened", pull_request: { number: 9, head: {} } });
  assert.equal(r.routed.length, 0, "no spec transitioned");
});

test("webhook fails closed: unsigned rejected without opt-in; bad signature rejected with a secret", async () => {
  const { c, port } = await start(repo());
  after(() => c.stop());
  const post = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", ...headers }, body: JSON.stringify(pr("opened")) });

  delete process.env.ARKE_WEBHOOK_ALLOW_UNSIGNED;
  try {
    assert.equal((await post({})).status, 401, "unsigned + no opt-in → 401");
    process.env.ARKE_WEBHOOK_SECRET = "s3cr3t";
    assert.equal((await post({ "x-hub-signature-256": "sha256=deadbeef" })).status, 401, "wrong signature → 401");
  } finally {
    delete process.env.ARKE_WEBHOOK_SECRET;
    process.env.ARKE_WEBHOOK_ALLOW_UNSIGNED = "1"; // restore for any later tests
  }
});

// ---- SPEC-038: the Azure Repos forge drives the SAME lifecycle via POST /webhooks/azure -----------

const AZ_REF = `refs/heads/${BRANCH}`;
const azHook = (port: number, payload: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/webhooks/azure`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
const azJson = (port: number, payload: unknown) => azHook(port, payload).then((r) => r.json() as Promise<any>);
const azUpdated = (extra: Record<string, unknown>) => ({ eventType: "git.pullrequest.updated", resource: { pullRequestId: 3, sourceRefName: AZ_REF, ...extra } });

test("SPEC-038: an Azure Service Hook advances a spec created → approved → delivered via /webhooks/azure", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());

  let r = await azJson(port, { eventType: "git.pullrequest.created", resource: { pullRequestId: 3, status: "active", sourceRefName: AZ_REF } });
  assert.equal(r.routed[0].applied, "in-review", "git.pullrequest.created → in-review");
  assert.equal((await libraryVia(port))[0].status, "in-review");

  // A human reviewer's vote 10 (non-container, non-owner) → approved.
  r = await azJson(port, azUpdated({ status: "active", reviewers: [{ vote: 10, uniqueName: "rae@fabrikam.com", isContainer: false }] }));
  assert.equal(r.routed[0].applied, "approved", "a human vote 10 → approved");
  assert.equal((await libraryVia(port))[0].status, "approved");

  // Completed (merged) → delivered, flattening delta tags exactly as a GitHub merge does.
  r = await azJson(port, azUpdated({ status: "completed" }));
  assert.equal(r.routed[0].applied, "delivered", "status completed → delivered");
  const onDisk = readFileSync(resolve(dir, "docs", "specifications", "life.md"), "utf8");
  assert.ok(!/delta:/i.test(onDisk), "delta tags flattened on the Azure merge too");
});

test("SPEC-038: a container/team vote does not approve; an Azure Basic-auth webhook fails closed on a wrong credential", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());
  await azJson(port, { eventType: "git.pullrequest.created", resource: { pullRequestId: 3, status: "active", sourceRefName: AZ_REF } });

  // A container reviewer's vote must NOT advance to approved (no real approver identity).
  const r = await azJson(port, azUpdated({ status: "active", reviewers: [{ vote: 10, isContainer: true }] }));
  assert.notEqual(r.routed[0]?.applied, "approved", "a team/container vote does not approve");
  assert.equal((await libraryVia(port))[0].status, "in-review");

  // With a secret set, Azure verifies HTTP Basic auth (NOT a GitHub HMAC): a wrong credential → 401.
  delete process.env.ARKE_WEBHOOK_ALLOW_UNSIGNED;
  process.env.ARKE_WEBHOOK_SECRET = "arke:s3cr3t";
  try {
    const wrong = "Basic " + Buffer.from("arke:nope", "utf8").toString("base64");
    const bad = await azHook(port, azUpdated({ status: "completed" }), { authorization: wrong });
    assert.equal(bad.status, 401, "wrong Basic-auth credential → 401 (fail closed)");
    const ok = "Basic " + Buffer.from("arke:s3cr3t", "utf8").toString("base64");
    const good = await azHook(port, azUpdated({ status: "completed" }), { authorization: ok });
    assert.equal(good.status, 200, "the configured Basic-auth credential is accepted");
  } finally {
    delete process.env.ARKE_WEBHOOK_SECRET;
    process.env.ARKE_WEBHOOK_ALLOW_UNSIGNED = "1";
  }
});

test("SPEC-038: reopen advances only from a closed state — a plain Azure active edit is a no-op, GitHub reopen still works", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());

  await hook(port, "pull_request", pr("opened"));
  assert.equal((await libraryVia(port))[0].status, "in-review");

  // Azure emits `reopened` as a candidate for ANY active git.pullrequest.updated (a title edit re-fires it).
  // On an in-review (open, not closed) spec that must be a NO-OP — never a demote/reopen.
  let r = await azJson(port, azUpdated({ status: "active" }));
  assert.equal(r.routed[0]?.applied ?? "no-op", "no-op", "a plain active edit does not reopen an open spec");
  assert.equal((await libraryVia(port))[0].status, "in-review");

  // Close (unmerged) → draft, then an Azure active update (reactivation) from that CLOSED state → in-review.
  await hook(port, "pull_request", pr("closed", false));
  assert.equal((await libraryVia(port))[0].status, "draft");
  r = await azJson(port, azUpdated({ status: "active" }));
  assert.equal(r.routed[0].applied, "in-review", "reactivation from a closed state reopens");

  // GitHub's explicit `reopened` from a closed (draft) state still advances — byte-for-byte unchanged.
  await hook(port, "pull_request", pr("closed", false));
  assert.equal((await libraryVia(port))[0].status, "draft");
  r = await hook(port, "pull_request", pr("reopened"));
  assert.equal(r.routed[0].applied, "in-review", "GitHub reopened from draft still → in-review");
});
