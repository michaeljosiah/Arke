import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DirectoryEscapeError,
  canonicalizeRoot,
  isWithinRoot,
  resolveDirectory,
} from "../src/index.js";

const ROOT = canonicalizeRoot(tmpdir());

test("resolveDirectory returns the root when no candidate is given", () => {
  assert.equal(resolveDirectory(ROOT), ROOT);
});

test("resolveDirectory accepts a path inside the root", () => {
  const inside = resolveDirectory(ROOT, "sub/dir");
  assert.equal(inside, resolve(ROOT, "sub/dir"));
  assert.ok(isWithinRoot(ROOT, inside));
});

test("resolveDirectory refuses a parent-traversal escape", () => {
  assert.throws(() => resolveDirectory(ROOT, "../escape"), DirectoryEscapeError);
});

test("resolveDirectory refuses a deep traversal that climbs out", () => {
  assert.throws(() => resolveDirectory(ROOT, "a/b/../../../escape"), DirectoryEscapeError);
});

test("resolveDirectory refuses an absolute override outside the root", () => {
  const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
  assert.throws(() => resolveDirectory(ROOT, outside), DirectoryEscapeError);
});

test("isWithinRoot treats the root itself as within", () => {
  assert.equal(isWithinRoot(ROOT, ROOT), true);
});

test("isWithinRoot rejects a sibling directory", () => {
  assert.equal(isWithinRoot(resolve(ROOT, "a"), resolve(ROOT, "b")), false);
});
