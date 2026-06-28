import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CoordinatorSessionStore } from "../src/session-store.js";

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), "arke-store-")), "sessions.ndjson");
}

test("upsert enriches the adapter record with harness + createdAt", () => {
  const store = new CoordinatorSessionStore(storePath(), "OpenCode");
  store.load();
  store.upsert({ sessionId: "s1", kind: "spec", specId: "SPEC-1" });
  const rec = store.get("s1")!;
  assert.equal(rec.harness, "OpenCode");
  assert.equal(typeof rec.createdAt, "number");
  assert.equal(rec.specId, "SPEC-1");
});

test("ownership survives a coordinator restart (loadAll restores the map)", () => {
  const path = storePath();
  const first = new CoordinatorSessionStore(path, "OpenCode");
  first.load();
  first.upsert({ sessionId: "spec1", kind: "spec", specId: "SPEC-1" });
  first.upsert({ sessionId: "task1", kind: "task", specId: "SPEC-1", parentSessionId: "spec1" });

  const restarted = new CoordinatorSessionStore(path, "OpenCode");
  restarted.load();
  assert.equal(restarted.loadAll().length, 2);
  const task = restarted.get("task1")!;
  assert.equal(task.kind, "task");
  assert.equal(task.parentSessionId, "spec1");
  assert.equal(task.specId, "SPEC-1");
});

test("createdAt is preserved across updates (creation time, not last-write)", () => {
  const path = storePath();
  const store = new CoordinatorSessionStore(path, "OpenCode");
  store.load();
  store.upsert({ sessionId: "s1", kind: "spec", specId: "OLD" });
  const created = store.get("s1")!.createdAt;
  store.upsert({ sessionId: "s1", kind: "spec", specId: "NEW" });
  const after = store.get("s1")!;
  assert.equal(after.specId, "NEW");
  assert.equal(after.createdAt, created);
});

test("loading a store that was never written yields an empty map, not an error", () => {
  const store = new CoordinatorSessionStore(storePath(), "OpenCode");
  store.load();
  assert.equal(store.loadAll().length, 0);
});
