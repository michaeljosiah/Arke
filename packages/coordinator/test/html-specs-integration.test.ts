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

/** SPEC-036: HTML specifications are discovered, created, and lifecycle-gated alongside markdown. */

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

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-html-"));
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  return dir;
}

const APPROVED_HTML = `<!--arke
---
spec_id: SPEC-HTML-APPROVED
title: Approved HTML spec
status: approved
branch: feat/x
owner: t
---
-->
<h1>Approved HTML spec</h1>
<h2>Requirements</h2>
<h3>Requirement: A thing</h3>
<p>The system SHALL do a thing.</p>
<h4>Scenario: it works</h4>
<ul><li>WHEN asked</li><li>THEN it does</li></ul>
<h2>Tasks</h2>
<ul><li>[ ] do the thing</li></ul>
`;

test("spec.create with format html writes a valid HTML spec that the library discovers", async () => {
  const dir = repo();
  const ctx = makeCtx(dir);
  after(() => ctx.stop());
  const res = (await ctx.dispatch("spec.create", { title: "My HTML feature", format: "html" })) as any;
  assert.equal(res.format, "html");
  assert.match(res.path, /\.html$/);
  const abs = resolve(dir, res.path);
  assert.ok(existsSync(abs), "the .html file was written");
  const text = readFileSync(abs, "utf8");
  assert.ok(text.startsWith("<!--arke"), "leading-comment frontmatter");
  assert.match(text, /<h2>Requirements<\/h2>/);

  const lib = (await ctx.dispatch("spec.library")) as any[];
  assert.ok(lib.some((r) => r.specId === res.specId), "the HTML spec appears in the library");
});

test("spec.create defaults to markdown and leaves the existing path byte-for-byte unchanged", async () => {
  const dir = repo();
  const ctx = makeCtx(dir);
  after(() => ctx.stop());
  const res = (await ctx.dispatch("spec.create", { title: "A markdown feature" })) as any;
  assert.equal(res.format, "markdown");
  assert.match(res.path, /\.md$/);
  const text = readFileSync(resolve(dir, res.path), "utf8");
  assert.ok(text.startsWith("---"), "markdown frontmatter is a leading YAML fence, not an HTML comment");
  assert.doesNotMatch(text, /^<!--arke/);
});

test("the numbering scan spans .html so a new spec never lands on an existing HTML number", async () => {
  // The cross-extension collision guard is defensive; the property that actually keeps stems unique is
  // that nextSpecNumber counts every extension. Seed an .html at 001 and confirm the next create skips it.
  const dir = repo();
  const specsDir = resolve(dir, "docs", "specifications");
  writeFileSync(resolve(specsDir, "001.clash.html"), "<!--arke\n---\nstatus: draft\n---\n-->\n<h1>x</h1>\n", "utf8");
  const ctx = makeCtx(dir);
  after(() => ctx.stop());
  const res = (await ctx.dispatch("spec.create", { title: "Clash" })) as any;
  assert.match(res.path, /002\.clash\.md$/, "numbering scan spans .html so the next number skips past it");
});

test("spec.deliver on an HTML spec is refused with a typed error (v1)", async () => {
  const dir = repo();
  writeFileSync(resolve(dir, "docs", "specifications", "050.approved.html"), APPROVED_HTML, "utf8");
  const ctx = makeCtx(dir);
  after(() => ctx.stop());
  const res = (await ctx.dispatch("spec.deliver", { specId: "SPEC-HTML-APPROVED" })) as any;
  assert.equal(res.ok, false);
  assert.equal(res.code, "spec.deliver-unsupported-format");
  assert.match(res.error, /HTML specification is not supported/i);
});
