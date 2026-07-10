import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { omnigentInstanceFor } from "../src/server.js";

/**
 * SPEC-037: the coordinator selects the Omnigent substrate when — and only when — a project pins an
 * `omnigent` instance and NO leaf harness (OpenCode/Codex win a tie — substrate-exclusivity, ADR-0004 Dec 5).
 * Mirrors the Codex-selection precedence (project config wins over global).
 */
function projectConfig(instances: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-omni-sel-"));
  mkdirSync(resolve(dir, ".arke"), { recursive: true });
  const cfg = resolve(dir, ".arke", "config.json");
  writeFileSync(cfg, JSON.stringify({ registry: { instances } }), "utf8");
  return cfg;
}

test("a project pinning an omnigent instance (no leaf) selects the Omnigent substrate", () => {
  const inst = omnigentInstanceFor(projectConfig([{ id: "omnigent-local", driver: "omnigent", baseUrl: "http://localhost:6767" }]));
  assert.ok(inst, "an omnigent instance is selected");
  assert.equal(inst!.driver, "omnigent");
  assert.equal(inst!.baseUrl, "http://localhost:6767");
});

test("a leaf harness wins a tie — a project declaring omnigent + opencode stays on the leaf (exclusivity)", () => {
  assert.equal(omnigentInstanceFor(projectConfig([{ id: "om", driver: "omnigent" }, { id: "oc", driver: "opencode" }])), undefined);
  assert.equal(omnigentInstanceFor(projectConfig([{ id: "om", driver: "omnigent" }, { id: "cx", driver: "codex" }])), undefined);
});

test("a project pinning only opencode does not select omnigent", () => {
  assert.equal(omnigentInstanceFor(projectConfig([{ id: "oc", driver: "opencode" }])), undefined);
});

test("the project's own omnigent instance is not suppressed by global config", () => {
  const inst = omnigentInstanceFor(projectConfig([{ id: "omnigent-local", driver: "omnigent" }]));
  assert.equal(inst?.driver, "omnigent");
});
