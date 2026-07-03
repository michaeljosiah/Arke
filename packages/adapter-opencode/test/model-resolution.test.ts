import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOpenCodeConfig } from "../src/index.js";

/**
 * `.arke/config.json` is now a PROVIDER/AUTH PROFILE store (SPEC-016 revised) — the ENDPOINT the
 * adapter talks to. The concrete MODEL is declared per-agent in the image's `executor` and passed on
 * each dispatch, so `loadOpenCodeConfig` no longer resolves models — only the endpoint + settings.
 */

function writeConfig(contents: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "arke-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents), "utf8");
  return { dir, path };
}

test("loadOpenCodeConfig derives baseUrl from an opencode provider profile's host/port", () => {
  const { dir, path } = writeConfig({
    providers: { "opencode-local": { harness: "opencode", host: "localhost", port: 5000, cwd: ".", credentialsRef: "opencode/gateway" } },
  });
  const config = loadOpenCodeConfig({ configPath: path, baseDir: dir, env: { OPENCODE_SERVER_PASSWORD: "host-only" } });
  assert.ok(config);
  assert.equal(config!.baseUrl, "http://127.0.0.1:5000");
  assert.equal(config!.password, "host-only"); // credentials come from the host env only
});

test("loadOpenCodeConfig picks the first OpenCode provider and ignores non-opencode ones", () => {
  const { dir, path } = writeConfig({
    providers: {
      "claude-remote": { harness: "claude-code", host: "localhost" },
      "opencode-local": { harness: "opencode", host: "localhost", port: 4096 },
    },
  });
  const config = loadOpenCodeConfig({ configPath: path, baseDir: dir, env: {} });
  assert.ok(config);
  assert.equal(config!.baseUrl, "http://127.0.0.1:4096");
});

test("ARKE_* env vars override individual keys", () => {
  const { dir, path } = writeConfig({
    providers: { "opencode-local": { harness: "opencode", host: "localhost", cwd: "." } },
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

test("loadOpenCodeConfig returns null when no opencode provider is configured", () => {
  const { dir, path } = writeConfig({ providers: { "claude-remote": { harness: "claude-code", host: "localhost" } } });
  assert.equal(loadOpenCodeConfig({ configPath: path, baseDir: dir, env: {} }), null);
});

test("a harness connected via legacy quick-setup (registry.instances) is still wired", () => {
  // The SPEC-019 quick-setup connect flow persists under `registry.instances`, not `providers`. The
  // loader must fold that in so a UI-connected OpenCode harness still yields an endpoint.
  const { dir, path } = writeConfig({
    registry: { instances: [{ id: "opencode-local", driver: "opencode", host: "localhost", port: 4096, cwd: ".", credentialsRef: "opencode/gateway" }] },
  });
  const config = loadOpenCodeConfig({ configPath: path, baseDir: dir, env: {} });
  assert.ok(config);
  assert.equal(config!.baseUrl, "http://127.0.0.1:4096");
});

test("an explicit `providers` profile wins over a legacy registry.instances entry of the same id", () => {
  const { dir, path } = writeConfig({
    providers: { "opencode-local": { harness: "opencode", host: "localhost", port: 5000 } },
    registry: { instances: [{ id: "opencode-local", driver: "opencode", host: "localhost", port: 4096 }] },
  });
  const config = loadOpenCodeConfig({ configPath: path, baseDir: dir, env: {} });
  assert.ok(config);
  assert.equal(config!.baseUrl, "http://127.0.0.1:5000"); // providers profile wins
});

test("loadOpenCodeConfig returns null on an empty/absent config", () => {
  const { dir, path } = writeConfig({});
  assert.equal(loadOpenCodeConfig({ configPath: path, baseDir: dir, env: {} }), null);
});
