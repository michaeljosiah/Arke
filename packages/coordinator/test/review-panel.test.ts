import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentImage } from "@arke/contracts";
import { AgentRegistry } from "../src/agent-registry.js";
import {
  buildAdjudicationPrompt,
  detectAdjudicatorCollisions,
  detectAgreement,
  parseDispositions,
  parseReviewerIssues,
  sectionHashOf,
  validateReviewers,
} from "../src/review-panel.js";

/** A minimal reviewer agent image pinning a concrete model (SPEC-016 revised — the agent IS the model). */
function reviewerImage(name: string, model: string): AgentImage {
  return {
    name,
    executor: { type: "omnigent", config: { harness: "opencode-native", model } },
    interaction: { conversational: false, mode: "subagent" },
    tools: [],
    skills: [],
    permission: { edit: "deny", bash: "deny" },
    subAgents: [],
  };
}

/** Build an {@link AgentRegistry} from a role → model map. */
function agents(byRole: Record<string, string>): AgentRegistry {
  return new AgentRegistry(Object.entries(byRole).map(([role, model]) => reviewerImage(role, model)));
}

test("validateReviewers passes when every reviewer resolves to a distinct model", () => {
  const r = agents({ "reviewer-a": "anthropic/opus", "reviewer-b": "copilot/gpt" });
  const v = validateReviewers(r, [{ role: "reviewer-a" }, { role: "reviewer-b" }]);
  assert.equal(v.ok, true);
  assert.equal(v.reviewers.length, 2);
  assert.notEqual(v.reviewers[0]!.model, v.reviewers[1]!.model);
  assert.match(v.reviewers[0]!.label, /·/); // client-safe label (harness · model)
});

test("validateReviewers rejects any same-model pair (not only all-identical)", () => {
  // reviewer-a and reviewer-c declare the same model; [A, B, A-dup] must be rejected.
  const r = agents({ "reviewer-a": "anthropic/opus", "reviewer-b": "copilot/gpt", "reviewer-c": "anthropic/opus" });
  const v = validateReviewers(r, [{ role: "reviewer-a" }, { role: "reviewer-b" }, { role: "reviewer-c" }]);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /same model/);
});

test("validateReviewers rejects when two reviewers declare the same model", () => {
  const r = agents({ "reviewer-a": "anthropic/opus", "reviewer-b": "anthropic/opus" }); // identical models
  const v = validateReviewers(r, [{ role: "reviewer-a" }, { role: "reviewer-b" }]);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /same model/);
});

test("validateReviewers requires at least two reviewers", () => {
  const r = agents({ "reviewer-a": "anthropic/opus", "reviewer-b": "copilot/gpt" });
  assert.equal(validateReviewers(r, [{ role: "reviewer-a" }]).ok, false);
});

test("validateReviewers rejects gateway/bare placeholder models (they resolve to the same harness default)", () => {
  // Freshly-scaffolded reviewers pin `gateway/reviewer-a` / `gateway/reviewer-b`: distinct strings,
  // but the adapter omits the gateway provider so BOTH run on the harness default → not independent.
  const gw = agents({ "reviewer-a": "gateway/reviewer-a", "reviewer-b": "gateway/reviewer-b" });
  const v = validateReviewers(gw, [{ role: "reviewer-a" }, { role: "reviewer-b" }]);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /non-concrete model/);
  // A bare name (no provider) is likewise non-concrete.
  const bare = agents({ "reviewer-a": "opus", "reviewer-b": "anthropic/opus" });
  assert.equal(validateReviewers(bare, [{ role: "reviewer-a" }, { role: "reviewer-b" }]).ok, false);
});

test("parseReviewerIssues reads a raw JSON array and defaults a missing section to 'general'", () => {
  const raw = '[{"section":"requirements > R1","severity":"blocking","text":"ambiguous"},{"section":"","text":"x"}]';
  const issues = parseReviewerIssues(raw);
  assert.equal(issues.length, 2); // a blank-section but non-empty-text entry is kept, not dropped
  assert.equal(issues[0]!.severity, "blocking");
  assert.equal(issues[1]!.section, "general"); // blank section anchored to "general"

  const fenced = "Here are my findings:\n```json\n[{\"section\":\"design\",\"severity\":\"nonsense\",\"text\":\"t\"}]\n```\n";
  const f = parseReviewerIssues(fenced);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.severity, "suggestion"); // unknown severity normalised
});

test("parseReviewerIssues drops entries with no actionable text", () => {
  const raw = '[{"section":"design","severity":"blocking","text":""},{"section":"design","text":"real issue"}]';
  const issues = parseReviewerIssues(raw);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.text, "real issue");
});

test("parseReviewerIssues finds the real issues array inside a prose critique full of stray brackets", () => {
  // The exact failure that yielded 0 issues on the Inner Siege review: a long prose analysis whose
  // first '[' and last ']' bracket unrelated tokens, with the true array only at the very end.
  const prose = [
    "## Review",
    "The spec marks organs 2–3 as `[STRETCH]` and references `[FR-01]`, `[FR-08]`, `[FR-10]`.",
    "See the template at [specification.template.md](docs/specifications/specification.template.md).",
    "My concrete findings follow.",
    "```json",
    "[",
    '  {"section":"Requirements > FR-08","severity":"blocking","text":"Spread telegraph timing contradicts FR-10."},',
    '  {"section":"Design > Data model","severity":"suggestion","text":"Cell-state enum omits the pre-spread state."}',
    "]",
    "```",
  ].join("\n");
  const issues = parseReviewerIssues(prose);
  assert.equal(issues.length, 2, "must recover both issues, not choke on the stray brackets");
  assert.equal(issues[0]!.severity, "blocking");
  assert.match(issues[0]!.section, /FR-08/);
});

test("parseReviewerIssues picks the issue array even when a stray string array appears first", () => {
  const text = 'Options I considered: ["wind","no-wind","gusts"].\n[{"section":"D","severity":"question","text":"why no wind?"}]';
  const issues = parseReviewerIssues(text);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.text, "why no wind?");
});

test("parseReviewerIssues returns [] on unparseable output", () => {
  assert.deepEqual(parseReviewerIssues("no json here"), []);
  assert.deepEqual(parseReviewerIssues("[not valid json"), []);
  assert.deepEqual(parseReviewerIssues("prose with [a] and [b] but no issue objects"), []);
});

test("sectionHashOf is stable and content-sensitive", () => {
  assert.equal(sectionHashOf("  same  "), sectionHashOf("same"));
  assert.notEqual(sectionHashOf("a"), sectionHashOf("b"));
});

test("detectAgreement groups a section raised by two distinct reviewers", () => {
  const h = sectionHashOf("requirements > R1");
  const groups = detectAgreement([
    { issueId: "i1", reviewerRole: "reviewer-a", section: "requirements > R1", sectionHash: h },
    { issueId: "i2", reviewerRole: "reviewer-b", section: "requirements > R1", sectionHash: h },
    { issueId: "i3", reviewerRole: "reviewer-a", section: "design", sectionHash: sectionHashOf("design") },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.issueIds.sort(), ["i1", "i2"]);
});

test("detectAgreement does NOT group a section raised twice by the same reviewer", () => {
  const h = sectionHashOf("requirements > R1");
  const groups = detectAgreement([
    { issueId: "i1", reviewerRole: "reviewer-a", section: "requirements > R1", sectionHash: h },
    { issueId: "i2", reviewerRole: "reviewer-a", section: "requirements > R1", sectionHash: h },
  ]);
  assert.equal(groups.length, 0); // same reviewer twice ≠ agreement
});

// ---- SPEC-035 author-adjudication helpers ----

test("parseDispositions reads a fenced disposition array and coerces well-formed entries", () => {
  const text = [
    "I applied the first and declined the second.",
    "```json",
    '[{"issueId":"issue-1","action":"accept","rationale":"Quantified the window."},',
    ' {"issueId":"issue-2","action":"dismiss","rationale":"FR-10 governs a different path."}]',
    "```",
  ].join("\n");
  const d = parseDispositions(text);
  assert.equal(d.length, 2);
  assert.deepEqual(d[0], { issueId: "issue-1", action: "accept", rationale: "Quantified the window." });
  assert.equal(d[1]!.action, "dismiss");
});

test("parseDispositions drops entries with no issueId or an invalid action, and tolerates a missing rationale", () => {
  const text = '[{"issueId":"","action":"accept","rationale":"x"},{"issueId":"i2","action":"maybe","rationale":"y"},{"issueId":"i3","action":"accept"}]';
  const d = parseDispositions(text);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0], { issueId: "i3", action: "accept", rationale: "" });
});

test("parseDispositions returns [] on unparseable output", () => {
  assert.deepEqual(parseDispositions("no json"), []);
  assert.deepEqual(parseDispositions("[not json"), []);
});

test("detectAdjudicatorCollisions flags a reviewer sharing the author's model, and is silent otherwise", () => {
  const reviewers = [
    { role: "reviewer-a", model: "anthropic/opus" },
    { role: "reviewer-b", model: "copilot/gpt" },
  ];
  const hit = detectAdjudicatorCollisions("anthropic/opus", reviewers);
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0], { reviewerRole: "reviewer-a", model: "anthropic/opus" });
  assert.equal(detectAdjudicatorCollisions("openai/o5", reviewers).length, 0); // distinct author → no collision
  assert.equal(detectAdjudicatorCollisions(undefined, reviewers).length, 0); // unknown author → nothing to compare
});

test("buildAdjudicationPrompt lists every issue id + the file path and demands a JSON disposition array", () => {
  const p = buildAdjudicationPrompt(
    "SPEC BODY",
    "GROUNDING",
    [{ issueId: "issue-9", reviewerRole: "reviewer-a", section: "Requirements > R1", severity: "blocking", text: "vague", agreed: true }],
    "docs/specifications/007.thing.md",
  );
  assert.match(p, /issue-9/);
  assert.match(p, /docs\/specifications\/007\.thing\.md/);
  assert.match(p, /concurred by ≥2 reviewers/);
  assert.match(p, /```json/);
  assert.match(p, /SPEC BODY/);
});
