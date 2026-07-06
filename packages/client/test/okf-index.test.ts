import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bundleEntryFromFile,
  isBundleDoc,
  isSpecFile,
  parseFlowSequence,
  renderBundleIndex,
  renderSpecIndex,
  specEntryFromFile,
  type SpecIndexEntry,
} from "@arke/contracts";

// SPEC-026: pure generation of a bundle's index.md. These cover the determinism/idempotence/unparsed/
// exclusion scenarios the spec makes normative.

const SPEC = (id: string, title: string, status: string, caps = "[grounding]", updated = "2026-07-06") =>
  `---\nspec_id: ${id}\ntitle: ${title}\nstatus: ${status}\ncapabilities: ${caps}\nupdated: ${updated}\n---\n\n# ${title}\n`;

test("parseFlowSequence splits arrays, tolerates a bare scalar, throws on an unclosed bracket", () => {
  assert.deepEqual(parseFlowSequence("[grounding, spec-library]"), ["grounding", "spec-library"]);
  assert.deepEqual(parseFlowSequence("[a]"), ["a"]);
  assert.deepEqual(parseFlowSequence(""), []);
  assert.deepEqual(parseFlowSequence("grounding"), ["grounding"]); // bare scalar → one-element list
  assert.deepEqual(parseFlowSequence("['a', \"b\"]"), ["a", "b"]); // quotes stripped
  assert.throws(() => parseFlowSequence("[a, b"), /malformed array/);
});

test("specEntryFromFile parses a well-formed spec and derives its NNN", () => {
  const e = specEntryFromFile("026.okf-bundle-indexes.md", SPEC("SPEC-X", "Bundle indexes", "draft", "[spec-library]"));
  assert.equal(e.parseState, "ok");
  if (e.parseState !== "ok") return;
  assert.equal(e.number, "026");
  assert.equal(e.title, "Bundle indexes");
  assert.equal(e.status, "draft");
  assert.deepEqual(e.capabilities, ["spec-library"]);
});

test("specEntryFromFile tolerates the camelCase specId convention (SPEC-001 style)", () => {
  const e = specEntryFromFile("001.foundation.md", `---\nspecId: SPEC-001\nslug: foundation\ntitle: Foundation\nstatus: draft\n---\n\n# Foundation\n`);
  assert.equal(e.parseState, "ok");
  if (e.parseState === "ok") assert.equal(e.specId, "SPEC-001");
});

test("specEntryFromFile flags missing spec_id/title, a malformed array, and unterminated frontmatter", () => {
  const noId = specEntryFromFile("027.x.md", `---\ntitle: T\nstatus: draft\n---\n\n# T\n`);
  assert.equal(noId.parseState, "unparsed");
  if (noId.parseState === "unparsed") assert.match(noId.error, /spec_id/);

  const badArr = specEntryFromFile("028.y.md", `---\nspec_id: S\ntitle: T\nstatus: draft\ncapabilities: [a, b\n---\n\n# T\n`);
  assert.equal(badArr.parseState, "unparsed");
  if (badArr.parseState === "unparsed") assert.match(badArr.error, /malformed array/);

  const unterminated = specEntryFromFile("029.z.md", `---\nspec_id: S\ntitle: T\nno closing fence\n`);
  assert.equal(unterminated.parseState, "unparsed"); // parseFrontmatter returns {} → missing fields
});

test("renderSpecIndex orders by NNN, links titles, and appends unparsed rows last", () => {
  const entries: SpecIndexEntry[] = [
    specEntryFromFile("027.grounding.md", SPEC("SPEC-27", "Grounding", "draft", "[grounding]")),
    specEntryFromFile("026.indexes.md", SPEC("SPEC-26", "Indexes", "in-review", "[spec-library]")),
    specEntryFromFile("099.bad.md", `---\ntitle: only title\n---\n`), // unparsed (no spec_id)
  ];
  const md = renderSpecIndex(entries);
  assert.ok(md.startsWith("---\ntype: index\ngenerated: true\n"));
  assert.ok(md.includes("do not edit by hand"));
  // 026 sorts before 027; unparsed row is last and flagged.
  assert.ok(md.indexOf("[Indexes](026.indexes.md)") < md.indexOf("[Grounding](027.grounding.md)"));
  assert.ok(md.indexOf("⚠") > md.indexOf("[Grounding]"));
  assert.ok(md.includes("| in-review |") && md.includes("spec-library"));
});

test("renderSpecIndex is idempotent and content-derived (no wall-clock date; stable across calls)", () => {
  const entries = [
    specEntryFromFile("026.a.md", SPEC("A", "Alpha", "draft", "[x]", "2026-06-01")),
    specEntryFromFile("027.b.md", SPEC("B", "Bravo", "draft", "[y]", "2026-07-06")),
  ];
  const first = renderSpecIndex(entries);
  const second = renderSpecIndex(entries);
  assert.equal(first, second, "same inputs → byte-identical output");
  assert.ok(first.includes("updated: 2026-07-06"), "index date is the max spec updated, not now()");
  assert.ok(!/\d{2}:\d{2}/.test(first), "no wall-clock time component leaks in");
});

test("renderSpecIndex uses LF only (Windows autocrlf-safe)", () => {
  const md = renderSpecIndex([specEntryFromFile("026.a.md", SPEC("A", "Alpha", "draft"))]);
  assert.ok(!md.includes("\r"), "no CR in generated output");
});

test("isSpecFile selects NNN specs and excludes template/README/index", () => {
  assert.equal(isSpecFile("026.okf-bundle-indexes.md"), true);
  assert.equal(isSpecFile("specification.template.md"), false);
  assert.equal(isSpecFile("README.md"), false);
  assert.equal(isSpecFile("index.md"), false);
  assert.equal(isSpecFile("notes.md"), false); // no NNN prefix
});

test("bundleEntryFromFile derives type/title/description; renderBundleIndex sorts by title", () => {
  const dec1 = bundleEntryFromFile("0002-omnigent.md", `---\ntype: decision\ntitle: Omnigent substrate\ndescription: Evaluate Omnigent.\n---\n\nbody\n`);
  const dec2 = bundleEntryFromFile("0001-adr.md", `---\ntype: decision\ntitle: ADR process\n---\n\nFirst paragraph becomes the description.\n`);
  assert.equal(dec2.parseState, "ok");
  if (dec2.parseState === "ok") assert.equal(dec2.description, "First paragraph becomes the description.");
  const md = renderBundleIndex("decisions", [dec1, dec2]);
  assert.ok(md.startsWith("---\ntype: index\ngenerated: true\n"));
  assert.ok(md.includes("# Decisions"));
  // "ADR process" sorts before "Omnigent substrate".
  assert.ok(md.indexOf("ADR process") < md.indexOf("Omnigent substrate"));
});

test("bundleEntryFromFile derives type when absent (no spec_id → convention)", () => {
  const e = bundleEntryFromFile("glossary.md", `---\ntitle: Glossary\n---\n\nTerms.\n`);
  assert.equal(e.parseState, "ok");
  if (e.parseState === "ok") assert.equal(e.type, "convention");
});

test("table cells escape pipes so a title with | cannot break the row", () => {
  const e = specEntryFromFile("026.a.md", SPEC("A", "Alpha | Beta", "draft"));
  const md = renderSpecIndex([e]);
  assert.ok(md.includes("Alpha \\| Beta"), "pipe in title is escaped");
});

test("isBundleDoc excludes index/README/templates but includes ordinary docs", () => {
  assert.equal(isBundleDoc("0001-adr.md"), true);
  assert.equal(isBundleDoc("index.md"), false);
  assert.equal(isBundleDoc("README.md"), false);
  assert.equal(isBundleDoc("thing.template.md"), false);
  assert.equal(isBundleDoc("logo.png"), false);
});
