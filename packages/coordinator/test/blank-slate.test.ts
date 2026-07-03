import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSpecDoc } from "@arke/contracts";
import { nextSpecNumber, renderBlankSpec, slugify } from "../src/project-context.js";

/** SPEC-020: the blank-slate generation core — slug, next-number, and the empty-section template. */

test("slugify produces a filesystem/branch-safe slug", () => {
  assert.equal(slugify("Extract fields from an RFP!"), "extract-fields-from-an-rfp");
  assert.equal(slugify("  Weird   Spaces  "), "weird-spaces");
  assert.equal(slugify("---"), "spec"); // empty result falls back
});

test("nextSpecNumber is one above the highest NNN. file", () => {
  const dir = mkdtempSync(join(tmpdir(), "arke-specs-"));
  assert.equal(nextSpecNumber(dir), 1); // empty dir → 1
  writeFileSync(join(dir, "001.foo.md"), "");
  writeFileSync(join(dir, "019.bar.md"), "");
  writeFileSync(join(dir, "specification.template.md"), ""); // non-numbered, ignored
  writeFileSync(join(dir, "README.md"), "");
  assert.equal(nextSpecNumber(dir), 20);
});

test("renderBlankSpec seeds frontmatter and leaves the sections empty", () => {
  const md = renderBlankSpec({ specId: "SPEC-2026-07-01-x", title: "My Feature", branch: "spec/my-feature", date: "2026-07-01" });
  const doc = parseSpecDoc(md);
  assert.equal(doc.frontmatter.spec_id, "SPEC-2026-07-01-x");
  assert.equal(doc.frontmatter.status, "draft");
  assert.equal(doc.frontmatter.branch, "spec/my-feature");
  // No requirements authored yet.
  assert.equal(doc.requirements.length, 0);
  // The anatomy sections (Requirements / Design / Tasks) are PRESENT (headings) but empty-bodied,
  // so the SPEC-006 preview renders them as placeholders rather than hiding them.
  const req = doc.sections.find((s) => s.key === "requirements");
  assert.ok(req?.present, "Requirements heading present");
  assert.equal((req?.markdown ?? "").trim(), "");
});

test("renderBlankSpec includes the Why / Design / Tasks headings", () => {
  const md = renderBlankSpec({ specId: "SPEC-x", title: "T", branch: "spec/t", date: "2026-07-01" });
  for (const h of ["## Why", "## What changes", "## Requirements", "## Design", "## Tasks", "## Change history"]) {
    assert.ok(md.includes(h), `blank spec should contain '${h}'`);
  }
});
