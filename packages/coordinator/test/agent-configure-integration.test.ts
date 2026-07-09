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

async function start(dir: string, adapter: any = new MockAdapter()) {
  const providers = { "opencode-local": { harness: "opencode", host: "localhost", port: 4096, credentialsRef: "opencode/gateway" } };
  const c = new Coordinator(adapter, new Trace(join(dir, ".arke", "trace.ndjson")), new GrantStore(join(dir, ".arke", "grants.ndjson")), 0, {
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

test("agent.configure also writes the permission grid when supplied (SPEC-021)", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.configure", { name: "implementer", provider: "github-copilot", model: "gpt-5.5", permission: { edit: "ask", bash: "deny" } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.result.permission, { edit: "ask", bash: "deny" });
  const img = loadAgentImage(resolve(dir, "agents", "implementer"));
  assert.equal(img.permission.edit, "ask");
  assert.equal(img.permission.bash, "deny");
  // the roster projection carries the new verbs
  const snap = await request("registry.get");
  const impl = snap.result.agents.find((a: any) => a.name === "implementer");
  assert.equal(impl.permission.bash, "deny");
  ws.close();
});

test("agent.create writes a new agent image and it appears on the roster with tools (SPEC-021)", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.create", {
    spec: {
      name: "scout",
      description: "recon",
      harness: "opencode-native",
      model: "github-copilot/gpt-5.5",
      mode: "subagent",
      permission: { read: "allow" },
      tools: { github: { type: "mcp", transport: "local", command: "uv", args: ["run", "mcp"], environment: { GITHUB_TOKEN: "${GH_TOKEN}" } } },
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.result.name, "scout");

  // The image exists and is valid; the ${VAR} was kept unresolved (NFR-1).
  const img = loadAgentImage(resolve(dir, "agents", "scout"));
  assert.equal(img.executor.config.model, "github-copilot/gpt-5.5");
  assert.equal((img.tools.github as any).environment.GITHUB_TOKEN, "${GH_TOKEN}");

  // The roster refreshed to include the new agent with its declared tools.
  const snap = await request("registry.get");
  const scout = snap.result.agents.find((a: any) => a.name === "scout");
  assert.ok(scout, "new agent on the roster");
  assert.deepEqual(scout.tools, [{ name: "github", kind: "mcp" }]);
  ws.close();
});

test("agent.configure rejects an invalid permission verb before writing (PR #37 review)", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.configure", { name: "implementer", provider: "github-copilot", model: "gpt-5.5", permission: { edit: "always" } });
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid permission verb 'always'/);
  // the image is untouched — the bad verb never reached config.yaml (so the agent stays on the roster)
  const raw = readFileSync(resolve(dir, "agents", "implementer", "config.yaml"), "utf8");
  assert.match(raw, /edit: allow/);
  ws.close();
});

test("agent.configure saves permissions on a default-model agent without a model (PR #37 review)", async () => {
  const dir = project(); // seed implementer declares `model: gateway/implementer` (a default sentinel)
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  // provider=gateway + empty model = a permission-only save; the coordinator must not reject it.
  const res = await request("agent.configure", { name: "implementer", provider: "gateway", model: "", permission: { read: "allow", edit: "deny" } });
  assert.equal(res.ok, true);
  const img = loadAgentImage(resolve(dir, "agents", "implementer"));
  assert.equal(img.permission.edit, "deny"); // permission written
  assert.equal(img.executor.config.model, "gateway/implementer"); // model left untouched
  ws.close();
});

test("agent.configure with an explicit empty permission map clears the block (PR #37 review)", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.configure", { name: "implementer", provider: "gateway", model: "", permission: {} });
  assert.equal(res.ok, true);
  const img = loadAgentImage(resolve(dir, "agents", "implementer"));
  assert.deepEqual(img.permission, {}); // the seed's `edit: allow` was removed
  ws.close();
});

test("agent.configure persists an interaction mode change (PR #37 review)", async () => {
  const dir = project(); // seed implementer is `mode: subagent`
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.configure", { name: "implementer", provider: "gateway", model: "", mode: "primary" });
  assert.equal(res.ok, true);
  assert.equal(loadAgentImage(resolve(dir, "agents", "implementer")).interaction.mode, "primary");
  ws.close();
});

test("agent.configure re-materialises the harness agent so a permission edit reaches OpenCode (PR #37 review)", async () => {
  const dir = project();
  const calls: string[] = [];
  const spy = new MockAdapter() as any;
  spy.materializeAgent = async (img: any) => { calls.push(img.name); };
  const { c, port } = await start(dir, spy);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  await request("agent.configure", { name: "implementer", provider: "gateway", model: "", permission: { edit: "deny" } });
  assert.ok(calls.includes("implementer"), "materializeAgent was called for the edited agent");
  ws.close();
});

test("agent.configure accepts the 'all' interaction mode (PR #37 re-review R4)", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.configure", { name: "implementer", provider: "gateway", model: "", mode: "all" });
  assert.equal(res.ok, true); // 'all' is a valid AgentInteraction mode — must not be rejected
  assert.equal(loadAgentImage(resolve(dir, "agents", "implementer")).interaction.mode, "all");
  ws.close();
});

test("agent.create materialises the new agent into the harness (PR #37 re-review R1)", async () => {
  const dir = project();
  const materialized: string[] = [];
  const capMaterialized: string[] = [];
  const spy = new MockAdapter() as any;
  spy.materializeAgent = async (img: any) => { materialized.push(img.name); };
  spy.materializeCapabilities = async (img: any) => { capMaterialized.push(img.name); return { registered: [], unsupported: [] }; };
  const { c, port } = await start(dir, spy);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.create", { spec: { name: "scout", harness: "opencode-native", mode: "subagent" } });
  assert.equal(res.ok, true);
  assert.ok(materialized.includes("scout"), "materializeAgent ran for the created agent");
  assert.ok(capMaterialized.includes("scout"), "materializeCapabilities ran for the created agent");
  ws.close();
});

test("agent.configure writes the tools map, re-materialises capabilities, and refreshes the roster (SPEC-021)", async () => {
  const dir = project();
  const capMaterialized: string[] = [];
  const spy = new MockAdapter() as any;
  spy.materializeAgent = async () => {};
  spy.materializeCapabilities = async (img: any) => { capMaterialized.push(img.name); return { registered: ["github"], unsupported: [] }; };
  const { c, port } = await start(dir, spy);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.configure", {
    name: "implementer", provider: "gateway", model: "",
    tools: { github: { type: "mcp", transport: "local", command: "uv", args: ["run", "mcp"], environment: { GH_TOKEN: "${GH_TOKEN}" } } },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.result.tools, [{ name: "github", kind: "mcp" }]);

  // The image on disk gained the tools map with the ${VAR} kept unresolved (NFR-1); the rest is intact.
  const img = loadAgentImage(resolve(dir, "agents", "implementer"));
  assert.equal((img.tools.github as any).command, "uv");
  assert.equal((img.tools.github as any).environment.GH_TOKEN, "${GH_TOKEN}");
  assert.equal(img.executor.config.model, "gateway/implementer"); // model untouched by a tools-only edit

  // The edit reached native config (materializeCapabilities) and the roster shows names+kinds only.
  assert.ok(capMaterialized.includes("implementer"), "materializeCapabilities ran on the tools edit");
  const snap = await request("registry.get");
  const impl = snap.result.agents.find((a: any) => a.name === "implementer");
  assert.deepEqual(impl.tools, [{ name: "github", kind: "mcp" }]);
  ws.close();
});

test("agent.get returns an agent's editable tool wiring (${VAR} refs, no resolved secret) — SPEC-021", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  await request("agent.configure", {
    name: "implementer", provider: "gateway", model: "",
    tools: { docs: { type: "mcp", transport: "remote", url: "https://x/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } } },
  });
  const got = await request("agent.get", { name: "implementer" });
  assert.equal(got.ok, true);
  assert.equal(got.result.name, "implementer");
  assert.equal(got.result.tools.docs.url, "https://x/mcp");
  assert.equal(got.result.tools.docs.headers.Authorization, "Bearer ${DOCS_TOKEN}", "the ${VAR} ref is returned unresolved, never a secret value");
  ws.close();
});

test("agent.configure rejects a literal secret in a tool and rolls the image back (NFR-1, SPEC-021)", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const res = await request("agent.configure", {
    name: "implementer", provider: "gateway", model: "",
    tools: { docs: { type: "mcp", transport: "remote", url: "https://x/mcp", headers: { Authorization: "Bearer sk-LITERAL" } } },
  });
  assert.equal(res.ok, false);
  // The image is untouched — the rejected tools edit rolled back, so no tools block landed.
  const raw = readFileSync(resolve(dir, "agents", "implementer", "config.yaml"), "utf8");
  assert.ok(!/tools:/.test(raw), "no tools block was written");
  assert.match(raw, /model: gateway\/implementer/); // rest intact
  ws.close();
});

test("agent.create rejects a duplicate name and a path-traversal name", async () => {
  const dir = project();
  const { c, port } = await start(dir);
  after(() => c.stop());
  const { ws, ready, waitFor, request } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");

  const dup = await request("agent.create", { spec: { name: "implementer", harness: "opencode-native" } });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already exists/);

  const bad = await request("agent.create", { spec: { name: "../evil", harness: "opencode-native" } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid agent name/);
  ws.close();
});
