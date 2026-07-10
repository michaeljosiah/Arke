import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendChangeHistory,
  deltaKindOf,
  parseFrontmatter,
  parseLinkage,
  parseSpecDoc,
  setFrontmatterStatus,
  validateWellFormed,
} from "@arke/contracts";

const DOC = `---
spec_id: SPEC-2026-06-28-authoring-cockpit
title: Authoring cockpit
status: draft
branch: feat/authoring-cockpit
owner: core-maintainers
---

# Authoring cockpit

## Why
Some motivation prose.

## Requirements

### Requirement: Split authoring surface
\`capability: authoring-cockpit\` · \`delta: ADDED (feat/authoring-cockpit)\`

The system SHALL present a split surface.

### Requirement: Settled behaviour
A long-standing requirement with no delta tag.

### Requirement: Old thing removed
\`capability: authoring-cockpit\` · \`delta: REMOVED\`

Tombstone text.

## Design
Design prose.

## Change history
- 2026-06-28 · feat/authoring-cockpit · draft — ADDED authoring-cockpit
`;

test("parseFrontmatter reads flat key/values and splits the body", () => {
  const { data, body } = parseFrontmatter(DOC);
  assert.equal(data.status, "draft");
  assert.equal(data.branch, "feat/authoring-cockpit");
  assert.equal(data.spec_id, "SPEC-2026-06-28-authoring-cockpit");
  assert.ok(body.trimStart().startsWith("# Authoring cockpit"));
});

test("parseFrontmatter strips inline comments and unquotes scalars", () => {
  const md = "---\nstatus: draft # set by tooling\nbranch: \"feat/x\"\nowner: 'dana.k'\n---\n\nbody\n";
  const { data } = parseFrontmatter(md);
  assert.equal(data.status, "draft"); // inline comment removed
  assert.equal(data.branch, "feat/x"); // double-quotes stripped
  assert.equal(data.owner, "dana.k"); // single-quotes stripped
});

test("parseFrontmatter parses CRLF frontmatter (git autocrlf checkout on Windows)", () => {
  // Regression (SPEC-024): git's autocrlf converts a spec to CRLF on checkout; the value regex's `.`
  // does not match `\r`, so every key silently failed and the whole doc parsed empty — which made
  // findSpecFile miss the file after a local merge left HEAD on the mainline.
  const crlf = DOC.replace(/\n/g, "\r\n");
  const { data } = parseFrontmatter(crlf);
  assert.equal(data.spec_id, "SPEC-2026-06-28-authoring-cockpit");
  assert.equal(data.status, "draft");
  assert.equal(data.branch, "feat/authoring-cockpit");
});

test("parseFrontmatter unquotes a scalar that also carries an inline comment", () => {
  // Regression (PR #18 final review): a quoted value followed by a comment ends with the comment, not
  // the quote, so endsWith() left it quoted and approveDraft wrongly rejected the spec.
  const md = "---\nstatus: \"draft\" # set by tooling\nbranch: 'feat/x' # comment\n---\n\nbody\n";
  const { data } = parseFrontmatter(md);
  assert.equal(data.status, "draft");
  assert.equal(data.branch, "feat/x");
});

test("parseSpecDoc extracts requirements with delta kinds", () => {
  const doc = parseSpecDoc(DOC);
  assert.equal(doc.requirements.length, 3);
  assert.equal(doc.requirements[0]!.title, "Split authoring surface");
  assert.equal(doc.requirements[0]!.deltaKind, "ADDED");
  assert.equal(doc.requirements[0]!.capability, "authoring-cockpit");
  assert.equal(doc.requirements[1]!.deltaKind, undefined); // settled, no tag
  assert.equal(doc.requirements[2]!.deltaKind, "REMOVED");
});

test("parseSpecDoc renders sections against SPEC_ANATOMY incl. an absent one", () => {
  const doc = parseSpecDoc(DOC);
  const byKey = Object.fromEntries(doc.sections.map((s) => [s.key, s]));
  assert.equal(byKey.requirements!.present, true);
  assert.equal(byKey.design!.present, true);
  assert.equal(byKey.tasks!.present, false); // no ## Tasks heading in DOC
  assert.equal(byKey.tasks!.markdown, "");
});

test("deltaKindOf parses kinds and ignores noise", () => {
  assert.equal(deltaKindOf("ADDED (feat/x)"), "ADDED");
  assert.equal(deltaKindOf("MODIFIED"), "MODIFIED");
  assert.equal(deltaKindOf("REMOVED (branch)"), "REMOVED");
  assert.equal(deltaKindOf("nonsense"), undefined);
  assert.equal(deltaKindOf(undefined), undefined);
});

test("setFrontmatterStatus rewrites only the status line", () => {
  const out = setFrontmatterStatus(DOC, "in-review");
  const { data } = parseFrontmatter(out);
  assert.equal(data.status, "in-review");
  assert.equal(data.branch, "feat/authoring-cockpit"); // untouched
  assert.ok(out.includes("# Authoring cockpit")); // body preserved
});

test("appendChangeHistory inserts under the Change history section", () => {
  const out = appendChangeHistory(DOC, "2026-06-30 · feat/authoring-cockpit · in-review — approved");
  const tail = out.slice(out.indexOf("## Change history"));
  assert.ok(tail.includes("ADDED authoring-cockpit"));
  assert.ok(tail.includes("in-review — approved"));
  assert.ok(tail.indexOf("ADDED authoring-cockpit") < tail.indexOf("in-review — approved"));
});

test("appendChangeHistory creates the section when absent", () => {
  const out = appendChangeHistory("# Spec\n\nbody only\n", "first line");
  assert.ok(out.includes("## Change history"));
  assert.ok(out.includes("- first line"));
});

// ---- SPEC-024: the well-formedness gate (new parser, beyond section presence) ----

/** A well-formed draft: Requirements section + a SHALL statement + a WHEN/THEN scenario. */
const WELL_FORMED = `---
spec_id: SPEC-WF
status: draft
branch: feat/x
---

# WF

## Requirements

### Requirement: A thing
The system SHALL do a thing.

#### Scenario: it works
- **WHEN** asked
- **THEN** it does
`;

test("validateWellFormed passes a draft with requirements, a SHALL, and a WHEN/THEN scenario", () => {
  const r = validateWellFormed(WELL_FORMED);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test("validateWellFormed flags a missing WHEN/THEN scenario", () => {
  const noScenario = WELL_FORMED.replace(/#### Scenario:[\s\S]*$/, "");
  const r = validateWellFormed(noScenario);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("scenarios"));
});

test("validateWellFormed flags a scenario missing its THEN (a WHEN alone is not enough)", () => {
  const whenOnly = WELL_FORMED.replace(/- \*\*THEN\*\* it does\n/, "");
  const r = validateWellFormed(whenOnly);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("scenarios"));
});

test("validateWellFormed flags missing normative statements (no SHALL/MUST)", () => {
  const noNormative = WELL_FORMED.replace("The system SHALL do a thing.", "The system does a thing.");
  const r = validateWellFormed(noNormative);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("normative statements"));
});

test("validateWellFormed flags a missing requirements section", () => {
  const noReq = `---\nstatus: draft\n---\n\n# X\n\n## Design\nprose only\n`;
  const r = validateWellFormed(noReq);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("requirements section"));
});

test("validateWellFormed accepts MUST as a normative statement too", () => {
  const withMust = WELL_FORMED.replace("The system SHALL do a thing.", "The system MUST do a thing.");
  assert.equal(validateWellFormed(withMust).ok, true);
});

// ---- SPEC-030 cross-repo linkage (parseLinkage) ----

const CANONICAL_DOC = `---
spec_id: SPEC-100
title: Contract change
status: draft
branch: feat/x
owner: t
ripples:
  - repo: acme/widgets
    spec: SPEC-2026-01-01-widget-side
    kind: delta
  - repo: acme/gizmos
    spec: generated
    kind: pointer
---

# Contract change
`;

const RIPPLE_DOC = `---
spec_id: SPEC-2026-01-01-widget-side
title: Widget side
status: draft
branch: feat/y
owner: t
canonical:
  repo: acme/contracts
  spec: SPEC-100
---

# Widget side
`;

test("parseLinkage reads a canonical spec's nested ripples list", () => {
  const l = parseLinkage(CANONICAL_DOC);
  assert.equal(l.warnings.length, 0);
  assert.equal(l.canonical, undefined);
  assert.deepEqual(l.ripples, [
    { repo: "acme/widgets", spec: "SPEC-2026-01-01-widget-side", kind: "delta" },
    { repo: "acme/gizmos", spec: "generated", kind: "pointer" },
  ]);
});

test("parseLinkage reads a ripple spec's canonical back-reference", () => {
  const l = parseLinkage(RIPPLE_DOC);
  assert.deepEqual(l.canonical, { repo: "acme/contracts", spec: "SPEC-100" });
  assert.deepEqual(l.ripples, []);
  assert.equal(l.warnings.length, 0);
});

test("parseLinkage warns (never throws) on a malformed ripple and drops only that entry", () => {
  const bad = CANONICAL_DOC.replace("    kind: pointer", "    kind: mirror"); // unknown kind
  const l = parseLinkage(bad);
  assert.equal(l.ripples.length, 1); // the good delta ripple survives
  assert.equal(l.ripples[0]!.repo, "acme/widgets");
  assert.match(l.warnings.join(" "), /unknown kind 'mirror'/);
});

test("parseLinkage warns on a ripple missing a required field", () => {
  const missing = `---
ripples:
  - repo: acme/widgets
    kind: delta
---
# x
`;
  const l = parseLinkage(missing);
  assert.equal(l.ripples.length, 0);
  assert.match(l.warnings.join(" "), /missing repo\/spec\/kind/);
});

test("parseLinkage on a plain spec yields empty linkage and no warnings", () => {
  const l = parseLinkage(DOC);
  assert.deepEqual(l.ripples, []);
  assert.equal(l.canonical, undefined);
  assert.equal(l.warnings.length, 0);
});

test("parseLinkage tolerates CRLF frontmatter (Windows autocrlf checkout)", () => {
  const l = parseLinkage(CANONICAL_DOC.replace(/\n/g, "\r\n"));
  assert.equal(l.ripples.length, 2);
  assert.equal(l.warnings.length, 0);
});
