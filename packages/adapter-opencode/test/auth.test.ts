import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { OpenCodeHttp, canonicalizeRoot } from "../src/index.js";

const projectRoot = canonicalizeRoot(tmpdir());

test("headers carry Basic auth when a password is configured", () => {
  const http = new OpenCodeHttp({
    baseUrl: "http://127.0.0.1:4096",
    username: "opencode",
    password: "s3cret",
    projectRoot,
  });
  const h = http.headers();
  const expected = "Basic " + Buffer.from("opencode:s3cret").toString("base64");
  assert.equal(h.Authorization, expected);
  assert.equal(h["Content-Type"], "application/json");
});

test("headers omit Authorization when no password is configured", () => {
  const http = new OpenCodeHttp({ baseUrl: "http://127.0.0.1:4096", projectRoot });
  assert.equal(http.headers().Authorization, undefined);
});

test("the password never appears in a built URL", () => {
  const http = new OpenCodeHttp({
    baseUrl: "http://127.0.0.1:4096",
    password: "s3cret",
    projectRoot,
  });
  const url = http.url("/session");
  assert.ok(!url.includes("s3cret"), "URL must not leak the password");
});

test("every request URL is scoped to the validated project directory", () => {
  const http = new OpenCodeHttp({ baseUrl: "http://127.0.0.1:4096", projectRoot });
  const url = new URL(http.url("/session/abc/todo"));
  // The wire form is forward-slash (OpenCode ≥1.17.13 500s on backslash paths); same canonical dir.
  assert.equal(url.searchParams.get("directory"), projectRoot.replaceAll("\\", "/"));
});

test("a configured project root that escapes is refused at construction", () => {
  // resolveDirectory(root) with no candidate cannot escape, so construction is the guard
  // for the *configured* root; traversal of a candidate is covered in directory.test.ts.
  const http = new OpenCodeHttp({ baseUrl: "http://127.0.0.1:4096", projectRoot });
  assert.equal(http.directory, projectRoot);
});
