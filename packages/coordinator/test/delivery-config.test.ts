import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAutoOpenPr, setAutoOpenPr } from "../src/delivery-config.js";

const tmpConfig = () => join(mkdtempSync(join(tmpdir(), "arke-delivery-cfg-")), "config.json");

test("loadAutoOpenPr defaults to false when the config file is absent", () => {
  assert.equal(loadAutoOpenPr(join(mkdtempSync(join(tmpdir(), "arke-nofile-")), "config.json")), false);
});

test("loadAutoOpenPr reads delivery.autoOpenPr === true", () => {
  const p = tmpConfig();
  writeFileSync(p, JSON.stringify({ delivery: { autoOpenPr: true } }), "utf8");
  assert.equal(loadAutoOpenPr(p), true);
});

test("loadAutoOpenPr treats a missing/other-typed value as false (only literal true opts in)", () => {
  const p = tmpConfig();
  writeFileSync(p, JSON.stringify({ delivery: { autoOpenPr: "yes" }, registry: {} }), "utf8");
  assert.equal(loadAutoOpenPr(p), false);
  writeFileSync(p, JSON.stringify({ registry: { instances: [] } }), "utf8");
  assert.equal(loadAutoOpenPr(p), false);
});

test("loadAutoOpenPr returns false (not throw) on an unparseable file", () => {
  const p = tmpConfig();
  writeFileSync(p, "{ not json", "utf8");
  assert.equal(loadAutoOpenPr(p), false);
});

test("setAutoOpenPr writes a fresh config when none exists, and round-trips through loadAutoOpenPr", () => {
  const p = tmpConfig();
  setAutoOpenPr(p, true);
  assert.equal(loadAutoOpenPr(p), true);
  setAutoOpenPr(p, false);
  assert.equal(loadAutoOpenPr(p), false);
});

test("setAutoOpenPr PRESERVES every other config key (registry, settings, providers)", () => {
  const p = tmpConfig();
  const original = { registry: { instances: [{ id: "oc", driver: "opencode" }] }, settings: { permissionTimeoutMs: 5000 }, providers: { anthropic: {} } };
  writeFileSync(p, JSON.stringify(original), "utf8");
  setAutoOpenPr(p, true);
  const after = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(after.registry, original.registry, "registry untouched");
  assert.deepEqual(after.settings, original.settings, "settings untouched");
  assert.deepEqual(after.providers, original.providers, "providers untouched");
  assert.equal(after.delivery.autoOpenPr, true, "only delivery.autoOpenPr is added");
});

test("setAutoOpenPr refuses to clobber a file that exists but is not valid JSON", () => {
  const p = tmpConfig();
  writeFileSync(p, "{ hand-edited, broken", "utf8");
  assert.throws(() => setAutoOpenPr(p, true), /not valid JSON/);
  assert.equal(readFileSync(p, "utf8"), "{ hand-edited, broken", "the broken file is left untouched");
});
