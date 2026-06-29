import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_RESOLVE_MODEL, loadOpenCodeConfig, parseModelRef } from "../src/index.js";

test("parseModelRef splits provider/name", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-sonnet"), {
    provider: "anthropic",
    name: "claude-sonnet",
  });
});

test("parseModelRef defaults a bare name to the gateway provider", () => {
  assert.deepEqual(parseModelRef("capable-tier"), { provider: "gateway", name: "capable-tier" });
});

test("the default resolver targets the internal gateway per tier", () => {
  assert.deepEqual(DEFAULT_RESOLVE_MODEL("capable"), { provider: "gateway", name: "capable-tier" });
  assert.deepEqual(DEFAULT_RESOLVE_MODEL("mid"), { provider: "gateway", name: "mid-tier" });
  assert.deepEqual(DEFAULT_RESOLVE_MODEL("fast"), { provider: "gateway", name: "fast-tier" });
});

test("a configured fast serve resolves to its concrete model, not a downgrade", () => {
  const { dir, path } = writeConfig({
    registry: {
      instances: [
        {
          id: "opencode-local",
          driver: "opencode",
          host: "localhost",
          cwd: ".",
          serves: [
            { tier: "mid", model: "vendorx/small" },
            { tier: "fast", model: "vendorx/tiny" },
          ],
        },
      ],
    },
  });
  const config = loadOpenCodeConfig({ configPath: path, baseDir: dir, env: {} });
  assert.ok(config);
  assert.deepEqual(config!.resolveModel!("fast"), { provider: "vendorx", name: "tiny" });
  // an unconfigured tier still falls back to its own gateway placeholder, never another tier
  assert.deepEqual(config!.resolveModel!("capable"), { provider: "gateway", name: "capable-tier" });
});

function writeConfig(contents: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "arke-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents), "utf8");
  return { dir, path };
}

test("loadOpenCodeConfig resolves tiers from the registry, never hardcoded", () => {
  const { dir, path } = writeConfig({
    registry: {
      instances: [
        {
          id: "opencode-local",
          driver: "opencode",
          host: "localhost",
          cwd: ".",
          serves: [
            { tier: "capable", model: "vendorx/big" },
            { tier: "mid", model: "vendorx/small" },
          ],
        },
      ],
    },
  });
  const config = loadOpenCodeConfig({ configPath: path, baseDir: dir, env: {} });
  assert.ok(config);
  assert.deepEqual(config!.resolveModel!("capable"), { provider: "vendorx", name: "big" });
  assert.deepEqual(config!.resolveModel!("mid"), { provider: "vendorx", name: "small" });
});

test("loadOpenCodeConfig derives baseUrl from host/port and reads password from env only", () => {
  const { dir, path } = writeConfig({
    registry: { instances: [{ driver: "opencode", host: "localhost", port: 5000, cwd: "." }] },
  });
  const config = loadOpenCodeConfig({
    configPath: path,
    baseDir: dir,
    env: { OPENCODE_SERVER_PASSWORD: "host-only" },
  });
  assert.ok(config);
  assert.equal(config!.baseUrl, "http://127.0.0.1:5000");
  assert.equal(config!.password, "host-only");
});

test("ARKE_* env vars override individual keys", () => {
  const { dir, path } = writeConfig({
    registry: { instances: [{ driver: "opencode", host: "localhost", cwd: "." }] },
    settings: { permissionTimeoutMs: 1000 },
  });
  const config = loadOpenCodeConfig({
    configPath: path,
    baseDir: dir,
    env: { ARKE_OPENCODE_BASE_URL: "http://override:9999", ARKE_PERMISSION_TIMEOUT_MS: "42" },
  });
  assert.ok(config);
  assert.equal(config!.baseUrl, "http://override:9999");
  assert.equal(config!.permissionTimeoutMs, 42);
});

test("loadOpenCodeConfig returns null when no opencode instance is configured", () => {
  const { dir, path } = writeConfig({
    registry: { instances: [{ driver: "claude-code", host: "localhost", cwd: "." }] },
  });
  assert.equal(loadOpenCodeConfig({ configPath: path, baseDir: dir, env: {} }), null);
});
