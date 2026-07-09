import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
 * SPEC-027 — the typed grounding digest reaches the AUTHORING injection site. A repo with (a) a
 * grounding-typed OKF doc under `docs/`, (b) a spec in the corpus, and (c) a nested `.arke/grounding/`
 * upload; the first authoring prompt must carry all three, distinctly framed, with the local tier by
 * explicit path — and the local tier must never be auto-promoted into the tracked tree.
 */

const BRANCH = "feat/spec-027-okf-grounding-layer";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function specDoc(): string {
  return `---
spec_id: SPEC-TEST
title: Widget pipeline
status: draft
branch: ${BRANCH}
owner: tester
capabilities: [widgets]
---

# Widget pipeline

## Requirements

### Requirement: A thing
\`capability: widgets\` · \`delta: ADDED (${BRANCH})\`

The system SHALL do a thing.
`;
}

function groundingDoc(): string {
  return `---
type: product-overview
title: Acme — the widget platform
---

# Acme

Acme turns raw widgets into finished gadgets, governed end to end.
`;
}

function repoWithGrounding(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-grounding-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", BRANCH);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  // A properly-numbered spec so it enters the SPEC-026 spec index (part b of the digest).
  writeFileSync(resolve(dir, "docs", "specifications", "001.widget.md"), specDoc(), "utf8");
  // (a) foundational grounding — a grounding-typed OKF doc at the docs/ ROOT (selected by type, not folder).
  writeFileSync(resolve(dir, "docs", "product-overview.md"), groundingDoc(), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function agentImage(name: string, model: string): AgentImage {
  return {
    name,
    executor: { type: "omnigent", config: { harness: "opencode-native", model, auth: { profile: "opencode-local" } } },
    interaction: { conversational: name === "spec-author", mode: name === "spec-author" ? "primary" : "subagent" },
    tools: [],
    skills: [],
    permission: { edit: "allow", bash: "ask" },
    subAgents: [],
  };
}

function agents(): AgentRegistry {
  return new AgentRegistry(
    [agentImage("spec-author", "anthropic/opus")],
    { "opencode-local": { harness: "opencode", host: "localhost", port: 4096, credentialsRef: "o/g" } },
  );
}

/** An adapter that records the last dispatched prompt text, so the test can inspect what was injected. */
class CapturingAdapter implements HarnessAdapter {
  readonly id = "Capturing";
  lastText = "";
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
    this.lastText = i.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async dispatchAsync(i: SendMessageInput): Promise<SendReceipt> {
    this.lastText = i.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    while (!signal?.aborted) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, 10);
        signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
      });
    }
  }
}

async function start(dir: string, adapter: HarnessAdapter) {
  const c = new Coordinator(adapter, new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir,
    registry: new ProjectRegistry({ persist: false }),
    agents: agents(),
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
  return { ws, ready, request };
}

test("the first authoring prompt carries the three-part grounding digest, distinctly framed", async () => {
  const dir = repoWithGrounding();
  const adapter = new CapturingAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());
  const { ws, ready, request } = connect(port);
  await ready;

  // A nested local upload — the tier the agent's search cannot reach, so it must be named by path.
  const up = await request("grounding.upload", { name: "client/brief.md", content: "Sensitive client brief." });
  assert.equal(up.ok, true);

  const sess = await request("session.create", { specId: "SPEC-TEST" });
  assert.equal(sess.ok, true);
  const sessionId = sess.result.sessionId;

  const sent = await request("prompt.dispatch", { sessionId, specId: "SPEC-TEST", agent: "spec-author", message: "start" });
  assert.equal(sent.ok, true);

  const text = adapter.lastText;
  // The working-spec anchor (SPEC-020) still leads.
  assert.match(text, /Working specification: docs\/specifications\/001\.widget\.md/);
  // (a) business grounding — the grounding-typed doc, selected by type across the tree.
  assert.match(text, /## Project grounding/);
  assert.match(text, /### Business grounding/);
  assert.match(text, /\*\*product-overview\*\* — Acme — the widget platform \(`docs\/product-overview\.md`\)/);
  assert.match(text, /Acme turns raw widgets/);
  // (b) the existing spec corpus.
  assert.match(text, /### Existing specification corpus/);
  assert.match(text, /\*\*001\*\* Widget pipeline — draft · widgets \(`docs\/specifications\/001\.widget\.md`\)/);
  // (c) the local upload, by EXPLICIT nested path.
  assert.match(text, /### Session uploads/);
  assert.match(text, /- `\.arke\/grounding\/client\/brief\.md`/);
  // Distinct framing: business grounding is not mislabelled as a session upload.
  assert.ok(text.indexOf("Business grounding") < text.indexOf("Session uploads"));
  ws.close();
});

test("a nested local upload is surfaced by the recursive grounding list, never auto-promoted into docs/", async () => {
  const dir = repoWithGrounding();
  const adapter = new CapturingAdapter();
  const { c, port } = await start(dir, adapter);
  after(() => c.stop());
  const { ws, ready, request } = connect(port);
  await ready;

  await request("grounding.upload", { name: "nested/deep/secret.md", content: "endpoint: https://internal" });
  const list = await request("grounding.list");
  assert.equal(list.ok, true);
  assert.deepEqual(
    list.result.map((g: { name: string }) => g.name),
    ["nested/deep/secret.md"],
    "the recursive listing surfaces the nested upload by its posix path under the grounding root",
  );

  // Two-tier guarantee: the sensitive file stays in the git-ignored tier and is NEVER copied into docs/.
  assert.ok(existsSync(resolve(dir, ".arke", "grounding", "nested", "deep", "secret.md")), "the upload lives in the local tier");
  assert.ok(!existsSync(resolve(dir, "docs", "secret.md")), "it was not auto-promoted into the tracked docs/ tree");
  assert.ok(!existsSync(resolve(dir, "docs", "nested")), "no part of the local path leaked into docs/");
  ws.close();
});
