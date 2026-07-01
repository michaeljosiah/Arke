import assert from "node:assert/strict";
import { test } from "node:test";
import { descriptorFor, parseEndpoint } from "../src/server.js";

/**
 * SPEC-019 quick-setup endpoint handling. The security-critical guarantee: `user:pass@` userinfo in
 * a connect endpoint is NEVER persisted (NFR-1 — the harness owns credentials), and the endpoint's
 * scheme (notably https) survives the round-trip so a TLS/reverse-proxied harness isn't reverted to http.
 */

test("parseEndpoint separates scheme, host, and userinfo", () => {
  assert.deepEqual(parseEndpoint("opencode://localhost:4096"), { scheme: "opencode", host: "localhost:4096" });
  assert.deepEqual(parseEndpoint("https://gw.example.com"), { scheme: "https", host: "gw.example.com" });
  assert.deepEqual(parseEndpoint("localhost:4096"), { host: "localhost:4096" });
  assert.deepEqual(parseEndpoint("opencode://user:secret@localhost:4096"), {
    scheme: "opencode",
    host: "localhost:4096",
    userinfo: "user:secret",
  });
});

test("descriptorFor strips userinfo — a secret is never written to the global config", () => {
  const d = descriptorFor("opencode", "opencode://user:secret@localhost:4096");
  assert.equal(d.host, "localhost:4096");
  assert.doesNotMatch(JSON.stringify(d), /secret|user:/);
  assert.equal(d.baseUrl, "http://localhost:4096");
  assert.equal(d.credentialsRef, "opencode/gateway"); // pointer only
  assert.deepEqual(d.serves, []);
});

test("descriptorFor preserves an https scheme so a TLS harness round-trips", () => {
  const d = descriptorFor("opencode", "https://gw.example.com");
  assert.equal(d.baseUrl, "https://gw.example.com");
  assert.equal(d.host, "gw.example.com");
});
