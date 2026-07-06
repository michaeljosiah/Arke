import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveTriage, derivePipeline, deriveRepoRows, deriveSyncSystems } from "../src/screens/overview-derivations";

/** SPEC-025: the Overview's pure data derivations, tested without a DOM. */

test("deriveTriage aggregates gates, review-ready, diffs, and unhealthy projections", () => {
  const cards = [
    { id: "SPEC-1", specId: "SPEC-1", title: "One", col: "needs-human", needsHuman: true, sessions: [] },
    { id: "SPEC-2", specId: "SPEC-2", title: "Two", col: "review", needsHuman: false, sessions: [] },
    { id: "SPEC-3", specId: "SPEC-3", title: "Three", col: "diff", needsHuman: false, sessions: [{ diff: { added: 4, removed: 1, files: 2 } }] },
  ];
  const projections = [
    { target: "jira", specId: "SPEC-2", ok: true },
    { target: "jira", specId: "SPEC-9", ok: false, error: "retrying" },
  ];
  const items = deriveTriage(cards, projections);
  assert.equal(items.length, 4);
  assert.ok(items.find((i) => i.kind === "permission gate"));
  assert.ok(items.find((i) => i.kind === "review"));
  const diff = items.find((i) => i.kind === "diff")!;
  assert.match(diff.detail, /\+4 −1 across 2 files/);
  assert.ok(items.find((i) => i.kind === "record sync"));
});

test("deriveTriage returns nothing when nothing needs a human (calm state)", () => {
  const cards = [{ id: "SPEC-1", specId: "SPEC-1", title: "One", col: "implementing", needsHuman: false, sessions: [] }];
  const projections = [{ target: "jira", ok: true }];
  assert.deepEqual(deriveTriage(cards, projections), []);
});

test("derivePipeline counts specs by status using the SPEC-024 'delivered' terminal name", () => {
  const specs = [
    { status: "draft" }, { status: "draft" }, { status: "in-review" }, { status: "approved" }, { status: "delivered" },
  ];
  const counts = derivePipeline(specs);
  assert.deepEqual(counts.map((c) => c.n), [2, 1, 1, 1]);
  assert.equal(counts[3]!.id, "delivered");
});

test("deriveRepoRows joins each branch row with its spec title", () => {
  const gitBranches = [{ specId: "SPEC-1", branch: "spec/one", ahead: 1 }];
  const specs = [{ specId: "SPEC-1", title: "The One" }];
  const rows = deriveRepoRows(gitBranches, specs);
  assert.equal(rows[0]!.specTitle, "The One");
});

test("deriveSyncSystems groups by system and counts unhealthy rows (both live and demo shapes)", () => {
  const projections = [
    { target: "jira", ok: true },
    { target: "jira", ok: false, error: "retry" },
    { system: "Azure DevOps", health: "warn", last: "2 attempts" },
  ];
  const systems = deriveSyncSystems(projections);
  const jira = systems.find((s) => s.system === "jira")!;
  assert.equal(jira.count, 2);
  assert.equal(jira.warn, 1);
  const azure = systems.find((s) => s.system === "Azure DevOps")!;
  assert.equal(azure.warn, 1);
  assert.equal(azure.lastWarn, "2 attempts");
});
