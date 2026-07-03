import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSpecDoc } from "@arke/contracts";
import { conciseSlugFromTitle, nextSpecNumber, renderBlankSpec, setFrontmatterField, slugify } from "../src/project-context.js";

/** SPEC-020: the blank-slate generation core — slug, next-number, and the empty-section template. */

test("slugify produces a filesystem/branch-safe slug", () => {
  assert.equal(slugify("Extract fields from an RFP!"), "extract-fields-from-an-rfp");
  assert.equal(slugify("  Weird   Spaces  "), "weird-spaces");
  assert.equal(slugify("---"), "spec"); // empty result falls back
});

test("conciseSlugFromTitle takes the headline before the em-dash and caps the words", () => {
  // The real Inner Siege titles that were landing as untitled-NNN.
  assert.equal(
    conciseSlugFromTitle("Evolution research report — agent skills & tooling to grow Inner Siege (3D, adaptive score)", "untitled-002"),
    "evolution-research-report",
  );
  assert.equal(
    conciseSlugFromTitle("Inner Siege — vertical slice (bloodstream biome, core turn loop)", "untitled-001"),
    "inner-siege",
  );
  // A colon separates a multi-word headline too.
  assert.equal(conciseSlugFromTitle("Payment retries: idempotency keys", "untitled-003"), "payment-retries");
  // A single-word headline falls back to the full title, capped to a few words.
  assert.equal(conciseSlugFromTitle("Payments: retry with idempotency keys", "untitled-003b"), "payments-retry-with-idempotency-keys");
  assert.equal(
    conciseSlugFromTitle("One two three four five six seven eight nine ten", "untitled-004"),
    "one-two-three-four-five-six",
  );
  // Nothing usable → the placeholder is kept.
  assert.equal(conciseSlugFromTitle("   ", "untitled-005"), "untitled-005");
});

test("setFrontmatterField replaces scalars without corrupting the frontmatter (double application)", () => {
  const md = "---\nspec_id: SPEC-x-untitled-002\ntitle: Evolution report\nbranch: spec/untitled-002\n---\n\n# Body\ntext\n";
  // Apply TWICE (spec_id then branch) — the real rename path. The output must remain a single,
  // well-formed frontmatter block, not gain a second stray `---` fence.
  const out = setFrontmatterField(setFrontmatterField(md, "spec_id", "SPEC-x-evolution-research-report"), "branch", "spec/evolution-research-report");
  assert.equal((out.match(/^---$/gm) || []).length, 2, "exactly one frontmatter block (two fence lines)");
  const doc = parseSpecDoc(out);
  assert.equal(doc.frontmatter.spec_id, "SPEC-x-evolution-research-report");
  assert.equal(doc.frontmatter.branch, "spec/evolution-research-report");
  assert.equal(doc.frontmatter.title, "Evolution report"); // untouched
  assert.match(out, /# Body\ntext/); // body intact
  // No duplicate/stale field lines survived.
  assert.equal((out.match(/^branch:/gm) || []).length, 1, "exactly one branch line");
  assert.equal((out.match(/^spec_id:/gm) || []).length, 1, "exactly one spec_id line");
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
