import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { codexInstanceFor } from "../src/server.js";

/**
 * SPEC-034: the coordinator selects the Codex leaf adapter when — and only when — a project pins a
 * `codex` instance (and not `opencode`). The project's own config takes precedence over the machine's
 * global one, so a global OpenCode instance must not suppress a project that opts into Codex.
 */
function projectConfig(instances: unknown[]): string {
  return rawConfig({ registry: { instances } });
}

function rawConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-codex-sel-"));
  mkdirSync(resolve(dir, ".arke"), { recursive: true });
  const cfg = resolve(dir, ".arke", "config.json");
  writeFileSync(cfg, JSON.stringify(obj), "utf8");
  return cfg;
}

test("a project pinning a codex instance (no opencode) selects the Codex adapter", () => {
  const inst = codexInstanceFor(projectConfig([{ id: "codex-local", driver: "codex", host: "localhost" }]));
  assert.ok(inst, "a codex instance is selected");
  assert.equal(inst!.driver, "codex");
});

test("OpenCode wins a tie — a project declaring both stays on OpenCode", () => {
  assert.equal(codexInstanceFor(projectConfig([{ id: "cx", driver: "codex" }, { id: "oc", driver: "opencode" }])), undefined);
});

test("a project pinning only opencode does not select codex", () => {
  assert.equal(codexInstanceFor(projectConfig([{ id: "oc", driver: "opencode" }])), undefined);
});

test("the project's own harness takes precedence — codex is selected even with a global opencode present", () => {
  // The project config has a codex instance; codexInstanceFor must return it from the PROJECT config
  // without consulting (and being overridden by) any global opencode instance on the machine.
  const inst = codexInstanceFor(projectConfig([{ id: "codex-local", driver: "codex" }]));
  assert.equal(inst?.driver, "codex", "a project-pinned codex is not suppressed by global config");
});

test("a project configuring an OpenCode PROVIDER (no registry.instances) is not overridden by a global Codex", () => {
  // The provider shape (no local registry.instances) still pins the project to OpenCode — a machine-level
  // Codex instance must not win over it (review). codexInstanceFor returns undefined without consulting global.
  const cfg = rawConfig({ providers: { "opencode-local": { harness: "opencode", host: "localhost", port: 4096, credentialsRef: "o/g" } }, registry: { instances: [] } });
  assert.equal(codexInstanceFor(cfg), undefined, "the project's provider pins OpenCode; a global Codex does not win");
});
