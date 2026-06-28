import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileSessionStore, InMemorySessionStore } from "../src/index.js";

test("in-memory store records and reads back identity", () => {
  const store = new InMemorySessionStore();
  store.upsert({ sessionId: "s1", kind: "spec", specId: "SPEC-1" });
  assert.deepEqual(store.get("s1"), { sessionId: "s1", kind: "spec", specId: "SPEC-1" });
  assert.equal(store.all().length, 1);
});

test("FileSessionStore persists across instances (coordinator restart recovery)", () => {
  const dir = mkdtempSync(join(tmpdir(), "arke-graph-"));
  const path = join(dir, "sessions.ndjson");

  const first = new FileSessionStore(path);
  first.load();
  first.upsert({ sessionId: "spec1", kind: "spec", specId: "SPEC-1" });
  first.upsert({ sessionId: "task1", kind: "task", specId: "SPEC-1", parentSessionId: "spec1" });

  // A fresh instance recovers ownership from disk without re-deriving from events.
  const recovered = new FileSessionStore(path);
  recovered.load();
  assert.deepEqual(recovered.get("task1"), {
    sessionId: "task1",
    kind: "task",
    specId: "SPEC-1",
    parentSessionId: "spec1",
  });
  assert.equal(recovered.all().length, 2);
});

test("FileSessionStore folds the append log last-write-wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "arke-graph-"));
  const path = join(dir, "sessions.ndjson");
  const store = new FileSessionStore(path);
  store.load();
  store.upsert({ sessionId: "s1", kind: "spec", specId: "OLD" });
  store.upsert({ sessionId: "s1", kind: "spec", specId: "NEW" });

  const recovered = new FileSessionStore(path);
  recovered.load();
  assert.equal(recovered.get("s1")?.specId, "NEW");
  assert.equal(recovered.all().length, 1);
});
