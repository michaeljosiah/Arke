import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { loadAgentImage } from "@arke/agent-image";
import { Coordinator } from "../src/server.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { loadAgentRegistry } from "../src/agent-registry.js";

/**
 * SPEC-016 revised: `agent.configure` is the write half of the model-selection UX. It rewrites an
 * agent's declared model in its `agents/<name>/config.yaml`, reloads the roster, and refreshes the
 * projection — so the client's model editor persists a choice and the roster updates live.
 */

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-agentcfg-"));
  mkdirSync(resolve(dir, "agents", "implementer"), { recursive: true });
  writeFileSync(
    resolve(dir, "agents", "implementer", "config.yaml"),
    "spec_version: 1\nname: implementer\ndescription: writes code\nexecutor:\n  type: omnigent\n  config:\n    harness: opencode-native\n    model: gateway/implementer\n    auth:\n      profile: opencode-local\ninteraction:\n  mode: subagent\npermission:\n  edit: allow\n",
    "utf8",
  );
  mkdirSync(resolve(dir, ".arke"), { recursive: true });
  writeFileSync(
    resolve(dir, ".arke", "config.json"),
    JSON.stringify({ providers: { "opencode-local": { harness: "opencode", host: "localhost", port: 4096, credentialsRef: "opencode/gateway" } } }),
    "utf8",
  );
  return dir;
}

async function start(dir: string) {
  const providers = { "opencode-local": { harness: "opencode", host: "localhost", port: 4096, credentialsRef: "opencode/gateway" } };
  const c = new Coordinator(new MockAdapter(), new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
    projectRoot: dir,
    registry: new ProjectRegistry({ persist: false }),
    agents: loadAgentRegistry(dir, providers),
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
  const waitFor = (pred: (f: any) => boolean, ms = 4000) =>
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

test("agent.configure rewrites the agent's image model + effort and refreshes the roster", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.configure", { name: "implementer", provider: "github-copilot", model: "gpt-5.5", reasoningEffort: "xhigh" });
  assert.equal(res.ok, true);
  assert.equal(res.result.model, "github-copilot/gpt-5.5");
  assert.equal(res.result.reasoningEffort, "xhigh");

  // The image on disk was rewritten (provider-qualified model + effort), preserving the rest.
  const img = loadAgentImage(resolve(dir, "agents", "implementer"));
  assert.equal(img.executor.config.model, "github-copilot/gpt-5.5");
  assert.equal(img.executor.config.options?.reasoningEffort, "xhigh");
  assert.equal(img.executor.config.auth?.profile, "opencode-local"); // untouched
  assert.equal(img.description, "writes code"); // untouched

  // A fresh snapshot's roster reflects the new model.
  const snap = await request("registry.get");
  const impl = snap.result.agents.find((a: any) => a.name === "implementer");
  assert.equal(impl.model, "github-copilot/gpt-5.5");
  assert.equal(impl.reasoningEffort, "xhigh");
  ws.close();
});

test("agent.configure rejects an unknown agent and a path-traversal name", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const unknown = await request("agent.configure", { name: "nope", provider: "x", model: "y" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown agent/);

  const traversal = await request("agent.configure", { name: "../../etc", provider: "x", model: "y" });
  assert.equal(traversal.ok, false);
  assert.match(traversal.error, /invalid agent name/);

  // The original image is untouched after the rejected calls.
  const raw = readFileSync(resolve(dir, "agents", "implementer", "config.yaml"), "utf8");
  assert.match(raw, /model: gateway\/implementer/);
  ws.close();
});

test("agent.configure with a bare gateway provider stores an unqualified model + drops effort", async () => {
  const dir = project();
  // Seed with a reasoning effort so we can prove it is dropped when omitted.
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");
  await request("agent.configure", { name: "implementer", provider: "github-copilot", model: "gpt-5.5", reasoningEffort: "xhigh" });

  const res = await request("agent.configure", { name: "implementer", provider: "gateway", model: "implementer" });
  assert.equal(res.ok, true);
  assert.equal(res.result.model, "implementer"); // gateway sentinel → bare name, no provider prefix
  const img = loadAgentImage(resolve(dir, "agents", "implementer"));
  assert.equal(img.executor.config.model, "implementer");
  assert.equal(img.executor.config.options?.reasoningEffort, undefined); // effort dropped
  ws.close();
});
