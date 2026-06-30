import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryResolver, type RegistryConfig } from "../src/registry.js";
import {
  detectAgreement,
  parseReviewerIssues,
  sectionHashOf,
  validateReviewers,
} from "../src/review-panel.js";

function registry(capableModels: string[]): RegistryResolver {
  const instances = capableModels.map((model, i) => ({
    id: `inst-${i}`,
    driver: i === 0 ? "claude-code" : "opencode",
    host: "localhost",
    cwd: ".",
    credentialsRef: `c-${i}`,
    serves: [{ tier: "capable" as const, model }],
  }));
  const roster: RegistryConfig["roster"] = {
    "reviewer-a": { tier: "capable", instance: instances[0]!.id },
    "reviewer-b": { tier: "capable", instance: instances[1]?.id ?? instances[0]!.id },
    "reviewer-c": { tier: "capable", instance: instances[2]?.id ?? instances[0]!.id },
  };
  return new RegistryResolver({ instances, roster });
}

test("validateReviewers passes when every reviewer resolves to a distinct model", () => {
  const r = registry(["anthropic/opus", "copilot/gpt"]);
  const v = validateReviewers(r, [{ role: "reviewer-a" }, { role: "reviewer-b" }]);
  assert.equal(v.ok, true);
  assert.equal(v.reviewers.length, 2);
  assert.notEqual(v.reviewers[0]!.model, v.reviewers[1]!.model);
  assert.match(v.reviewers[0]!.label, /capable — /); // client-safe label, not a vendor id
});

test("validateReviewers rejects any same-model pair (not only all-identical)", () => {
  // reviewer-a and reviewer-c both pin inst-0 → same model; [A, B, A-dup] must be rejected.
  const r = registry(["anthropic/opus", "copilot/gpt"]);
  const v = validateReviewers(r, [{ role: "reviewer-a" }, { role: "reviewer-b" }, { role: "reviewer-c", instanceId: "inst-0" }]);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /same model/);
});

test("validateReviewers rejects when the registry has too few distinct capable models", () => {
  const r = registry(["anthropic/opus"]); // only one capable model
  const v = validateReviewers(r, [{ role: "reviewer-a" }, { role: "reviewer-b", instanceId: "inst-0" }]);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /insufficient distinct capable models|same model/);
});

test("validateReviewers requires at least two reviewers", () => {
  const r = registry(["anthropic/opus", "copilot/gpt"]);
  assert.equal(validateReviewers(r, [{ role: "reviewer-a" }]).ok, false);
});

test("parseReviewerIssues reads a raw or fenced JSON array and drops malformed entries", () => {
  const raw = '[{"section":"requirements > R1","severity":"blocking","text":"ambiguous"},{"section":"","text":"x"}]';
  const issues = parseReviewerIssues(raw);
  assert.equal(issues.length, 1); // the empty-section entry is dropped
  assert.equal(issues[0]!.severity, "blocking");

  const fenced = "Here are my findings:\n```json\n[{\"section\":\"design\",\"severity\":\"nonsense\",\"text\":\"t\"}]\n```\n";
  const f = parseReviewerIssues(fenced);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.severity, "suggestion"); // unknown severity normalised
});

test("parseReviewerIssues returns [] on unparseable output", () => {
  assert.deepEqual(parseReviewerIssues("no json here"), []);
  assert.deepEqual(parseReviewerIssues("[not valid json"), []);
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
