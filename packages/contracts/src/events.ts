import { z } from "zod";
import { ModelTier, RippleKind, SpecStatus } from "./spec.js";
import { Capability } from "./adapter.js";

/**
 * The canonical, normalized domain-event model (PRD §8.5, §21.1).
 *
 * Provider-native events from each harness are normalized by the coordinator into
 * exactly these shapes, persisted, and pushed to the client ordered, monotonically
 * sequenced per connection, and schema-validated at the boundary (NFR-8). The board
 * reads from this model, never from raw provider output — which is what lets harness
 * capability differences be absorbed cleanly.
 */

/** A session is the unit of execution: parent = a spec, child = a task (FR-8). */
export const SessionKind = z.enum(["spec", "task"]);
export type SessionKind = z.infer<typeof SessionKind>;

export const SessionStatus = z.enum([
  "idle",
  "running",
  "waiting", // blocked on a human (permission/elicitation)
  "error",
  "done",
  "interrupted", // its harness instance was lost mid-session; not migrated (SPEC-005, NFR-4)
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Envelope wrapping every pushed event: ordered + sequenced per connection (NFR-8). */
export const EventEnvelope = z.object({
  seq: z.number().int().nonnegative(), // monotonic per connection
  ts: z.number().int(), // epoch ms, stamped at the coordinator
  harness: z.string(), // e.g. "OpenCode", "Claude Code"
  // Correlation id (the harness messageID) attributing an event to the request that
  // produced it (SPEC-002). Optional on the envelope; the full domain-model treatment
  // — message/part events that always carry it — is SPEC-003. Landed early here so the
  // OpenCode adapter can attribute turn output to its originating send.
  correlationId: z.string().optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

const base = EventEnvelope;

export const SpecStatusEvent = base.extend({
  type: z.literal("spec.status"),
  specId: z.string(),
  status: SpecStatus,
  // SPEC-008: why the status changed (pr-closed | pr-reopened | material-change | approved | merged …).
  reason: z.string().optional(),
  // SPEC-024: for a human-triggered (manual) transition, the in-app actor who moved it. Absent for a
  // webhook-triggered transition. Recorded so a manual move is attributable (`reason: "manual"`).
  actor: z.string().optional(),
});

/**
 * SPEC-020: a blank-slate spec was renamed once the spec-author derived its real title — its
 * `untitled-NNN` filename/spec_id/branch became a title-derived slug. Consumers re-key any state
 * held under `oldSpecId` (the client rebinds its active spec; the read model re-keys the card).
 */
export const SpecRenamedEvent = base.extend({
  type: z.literal("spec.renamed"),
  oldSpecId: z.string(),
  specId: z.string(), // the new canonical spec id
  path: z.string(), // new repo-relative path
  branch: z.string(), // new branch
  title: z.string(),
});

/** SPEC-008: a system-of-record projection derived from a spec went stale (spec regressed). */
export const ProjectionStaleEvent = base.extend({
  type: z.literal("projection.stale"),
  specId: z.string(),
  target: z.string(),
  recordRef: z.string(),
});

/** SPEC-008: after a force-push the frontmatter `branch` no longer matches the pushed branch. */
export const SpecBranchMismatchEvent = base.extend({
  type: z.literal("spec.branch-mismatch"),
  specId: z.string(),
  frontmatterBranch: z.string(),
  pushedBranch: z.string(),
});

/** SPEC-013: the generation agent proposed downstream artefacts from an approved spec (preview, no write). */
export const GenerationProposedEvent = base.extend({
  type: z.literal("generation.proposed"),
  specId: z.string(),
  sessionId: z.string(), // doubles as proposalId — carried on every decision command
  artifacts: z.array(
    z.object({
      id: z.string(),
      target: z.enum(["docs", "tests", "ticket", "tracking"]),
      title: z.string(),
      content: z.string(),
      sorTarget: z.enum(["jira", "azure-devops", "github"]).optional(),
      invalid: z.string().optional(),
    }),
  ),
});

/** SPEC-013: a human decided on a generation proposal (approve subset / reject). */
export const GenerationDecidedEvent = base.extend({
  type: z.literal("generation.decided"),
  specId: z.string(),
  sessionId: z.string(), // proposalId anchor
  decision: z.enum(["approved", "rejected"]),
  approvedArtifactIds: z.array(z.string()).optional(),
});

/** SPEC-013: generation could not produce a usable proposal (parse error / timeout). */
export const GenerationErrorEvent = base.extend({
  type: z.literal("generation.error"),
  specId: z.string(),
  reason: z.string(),
});

/** SPEC-011: an agent asks the human a structured question mid-run (maps to OpenCode `question.asked`). */
export const ElicitationAskedEvent = base.extend({
  type: z.literal("elicitation.asked"),
  sessionId: z.string(),
  elicitationId: z.string(),
  question: z.string(),
  options: z.array(z.string()).optional(),
});

/** SPEC-011: the human answered an elicitation. */
export const ElicitationRepliedEvent = base.extend({
  type: z.literal("elicitation.replied"),
  sessionId: z.string(),
  elicitationId: z.string(),
  answer: z.string(),
});

/** SPEC-011: the human dismissed/rejected an elicitation without answering. */
export const ElicitationRejectedEvent = base.extend({
  type: z.literal("elicitation.rejected"),
  sessionId: z.string(),
  elicitationId: z.string(),
});

/** SPEC-008: the read-model status diverged from the file's frontmatter status (reconciliation). */
export const SpecDivergenceWarningEvent = base.extend({
  type: z.literal("spec.divergence-warning"),
  specId: z.string(),
  readModelStatus: SpecStatus,
  frontmatterStatus: SpecStatus,
});

export const SessionStatusEvent = base.extend({
  type: z.literal("session.status"),
  sessionId: z.string(),
  specId: z.string(),
  kind: SessionKind,
  status: SessionStatus,
  model: z.string().optional(),
});

export const TodoUpdatedEvent = base.extend({
  type: z.literal("todo.updated"),
  sessionId: z.string(),
  todos: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      done: z.boolean(),
    }),
  ),
});

export const DiffFinalizedEvent = base.extend({
  type: z.literal("diff.finalized"),
  sessionId: z.string(),
  added: z.number().int(),
  removed: z.number().int(),
  files: z.number().int(),
});

/**
 * SPEC-025: live repository identity for a project — the header of the Overview's Repository panel.
 * Coordinator-emitted (never from the harness stream), re-emitted only when HEAD or the remote changes.
 * `default` reuses the existing `gitDefaultBranch()` mainline probe, not a separate symbolic-ref notion.
 */
export const RepoIdentityEvent = base.extend({
  type: z.literal("repo.identity"),
  name: z.string(),
  remote: z.string(),
  default: z.string(),
  head: z.string(),
});

/**
 * SPEC-025: live git + GitHub PR status for one specification branch. Every git-derived numeric field is
 * nullable and paired with an explicit `degraded[]` reason — a field the coordinator could not compute is
 * `null` with a degraded entry, NEVER a fabricated `0`. `pr === null` means "verified: no PR is linked";
 * `pr` present with a null number/status, or a degraded entry for `pr`, means "unknown" — the two are
 * never collapsed. `dirty` is null for any branch that is not the one currently checked out.
 */
export const RepoStatusEvent = base.extend({
  type: z.literal("repo.status"),
  specId: z.string(),
  branch: z.string(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  dirty: z.number().int().nullable(),
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
  files: z.number().int().nullable(),
  pr: z
    .object({ number: z.number().int().nullable(), status: z.enum(["open", "draft"]).nullable() })
    .nullable(),
  degraded: z
    .array(z.object({ field: z.enum(["ahead", "behind", "dirty", "diff", "pr"]), reason: z.string() }))
    .optional(),
});

/** SPEC-025: the read-model / client view of repository identity (event envelope stripped). */
export interface RepoIdentityView {
  name: string;
  remote: string;
  default: string;
  head: string;
}

/** SPEC-025: the read-model / client view of one specification branch's git + PR status. */
export interface RepoStatusView {
  specId: string;
  branch: string;
  ahead: number | null;
  behind: number | null;
  dirty: number | null;
  added: number | null;
  removed: number | null;
  files: number | null;
  pr: { number: number | null; status: "open" | "draft" | null } | null;
  degraded?: { field: "ahead" | "behind" | "dirty" | "diff" | "pr"; reason: string }[];
}

export const PermissionAskedEvent = base.extend({
  type: z.literal("permission.asked"),
  sessionId: z.string(),
  permissionId: z.string(),
  title: z.string(),
  detail: z.string().optional(),
});

export const PermissionRepliedEvent = base.extend({
  type: z.literal("permission.replied"),
  sessionId: z.string(),
  permissionId: z.string(),
  granted: z.boolean(),
});

/** A governed projection write to a system of record (FR-7, NFR-2): always logged. */
export const ProjectionWriteEvent = base.extend({
  type: z.literal("projection.write"),
  target: z.enum(["jira", "azure-devops", "github", "docs", "tests"]),
  specId: z.string(),
  trigger: z.string(), // the generation.decided event id that caused the write
  ok: z.boolean(),
  // SPEC-014 additions: anchor the write to its artefact + dedup + failure detail.
  artifactId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  errorMessage: z.string().optional(),
});

/** SPEC-014: the per-project integrations registry status (credentials never cross the wire). */
export const IntegrationStatusEvent = base.extend({
  type: z.literal("integration.status"),
  integrations: z.array(
    z.object({
      id: z.enum(["github", "jira", "azure-devops"]),
      status: z.enum(["connected", "not-configured", "error"]),
      enables: z.array(z.string()),
      lastCheckedAt: z.number(),
      errorReason: z.string().optional(),
    }),
  ),
});

/**
 * A streaming delta from an in-progress assistant turn (SPEC-003). Parts are folded into
 * per-session transcript state in `partIndex` order, not arrival order; `done: true` marks
 * the final part of a message.
 */
export const MessagePartEvent = base.extend({
  type: z.literal("message.part"),
  sessionId: z.string(),
  messageId: z.string(),
  partIndex: z.number().int().nonnegative(),
  delta: z.string(),
  role: z.enum(["assistant", "tool"]),
  done: z.boolean(),
});

/** A full turn-state snapshot once a message is complete (SPEC-003). */
export const MessageUpdatedEvent = base.extend({
  type: z.literal("message.updated"),
  sessionId: z.string(),
  messageId: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), result: z.string().optional() }))
    .default([]),
  isStreaming: z.boolean(),
});

/**
 * A typed runtime-signal receipt the coordinator emits when a session goes idle after a turn
 * (SPEC-003, D2). Consumers detect turn completion from this — never by polling or timeout.
 */
export const TurnQuiescentEvent = base.extend({
  type: z.literal("turn.quiescent"),
  sessionId: z.string(),
  turnId: z.string(),
});

/** The method-ready scaffold steps (SPEC-004). `config` seeds `.arke/config.json` (registry +
 *  roster); `repos` is advisory (skipped without git). */
export const ScaffoldStep = z.enum(["config", "agents", "specs", "grounding", "plugins", "repos"]);
export type ScaffoldStep = z.infer<typeof ScaffoldStep>;

export const ScaffoldStepStatus = z.enum(["running", "done", "skipped", "error"]);
export type ScaffoldStepStatus = z.infer<typeof ScaffoldStepStatus>;

/**
 * Progress for one scaffold step (SPEC-004). `detail` carries a skip reason or error message —
 * NEVER a credential value, a path outside the project root, or any file content (NFR-1).
 */
export const ScaffoldStepEvent = base.extend({
  type: z.literal("scaffold.step"),
  step: ScaffoldStep,
  status: ScaffoldStepStatus,
  detail: z.string().optional(),
});

/** Terminal scaffold signal (SPEC-004): the canonicalised project root and the steps that ran. */
export const ScaffoldDoneEvent = base.extend({
  type: z.literal("scaffold.done"),
  projectPath: z.string(), // canonicalised project root only — never a raw client value
  // Checked as strictly as scaffold.step so a malformed terminal signal (e.g. a bogus step name)
  // cannot pass DomainEvent validation and be traced/rendered as completed progress.
  stepsRun: z.array(ScaffoldStep),
});

/**
 * Per-endpoint harness reachability from the onboarding probe (SPEC-004). `reason` is a
 * human-readable failure cause (e.g. "timeout", "HTTP 503") — never a credential value. This is
 * complementary to the SPEC-005 `registry.updated` projection: this fires from the onboarding
 * probe path; `registry.updated` is the authoritative full-registry projection.
 */
export const HarnessReachabilityEvent = base.extend({
  type: z.literal("harness.reachability"),
  endpoint: z.string(),
  reachable: z.boolean(),
  /** Distinguishes a clean failure from a partial response (health up, capabilities unconfirmed). */
  partial: z.boolean().optional(),
  reason: z.string().optional(),
});

/**
 * A live projection of the harness/model registry (SPEC-005, FR-4/FR-19). The client renders the
 * harnesses screen from this — never from a static seed. Carries instance ids, drivers, endpoints,
 * reachability, capability flags, and tier *labels* only: no `credentialsRef`, no credential value,
 * and no vendor model string ever appears here.
 */
export const RegistryUpdatedEvent = base.extend({
  type: z.literal("registry.updated"),
  instances: z.array(
    z.object({
      id: z.string(),
      driver: z.string(),
      endpoint: z.string(),
      reachable: z.boolean(),
      // Reuse the adapter Capability + ModelTier schemas so a malformed projection (e.g.
      // caps: ["eventz"] or tier: "turbo") is rejected at the boundary, not rendered.
      caps: z.array(Capability),
      // serves carries tier labels only — never a vendor model string or a credentialsRef.
      serves: z.array(z.object({ tier: ModelTier, label: z.string() })),
      /** True when the backend exposes no model catalog, so serves were trusted unvalidated. */
      catalogUnavailable: z.boolean().optional(),
    }),
  ),
});

/**
 * A registry health/config warning (SPEC-005). `detail` is human-readable and MUST NOT contain a
 * credential value or a vendor model id beyond a label the operator already authored.
 */
export const RegistryWarningEvent = base.extend({
  type: z.literal("registry.warning"),
  reason: z.enum([
    "reviewer-models-identical",
    "no-instance-for-tier",
    "credential-missing",
    "instance-failover",
    "model-not-in-catalog", // a configured serves[].model is absent from the instance's live catalog
  ]),
  detail: z.string().optional(),
});

/**
 * An approval commit failed (SPEC-006). Emitted by the coordinator when `approveDraft` cannot
 * complete — a branch-guard mismatch, a dirty tree, or a git failure — so the cockpit can surface
 * the reason and keep the action available for retry. The status is NOT advanced on failure.
 */
export const SpecApprovalFailedEvent = base.extend({
  type: z.literal("spec.approval-failed"),
  specId: z.string(),
  reason: z.string(),
});

// ---- multi-model review panel (SPEC-007) -----------------------------------

/** Severity a reviewer assigns to an issue. */
export const ReviewSeverity = z.enum(["blocking", "suggestion", "question"]);
export type ReviewSeverity = z.infer<typeof ReviewSeverity>;

/** A panel started: the reviewers and the model LABEL each runs on (never a vendor id — SPEC-005). The
 *  `round` (SPEC-035) is the loop round this panel belongs to — 1 for a fresh review, >1 for a reconvene —
 *  so the client resets vs. accumulates round summaries. */
export const PanelStartedEvent = base.extend({
  type: z.literal("panel.started"),
  panelId: z.string(),
  specId: z.string(),
  round: z.number().int().positive().default(1),
  reviewers: z.array(z.object({ role: z.string(), model: z.string() })),
});

/** One issue a reviewer raised, anchored to a spec section (by key + content hash). */
export const PanelIssueEvent = base.extend({
  type: z.literal("panel.issue"),
  panelId: z.string(),
  issueId: z.string(),
  reviewerRole: z.string(),
  section: z.string(),
  sectionHash: z.string(),
  text: z.string(),
  severity: ReviewSeverity,
});

/** Two or more reviewers raised substantially the same concern on the same section. */
export const PanelAgreedEvent = base.extend({
  type: z.literal("panel.agreed"),
  panelId: z.string(),
  issueIds: z.array(z.string()),
  section: z.string(),
});

/** A panel finished: all reviewer sessions are done (or every one errored → failed). */
export const PanelCompleteEvent = base.extend({
  type: z.literal("panel.complete"),
  panelId: z.string(),
  specId: z.string(),
  status: z.enum(["complete", "failed"]),
  issueCount: z.number().int().nonnegative(),
  adjudicatedCount: z.number().int().nonnegative(),
});

/** One reviewer errored/timed out; the panel continues with the rest. */
export const PanelReviewerErrorEvent = base.extend({
  type: z.literal("panel.reviewer-error"),
  panelId: z.string(),
  reviewerRole: z.string(),
  reason: z.string(),
});

/** A panel could not start: a same-model pair, or too few distinct capable models. */
export const PanelConfigErrorEvent = base.extend({
  type: z.literal("panel.config-error"),
  panelId: z.string().optional(),
  specId: z.string().optional(),
  reason: z.string(),
});

/** On accept: the reviewed section changed since panel start — confirm before routing the critique. */
export const PanelStaleFileWarningEvent = base.extend({
  type: z.literal("panel.stale-file-warning"),
  panelId: z.string(),
  issueId: z.string(),
  specId: z.string(),
});

/** The finalisation gate rejected an `approveDraft` issued without a completed review (SPEC-007). */
export const ReviewGateFailedEvent = base.extend({
  type: z.literal("review.gate-failed"),
  specId: z.string(),
  reason: z.string(),
});

/** The well-formedness gate rejected a promotion of a malformed draft (SPEC-024). `missing` names each
 *  absent element ("requirements section" | "normative statements" | "scenarios") so the cockpit can
 *  tell the author exactly what to add before the draft can advance out of `draft`. */
export const SpecMalformedEvent = base.extend({
  type: z.literal("spec.malformed"),
  specId: z.string(),
  missing: z.array(z.string()),
});

/** SPEC-035: the spec-author's adjudication turn began for a panel (one round of the review loop). */
export const PanelAdjudicatingEvent = base.extend({
  type: z.literal("panel.adjudicating"),
  panelId: z.string(),
  specId: z.string(),
  round: z.number().int().positive(),
});

/** SPEC-035: the author's disposition of one reviewer issue — `accept` (applied to the working file) or
 *  `dismiss` (with a recorded rationale). Replaces the human accept/dismiss/send-back of SPEC-007. */
export const PanelDispositionEvent = base.extend({
  type: z.literal("panel.disposition"),
  panelId: z.string(),
  issueId: z.string(),
  action: z.enum(["accept", "dismiss"]),
  rationale: z.string(),
  actor: z.literal("spec-author"),
});

/** SPEC-035: one review round finished adjudicating — applied/dismissed counts and whether a fresh panel
 *  reconvenes (a blocker was accepted and the spec's normative content changed, under the round cap). */
export const PanelRoundCompleteEvent = base.extend({
  type: z.literal("panel.round-complete"),
  panelId: z.string(),
  specId: z.string(),
  round: z.number().int().positive(),
  applied: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  reconvened: z.boolean(),
});

/** SPEC-035: the adjudicating author shares a reviewer's model — a warning, never a gate. The concrete
 *  model stays host-side (trace only, SPEC-005); the client sees only which reviewer role collided. */
export const PanelAdjudicatorModelCollisionEvent = base.extend({
  type: z.literal("panel.adjudicator-model-collision"),
  panelId: z.string(),
  reviewerRole: z.string(),
});

/** SPEC-035: the bounded review loop converged — the review gate is satisfied for this draft.
 *  `unresolvedBlockers` are blocking issues the author dismissed (with rationale), surfaced prominently to
 *  the human at approval so a dismissed-but-valid critique is never silently dropped. */
export const ReviewConvergedEvent = base.extend({
  type: z.literal("review.converged"),
  specId: z.string(),
  rounds: z.number().int().positive(),
  /** True when the loop stopped at the round cap while a blocker fix was still pending re-review — the
   *  human sees "stopped at cap without re-reviewing the final fix" rather than a clean convergence. */
  reachedCap: z.boolean().default(false),
  unresolvedBlockers: z.array(
    z.object({ issueId: z.string(), section: z.string(), text: z.string(), rationale: z.string() }),
  ),
});

/** SPEC-030: a cross-repo ripple went stale because its canonical spec materially changed — surfaced in the
 *  AFFECTED project so a cross-repo contract change never goes silently unnoticed. `trigger` names the
 *  canonical change (normative-hash delta and/or status transition). */
export const SpecRippleStaleEvent = base.extend({
  type: z.literal("spec.ripple-stale"),
  specId: z.string(), // the ripple spec (in the affected project); "generated" pointer stubs use their file id
  canonicalRepo: z.string(),
  canonicalSpec: z.string(),
  kind: RippleKind,
  trigger: z.string(),
});

/** SPEC-030: a human acknowledged a stale `delta` ripple in its project (re-review / no-local-impact). */
export const SpecRippleAckedEvent = base.extend({
  type: z.literal("spec.ripple-acked"),
  specId: z.string(),
  actor: z.string().optional(),
  reason: z.string(),
});

/** Discriminated union of every normalized domain event. */
export const DomainEvent = z.discriminatedUnion("type", [
  SpecStatusEvent,
  SpecRenamedEvent,
  ProjectionStaleEvent,
  SpecBranchMismatchEvent,
  SpecDivergenceWarningEvent,
  ElicitationAskedEvent,
  ElicitationRepliedEvent,
  ElicitationRejectedEvent,
  GenerationProposedEvent,
  GenerationDecidedEvent,
  GenerationErrorEvent,
  SessionStatusEvent,
  TodoUpdatedEvent,
  DiffFinalizedEvent,
  RepoIdentityEvent,
  RepoStatusEvent,
  PermissionAskedEvent,
  PermissionRepliedEvent,
  ProjectionWriteEvent,
  IntegrationStatusEvent,
  MessagePartEvent,
  MessageUpdatedEvent,
  TurnQuiescentEvent,
  ScaffoldStepEvent,
  ScaffoldDoneEvent,
  HarnessReachabilityEvent,
  RegistryUpdatedEvent,
  RegistryWarningEvent,
  SpecApprovalFailedEvent,
  PanelStartedEvent,
  PanelIssueEvent,
  PanelAgreedEvent,
  PanelCompleteEvent,
  PanelReviewerErrorEvent,
  PanelConfigErrorEvent,
  PanelStaleFileWarningEvent,
  ReviewGateFailedEvent,
  SpecMalformedEvent,
  PanelAdjudicatingEvent,
  PanelDispositionEvent,
  PanelRoundCompleteEvent,
  PanelAdjudicatorModelCollisionEvent,
  ReviewConvergedEvent,
  SpecRippleStaleEvent,
  SpecRippleAckedEvent,
]);
export type DomainEvent = z.infer<typeof DomainEvent>;

/** One message in a session's transcript, accumulated from message.part/updated events. */
export interface TranscriptEntry {
  messageId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls: { id: string; name: string; result?: string }[];
  isStreaming: boolean;
}

/**
 * Board columns are computed from real signals (FR-9, Figure 4) — never hand-set.
 * A card moves because the work moved.
 */
export const BoardColumn = z.enum([
  "authoring",
  "review",
  "approved",
  "implementing",
  "needs-human",
  "diff",
  "delivered", // terminal (SPEC-024); renamed from `merged` — names the outcome, not the git verb
]);
export type BoardColumn = z.infer<typeof BoardColumn>;
