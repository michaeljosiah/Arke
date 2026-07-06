import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { ProjectContext } from "../src/project-context.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

// SPEC-026 (coordinator wiring): the project-open sweep generates every docs/ bundle's index; the spec
// lifecycle fast-path (createSpec) refreshes docs/specifications/index.md synchronously. The pure
// generators themselves are covered in packages/client/test/okf-index.test.ts.

const SPEC = (id: string, title: string, status = "draft", caps = "[x]") =>
  `---\nspec_id: ${id}\ntitle: ${title}\nstatus: ${status}\ncapabilities: ${caps}\nupdated: 2026-07-06\n---\n\n# ${title}\n`;

function makeCtx(dir: string): ProjectContext {
  return new ProjectContext({
    projectId: "test",
    root: dir,
    adapter: new MockAdapter(),
    trace: new Trace(join(dir, ".arke", "trace.ndjson")),
    grants: new GrantStore(join(dir, ".arke", "grants.ndjson")),
    endpoints: [],
    registry: new ProjectRegistry({ persist: false }),
    publish: () => {},
  });
}

function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-okf-int-"));
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  mkdirSync(resolve(dir, "docs", "decisions"), { recursive: true });
  writeFileSync(resolve(dir, "docs", "specifications", "001.alpha.md"), SPEC("SPEC-1", "Alpha", "draft", "[spec-library]"), "utf8");
  writeFileSync(resolve(dir, "docs", "decisions", "0001-adr.md"), `---\ntype: decision\ntitle: Adopt OKF\ndescription: We adopt the Open Knowledge Format.\n---\n\nbody\n`, "utf8");
  return dir;
}

test("the project-open sweep generates an index for every docs/ bundle (specs + decisions)", async () => {
  const dir = seedRepo();
  const ctx = makeCtx(dir);
  after(() => ctx.stop());
  await ctx.start();

  const specsIndex = resolve(dir, "docs", "specifications", "index.md");
  const decisionsIndex = resolve(dir, "docs", "decisions", "index.md");
  assert.ok(existsSync(specsIndex), "specs bundle index generated");
  assert.ok(existsSync(decisionsIndex), "decisions bundle index generated");

  const specs = readFileSync(specsIndex, "utf8");
  assert.ok(specs.startsWith("---\ntype: index\ngenerated: true\n"), "generated frontmatter");
  assert.ok(specs.includes("do not edit by hand"), "do-not-edit banner");
  assert.ok(specs.includes("[Alpha](001.alpha.md)"), "spec listed with a link");
  assert.ok(!specs.includes("\r"), "LF-only");

  const decisions = readFileSync(decisionsIndex, "utf8");
  assert.ok(decisions.includes("# Decisions"));
  assert.ok(decisions.includes("Adopt OKF") && decisions.includes("We adopt the Open Knowledge Format."));
});

test("createSpec refreshes docs/specifications/index.md synchronously (the lifecycle fast-path)", async () => {
  const dir = seedRepo();
  const ctx = makeCtx(dir);
  after(() => ctx.stop());
  await ctx.start();

  const before = readFileSync(resolve(dir, "docs", "specifications", "index.md"), "utf8");
  assert.ok(!before.toLowerCase().includes("bravo"));

  const created = await ctx.createSpec("Bravo feature");
  // The index reflects the new spec immediately, without an agent turn or waiting on the watcher.
  const after2 = readFileSync(resolve(dir, "docs", "specifications", "index.md"), "utf8");
  assert.ok(after2.includes(created.specId) || /bravo/i.test(after2), "new spec appears in the index");
  // And the created file is OKF-well-formed by construction.
  assert.ok(readFileSync(resolve(dir, created.path), "utf8").includes("type: specification"));
});

test("a bundle with no documents gets no index; regeneration is idempotent", async () => {
  const dir = seedRepo();
  mkdirSync(resolve(dir, "docs", "assets"), { recursive: true }); // no .md → not a bundle
  const ctx = makeCtx(dir);
  after(() => ctx.stop());
  await ctx.start();

  assert.ok(!existsSync(resolve(dir, "docs", "assets", "index.md")), "empty folder gets no index");
  // Re-running the sweep (via a second start on a fresh context) yields byte-identical index files.
  const first = readFileSync(resolve(dir, "docs", "specifications", "index.md"), "utf8");
  const ctx2 = makeCtx(dir);
  after(() => ctx2.stop());
  await ctx2.start();
  const second = readFileSync(resolve(dir, "docs", "specifications", "index.md"), "utf8");
  assert.equal(first, second, "idempotent across regenerations — no spurious diff");
});
