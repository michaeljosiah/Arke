import assert from "node:assert/strict";
import { test } from "node:test";
import type { DomainEvent } from "@arke/contracts";
import { ReadModel } from "../src/read-model.js";

/** SPEC-025: the read model folds repo.identity/repo.status and exposes them for the snapshot. */

const env = { seq: 0, ts: 0, harness: "OpenCode" };

test("repo.identity folds into the snapshot; repo.status is keyed one row per spec", () => {
  const rm = new ReadModel();
  rm.apply({ ...env, type: "repo.identity", name: "acme/pay", remote: "git@x", default: "main", head: "abc1234" } as DomainEvent);
  rm.apply({ ...env, type: "repo.status", specId: "SPEC-1", branch: "spec/one", ahead: 2, behind: 0, dirty: 1, added: 10, removed: 2, files: 3, pr: null } as DomainEvent);
  rm.apply({ ...env, type: "repo.status", specId: "SPEC-2", branch: "spec/two", ahead: null, behind: null, dirty: null, added: null, removed: null, files: null, pr: null, degraded: [{ field: "ahead", reason: "no upstream" }] } as DomainEvent);

  const snap = rm.repoSnapshot();
  assert.deepEqual(snap.repoIdentity, { name: "acme/pay", remote: "git@x", default: "main", head: "abc1234" });
  assert.equal(snap.gitBranches.length, 2);
  const one = snap.gitBranches.find((b) => b.specId === "SPEC-1")!;
  assert.equal(one.ahead, 2);
  assert.equal(one.dirty, 1);
  const two = snap.gitBranches.find((b) => b.specId === "SPEC-2")!;
  assert.equal(two.ahead, null); // degraded field stays null, never a fabricated 0
  assert.equal(two.degraded?.[0]?.field, "ahead");
});

test("a later repo.status for the same spec replaces the row, not appends", () => {
  const rm = new ReadModel();
  rm.apply({ ...env, type: "repo.status", specId: "SPEC-1", branch: "spec/one", ahead: 1, behind: 0, dirty: null, added: null, removed: null, files: null, pr: null } as DomainEvent);
  rm.apply({ ...env, type: "repo.status", specId: "SPEC-1", branch: "spec/one", ahead: 5, behind: 0, dirty: 0, added: 3, removed: 1, files: 1, pr: { number: 7, status: "open" } } as DomainEvent);
  const snap = rm.repoSnapshot();
  assert.equal(snap.gitBranches.length, 1);
  assert.equal(snap.gitBranches[0]!.ahead, 5);
  assert.deepEqual(snap.gitBranches[0]!.pr, { number: 7, status: "open" });
});

test("specForSession resolves a session's owning spec (for the repo-status recompute trigger)", () => {
  const rm = new ReadModel();
  rm.apply({ ...env, type: "session.status", sessionId: "ses_a", specId: "SPEC-9", kind: "task", status: "running" } as DomainEvent);
  assert.equal(rm.specForSession("ses_a"), "SPEC-9");
  assert.equal(rm.specForSession("ses_unknown"), undefined);
});
