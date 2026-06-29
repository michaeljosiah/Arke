import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { Coordinator } from "../src/server.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";
import type { RegistryConfig } from "../src/registry.js";

/** A two-instance registry: a connected mock + a configured-but-not-connected claude. */
function registryConfig(): RegistryConfig {
  return {
    instances: [
      { id: "mock-local", driver: "mock", host: "localhost", cwd: ".", credentialsRef: "mock/cred", serves: [{ tier: "capable", model: "vendorx/big" }, { tier: "mid", model: "vendorx/small" }] },
      { id: "claude-local", driver: "claude-code", host: "localhost", cwd: ".", credentialsRef: "claude/default", serves: [{ tier: "capable", model: "anthropic/opus" }] },
    ],
    roster: {
      "spec-author": { tier: "capable" },
      implementer: { tier: "mid" },
      "reviewer-a": { tier: "capable", instance: "claude-local" },
    },
  };
}

async function start(cfg: RegistryConfig = registryConfig()) {
  const dir = mkdtempSync(join(tmpdir(), "arke-reg-"));
  const c = new Coordinator(
    new MockAdapter(),
    new Trace(join(dir, ".arke", "trace.ndjson")),
    new GrantStore(join(dir, ".arke", "grants.ndjson")),
    0,
    {
      projectRoot: dir,
      registry: new ProjectRegistry({ persist: false }),
      registryConfig: cfg,
      connectedInstanceId: "mock-local",
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

test("the snapshot carries a live registry projection (connected + configured instances)", async () => {
  const { c, port } = await start();
  after(() => c.stop());
  const { ws, ready, waitFor } = connect(port);
  await ready;
  const snap = await waitFor((f) => f.type === "snapshot");
  const reg = snap.registry;
  assert.ok(reg, "snapshot.registry present");
  assert.equal(reg.instances.length, 2);

  const mock = reg.instances.find((i: any) => i.id === "mock-local");
  assert.equal(mock.reachable, true); // backed by the live MockAdapter
  assert.ok(mock.caps.includes("events"));
  assert.equal(mock.catalogUnavailable, true); // MockAdapter has no `models` capability
  assert.deepEqual(mock.serves.map((s: any) => s.tier).sort(), ["capable", "mid"]);

  const claude = reg.instances.find((i: any) => i.id === "claude-local");
  assert.equal(claude.reachable, false); // configured but no adapter wired

  // tier resolution + roster table present, roster resolves the pinned reviewer to claude
  assert.ok(reg.tierResolution.some((t: any) => t.tier === "capable"));
  const reviewer = reg.roster.find((r: any) => r.role === "reviewer-a");
  assert.equal(reviewer.instanceId, "claude-local");
  assert.deepEqual(reg.warnings, []); // a clean config carries no warnings
  ws.close();
});

test("a bad registry surfaces warnings in the opening snapshot (not only as events)", async () => {
  // Both reviewers pinned to the same instance + tier → identical model → reviewer-distinct fails.
  // The opening client must see this in snapshot.registry.warnings, since the warning events fire
  // before it has subscribed (PR #15 review).
  const cfg = registryConfig();
  cfg.roster["reviewer-a"] = { tier: "capable", instance: "mock-local" };
  cfg.roster["reviewer-b"] = { tier: "capable", instance: "mock-local" };
  const { c, port } = await start(cfg);
  after(() => c.stop());
  const { ws, ready, waitFor } = connect(port);
  await ready;
  const snap = await waitFor((f) => f.type === "snapshot");
  assert.ok(snap.registry.warnings.some((w: any) => w.reason === "reviewer-models-identical"));
  ws.close();
});

test("no model string or credentialsRef leaks into the snapshot", async () => {
  const { c, port } = await start();
  after(() => c.stop());
  const { ws, ready, waitFor } = connect(port);
  await ready;
  const snap = await waitFor((f) => f.type === "snapshot");
  const json = JSON.stringify(snap.registry);
  for (const leak of ["vendorx", "anthropic/opus", "vendorx/big", "mock/cred", "claude/default", "credentialsRef"]) {
    assert.ok(!json.includes(leak), `registry projection must not leak '${leak}'`);
  }
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
  assert.ok(evt.event.instances.some((i: any) => i.id === "mock-local"));
  ws.close();
});
