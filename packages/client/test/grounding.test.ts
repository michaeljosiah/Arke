import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SUMMARY_BUDGET,
  firstMeaningfulParagraph,
  groundingDocFromFile,
  isGroundingType,
  renderGroundingDigest,
  type GroundingDigest,
} from "@arke/contracts";

test("isGroundingType matches the grounding vocabulary and rejects everything else (explicit type only)", () => {
  for (const t of ["product-overview", "business-context", "domain-glossary", "architecture", "convention"]) {
    assert.ok(isGroundingType(t), `${t} is a grounding type`);
  }
  for (const t of ["specification", "index", "decision", "", undefined, null]) {
    assert.ok(!isGroundingType(t as string), `${String(t)} is NOT a grounding type`);
  }
});

const PRODUCT_DOC = `---
type: product-overview
title: Arke — spec-first delivery
---

# Arke

Arke turns an approved specification into a reviewed, delivered change. The engineer authors, a panel
reviews, and the coordinator drives delivery.

More detail follows here.
`;

test("groundingDocFromFile selects a grounding-typed doc and extracts type/title/path/summary", () => {
  const doc = groundingDocFromFile("docs/product-overview.md", PRODUCT_DOC);
  assert.ok(doc);
  assert.equal(doc!.type, "product-overview");
  assert.equal(doc!.title, "Arke — spec-first delivery");
  assert.equal(doc!.path, "docs/product-overview.md");
  assert.match(doc!.summary, /^Arke turns an approved specification/);
  assert.ok(!doc!.summary.includes("More detail follows"), "summary is only the FIRST paragraph");
});

test("groundingDocFromFile returns null for a non-grounding type (a spec is part b, not part a)", () => {
  const spec = `---\ntype: specification\ntitle: Something\nspec_id: SPEC-x\n---\n\nbody\n`;
  assert.equal(groundingDocFromFile("docs/specifications/001.x.md", spec), null);
  const untyped = `---\ntitle: Legacy\n---\n\nbody\n`;
  assert.equal(groundingDocFromFile("docs/legacy.md", untyped), null, "no explicit type → not grounding (not swept as convention)");
});

test("groundingDocFromFile falls back to H1 then filename for the title", () => {
  const noTitle = `---\ntype: architecture\n---\n\n# The Architecture\n\nOverview text.\n`;
  assert.equal(groundingDocFromFile("docs/architecture/overview.md", noTitle)!.title, "The Architecture");
  const noTitleNoH1 = `---\ntype: convention\n---\n\nJust prose, no heading.\n`;
  assert.equal(groundingDocFromFile("docs/house-rules.md", noTitleNoH1)!.title, "house-rules");
});

test("an EMPTY frontmatter title falls through to H1 (not left blank)", () => {
  const emptyTitle = `---\ntype: architecture\ntitle:\n---\n\n# The Real Title\n\nBody.\n`;
  assert.equal(groundingDocFromFile("docs/x.md", emptyTitle)!.title, "The Real Title", "a bare `title:` must not win over the H1");
});

test("a pathologically long title is capped so one entry cannot blow the total budget", () => {
  const longTitle = "T".repeat(5000);
  const doc = groundingDocFromFile("docs/x.md", `---\ntype: product-overview\ntitle: ${longTitle}\n---\n\nBody.\n`)!;
  assert.ok(doc.title.length <= 201, "title capped near TITLE_BUDGET (200) + ellipsis");
  assert.ok(doc.title.endsWith("…"));
  // Even ranked first and under a tiny budget, the "always keep first entry" guard now stays bounded.
  const text = renderGroundingDigest({ businessGrounding: [doc], specIndex: [], sessionUploads: [] }, { totalBudget: 100 });
  assert.ok(text.length < 1000, "bounded despite an adversarial title");
});

test("summary skips headings, HTML comments, and blockquote callouts", () => {
  const body = `# Heading\n\n<!-- a comment -->\n\n> A callout note, not the summary.\n\nThe real first paragraph.\n`;
  assert.equal(firstMeaningfulParagraph(body), "The real first paragraph.");
});

test("summary is truncated to the per-document budget with an ellipsis", () => {
  const long = "word ".repeat(400).trim(); // ~1999 chars
  const doc = groundingDocFromFile("docs/x.md", `---\ntype: business-context\ntitle: X\n---\n\n${long}\n`);
  assert.ok(doc!.summary.length <= DEFAULT_SUMMARY_BUDGET, "within the default 500-char budget");
  assert.ok(doc!.summary.endsWith("…"), "an ellipsis marks the cut");
  const small = groundingDocFromFile("docs/y.md", `---\ntype: business-context\ntitle: Y\n---\n\nshort.\n`);
  assert.ok(!small!.summary.endsWith("…"), "a short summary is not truncated");
});

function digest(over: Partial<GroundingDigest> = {}): GroundingDigest {
  return { businessGrounding: [], specIndex: [], sessionUploads: [], ...over };
}

test("renderGroundingDigest renders the three labelled parts, distinctly framed", () => {
  const text = renderGroundingDigest(
    digest({
      businessGrounding: [{ type: "product-overview", title: "Overview", path: "docs/overview.md", summary: "What Arke is." }],
      specIndex: [{ number: "026", title: "Bundle indexes", status: "in-review", capabilities: ["spec-library"], path: "docs/specifications/026.x.md" }],
      sessionUploads: [{ path: ".arke/grounding/client-brief.md" }],
    }),
  );
  assert.match(text, /### Business grounding/);
  assert.match(text, /\*\*product-overview\*\* — Overview \(`docs\/overview\.md`\)/);
  assert.match(text, /What Arke is\./);
  assert.match(text, /### Existing specification corpus/);
  assert.match(text, /\*\*026\*\* Bundle indexes — in-review · spec-library \(`docs\/specifications\/026\.x\.md`\)/);
  assert.match(text, /### Session uploads/);
  assert.match(text, /- `\.arke\/grounding\/client-brief\.md`/, "the local tier is referenced by EXPLICIT path");
  // Ordering: business grounding, then spec corpus, then uploads.
  assert.ok(text.indexOf("Business grounding") < text.indexOf("specification corpus"));
  assert.ok(text.indexOf("specification corpus") < text.indexOf("Session uploads"));
});

test("renderGroundingDigest is empty when the digest is empty (caller suppresses the wrapper)", () => {
  assert.equal(renderGroundingDigest(digest()), "");
});

test("renderGroundingDigest omits only the growing parts when over the total budget, always keeping uploads reachable", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    type: "architecture",
    title: `Doc ${i}`,
    path: `docs/a${i}.md`,
    summary: "x".repeat(400),
  }));
  const text = renderGroundingDigest(digest({ businessGrounding: many, sessionUploads: [{ path: ".arke/grounding/keep.md" }] }), {
    totalBudget: 1500,
  });
  assert.match(text, /omitted to stay within the grounding budget/, "the tail is dropped with a note");
  assert.match(text, /- `\.arke\/grounding\/keep\.md`/, "uploads are rendered first, so they survive a tight budget");
  assert.ok(text.length < 3000, "the injected text stays bounded");
});
