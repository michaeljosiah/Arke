import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { browseDirectory, createProject } from "../src/workspace.js";
import { ValidationError } from "../src/input-validator.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "arke-ws-"));
}

test("browseDirectory lists subdirectories, hides dot dirs, flags Arke projects", () => {
  const root = workspace();
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "beta", ".arke"), { recursive: true }); // an existing Arke project
  mkdirSync(join(root, ".hidden")); // a dot dir — should be hidden
  writeFileSync(join(root, "readme.md"), "x"); // a file — not a directory

  const res = browseDirectory(root);
  assert.equal(res.root, resolve(root));
  assert.equal(res.path, resolve(root));
  assert.equal(res.parent, null); // at the workspace root — cannot go up
  assert.deepEqual(res.entries.map((e) => e.name), ["alpha", "beta"]);
  assert.equal(res.entries.find((e) => e.name === "beta")!.isProject, true);
  assert.equal(res.entries.find((e) => e.name === "alpha")!.isProject, false);
});

test("browseDirectory exposes a parent only while inside the root", () => {
  const root = workspace();
  mkdirSync(join(root, "sub", "deeper"), { recursive: true });
  const sub = browseDirectory(root, join(root, "sub"));
  assert.equal(sub.parent, resolve(root)); // parent is the root
  const rootRes = browseDirectory(root, root);
  assert.equal(rootRes.parent, null); // never above the root
});

test("browseDirectory refuses a path outside the workspace root", () => {
  const root = workspace();
  assert.throws(() => browseDirectory(root, join(root, "..", "..")), ValidationError);
});

test("createProject makes a bounded folder and rejects escapes / bad names / collisions", () => {
  const root = workspace();
  const r = createProject(root, undefined, "new-service");
  assert.equal(r.path, resolve(root, "new-service"));
  assert.equal(r.name, "new-service");

  assert.throws(() => createProject(root, undefined, "new-service"), ValidationError); // already exists
  assert.throws(() => createProject(root, undefined, "../escape"), ValidationError); // separator in name
  assert.throws(() => createProject(root, undefined, ""), ValidationError); // empty
  assert.throws(() => createProject(root, join(root, "..", ".."), "x"), ValidationError); // dest escapes root
});

test("createProject honours a destination subdirectory within the root", () => {
  const root = workspace();
  mkdirSync(join(root, "clients"));
  const r = createProject(root, join(root, "clients"), "acme");
  assert.equal(r.path, resolve(root, "clients", "acme"));
});
