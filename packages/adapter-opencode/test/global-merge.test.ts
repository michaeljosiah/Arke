import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOpenCodeConfig } from "../src/index.js";

/**
 * SPEC-019: `loadOpenCodeConfig` merges the global (machine-level) config UNDER the project's, so a
 * globally-configured OpenCode harness is picked up by a project with no local instance. These tests
 * cover the load path that makes a globally-connected harness go live on project open.
 */

function writeJson(name: string, contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-merge-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(contents), "utf8");
  return path;
}

const opencodeInstance = (over: Record<string, unknown> = {}) => ({
  id: "opencode-local",
  driver: "opencode",
  host: "localhost:4096",
  credentialsRef: "opencode/gateway",
  serves: [{ tier: "capable", model: "x/y" }],
  ...over,
});

test("a project with no config inherits the global OpenCode instance", () => {
  const globalConfigPath = writeJson("global.json", { registry: { instances: [opencodeInstance()] } });
  const cfg = loadOpenCodeConfig({ configPath: join(tmpdir(), "arke-absent-zzz.json"), baseDir: tmpdir(), globalConfigPath });
  assert.ok(cfg);
  assert.equal(cfg!.baseUrl, "http://localhost:4096"); // host authority carried, port not doubled
});

test("a project instance overrides the global one by id (project wins)", () => {
  const globalConfigPath = writeJson("global.json", { registry: { instances: [opencodeInstance({ host: "localhost:4096" })] } });
  const configPath = writeJson("config.json", { registry: { instances: [opencodeInstance({ host: "localhost:5000" })] } });
  const cfg = loadOpenCodeConfig({ configPath, baseDir: tmpdir(), globalConfigPath });
  assert.ok(cfg);
  assert.equal(cfg!.baseUrl, "http://localhost:5000"); // project's host wins
});

test("null when neither project nor global configures an OpenCode instance", () => {
  const globalConfigPath = writeJson("global.json", { registry: { instances: [{ id: "omni", driver: "omnigent" }] } });
  const cfg = loadOpenCodeConfig({ configPath: join(tmpdir(), "arke-absent-zzz.json"), baseDir: tmpdir(), globalConfigPath });
  assert.equal(cfg, null);
});

test("without a global path, project-only loading is unchanged (back-compat)", () => {
  const configPath = writeJson("config.json", { registry: { instances: [opencodeInstance()] } });
  const cfg = loadOpenCodeConfig({ configPath, baseDir: tmpdir() });
  assert.ok(cfg);
  assert.equal(cfg!.baseUrl, "http://localhost:4096");
});
