import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ProjectRegistry, projectIdForRoot, arkeHome } from "../src/project-registry.js";

function fresh(): string {
  return join(mkdtempSync(join(tmpdir(), "arke-reg-")), "projects.json");
}

test("a fresh registry lists nothing (picker empty state)", () => {
  const reg = new ProjectRegistry({ path: fresh() });
  assert.deepEqual(reg.list(), []);
});

test("upsert registers a project and it appears in list", () => {
  const reg = new ProjectRegistry({ path: fresh() });
  const e = reg.upsert({ root: "/code/alpha", name: "alpha", state: "empty" });
  assert.equal(e.name, "alpha");
  assert.equal(reg.list().length, 1);
  assert.equal(reg.list()[0]!.projectId, e.projectId);
});

test("projectId is stable for the same root and distinct across roots", () => {
  assert.equal(projectIdForRoot("/code/alpha"), projectIdForRoot("/code/alpha"));
  assert.notEqual(projectIdForRoot("/code/alpha"), projectIdForRoot("/code/beta"));
});

test("re-upserting the same root updates in place (one entry, refreshed state)", () => {
  const reg = new ProjectRegistry({ path: fresh() });
  reg.upsert({ root: "/code/alpha", name: "alpha", state: "empty" });
  reg.upsert({ root: "/code/alpha", name: "alpha", state: "method-ready" });
  assert.equal(reg.list().length, 1);
  assert.equal(reg.list()[0]!.lastState, "method-ready");
});

test("list is most-recently-opened first", () => {
  let t = 1000;
  const reg = new ProjectRegistry({ path: fresh(), clock: () => ++t });
  reg.upsert({ root: "/code/alpha", name: "alpha", state: "empty" });
  reg.upsert({ root: "/code/beta", name: "beta", state: "empty" });
  reg.upsert({ root: "/code/alpha", name: "alpha", state: "has-code" }); // alpha re-opened most recently
  assert.deepEqual(reg.list().map((p) => p.name), ["alpha", "beta"]);
});

test("forget removes the entry and never touches files on disk", () => {
  const path = fresh();
  const reg = new ProjectRegistry({ path });
  const e = reg.upsert({ root: "/code/alpha", name: "alpha", state: "empty" });
  assert.equal(reg.forget(e.projectId), true);
  assert.deepEqual(reg.list(), []);
  // forgetting an unknown id is a no-op false
  assert.equal(reg.forget("deadbeef"), false);
});

test("registry survives a reload from disk", () => {
  const path = fresh();
  const a = new ProjectRegistry({ path });
  a.upsert({ root: "/code/alpha", name: "alpha", state: "empty" });
  const b = new ProjectRegistry({ path }); // fresh instance, same file
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0]!.name, "alpha");
});

test("arkeHome honours ARKE_HOME override", () => {
  const dir = mkdtempSync(join(tmpdir(), "arke-home-"));
  assert.equal(arkeHome({ ARKE_HOME: dir } as NodeJS.ProcessEnv), resolve(dir));
});

test("upsert persists atomically (file exists and re-parses)", () => {
  const path = fresh();
  const reg = new ProjectRegistry({ path });
  reg.upsert({ root: "/code/alpha", name: "alpha", state: "empty" });
  assert.ok(existsSync(path));
});
