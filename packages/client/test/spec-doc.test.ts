import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendChangeHistory,
  deltaKindOf,
  parseFrontmatter,
  parseSpecDoc,
  setFrontmatterStatus,
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
