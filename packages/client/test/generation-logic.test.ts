import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveAll,
  collectApproval,
  effectiveSorTarget,
  isApprovable,
  needsSorTarget,
  type ArtifactDecision,
  type ArtifactLike,
} from "../src/generation-logic.js";

const ARTIFACTS: ArtifactLike[] = [
  { id: "d1", target: "docs", content: "# Docs" },
  { id: "t1", target: "tests", content: "def test(): ..." },
  { id: "k1", target: "ticket", content: "Story", sorTarget: "jira" },
  { id: "k2", target: "ticket", content: "Story 2", invalid: "no integration target" }, // no sorTarget
];

test("needsSorTarget only for ticket/tracking", () => {
  assert.ok(needsSorTarget("ticket"));
  assert.ok(needsSorTarget("tracking"));
  assert.ok(!needsSorTarget("docs"));
  assert.ok(!needsSorTarget("tests"));
});

test("effectiveSorTarget prefers a human edit over the proposed target", () => {
  assert.equal(effectiveSorTarget(ARTIFACTS[2]!), "jira");
  assert.equal(effectiveSorTarget(ARTIFACTS[2]!, { sorTarget: "github" }), "github");
  assert.equal(effectiveSorTarget(ARTIFACTS[3]!), undefined);
  assert.equal(effectiveSorTarget(ARTIFACTS[3]!, { sorTarget: "azure-devops" }), "azure-devops");
});

test("isApprovable: docs/tests always; ticket only with an effective target", () => {
  assert.ok(isApprovable(ARTIFACTS[0]!));
  assert.ok(isApprovable(ARTIFACTS[1]!));
  assert.ok(isApprovable(ARTIFACTS[2]!)); // has sorTarget
  assert.ok(!isApprovable(ARTIFACTS[3]!)); // ticket, no target → not approvable
  assert.ok(isApprovable(ARTIFACTS[3]!, { sorTarget: "jira" }), "a supplied target makes it approvable");
});

test("collectApproval returns only approved ids and no edit entries when nothing changed", () => {
  const decisions: Record<string, ArtifactDecision> = { d1: "approved", t1: "rejected", k1: "approved" };
  const { approvedArtifactIds, edits } = collectApproval(ARTIFACTS, decisions, {});
  assert.deepEqual(approvedArtifactIds, ["d1", "k1"], "only the approved subset, rejected/pending excluded");
  assert.deepEqual(edits, [], "no edits emitted when content/target unchanged");
});

test("collectApproval emits an edit entry only for a genuine content change", () => {
  const decisions: Record<string, ArtifactDecision> = { d1: "approved" };
  const unchanged = collectApproval(ARTIFACTS, decisions, { d1: { content: "# Docs" } }); // same as proposal
  assert.deepEqual(unchanged.edits, [], "content equal to the proposal is not an edit");
  const changed = collectApproval(ARTIFACTS, decisions, { d1: { content: "# Docs (revised)" } });
  assert.deepEqual(changed.edits, [{ id: "d1", content: "# Docs (revised)" }]);
});

test("collectApproval carries a supplied sorTarget so an invalid ticket can be approved", () => {
  const decisions: Record<string, ArtifactDecision> = { k2: "approved" };
  const { approvedArtifactIds, edits } = collectApproval(ARTIFACTS, decisions, { k2: { sorTarget: "github" } });
  assert.deepEqual(approvedArtifactIds, ["k2"]);
  assert.deepEqual(edits, [{ id: "k2", sorTarget: "github" }], "the added target rides along so the coordinator accepts it");
});

test("collectApproval combines a content edit and a target fix into one entry", () => {
  const { edits } = collectApproval(ARTIFACTS, { k2: "approved" }, { k2: { content: "Story 2 (edited)", sorTarget: "jira" } });
  assert.deepEqual(edits, [{ id: "k2", content: "Story 2 (edited)", sorTarget: "jira" }]);
});

test("approveAll marks every approvable artefact and skips an unfixed invalid one", () => {
  const d = approveAll(ARTIFACTS, {});
  assert.deepEqual(d, { d1: "approved", t1: "approved", k1: "approved" }, "k2 (invalid, no target) is not auto-approved");
  const withFix = approveAll(ARTIFACTS, { k2: { sorTarget: "jira" } });
  assert.equal(withFix.k2, "approved", "once a target is supplied, approve-all includes it");
});
