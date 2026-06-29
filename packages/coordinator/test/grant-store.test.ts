import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GrantStore } from "../src/grant-store.js";

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), "arke-grants-")), "grants.ndjson");
}

test("a remembered grant matches a later request with the same session + action class", () => {
  const store = new GrantStore(storePath());
  store.load();
  store.remember({ sessionId: "T-5", actionClass: "Write migration file", createdBy: "human" });
  const match = store.findMatch("T-5", "Write migration file");
  assert.ok(match);
  assert.equal(match!.actionClass, "Write migration file");
});

test("a grant does not match a different action class or session", () => {
  const store = new GrantStore(storePath());
  store.load();
  store.remember({ sessionId: "T-5", actionClass: "Write migration file", createdBy: "human" });
  assert.equal(store.findMatch("T-5", "Open pull request"), undefined);
  assert.equal(store.findMatch("T-9", "Write migration file"), undefined);
});

test("a wildcard (no session) grant matches any session for that action class", () => {
  const store = new GrantStore(storePath());
  store.load();
  store.remember({ actionClass: "Read file", createdBy: "human" });
  assert.ok(store.findMatch("anything", "Read file"));
});

test("grants survive a restart (durable load)", () => {
  const path = storePath();
  const first = new GrantStore(path);
  first.load();
  first.remember({ sessionId: "T-5", actionClass: "Write migration file", createdBy: "human" });

  const restarted = new GrantStore(path);
  restarted.load();
  assert.ok(restarted.findMatch("T-5", "Write migration file"));
});

test("revoking a grant makes the next matching request prompt again", () => {
  const path = storePath();
  const store = new GrantStore(path);
  store.load();
  const grant = store.remember({ sessionId: "T-5", actionClass: "Write migration file", createdBy: "human" });
  store.revoke(grant.id);
  assert.equal(store.findMatch("T-5", "Write migration file"), undefined);

  // the revocation is durable too
  const restarted = new GrantStore(path);
  restarted.load();
  assert.equal(restarted.findMatch("T-5", "Write migration file"), undefined);
});
