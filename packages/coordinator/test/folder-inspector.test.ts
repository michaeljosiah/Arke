import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { FolderInspector } from "../src/folder-inspector.js";

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "arke-fi-"));
}

function touch(root: string, rel: string): void {
  const abs = resolve(root, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, "x", "utf8");
}

test("classifies a folder with all sentinels (incl. the config registry) as method-ready", () => {
  const root = fresh();
  touch(root, ".arke/config.json");
  mkdirSync(resolve(root, ".opencode/agents"), { recursive: true });
  mkdirSync(resolve(root, "docs/specifications"), { recursive: true });
  touch(root, "AGENTS.md");
  const c = FolderInspector.classify(root);
  assert.equal(c.state, "method-ready");
  assert.deepEqual(c.missingSentinels, []);
});

test("the agent/spec sentinels without the config registry classify as partial, not method-ready", () => {
  // An older scaffold (or one that crashed before/after the config step) must NOT read as ready.
  const root = fresh();
  mkdirSync(resolve(root, ".opencode/agents"), { recursive: true });
  mkdirSync(resolve(root, "docs/specifications"), { recursive: true });
  touch(root, "AGENTS.md");
  const c = FolderInspector.classify(root);
  assert.equal(c.state, "partial-scaffold");
  assert.deepEqual(c.missingSentinels, [".arke/config.json"]);
});

test("classifies a folder with one sentinel as partial-scaffold and lists the missing ones", () => {
  const root = fresh();
  touch(root, "AGENTS.md"); // only one of four
  const c = FolderInspector.classify(root);
  assert.equal(c.state, "partial-scaffold");
  assert.deepEqual(
    c.missingSentinels.sort(),
    [".arke/config.json", ".opencode/agents", "docs/specifications"].sort(),
  );
});

test("classifies a folder with source files and no sentinels as has-code", () => {
  const root = fresh();
  touch(root, "src/index.ts");
  const c = FolderInspector.classify(root);
  assert.equal(c.state, "has-code");
  assert.equal(c.missingSentinels.length, 4);
});

test("classifies a pristine folder as empty", () => {
  const root = fresh();
  const c = FolderInspector.classify(root);
  assert.equal(c.state, "empty");
});

test("ignores node_modules/.git when scanning for source", () => {
  const root = fresh();
  touch(root, "node_modules/pkg/index.js");
  touch(root, ".git/config");
  const c = FolderInspector.classify(root);
  assert.equal(c.state, "empty");
});
