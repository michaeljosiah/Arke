import assert from "node:assert/strict";
import { test } from "node:test";
import { idempotencyKey, probeIntegrations, matchesBlockedDomain, isSpecPath, policyDecision, DEFAULT_BLOCKED_DOMAINS } from "../src/projection.js";

test("idempotencyKey is stable for identical content and differs on change", () => {
  const a = idempotencyKey("SPEC-1", "art-0", "hello");
  assert.equal(a, idempotencyKey("SPEC-1", "art-0", "hello"), "same input → same key");
  assert.notEqual(a, idempotencyKey("SPEC-1", "art-0", "hello!"), "content change → new key");
  assert.notEqual(a, idempotencyKey("SPEC-1", "art-1", "hello"), "artifact change → new key");
});

test("probeIntegrations reports connected/not-configured from env, never a credential", () => {
  const recs = probeIntegrations({ GITHUB_TOKEN: "ghp_secret" }, 1000);
  const gh = recs.find((r) => r.id === "github")!;
  assert.equal(gh.status, "connected");
  assert.equal(gh.lastCheckedAt, 1000);
  assert.deepEqual(gh.enables, ["issue projection"]);
  assert.equal(recs.find((r) => r.id === "jira")!.status, "not-configured");
  // No credential leaks into the record.
  assert.equal(JSON.stringify(recs).includes("ghp_secret"), false);
});

test("matchesBlockedDomain handles exact + wildcard + URL forms", () => {
  assert.equal(matchesBlockedDomain("api.github.com"), true);
  assert.equal(matchesBlockedDomain("https://api.github.com/repos/x"), true);
  assert.equal(matchesBlockedDomain("acme.atlassian.net"), true, "*.atlassian.net wildcard");
  assert.equal(matchesBlockedDomain("atlassian.net"), true, "bare suffix matches wildcard base");
  assert.equal(matchesBlockedDomain("example.com"), false);
  assert.equal(matchesBlockedDomain("notgithub.com"), false);
});

test("isSpecPath detects docs/specifications writes (any separator)", () => {
  assert.equal(isSpecPath("docs/specifications/foo.md"), true);
  assert.equal(isSpecPath("a/b/docs/specifications/x.md"), true);
  assert.equal(isSpecPath("docs\\specifications\\x.md"), true);
  assert.equal(isSpecPath("src/foo.ts"), false);
});

test("policyDecision blocks spec writes from non-authoring + unknown-kind sessions, allows authoring", () => {
  assert.equal(policyDecision({ sessionKind: "spec", path: "docs/specifications/x.md" }), null, "authoring allowed");
  assert.match(policyDecision({ sessionKind: "projection", path: "docs/specifications/x.md" })!, /may not write the spec/);
  assert.match(policyDecision({ sessionKind: undefined, path: "docs/specifications/x.md" })!, /kind unknown|refused/i);
  assert.equal(policyDecision({ sessionKind: "task", path: "src/foo.ts" }), null, "non-spec path allowed");
});

test("policyDecision blocks direct calls to integration domains regardless of session", () => {
  assert.match(policyDecision({ sessionKind: "task", domainTarget: "https://api.github.com/x" })!, /integration domain/);
  assert.equal(policyDecision({ sessionKind: "task", domainTarget: "https://example.com" }), null);
});

test("DEFAULT_BLOCKED_DOMAINS covers the three integrations", () => {
  assert.ok(DEFAULT_BLOCKED_DOMAINS.includes("api.github.com"));
  assert.ok(DEFAULT_BLOCKED_DOMAINS.some((d) => d.includes("atlassian")));
  assert.ok(DEFAULT_BLOCKED_DOMAINS.some((d) => d.includes("azure")));
});
