/**
 * Pure helpers for the generation workspace (SPEC-013) — no React, store, or transport imports, so the
 * approval-collection logic is unit-testable in isolation. The screen holds per-artefact decisions and
 * edits in local state; these functions turn that state into the `approve-generation` command payload
 * (`approvedArtifactIds` + minimal `edits`) and decide which artefacts are approvable.
 */

export type ArtifactDecision = "approved" | "rejected" | "pending";

/** The subset of an ArtifactProposal this logic needs (mirrors the generation.proposed artefact shape). */
export interface ArtifactLike {
  id: string;
  target: string; // "docs" | "tests" | "ticket" | "tracking"
  content: string;
  sorTarget?: string;
  invalid?: string;
}

/** A human override for one artefact: replacement content and/or an integration target for a ticket/tracking item. */
export interface ArtifactEditInput {
  content?: string;
  sorTarget?: string;
}

/** A ticket/tracking artefact needs an integration target — from the proposal or added by a human edit. */
export function needsSorTarget(target: string): boolean {
  return target === "ticket" || target === "tracking";
}

/** The effective integration target for an artefact (a human edit overrides the proposed one). */
export function effectiveSorTarget(a: ArtifactLike, edit?: ArtifactEditInput): string | undefined {
  return edit?.sorTarget ?? a.sorTarget;
}

/**
 * Whether an artefact may be approved: a ticket/tracking artefact is approvable only once it has an
 * integration target (proposed or supplied via a human edit). Everything else is always approvable.
 * This mirrors the coordinator's `resolveApproval` refusal so the UI can disable the control up front
 * rather than let an approval bounce back as an error.
 */
export function isApprovable(a: ArtifactLike, edit?: ArtifactEditInput): boolean {
  return needsSorTarget(a.target) ? !!effectiveSorTarget(a, edit) : true;
}

/**
 * Turn per-artefact decisions + edits into the `approve-generation` command payload. Only approved
 * artefacts are included; an edit is emitted only when it actually changes something (content differs
 * from the proposal, or a sorTarget is added/changed) so the command stays minimal and the coordinator
 * records the final human-reviewed content.
 */
export function collectApproval(
  artifacts: ArtifactLike[],
  decisions: Record<string, ArtifactDecision>,
  edits: Record<string, ArtifactEditInput>,
): { approvedArtifactIds: string[]; edits: Array<{ id: string; content?: string; sorTarget?: string }> } {
  const approvedArtifactIds: string[] = [];
  const editList: Array<{ id: string; content?: string; sorTarget?: string }> = [];
  for (const a of artifacts) {
    if (decisions[a.id] !== "approved") continue;
    approvedArtifactIds.push(a.id);
    const ed = edits[a.id];
    if (!ed) continue;
    const entry: { id: string; content?: string; sorTarget?: string } = { id: a.id };
    if (ed.content !== undefined && ed.content !== a.content) entry.content = ed.content;
    if (ed.sorTarget && ed.sorTarget !== a.sorTarget) entry.sorTarget = ed.sorTarget;
    if (entry.content !== undefined || entry.sorTarget !== undefined) editList.push(entry);
  }
  return { approvedArtifactIds, edits: editList };
}

/** Mark every approvable artefact approved (the "Approve all" gesture); non-approvable items stay pending. */
export function approveAll(
  artifacts: ArtifactLike[],
  edits: Record<string, ArtifactEditInput>,
): Record<string, ArtifactDecision> {
  const out: Record<string, ArtifactDecision> = {};
  for (const a of artifacts) if (isApprovable(a, edits[a.id])) out[a.id] = "approved";
  return out;
}
