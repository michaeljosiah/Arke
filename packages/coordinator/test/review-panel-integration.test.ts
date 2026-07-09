import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type {
  AgentImage,
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
import { AgentRegistry } from "../src/agent-registry.js";

/**
 * SPEC-035 author-adjudicated review, end to end. Reviewers critique on distinct models; the spec-author
 * then adjudicates every issue (accept → applied; dismiss → rationale) and the coordinator loops up to
 * three rounds (reconvening only on a blocker-driven material change) before converging and auto-promoting
 * the draft to `in-review`. The `ScriptedAdapter` lets each test drive both halves — reviewer issues per
 * round and the author's disposition (including an actual file edit to force a normative change).
 */

const BRANCH = "feat/spec-035-agent-adjudicated-review";
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

#### Scenario: The thing is done
- **WHEN** the thing is requested
- **THEN** the system does the thing

## Change history
- 2026-07-10 · ${BRANCH} · draft — ADDED x
`;
}

function repoWithSpec(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-loop-"));
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

const specPath = (dir: string) => resolve(dir, "docs", "specifications", "test.md");

/** An agent image pinning a concrete model on an OpenCode harness (SPEC-016 revised — agent IS model). */
function agentImage(name: string, model: string): AgentImage {
  return {
    name,
    executor: { type: "omnigent", config: { harness: "opencode-native", model, auth: { profile: "opencode-local" } } },
    interaction: { conversational: name === "spec-author", mode: name === "spec-author" ? "primary" : "subagent" },
    tools: [],
    skills: [],
    permission: name.startsWith("reviewer") ? { edit: "deny", bash: "deny" } : { edit: "allow", bash: "ask" },
    subAgents: [],
  };
}

/** A roster of author + two reviewers with the given models (default: three pairwise-distinct). */
function roster(author = "anthropic/opus", a = "anthropic/sonnet", b = "github-copilot/gpt"): AgentRegistry {
  return new AgentRegistry(
    [agentImage("spec-author", author), agentImage("reviewer-a", a), agentImage("reviewer-b", b)],
    { "opencode-local": { harness: "opencode", host: "localhost", port: 4096, credentialsRef: "o/g" } },
  );
}

type Issue = { section: string; severity: string; text: string };
type Disposition = { issueId: string; action: "accept" | "dismiss"; rationale: string };
interface Script {
  /** Issues each reviewer raises in a given (1-based) round. */
  reviewers: (round: number) => Record<string, Issue[]>;
  /** The author's plan for a round, given the issues it was handed (parsed from the prompt). */
  author: (round: number, issues: Array<{ issueId: string; severity: string }>) => { edit?: boolean; dispositions: Disposition[] };
}

/** Extract `[issue-id] (severity …` entries the coordinator listed in the adjudication prompt. */
function issuesFromPrompt(prompt: string): Array<{ issueId: string; severity: string }> {
  const out: Array<{ issueId: string; severity: string }> = [];
  const re = /- \[(issue-[^\]]+)\] \((\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ issueId: m[1]!, severity: m[2]! });
  return out;
}

/** Drives reviewers AND the spec-author from a per-round {@link Script}. */
class ScriptedAdapter implements HarnessAdapter {
  readonly id = "ScriptedMock";
  private q: DomainEvent[] = [];
  private n = 0;
  private round = 0;
  constructor(private readonly dir: string, private readonly script: Script) {}
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
  private answer(sessionId: string, payload: unknown): void {
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "session.status", sessionId, specId: "SPEC-TEST", kind: "task", status: "running" } as DomainEvent);
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "message.updated", sessionId, messageId: `m-${sessionId}`, role: "assistant", text: JSON.stringify(payload), toolCalls: [], isStreaming: false } as DomainEvent);
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    if (i.agent === "reviewer-a") this.round++; // reviewer-a leads each round
    if (i.agent === "reviewer-a" || i.agent === "reviewer-b") {
      const mine = this.script.reviewers(this.round)[i.agent] ?? [];
      this.answer(i.sessionId, mine);
    } else if (i.agent === "spec-author") {
      const prompt = (i.parts.find((p) => p.type === "text") as { text?: string } | undefined)?.text ?? "";
      const plan = this.script.author(this.round, issuesFromPrompt(prompt));
      if (plan.edit) {
        const t = readFileSync(specPath(this.dir), "utf8");
        writeFileSync(specPath(this.dir), t.replace("SHALL do a thing", `SHALL do a thing (revised in round ${this.round})`), "utf8");
      }
      this.answer(i.sessionId, plan.dispositions);
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
        const t = setTimeout(r, 5);
        signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
      });
    }
  }
}

async function start(dir: string, adapter: HarnessAdapter, reg: AgentRegistry) {
  const c = new Coordinator(adapter, new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir,
    registry: new ProjectRegistry({ persist: false }),
    agents: reg,
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

const status = (dir: string) => /status:\s*(\S+)/.exec(readFileSync(specPath(dir), "utf8"))?.[1];

test("a review converges in one round (dismiss the blocker with a rationale) and auto-promotes to in-review", async () => {
  const dir = repoWithSpec();
  const script: Script = {
    reviewers: () => ({
      "reviewer-a": [{ section: SECTION, severity: "blocking", text: "a-blocker" }],
      "reviewer-b": [{ section: SECTION, severity: "suggestion", text: "b-nit" }],
    }),
    // Accept the suggestion, dismiss the blocker WITH a rationale → no blocker accepted → converge.
    author: (_round, issues) => ({
      dispositions: issues.map((i) => i.severity === "blocking"
        ? { issueId: i.issueId, action: "dismiss", rationale: "the concern does not hold" }
        : { issueId: i.issueId, action: "accept", rationale: "folded in" }),
    }),
  };
  const { c, port } = await start(dir, new ScriptedAdapter(dir, script), roster());
  after(() => c.stop());
  const { ws, ready, request, ev, frames } = connect(port);
  await ready;

  const conv = await request("reviewSpec", { specId: "SPEC-TEST" });
  assert.equal(conv.ok, true);
  assert.ok(/·/.test(conv.result.reviewers[0].model)); // client label, never a bare vendor id

  await ev("panel.started");
  await ev("panel.issue", (e) => e.reviewerRole === "reviewer-a");
  await ev("panel.adjudicating", (e) => e.round === 1);
  await ev("panel.disposition", (e) => e.actor === "spec-author");
  const rc = await ev("panel.round-complete");
  assert.equal(rc.event.reconvened, false);
  const converged = await ev("review.converged");
  assert.equal(converged.event.rounds, 1);
  assert.equal(converged.event.unresolvedBlockers.length, 1); // the dismissed blocker is surfaced
  await ev("spec.status", (e) => e.status === "in-review"); // auto-promoted

  // panel.started must precede panel.issue so the UI has columns to fold into.
  const idx = (pred: (e: any) => boolean) => frames.findIndex((f) => f.type === "event" && pred(f.event));
  assert.ok(idx((e) => e.type === "panel.started") < idx((e) => e.type === "panel.issue"));
  assert.equal(status(dir), "in-review");
  ws.close();
});

test("a blocker the author accepts on a materially-changed spec reconvenes, then converges", async () => {
  const dir = repoWithSpec();
  const script: Script = {
    reviewers: (round) => round === 1
      ? { "reviewer-a": [{ section: SECTION, severity: "blocking", text: "fix the thing" }], "reviewer-b": [] }
      : { "reviewer-a": [{ section: SECTION, severity: "suggestion", text: "tiny nit" }], "reviewer-b": [] },
    author: (round, issues) => round === 1
      // Round 1: accept the blocker AND edit the spec (material change) → reconvene.
      ? { edit: true, dispositions: issues.map((i) => ({ issueId: i.issueId, action: "accept", rationale: "applied" })) }
      // Round 2: only a suggestion, accept it, no blocker → converge.
      : { dispositions: issues.map((i) => ({ issueId: i.issueId, action: "accept", rationale: "applied" })) },
  };
  const { c, port } = await start(dir, new ScriptedAdapter(dir, script), roster());
  after(() => c.stop());
  const { ws, ready, request, ev, frames } = connect(port);
  await ready;

  await request("reviewSpec", { specId: "SPEC-TEST" });
  const r1 = await ev("panel.round-complete", (e) => e.round === 1);
  assert.equal(r1.event.reconvened, true, "an accepted blocker + material change reconvenes");
  await ev("panel.round-complete", (e) => e.round === 2);
  const converged = await ev("review.converged");
  assert.equal(converged.event.rounds, 2);
  // Two panels convened (one per round).
  const panels = frames.filter((f) => f.type === "event" && f.event?.type === "panel.started").length;
  assert.equal(panels, 2);
  ws.close();
});

test("a dismiss-only round does not reconvene even though a blocker was raised", async () => {
  const dir = repoWithSpec();
  const script: Script = {
    reviewers: () => ({ "reviewer-a": [{ section: SECTION, severity: "blocking", text: "b" }], "reviewer-b": [] }),
    // Dismiss the blocker (with rationale) and edit nothing → no material change → converge, one round.
    author: (_r, issues) => ({ dispositions: issues.map((i) => ({ issueId: i.issueId, action: "dismiss", rationale: "wrong" })) }),
  };
  const { c, port } = await start(dir, new ScriptedAdapter(dir, script), roster());
  after(() => c.stop());
  const { ws, ready, request, ev, frames } = connect(port);
  await ready;
  await request("reviewSpec", { specId: "SPEC-TEST" });
  const converged = await ev("review.converged");
  assert.equal(converged.event.rounds, 1);
  assert.equal(frames.filter((f) => f.type === "event" && f.event?.type === "panel.started").length, 1);
  ws.close();
});

test("the loop is capped at three rounds even if every round accepts a blocker and changes the spec", async () => {
  const dir = repoWithSpec();
  const script: Script = {
    reviewers: () => ({ "reviewer-a": [{ section: SECTION, severity: "blocking", text: "still wrong" }], "reviewer-b": [] }),
    author: (_r, issues) => ({ edit: true, dispositions: issues.map((i) => ({ issueId: i.issueId, action: "accept", rationale: "applied" })) }),
  };
  const { c, port } = await start(dir, new ScriptedAdapter(dir, script), roster());
  after(() => c.stop());
  const { ws, ready, request, ev, frames } = connect(port);
  await ready;
  await request("reviewSpec", { specId: "SPEC-TEST" });
  const converged = await ev("review.converged", () => true, 8000);
  assert.equal(converged.event.rounds, 3, "stops at the cap");
  assert.equal(frames.filter((f) => f.type === "event" && f.event?.type === "panel.started").length, 3);
  ws.close();
});

test("accept-or-justify: an unjustified blocker dismissal re-prompts, then fails the loop (gate unsatisfied)", async () => {
  const dir = repoWithSpec();
  const script: Script = {
    reviewers: () => ({ "reviewer-a": [{ section: SECTION, severity: "blocking", text: "b" }], "reviewer-b": [] }),
    // Dismiss the blocker with NO rationale, every time → re-prompt once, then fail.
    author: (_r, issues) => ({ dispositions: issues.map((i) => ({ issueId: i.issueId, action: "dismiss", rationale: "" })) }),
  };
  const { c, port } = await start(dir, new ScriptedAdapter(dir, script), roster());
  after(() => c.stop());
  const { ws, ready, request, ev } = connect(port);
  await ready;
  await request("reviewSpec", { specId: "SPEC-TEST" });
  const failed = await ev("review.gate-failed", (e) => /blocking issue/.test(e.reason));
  assert.ok(failed);
  assert.equal(status(dir), "draft"); // never promoted
  // The gate is unsatisfied: a direct approve is refused.
  const appr = await request("approveDraft", { specId: "SPEC-TEST" });
  assert.equal(appr.ok, false);
  ws.close();
});

test("adjudicator-model collision (author shares reviewer-a's model) warns but does not block convergence", async () => {
  const dir = repoWithSpec();
  const script: Script = {
    reviewers: () => ({ "reviewer-a": [{ section: SECTION, severity: "suggestion", text: "nit" }], "reviewer-b": [] }),
    author: (_r, issues) => ({ dispositions: issues.map((i) => ({ issueId: i.issueId, action: "accept", rationale: "ok" })) }),
  };
  // spec-author and reviewer-a share a model; reviewer-b differs (so the panel still validates).
  const { c, port } = await start(dir, new ScriptedAdapter(dir, script), roster("anthropic/opus", "anthropic/opus", "github-copilot/gpt"));
  after(() => c.stop());
  const { ws, ready, request, ev } = connect(port);
  await ready;
  await request("reviewSpec", { specId: "SPEC-TEST" });
  const collision = await ev("panel.adjudicator-model-collision", (e) => e.reviewerRole === "reviewer-a");
  assert.ok(collision, "the shared-model collision is surfaced");
  await ev("review.converged"); // …and the loop still converges
  ws.close();
});

test("approveDraft is blocked until the review loop converges", async () => {
  const dir = repoWithSpec();
  const script: Script = { reviewers: () => ({}), author: (_r, issues) => ({ dispositions: issues.map((i) => ({ issueId: i.issueId, action: "accept", rationale: "" })) }) };
  const { c, port } = await start(dir, new ScriptedAdapter(dir, script), roster());
  after(() => c.stop());
  const { ws, ready, request, ev } = connect(port);
  await ready;
  const appr = await request("approveDraft", { specId: "SPEC-TEST" });
  assert.equal(appr.ok, false);
  assert.match(appr.error, /review not converged/i);
  await ev("review.gate-failed");
  assert.equal(status(dir), "draft");
  ws.close();
});

test("reviewSpec rejects a roster whose reviewers declare the same model", async () => {
  const dir = repoWithSpec();
  const script: Script = { reviewers: () => ({}), author: () => ({ dispositions: [] }) };
  const { c, port } = await start(dir, new ScriptedAdapter(dir, script), roster("anthropic/opus", "anthropic/opus", "anthropic/opus"));
  after(() => c.stop());
  const { ws, ready, request, ev } = connect(port);
  await ready;
  const conv = await request("reviewSpec", { specId: "SPEC-TEST" });
  assert.equal(conv.ok, false);
  await ev("panel.config-error");
  ws.close();
});

/**
 * The adjudication prompt embeds an EXAMPLE disposition array; the author's own prompt arrives first as a
 * completed `message.updated` with role "user". The loop must ingest ONLY the author's assistant answer —
 * otherwise it would parse the example's `issue-abc`/`issue-def` ids (which match no real issue) and stall.
 */
class AuthorEchoAdapter implements HarnessAdapter {
  readonly id = "AuthorEchoMock";
  private q: DomainEvent[] = [];
  private n = 0;
  capabilities(): ReadonlySet<Capability> { return new Set<Capability>(["events", "diff"]); }
  readiness(): Readiness { return { ready: true }; }
  async createSession(input: CreateSessionInput): Promise<SessionRef> { return { sessionId: `${input.specId}-s${++this.n}` }; }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> { return { sessionId: i.sessionId, correlationId: "c" }; }
  private push(sessionId: string, role: "user" | "assistant", text: string) {
    this.q.push({ seq: 0, ts: 0, harness: this.id, type: "message.updated", sessionId, messageId: `${role}-${sessionId}`, role, text, toolCalls: [], isStreaming: false } as DomainEvent);
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    if (i.agent === "reviewer-a") this.push(i.sessionId, "assistant", JSON.stringify([{ section: SECTION, severity: "suggestion", text: "nit" }]));
    else if (i.agent === "reviewer-b") this.push(i.sessionId, "assistant", JSON.stringify([]));
    else if (i.agent === "spec-author") {
      const prompt = (i.parts.find((p) => p.type === "text") as { text?: string } | undefined)?.text ?? "";
      const realId = issuesFromPrompt(prompt)[0]?.issueId ?? "issue-none";
      this.push(i.sessionId, "user", prompt); // the prompt echo — contains issue-abc/issue-def EXAMPLES
      this.push(i.sessionId, "assistant", JSON.stringify([{ issueId: realId, action: "accept", rationale: "ok" }]));
    }
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    while (!signal?.aborted) {
      const next = this.q.shift();
      if (next) { yield next; continue; }
      await new Promise<void>((r) => { const t = setTimeout(r, 5); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
    }
  }
}

test("the loop ingests the author's disposition ANSWER, never the example array echoed in its prompt", async () => {
  const dir = repoWithSpec();
  const { c, port } = await start(dir, new AuthorEchoAdapter(), roster());
  after(() => c.stop());
  const { ws, ready, request, ev, frames } = connect(port);
  await ready;
  await request("reviewSpec", { specId: "SPEC-TEST" });
  const disp = await ev("panel.disposition");
  assert.equal(disp.event.action, "accept");
  await ev("review.converged"); // converged using the REAL disposition, not the prompt example
  // The prompt's example ids were never surfaced as dispositions.
  const exampleUsed = frames.some((f) => f.type === "event" && f.event?.type === "panel.disposition" && /issue-abc|issue-def/.test(f.event.issueId));
  assert.equal(exampleUsed, false);
  ws.close();
});

test("sendBackReview clears the converged gate and reopens authoring (in-review → draft)", async () => {
  const dir = repoWithSpec();
  const script: Script = {
    reviewers: () => ({ "reviewer-a": [{ section: SECTION, severity: "suggestion", text: "nit" }], "reviewer-b": [] }),
    author: (_r, issues) => ({ dispositions: issues.map((i) => ({ issueId: i.issueId, action: "accept", rationale: "ok" })) }),
  };
  const { c, port } = await start(dir, new ScriptedAdapter(dir, script), roster());
  after(() => c.stop());
  const { ws, ready, request, ev } = connect(port);
  await ready;
  await request("reviewSpec", { specId: "SPEC-TEST" });
  await ev("spec.status", (e) => e.status === "in-review");

  const back = await request("sendBackReview", { specId: "SPEC-TEST" });
  assert.equal(back.ok, true);
  await ev("spec.status", (e) => e.status === "draft");
  assert.equal(status(dir), "draft");
  // Gate cleared: a direct approve is refused again.
  const appr = await request("approveDraft", { specId: "SPEC-TEST" });
  assert.equal(appr.ok, false);
  ws.close();
});
