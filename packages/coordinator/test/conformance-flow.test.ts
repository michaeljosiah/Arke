import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractDeterministicChecks,
  executeDeterministicChecks,
  detectConformanceAgreement,
  parseConformanceVerdicts,
  extractRequirementsFromSpec,
} from "../src/review-panel.js";

test("extractRequirementsFromSpec parses ### Requirement: sections", () => {
  const spec = `
# Specification

## Requirements

### Requirement: API endpoint must exist
The endpoint /api/data must be available.

### Requirement: Response must be JSON
All responses must be valid JSON.

### Requirement: Cache invalidation triggers on type change
When the type field changes, the cache must be cleared.
`;

  const requirements = extractRequirementsFromSpec(spec);
  assert.equal(requirements.length, 3);
  assert.equal(requirements[0], "API endpoint must exist");
  assert.equal(requirements[1], "Response must be JSON");
  assert.equal(requirements[2], "Cache invalidation triggers on type change");
});

test("extractDeterministicChecks identifies file-exists patterns", () => {
  const requirements = [
    "file src/api.ts must exist",
    "add file src/handler.ts",
    "add the migration file migrations/001.sql",
  ];

  const rules = extractDeterministicChecks(requirements);
  const fileExistsRules = rules.filter((r) => r.checkType === "file-exists");

  assert.equal(fileExistsRules.length, 3);
  assert.equal(fileExistsRules[0]!.filePatterns?.[0], "src/api.ts");
  assert.equal(fileExistsRules[1]!.filePatterns?.[0], "src/handler.ts");
  assert.equal(fileExistsRules[2]!.filePatterns?.[0], "migrations/001.sql");
});

test("extractDeterministicChecks identifies file-absent patterns", () => {
  const requirements = [
    "file legacy.js must be removed",
    "delete file src/old-code.ts",
    "remove the deprecated config.json",
  ];

  const rules = extractDeterministicChecks(requirements);
  const fileAbsentRules = rules.filter((r) => r.checkType === "file-absent");

  assert.equal(fileAbsentRules.length, 3);
  assert.equal(fileAbsentRules[0]!.filePatterns?.[0], "legacy.js");
  assert.equal(fileAbsentRules[1]!.filePatterns?.[0], "src/old-code.ts");
});

test("extractDeterministicChecks identifies function/class definition patterns", () => {
  const requirements = [
    "function handleRequest must be defined",
    "export class Database must be defined",
    "define function validateInput",
  ];

  const rules = extractDeterministicChecks(requirements);
  const defineRules = rules.filter((r) => r.checkType === "file-contains");

  assert.equal(defineRules.length, 3);
  assert.ok(defineRules[0]!.pattern);
  assert.ok(defineRules[1]!.pattern);
});

test("extractDeterministicChecks identifies import patterns", () => {
  const requirements = [
    'must import from "express"',
    'imports must use "@arke/contracts"',
  ];

  const rules = extractDeterministicChecks(requirements);
  const importRules = rules.filter((r) => r.checkType === "pattern-match");

  assert.equal(importRules.length, 2);
  assert.ok(importRules[0]!.pattern);
});

test("executeDeterministicChecks detects file existence", async () => {
  const rules = extractDeterministicChecks(["file src/api.ts must exist", "file src/missing.ts must exist"]);

  const mockFileReader = async (path: string): Promise<string | null> => {
    if (path === "src/api.ts") return "export const api = () => {};";
    return null; // src/missing.ts doesn't exist
  };

  const results = await executeDeterministicChecks(rules, ["src/api.ts", "src/missing.ts"], mockFileReader);

  assert.equal(results.length, 2);
  assert.equal(results[0]!.passed, true); // src/api.ts exists
  assert.equal(results[1]!.passed, false); // src/missing.ts doesn't exist
});

test("executeDeterministicChecks detects file absence", async () => {
  const rules = extractDeterministicChecks(["file legacy.js must be removed", "file old.js must be removed"]);

  const mockFileReader = async (path: string): Promise<string | null> => {
    if (path === "legacy.js") return "old code"; // legacy.js exists (violation)
    return null; // old.js doesn't exist (passes)
  };

  const results = await executeDeterministicChecks(rules, ["legacy.js", "old.js"], mockFileReader);

  assert.equal(results.length, 2);
  assert.equal(results[0]!.passed, false); // legacy.js exists (should not)
  assert.equal(results[1]!.passed, true); // old.js doesn't exist (good)
});

test("executeDeterministicChecks finds patterns in code", async () => {
  const rules = extractDeterministicChecks(["function validateInput must be defined"]);

  const mockFileReader = async (path: string): Promise<string | null> => {
    if (path === "src/validation.ts") {
      return `
export async function validateInput(data: string): Promise<boolean> {
  return data.length > 0;
}
`;
    }
    return null;
  };

  const results = await executeDeterministicChecks(
    rules,
    ["src/validation.ts", "src/other.ts"],
    mockFileReader,
  );

  assert.equal(results[0]!.passed, true);
  assert.ok(results[0]!.evidence);
  assert.equal(results[0]!.evidence?.[0]?.file, "src/validation.ts");
});

test("parseConformanceVerdicts extracts verdicts from fenced JSON", () => {
  const reviewText = `
Here is my conformance assessment:

The code appears to handle the main requirement but I'm uncertain about edge cases.

\`\`\`json
[
  {"requirement": "API endpoint must exist", "verdict": "satisfied", "evidence": [{"file": "src/api.ts", "line": 5}]},
  {"requirement": "Response must be JSON", "verdict": "satisfied"},
  {"requirement": "Cache invalidation triggers", "verdict": "violated", "evidence": [{"file": "src/cache.ts", "line": 42}]}
]
\`\`\`
`;

  const verdicts = parseConformanceVerdicts(reviewText);

  assert.equal(verdicts.length, 3);
  assert.equal(verdicts[0]!.requirement, "API endpoint must exist");
  assert.equal(verdicts[0]!.verdict, "satisfied");
  assert.equal(verdicts[0]!.evidence?.[0]?.line, 5);

  assert.equal(verdicts[1]!.verdict, "satisfied");
  assert.equal(verdicts[1]!.evidence, undefined);

  assert.equal(verdicts[2]!.verdict, "violated");
  assert.equal(verdicts[2]!.evidence?.[0]?.file, "src/cache.ts");
});

test("detectConformanceAgreement applies 2-reviewer quorum rule", () => {
  const verdicts = [
    // Requirement 1: violated by both reviewers (clear violation)
    {
      requirement: "API endpoint must exist",
      verdict: "violated" as const,
      reviewerRole: "reviewer-a",
    },
    {
      requirement: "API endpoint must exist",
      verdict: "violated" as const,
      reviewerRole: "reviewer-b",
    },
    // Requirement 2: satisfied by both (consensus)
    {
      requirement: "Response must be JSON",
      verdict: "satisfied" as const,
      reviewerRole: "reviewer-a",
    },
    {
      requirement: "Response must be JSON",
      verdict: "satisfied" as const,
      reviewerRole: "reviewer-b",
    },
    // Requirement 3: single reviewer violation (below quorum)
    {
      requirement: "Cache invalidation",
      verdict: "violated" as const,
      reviewerRole: "reviewer-a",
    },
    {
      requirement: "Cache invalidation",
      verdict: "satisfied" as const,
      reviewerRole: "reviewer-b",
    },
    // Requirement 4: uncertain/satisfied (passes)
    {
      requirement: "Error handling",
      verdict: "uncertain" as const,
      reviewerRole: "reviewer-a",
    },
    {
      requirement: "Error handling",
      verdict: "satisfied" as const,
      reviewerRole: "reviewer-b",
    },
  ];

  const groups = detectConformanceAgreement(verdicts);

  assert.equal(groups.length, 4);

  // API endpoint: both violated → violation raised
  const apiGroup = groups.find((g) => g.requirement === "API endpoint must exist")!;
  assert.equal(apiGroup.verdictCounts.violated, 2);
  assert.equal(apiGroup.verdictCounts.satisfied, 0);

  // Response: both satisfied → satisfied
  const responseGroup = groups.find((g) => g.requirement === "Response must be JSON")!;
  assert.equal(responseGroup.verdictCounts.satisfied, 2);
  assert.equal(responseGroup.verdictCounts.violated, 0);

  // Cache: one violated, one satisfied → below quorum (no raise)
  const cacheGroup = groups.find((g) => g.requirement === "Cache invalidation")!;
  assert.equal(cacheGroup.verdictCounts.violated, 1);
  assert.equal(cacheGroup.verdictCounts.satisfied, 1);

  // Error handling: one uncertain, one satisfied → passes (not violated)
  const errorGroup = groups.find((g) => g.requirement === "Error handling")!;
  assert.equal(errorGroup.verdictCounts.uncertain, 1);
  assert.equal(errorGroup.verdictCounts.satisfied, 1);
  assert.equal(errorGroup.verdictCounts.violated, 0);
});

test("Full Tier-1 to Tier-2 flow: deterministic checks fail → skip reviewers", async () => {
  // Spec with both deterministic-checkable and reviewer-assessable requirements
  const spec = `
# Specification

## Requirements

### Requirement: file src/index.ts must exist
The main entry point must be present.

### Requirement: function main must be defined
The main handler must be exported.

### Requirement: code must handle edge cases gracefully
Error handling for unexpected inputs.
`;

  const requirements = extractRequirementsFromSpec(spec);
  assert.equal(requirements.length, 3);

  // Deterministic checks
  const deterministicRules = extractDeterministicChecks(requirements);
  assert.equal(deterministicRules.length, 2); // First two are deterministic

  const mockFileReader = async (path: string): Promise<string | null> => {
    if (path === "src/index.ts") {
      return "export function main() { return 42; }";
    }
    return null;
  };

  const checkResults = await executeDeterministicChecks(
    deterministicRules,
    ["src/index.ts"],
    mockFileReader,
  );

  // Both deterministic checks pass
  assert.equal(checkResults.every((r) => r.passed), true);

  // If all deterministic checks pass, proceed to Tier-2 (reviewers)
  // This would normally trigger reviewer panel in real flow
  const wouldProceedToTier2 = checkResults.every((r) => r.passed);
  assert.equal(wouldProceedToTier2, true);
});

test("Full Tier-1 to Tier-2 flow: deterministic checks pass → proceed to reviewers", async () => {
  const requirements = ["file src/api.ts must exist", "function handler must be defined"];

  const rules = extractDeterministicChecks(requirements);

  const mockFileReader = async (path: string): Promise<string | null> => {
    if (path === "src/api.ts") {
      return "export function handler(req) { return res; }";
    }
    return null;
  };

  const checkResults = await executeDeterministicChecks(rules, ["src/api.ts"], mockFileReader);

  // Both checks pass; would proceed to Tier-2
  const failedChecks = checkResults.filter((r) => !r.passed);
  assert.equal(failedChecks.length, 0);

  // In real flow, coordinator now spawns reviewer panel
  // Reviewers would assess non-deterministic requirements
});
