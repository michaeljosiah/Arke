import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type { Capability, CreateSessionInput, DomainEvent, HarnessAdapter, SendMessageInput, SendReceipt, SessionRef } from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

/** SPEC-020: a blank-slate spec created as untitled-NNN is renamed once the agent derives a title. */

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-rename-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-b", "main");
  writeFileSync(resolve(dir, "README.md"), "# repo\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

class NullAdapter implements HarnessAdapter {
  readonly id = "Null";
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["events"]);
  }
  async createSession(i: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: `${i.specId}-s` };
  }
  async sendMessage(i: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: i.sessionId, correlationId: "c" };
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    while (!signal?.aborted) await new Promise<void>((r) => {
      const t = setTimeout(r, 20);
      signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
    });
  }
}

async function start(dir: string) {
  const c = new Coordinator(new NullAdapter(), new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
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
      if (f.type === "response" && f.id === "r1") { ws.close(); resolveP(f); }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("op timeout")), 8000);
  });
}

test("a blank-slate spec is renamed from untitled-NNN to a title slug once titled", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());

  // 1) Create a blank spec (no title) → it lands as untitled-NNN.
  const created = await op(port, "spec.create", { title: "" });
  assert.equal(created.ok, true);
  assert.match(created.result.specId, /untitled-\d+$/);
  assert.match(created.result.path, /\d{3}\.untitled-\d+\.md$/);
  const oldSpecId = created.result.specId as string;
  const oldAbs = resolve(dir, created.result.path);
  assert.ok(existsSync(oldAbs));

  // 2) The spec-author derives a real title (simulated: rewrite the frontmatter title).
  const titled = readFileSync(oldAbs, "utf8").replace(/^title:.*$/m, 'title: "Evolution research report — agent skills & tooling (3D, music)"');
  writeFileSync(oldAbs, titled, "utf8");

  // 3) Finalise the name.
  const renamed = await op(port, "spec.rename", { specId: oldSpecId });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.result.renamed, true);
  assert.equal(renamed.result.specId, oldSpecId.replace(/untitled-\d+$/, "evolution-research-report"));
  assert.match(renamed.result.path, /\d{3}\.evolution-research-report\.md$/);
  assert.equal(renamed.result.branch, "spec/evolution-research-report");

  // The file was renamed on disk; the old name is gone; frontmatter re-keyed.
  const newAbs = resolve(dir, renamed.result.path);
  assert.ok(existsSync(newAbs), "renamed file exists");
  assert.ok(!existsSync(oldAbs), "old untitled file is gone");
  const body = readFileSync(newAbs, "utf8");
  assert.match(body, /spec_id: SPEC-\d{4}-\d{2}-\d{2}-evolution-research-report/);
  assert.match(body, /branch: spec\/evolution-research-report/);
  assert.match(body, /title: "Evolution research report/); // title preserved

  // The git branch was renamed too.
  assert.match(git(dir, "branch", "--show-current").trim(), /^spec\/evolution-research-report$/);

  // 4) Idempotent: renaming again is a no-op.
  const again = await op(port, "spec.rename", { specId: renamed.result.specId });
  assert.equal(again.result.renamed, false);
});

test("a spec created WITH a title is left alone by rename (not untitled)", async () => {
  const dir = repo();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const created = await op(port, "spec.create", { title: "Already Named Thing" });
  assert.match(created.result.path, /\d{3}\.already-named-thing\.md$/);
  const r = await op(port, "spec.rename", { specId: created.result.specId });
  assert.equal(r.result.renamed, false, "a non-untitled spec is never renamed");
});
