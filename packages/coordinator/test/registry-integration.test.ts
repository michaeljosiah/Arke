import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type { AgentImage } from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { AgentRegistry, type ProviderProfile } from "../src/agent-registry.js";

/**
 * SPEC-016 revised (Omnigent-shaped): agents declare their own model+provider in their image
 * `executor`, so the registry projection is now the live harness endpoints + the agent roster (each
 * agent's declared model) — no logical tiers. These tests drive the snapshot the client renders.
 */

/** An agent image pinning a concrete model (+ optional reasoning effort) on an OpenCode harness. */
function agentImage(name: string, model: string, options?: Record<string, string>): AgentImage {
  return {
    name,
    executor: { type: "omnigent", config: { harness: "opencode-native", model, ...(options ? { options } : {}), auth: { profile: "opencode-local" } } },
    interaction: { conversational: name === "spec-author", mode: name === "spec-author" ? "primary" : "subagent" },
    tools: [],
    skills: [],
    permission: name.startsWith("reviewer") ? { edit: "deny", bash: "deny" } : { edit: "allow", bash: "ask" },
    subAgents: [],
  };
}

/** A connected OpenCode profile (live, backed by the MockAdapter) + a configured-but-unwired claude. */
function providers(): Record<string, ProviderProfile> {
  return {
    "opencode-local": { harness: "opencode", host: "localhost", port: 4096, credentialsRef: "opencode/gateway" },
    "claude-remote": { harness: "claude-code", host: "localhost", credentialsRef: "claude/default" },
  };
}

/** The default roster: two distinct reviewers, plus spec-author + implementer (xhigh). */
function agents(over: AgentImage[] = []): AgentRegistry {
  const base = [
    agentImage("spec-author", "anthropic/opus"),
    agentImage("implementer", "vendorx/small", { reasoningEffort: "xhigh" }),
    agentImage("reviewer-a", "anthropic/opus"),
    agentImage("reviewer-b", "copilot/gpt"),
  ];
  const byName = new Map(base.map((i) => [i.name, i]));
  for (const o of over) byName.set(o.name, o);
  return new AgentRegistry([...byName.values()], providers());
}

async function start(reg: AgentRegistry = agents()) {
  const dir = mkdtempSync(join(tmpdir(), "arke-reg-"));
  const c = new Coordinator(
    new MockAdapter(),
    new Trace(join(dir, ".arke", "trace.ndjson")),
    new GrantStore(join(dir, ".arke", "grants.ndjson")),
    0,
    {
      projectRoot: dir,
      registry: new ProjectRegistry({ persist: false }),
      agents: reg,
      idleTtlMs: 0,
    },
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
  const waitFor = (pred: (f: any) => boolean, ms = 4000) =>
    new Promise<any>((res, rej) => {
      const existing = frames.find(pred);
      if (existing) return res(existing);
      const t = setTimeout(() => rej(new Error("frame not seen")), ms);
      waiters.push({ pred, resolve: res, t });
    });
  return { ws, ready, waitFor };
}

test("the snapshot carries a live registry projection (harnesses + agent roster)", async () => {
  const { c, port } = await start();
  after(() => c.stop());
  const { ws, ready, waitFor } = connect(port);
  await ready;
  const snap = await waitFor((f) => f.type === "snapshot");
  const reg = snap.registry;
  assert.ok(reg, "snapshot.registry present");
  assert.equal(reg.harnesses.length, 2);

  const local = reg.harnesses.find((h: any) => h.id === "opencode-local");
  assert.equal(local.reachable, true); // backed by the live MockAdapter
  assert.ok(local.caps.includes("events"));

  const claude = reg.harnesses.find((h: any) => h.id === "claude-remote");
  assert.equal(claude.reachable, false); // configured but no adapter wired

  // The agent roster carries each agent's declared model.
  const implementer = reg.agents.find((a: any) => a.name === "implementer");
  assert.equal(implementer.model, "vendorx/small");
  assert.equal(implementer.reasoningEffort, "xhigh");
  assert.deepEqual(reg.warnings, []); // distinct reviewers → no warnings
  ws.close();
});

test("a bad roster surfaces warnings in the opening snapshot (not only as events)", async () => {
  // Both reviewers declare the SAME model → reviewer-distinct independence fails. The opening client
  // must see this in snapshot.registry.warnings, since the warning events fire before it subscribes.
  const { c, port } = await start(agents([agentImage("reviewer-b", "anthropic/opus")]));
  after(() => c.stop());
  const { ws, ready, waitFor } = connect(port);
  await ready;
  const snap = await waitFor((f) => f.type === "snapshot");
  assert.ok(snap.registry.warnings.some((w: any) => w.reason === "reviewer-models-identical"));
  ws.close();
});

test("credentials never leak into the snapshot, but the roster surfaces the declared model", async () => {
  const { c, port } = await start();
  after(() => c.stop());
  const { ws, ready, waitFor } = connect(port);
  await ready;
  const snap = await waitFor((f) => f.type === "snapshot");
  const json = JSON.stringify(snap.registry);
  // The credential ref (value AND field name) must NEVER reach the client.
  for (const leak of ["opencode/gateway", "claude/default", "credentialsRef"]) {
    assert.ok(!json.includes(leak), `registry projection must not leak credential '${leak}'`);
  }
  // The declared model IS deliberately surfaced on the roster so an operator can verify which agent
  // runs on which model (the model id is public; only credentials are secret).
  const implementer = snap.registry.agents.find((a: any) => a.name === "implementer");
  assert.equal(implementer?.model, "vendorx/small", "roster surfaces the implementer's declared model");
  assert.equal(implementer?.reasoningEffort, "xhigh", "roster surfaces the reasoning effort");
  const reviewer = snap.registry.agents.find((a: any) => a.name === "reviewer-a");
  assert.equal(reviewer?.model, "anthropic/opus", "roster surfaces a reviewer's declared model");
  ws.close();
});

test("registry.probe triggers a registry.updated event", async () => {
  const { c, port } = await start();
  after(() => c.stop());
  const { ws, ready, waitFor } = connect(port);
  await ready;
  await waitFor((f) => f.type === "snapshot");
  ws.send(JSON.stringify({ type: "registry.probe" }));
  const evt = await waitFor((f) => f.type === "event" && f.event?.type === "registry.updated");
  assert.ok(Array.isArray(evt.event.instances));
  assert.ok(evt.event.instances.some((i: any) => i.id === "opencode-local"));
  ws.close();
});
