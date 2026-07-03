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
  Readiness,
  SendMessageInput,
  SendReceipt,
  SessionRef,
} from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";
import type { RegistryConfig } from "../src/registry.js";

const BRANCH = "feat/multi-model-review-panel";
const SECTION = "requirements > Requirement: A thing";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function specDoc(): string {
  return `---
spec_id: SPEC-TEST
title: Test spec
status: draft
branch: ${BRANCH}
owner: tester
---

# Test spec

## Requirements

### Requirement: A thing
\`capability: x\` · \`delta: ADDED (${BRANCH})\`

The system SHALL do a thing.

## Change history
- 2026-06-30 · ${BRANCH} · draft — ADDED x
`;
}

function repoWithSpec(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-panel-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", BRANCH);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "test.md"), specDoc(), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A two-instance registry with distinct capable models so a default panel validates. */
function registryConfig(capableModels = ["anthropic/opus", "github-copilot/gpt"]): RegistryConfig {
  const instances = [
    { id: "claude-local", driver: "claude-code", host: "localhost", cwd: ".", credentialsRef: "c/d", serves: [{ tier: "capable" as const, model: capableModels[0]! }] },
    ...(capableModels[1] ? [{ id: "opencode-local", driver: "opencode", host: "localhost", cwd: ".", credentialsRef: "o/g", serves: [{ tier: "capable" as const, model: capableModels[1]! }] }] : []),
  ];
  return {
    instances,
    roster: {
      "spec-author": { tier: "capable" },
      "reviewer-a": { tier: "capable", instance: "claude-local" },
      "reviewer-b": { tier: "capable", instance: capableModels[1] ? "opencode-local" : "claude-local" },
    },
  };
}

/** An adapter that, when a reviewer is dispatched, emits a completed turn carrying JSON issues. */
class ReviewMockAdapter implements HarnessAdapter {
  readonly id = "ReviewMock";
  private q: DomainEvent[] = [];
  private n = 0;
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["events", "diff"]);
  }
  readiness(): Readiness {
    return { ready: true };
  }
  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: `${input.specId}-s${++this.n}` };
  }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    const issues: Record<string, Array<{ section: string; severity: string; text: string }>> = {
      "reviewer-a": [{ section: SECTION, severity: "blocking", text: "a-concern" }],
      "reviewer-b": [{ section: SECTION, severity: "suggestion", text: "b-concern" }],
    };
    const mine = issues[i.agent];
    if (mine) {
      this.q.push({ seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId: i.sessionId, specId: "SPEC-TEST", kind: "task", status: "running" } as DomainEvent);
      this.q.push({ seq: 0, ts: 0, harness: this.id, type: "message.updated", sessionId: i.sessionId, messageId: `m-${i.sessionId}`, role: "assistant", text: JSON.stringify(mine), toolCalls: [], isStreaming: false } as DomainEvent);
    }
    return { sessionId: i.sessionId, correlationId: "c" };
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

async function start(dir: string, cfg: RegistryConfig) {
  const c = new Coordinator(new ReviewMockAdapter(), new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir,
    registry: new ProjectRegistry({ persist: false }),
    registryConfig: cfg,
    connectedInstanceId: "claude-local",
    idleTtlMs: 0,
  });
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
      if (waiters[i]!.pred(f)) { clearTimeout(waiters[i]!.t); waiters[i]!.resolve(f); waiters.splice(i, 1); }
    }
  });
  const ready = new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
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
  const ev = (t: string, extra: (e: any) => boolean = () => true) => waitFor((f) => f.type === "event" && f.event?.type === t && extra(f.event));
  return { ws, ready, waitFor, request, ev, frames };
}

test("a panel runs end to end: issues, agreement, completion — and satisfies the approval gate", async () => {
  const dir = repoWithSpec();
  const { c, port } = await start(dir, registryConfig());
  after(() => c.stop());
  const { ws, ready, request, ev, frames } = connect(port);
  await ready;

  const conv = await request("convenePanel", { specId: "SPEC-TEST" });
  assert.equal(conv.ok, true);
  assert.equal(conv.result.reviewers.length, 2);
  assert.ok(/capable — /.test(conv.result.reviewers[0].model)); // tier label, not a vendor id

  await ev("panel.started");
  await ev("panel.issue", (e) => e.reviewerRole === "reviewer-a");
  await ev("panel.issue", (e) => e.reviewerRole === "reviewer-b"); // BOTH reviewers' issues captured (no dropped-on-race)
  await ev("panel.agreed", (e) => e.section === SECTION); // both reviewers hit the same section
  const complete = await ev("panel.complete");
  assert.equal(complete.event.status, "complete");
  assert.equal(complete.event.specId, "SPEC-TEST"); // panel.complete carries its own specId (gate keys off it)

  // panel.started must reach the client before any panel.issue, so the UI has columns to fold into.
  const idx = (pred: (e: any) => boolean) => frames.findIndex((f) => f.type === "event" && pred(f.event));
  assert.ok(idx((e) => e.type === "panel.started") < idx((e) => e.type === "panel.issue"));

  // The finalisation gate is now satisfied → approveDraft commits.
  const appr = await request("approveDraft", { specId: "SPEC-TEST" });
  assert.equal(appr.ok, true);
  assert.equal(appr.result.status, "in-review");
  assert.ok(/status:\s*in-review/.test(readFileSync(resolve(dir, "docs", "specifications", "test.md"), "utf8")));
  ws.close();
});

test("approveDraft is blocked by the review gate until a panel completes", async () => {
  const dir = repoWithSpec();
  const { c, port } = await start(dir, registryConfig());
  after(() => c.stop());
  const { ws, ready, request, ev } = connect(port);
  await ready;
  const appr = await request("approveDraft", { specId: "SPEC-TEST" });
  assert.equal(appr.ok, false);
  assert.match(appr.error, /no completed review/i);
  await ev("review.gate-failed");
  // status unchanged on disk
  assert.ok(/status:\s*draft/.test(readFileSync(resolve(dir, "docs", "specifications", "test.md"), "utf8")));
  ws.close();
});

test("convenePanel rejects a config without enough distinct capable models", async () => {
  const dir = repoWithSpec();
  const { c, port } = await start(dir, registryConfig(["anthropic/opus"])); // one capable model only
  after(() => c.stop());
  const { ws, ready, request, ev } = connect(port);
  await ready;
  const conv = await request("convenePanel", { specId: "SPEC-TEST" });
  assert.equal(conv.ok, false);
  await ev("panel.config-error");
  ws.close();
});

/**
 * Adapter that reproduces the real harness ordering: the reviewer's own PROMPT arrives first as a
 * completed `message.updated` with role "user" — and that prompt embeds an example issues array —
 * followed by the reviewer's real assistant answer. The panel must ingest ONLY the assistant answer.
 */
class PromptEchoMockAdapter implements HarnessAdapter {
  readonly id = "PromptEchoMock";
  private q: DomainEvent[] = [];
  private n = 0;
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["events", "diff"]);
  }
  readiness(): Readiness {
    return { ready: true };
  }
  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: `${input.specId}-s${++this.n}` };
  }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    const real: Record<string, string> = {
      "reviewer-a": JSON.stringify([{ section: SECTION, severity: "blocking", text: "REAL-a-concern" }]),
      "reviewer-b": JSON.stringify([{ section: SECTION, severity: "suggestion", text: "REAL-b-concern" }]),
    };
    const mine = real[i.agent];
    if (mine) {
      const promptWithExample = [
        "You are a reviewer. End with a fenced block like:",
        "```json",
        '[{"section":"PROMPT EXAMPLE","severity":"blocking","text":"EXAMPLE-FROM-PROMPT-MUST-BE-IGNORED"}]',
        "```",
      ].join("\n");
      this.q.push({ seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId: i.sessionId, specId: "SPEC-TEST", kind: "task", status: "running" } as DomainEvent);
      // The user prompt is a COMPLETED (non-streaming) message.updated — the exact shape that fooled the parser.
      this.q.push({ seq: 0, ts: 0, harness: this.id, type: "message.updated", sessionId: i.sessionId, messageId: `u-${i.sessionId}`, role: "user", text: promptWithExample, toolCalls: [], isStreaming: false } as DomainEvent);
      this.q.push({ seq: 0, ts: 0, harness: this.id, type: "message.updated", sessionId: i.sessionId, messageId: `m-${i.sessionId}`, role: "assistant", text: mine, toolCalls: [], isStreaming: false } as DomainEvent);
    }
    return { sessionId: i.sessionId, correlationId: "c" };
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

test("the panel ingests the reviewer's ANSWER, never the example array embedded in its prompt", async () => {
  const dir = repoWithSpec();
  const c = new Coordinator(new PromptEchoMockAdapter(), new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir,
    registry: new ProjectRegistry({ persist: false }),
    registryConfig: registryConfig(),
    connectedInstanceId: "claude-local",
    idleTtlMs: 0,
  });
  const port = await c.start();
  after(() => c.stop());
  const { ws, ready, request, ev, frames } = connect(port);
  await ready;

  const conv = await request("convenePanel", { specId: "SPEC-TEST" });
  assert.equal(conv.ok, true);

  const issueA = await ev("panel.issue", (e) => e.reviewerRole === "reviewer-a");
  const issueB = await ev("panel.issue", (e) => e.reviewerRole === "reviewer-b");
  await ev("panel.complete");

  // The REAL answers are ingested…
  assert.equal(issueA.event.text, "REAL-a-concern");
  assert.equal(issueB.event.text, "REAL-b-concern");
  // …and the example from the prompt is NEVER surfaced as an issue.
  const anyExample = frames.some((f) => f.type === "event" && f.event?.type === "panel.issue" && /EXAMPLE-FROM-PROMPT|PROMPT EXAMPLE/.test(f.event.text + f.event.section));
  assert.equal(anyExample, false, "the prompt's example array must not be parsed as a reviewer issue");
  // Exactly one issue per reviewer (the user echo did not also produce one).
  const issueCount = frames.filter((f) => f.type === "event" && f.event?.type === "panel.issue").length;
  assert.equal(issueCount, 2);
  ws.close();
});

test("adjudicate: dismiss records the decision; accept routes to the authoring agent", async () => {
  const dir = repoWithSpec();
  const { c, port } = await start(dir, registryConfig());
  after(() => c.stop());
  const { ws, ready, request, ev } = connect(port);
  await ready;
  const conv = await request("convenePanel", { specId: "SPEC-TEST" });
  const panelId = conv.result.panelId;
  const issue = await ev("panel.issue");
  const issueId = issue.event.issueId;

  const dismiss = await request("adjudicateIssue", { panelId, issueId, action: "dismissed", rationale: "out of scope" });
  assert.equal(dismiss.ok, true);

  // accept a (second) issue → routed to spec-author (no stale change yet → no warning)
  const issue2 = await ev("panel.issue", (e) => e.issueId !== issueId);
  const accept = await request("adjudicateIssue", { panelId, issueId: issue2.event.issueId, action: "accepted" });
  assert.equal(accept.ok, true);
  assert.notEqual(accept.result.staleWarning, true);
  ws.close();
});
