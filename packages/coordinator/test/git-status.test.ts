import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { gitAheadBehind, gitDiffStat, gitDirtyCount, computeRepoStatus } from "../src/git-status.js";

/** SPEC-025: the read-only git status queries, exercised against a real temporary repository. */

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

/** A temp repo: main with one commit, then `spec/feature` two commits ahead with a +N/−M diff. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-gitstatus-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "spec/feature");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\n"); // +1 line
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "add four");
  writeFileSync(join(dir, "b.txt"), "new file\n"); // +1 line, new file
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "add b");
  return dir;
}

test("gitAheadBehind counts commits ahead/behind the default branch", () => {
  const dir = makeRepo();
  try {
    const r = gitAheadBehind(dir, "main", "spec/feature");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.ahead, 2); // two commits on spec/feature not on main
      assert.equal(r.behind, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitDiffStat sums added/removed lines and counts changed files vs default", () => {
  const dir = makeRepo();
  try {
    const r = gitDiffStat(dir, "main", "spec/feature");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.added, 2); // one line in a.txt + one line in b.txt
      assert.equal(r.removed, 0);
      assert.equal(r.files, 2);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitDirtyCount reflects the working tree of the checked-out branch", () => {
  const dir = makeRepo();
  try {
    assert.deepEqual(gitDirtyCount(dir), { ok: true, dirty: 0 });
    writeFileSync(join(dir, "a.txt"), "dirtied\n");
    const r = gitDirtyCount(dir);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.dirty, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitAheadBehind degrades (not throws) for a branch that does not exist", () => {
  const dir = makeRepo();
  try {
    const r = gitAheadBehind(dir, "main", "spec/nope");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeRepoStatus records the checked-out branch's dirty count and '—' for others", () => {
  const dir = makeRepo(); // HEAD is spec/feature
  try {
    // The checked-out branch gets a real dirty count...
    const feature = computeRepoStatus({ root: dir, specId: "SPEC-1", branch: "spec/feature", defaultBranch: "main", ghEnabled: false });
    assert.equal(feature.dirty, 0);
    assert.equal(feature.ahead, 2);
    // ...a different (not checked-out) branch reports dirty=null, never a fabricated 0.
    const other = computeRepoStatus({ root: dir, specId: "SPEC-2", branch: "main", defaultBranch: "main", ghEnabled: false });
    assert.equal(other.dirty, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeRepoStatus marks PR degraded (unknown) with the webhook number as fallback when gh is disabled", () => {
  const dir = makeRepo();
  try {
    const s = computeRepoStatus({ root: dir, specId: "SPEC-1", branch: "spec/feature", defaultBranch: "main", ghEnabled: false, prNumberFallback: 224 });
    // pr is present (fallback number) but status is unknown, and a degraded entry names the 'pr' field —
    // "unknown" is never collapsed into "no PR".
    assert.deepEqual(s.pr, { number: 224, status: null });
    assert.ok(s.degraded?.some((d) => d.field === "pr"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git queries degrade cleanly outside a repository (no throw)", () => {
  const dir = mkdtempSync(join(tmpdir(), "arke-nogit-"));
  try {
    assert.equal(gitAheadBehind(dir, "main", "x").ok, false);
    assert.equal(gitDiffStat(dir, "main", "x").ok, false);
    assert.equal(gitDirtyCount(dir).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
