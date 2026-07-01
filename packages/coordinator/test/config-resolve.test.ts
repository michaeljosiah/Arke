import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SUBSTRATE_DRIVER,
  SubstrateExclusivityError,
  assertSubstrateExclusivity,
  resolveEffectiveConfig,
  resolveProcessSettings,
} from "../src/config-resolve.js";
import type { GlobalConfig } from "../src/global-config.js";
import type { InstanceConfig, RegistryConfig } from "../src/registry.js";

function inst(id: string, driver = "opencode", over: Partial<InstanceConfig> = {}): InstanceConfig {
  return { id, driver, host: "localhost", cwd: ".", credentialsRef: `${driver}/default`, serves: [{ tier: "capable", model: "x/y" }], ...over };
}

test("a global instance is inherited when the project omits it", () => {
  const global: GlobalConfig = { instances: [inst("opencode-local")] };
  const project: RegistryConfig = { instances: [], roster: { "spec-author": { tier: "capable" } } };
  const eff = resolveEffectiveConfig(global, project);
  assert.deepEqual(eff.instances.map((i) => i.id), ["opencode-local"]);
  assert.equal(eff.roster["spec-author"]!.tier, "capable");
});

test("a project instance with the same id overrides the global one (no duplicate)", () => {
  const global: GlobalConfig = { instances: [inst("opencode-local", "opencode", { host: "localhost:4096" })] };
  const project: RegistryConfig = { instances: [inst("opencode-local", "opencode", { host: "localhost:5000" })], roster: {} };
  const eff = resolveEffectiveConfig(global, project);
  assert.equal(eff.instances.length, 1);
  assert.equal(eff.instances[0]!.host, "localhost:5000"); // project wins
});

test("project roster merges with global instances (split grain)", () => {
  const global: GlobalConfig = { instances: [inst("opencode-local"), inst("claude-local", "claude-code")] };
  const project: RegistryConfig = { instances: [], roster: { "reviewer-a": { tier: "capable", instance: "claude-local" } } };
  const eff = resolveEffectiveConfig(global, project);
  assert.equal(eff.instances.length, 2);
  assert.equal(eff.roster["reviewer-a"]!.instance, "claude-local");
});

test("global instances come first; project-only instances are appended (deterministic order)", () => {
  const global: GlobalConfig = { instances: [inst("g1"), inst("g2")] };
  const project: RegistryConfig = { instances: [inst("p1"), inst("g1", "opencode", { host: "h" })], roster: {} };
  const eff = resolveEffectiveConfig(global, project);
  // g1 keeps its original position (updated in place), g2 next, then project-only p1.
  assert.deepEqual(eff.instances.map((i) => i.id), ["g1", "g2", "p1"]);
  assert.equal(eff.instances[0]!.host, "h"); // g1 overridden by project
});

test("the roster is strictly project-level — a global config supplies no roster", () => {
  // GlobalConfig has no roster channel; only the project's roster reaches the effective config.
  const eff = resolveEffectiveConfig({ instances: [inst("opencode-local")] }, { instances: [], roster: {} });
  assert.deepEqual(eff.roster, {});
});

test("neither file present yields an empty-but-valid config (no throw)", () => {
  const eff = resolveEffectiveConfig(null, null);
  assert.deepEqual(eff.instances, []);
  assert.deepEqual(eff.roster, {});
});

// ---- credential precedence (R4) --------------------------------------------

test("credential precedence: same instance id in both — the project credentialsRef wins", () => {
  const global: GlobalConfig = { instances: [inst("opencode-local", "opencode", { credentialsRef: "opencode/gateway" })] };
  const project: RegistryConfig = { instances: [inst("opencode-local", "opencode", { credentialsRef: "opencode/project-key" })], roster: {} };
  const eff = resolveEffectiveConfig(global, project);
  assert.equal(eff.instances[0]!.credentialsRef, "opencode/project-key");
});

test("credential precedence: only the global defines the ref — the global value is used", () => {
  const global: GlobalConfig = { instances: [inst("opencode-local", "opencode", { credentialsRef: "opencode/gateway" })] };
  const eff = resolveEffectiveConfig(global, { instances: [], roster: {} });
  assert.equal(eff.instances[0]!.credentialsRef, "opencode/gateway");
});

// ---- process-wide settings (R3) --------------------------------------------

test("process-wide settings come from the global block; a project cannot supply them", () => {
  // The project type carries no settings, so the function cannot read one — the boundary is structural.
  const eff = resolveEffectiveConfig({ instances: [], settings: { coordinatorPort: 4319 } }, { instances: [], roster: {} }, {});
  assert.equal(eff.settings?.coordinatorPort, 4319);
});

test("ARKE_* env overrides a global settings value (env wins)", () => {
  const s = resolveProcessSettings({ maxProjects: 5, coordinatorPort: 4319 }, { ARKE_MAX_PROJECTS: "8" });
  assert.equal(s?.maxProjects, 8); // env wins
  assert.equal(s?.coordinatorPort, 4319); // untouched
});

test("resolveProcessSettings returns undefined when nothing supplies a value", () => {
  assert.equal(resolveProcessSettings(undefined, {}), undefined);
});

// ---- substrate exclusivity (R7 / ADR-0004) ---------------------------------

test("assertSubstrateExclusivity accepts an all-leaf or all-substrate config", () => {
  assert.doesNotThrow(() => assertSubstrateExclusivity({ instances: [inst("a"), inst("b", "claude-code")] }));
  assert.doesNotThrow(() => assertSubstrateExclusivity({ instances: [inst("omni", SUBSTRATE_DRIVER)] }));
  assert.doesNotThrow(() => assertSubstrateExclusivity({ instances: [] }));
});

test("assertSubstrateExclusivity rejects a substrate mixed with leaf instances", () => {
  assert.throws(
    () => assertSubstrateExclusivity({ instances: [inst("opencode-local"), inst("omni", SUBSTRATE_DRIVER)] }),
    SubstrateExclusivityError,
  );
});
