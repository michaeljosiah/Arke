import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { InputValidator, ValidationError } from "../src/input-validator.js";

const root = mkdtempSync(join(tmpdir(), "arke-iv-"));

test("canonicalisePath rejects `..` traversal out of the safe root", () => {
  assert.throws(() => InputValidator.canonicalisePath("../../etc", root), ValidationError);
});

test("canonicalisePath rejects an absolute path that escapes the root", () => {
  const escape = process.platform === "win32" ? "C:\\Windows" : "/etc";
  assert.throws(() => InputValidator.canonicalisePath(escape, root), ValidationError);
});

test("canonicalisePath rejects a null byte", () => {
  assert.throws(() => InputValidator.canonicalisePath("foo\0bar", root), ValidationError);
});

test("canonicalisePath rejects an empty value", () => {
  assert.throws(() => InputValidator.canonicalisePath("", root), ValidationError);
});

test("canonicalisePath accepts a path inside the root and returns it absolute", () => {
  const out = InputValidator.canonicalisePath("sub/dir", root);
  assert.equal(out, resolve(root, "sub/dir"));
});

test("canonicalisePath accepts the root itself", () => {
  const out = InputValidator.canonicalisePath(".", root);
  assert.equal(out, resolve(root));
});

test("validateCloneUrl accepts a well-formed https url", () => {
  const url = "https://github.com/acme/repo.git";
  assert.equal(InputValidator.validateCloneUrl(url), url);
});

test("validateCloneUrl accepts a well-formed ssh url", () => {
  const url = "ssh://git@github.com/acme/repo.git";
  assert.equal(InputValidator.validateCloneUrl(url), url);
});

test("validateCloneUrl rejects file:// (a read primitive)", () => {
  assert.throws(() => InputValidator.validateCloneUrl("file:///etc/passwd"), ValidationError);
});

test("validateCloneUrl rejects a shell-injection string", () => {
  assert.throws(() => InputValidator.validateCloneUrl("; rm -rf /"), ValidationError);
});

test("validateCloneUrl rejects a bare path string", () => {
  assert.throws(() => InputValidator.validateCloneUrl("/some/local/path"), ValidationError);
});

test("validateCloneUrl rejects an http (non-tls) url", () => {
  assert.throws(() => InputValidator.validateCloneUrl("http://github.com/acme/repo"), ValidationError);
});
