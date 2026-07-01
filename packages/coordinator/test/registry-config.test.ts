import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRegistryConfig } from "../src/registry-config.js";

function writeConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-regcfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents), "utf8");
  return path;
}

test("parses instances + roster and picks the opencode instance as connected", () => {
  const path = writeConfig({
    registry: {
      instances: [
        { id: "claude-local", driver: "claude-code", host: "localhost", cwd: ".", credentialsRef: "claude/default", serves: [{ tier: "capable", model: "anthropic/opus" }] },
        { id: "opencode-local", driver: "opencode", host: "localhost", cwd: ".", credentialsRef: "opencode/gateway", serves: [{ tier: "capable", model: "x/big" }, { tier: "mid", model: "x/small" }] },
      ],
      roster: { "spec-author": { tier: "capable" }, "reviewer-a": { tier: "capable", instance: "claude-local" } },
    },
  });
  const loaded = loadRegistryConfig(path);
  assert.ok(loaded);
  assert.equal(loaded!.config.instances.length, 2);
  assert.equal(loaded!.connectedInstanceId, "opencode-local"); // first opencode driver
  assert.equal(loaded!.config.roster["reviewer-a"]!.instance, "claude-local");
});

test("returns null when there is no registry or no instances", () => {
  assert.equal(loadRegistryConfig(writeConfig({})), null);
  assert.equal(loadRegistryConfig(writeConfig({ registry: {} })), null);
  assert.equal(loadRegistryConfig(writeConfig({ registry: { instances: [] } })), null);
});

test("returns null for an unreadable / missing file", () => {
  assert.equal(loadRegistryConfig(join(tmpdir(), "arke-nope-zzz.json")), null);
});

test("a roster-only project file survives the load (instances moved to global) — SPEC-019", () => {
  const path = writeConfig({
    registry: { roster: { "reviewer-a": { tier: "capable", instance: "claude-local" }, implementer: { tier: "mid" } } },
  });
  const loaded = loadRegistryConfig(path);
  assert.ok(loaded);
  assert.equal(loaded!.config.instances.length, 0);
  assert.equal(loaded!.config.roster["reviewer-a"]!.instance, "claude-local");
  assert.equal(loaded!.connectedInstanceId, undefined);
});

test("preserves explicit port and baseUrl fields verbatim across a load", () => {
  const path = writeConfig({
    registry: { instances: [{ id: "opencode-local", driver: "opencode", host: "localhost", port: 5000, baseUrl: "https://gw.example.com", serves: [] }] },
  });
  const loaded = loadRegistryConfig(path);
  assert.ok(loaded);
  assert.equal(loaded!.config.instances[0]!.port, 5000);
  assert.equal(loaded!.config.instances[0]!.baseUrl, "https://gw.example.com");
});

test("drops malformed entries leniently (no id/driver, bad tiers)", () => {
  const path = writeConfig({
    registry: {
      instances: [
        { driver: "opencode", serves: [] }, // no id → dropped
        { id: "ok", driver: "opencode", serves: [{ tier: "capable", model: "x/y" }, { tier: "turbo", model: "x/z" }] },
      ],
      roster: { good: { tier: "mid" }, bad: { tier: "turbo" } },
    },
  });
  const loaded = loadRegistryConfig(path);
  assert.ok(loaded);
  assert.equal(loaded!.config.instances.length, 1);
  assert.equal(loaded!.config.instances[0]!.serves.length, 1); // "turbo" serve dropped
  assert.deepEqual(Object.keys(loaded!.config.roster), ["good"]); // "turbo" roster role dropped
});
