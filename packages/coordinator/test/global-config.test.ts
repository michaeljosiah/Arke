import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { globalConfigPath, loadGlobalConfig, setGlobalManageHarness, upsertGlobalInstance } from "../src/global-config.js";
import type { InstanceConfig } from "../src/registry.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "arke-global-")), "config.json");
}

function inst(id: string, over: Partial<InstanceConfig> = {}): InstanceConfig {
  return { id, driver: "opencode", host: "localhost:4096", cwd: ".", credentialsRef: "opencode/gateway", serves: [{ tier: "capable", model: "x/y" }], ...over };
}

test("loadGlobalConfig returns null for a missing file", () => {
  assert.equal(loadGlobalConfig(join(tmpdir(), "arke-global-nope-zzz.json")), null);
});

test("loadGlobalConfig parses instances and a settings block, ignoring any roster", () => {
  const path = tmpPath();
  writeFileSync(path, JSON.stringify({
    registry: { instances: [{ id: "opencode-local", driver: "opencode", credentialsRef: "opencode/gateway", serves: [{ tier: "capable", model: "x/y" }] }], roster: { "spec-author": { tier: "capable" } } },
    settings: { coordinatorPort: 4319, maxProjects: 5 },
  }), "utf8");
  const cfg = loadGlobalConfig(path);
  assert.ok(cfg);
  assert.equal(cfg!.instances.length, 1);
  assert.equal(cfg!.settings?.coordinatorPort, 4319);
  assert.equal(cfg!.settings?.maxProjects, 5);
  // The global config has no roster channel — a roster in the file is ignored (decision #9).
  assert.equal((cfg as unknown as { roster?: unknown }).roster, undefined);
});

test("upsertGlobalInstance creates the file with a single instance when absent", () => {
  const path = tmpPath();
  upsertGlobalInstance(inst("opencode-local"), path);
  const cfg = loadGlobalConfig(path);
  assert.ok(cfg);
  assert.equal(cfg!.instances.length, 1);
  assert.equal(cfg!.instances[0]!.id, "opencode-local");
});

test("upsertGlobalInstance replaces a same-id entry and preserves settings + other instances", () => {
  const path = tmpPath();
  writeFileSync(path, JSON.stringify({
    registry: { instances: [{ id: "opencode-local", driver: "opencode", credentialsRef: "opencode/gateway", serves: [] }] },
    settings: { coordinatorPort: 4319 },
  }), "utf8");
  upsertGlobalInstance(inst("claude-local", { driver: "claude-code", credentialsRef: "claude/default" }), path);
  upsertGlobalInstance(inst("opencode-local", { host: "localhost:9999" }), path); // replace existing
  const cfg = loadGlobalConfig(path);
  assert.ok(cfg);
  assert.equal(cfg!.instances.length, 2);
  assert.equal(cfg!.instances.find((i) => i.id === "opencode-local")!.host, "localhost:9999");
  assert.equal(cfg!.settings?.coordinatorPort, 4319); // settings preserved across the write
});

test("upsertGlobalInstance writes only a credentialsRef pointer — never a secret", () => {
  const path = tmpPath();
  upsertGlobalInstance(inst("opencode-local", { credentialsRef: "opencode/gateway" }), path);
  const raw = readFileSync(path, "utf8");
  assert.match(raw, /opencode\/gateway/); // the pointer is present
  // The descriptor type carries only a ref; assert no obvious secret-shaped keys leaked into the file.
  assert.doesNotMatch(raw, /"(apiKey|token|secret|password)"/i);
});

test("setGlobalManageHarness toggles settings.manageHarness, preserving instances (SPEC-019 managed connect)", () => {
  const path = tmpPath();
  upsertGlobalInstance(inst("opencode-local"), path);
  setGlobalManageHarness(true, path);
  let cfg = loadGlobalConfig(path);
  assert.equal(cfg!.settings?.manageHarness, true);
  assert.equal(cfg!.instances.length, 1); // instance preserved across the settings write
  setGlobalManageHarness(false, path);
  cfg = loadGlobalConfig(path);
  assert.equal(cfg!.settings?.manageHarness, false);
  assert.equal(cfg!.instances.length, 1);
});

test("globalConfigPath honours ARKE_GLOBAL_CONFIG_PATH", () => {
  const custom = join(tmpdir(), "custom", "arke.json");
  assert.equal(globalConfigPath({ ARKE_GLOBAL_CONFIG_PATH: custom } as NodeJS.ProcessEnv), resolve(custom));
});
