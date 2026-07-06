import { z } from "zod";

/**
 * Specification lifecycle and frontmatter.
 *
 * The specification is the source of truth (PRD §4, D3). Its canonical copy is a
 * markdown file in `docs/specifications`; the client never holds the authoritative
 * copy. These schemas describe the frontmatter the cockpit reads and the board
 * projects — they do not store the spec body, which lives in git.
 */

/** Specification status, carried in frontmatter (FR-5). The terminal value is `delivered` (SPEC-024) —
 *  it names the governance outcome (landed on the mainline as current truth), not the git mechanism, so
 *  it stays correct for a PR merge or a local merge. Legacy on-disk `status: merged` is coerced to
 *  `delivered` when frontmatter is read (see spec-doc.ts). */
export const SpecStatus = z.enum(["draft", "in-review", "approved", "delivered"]);
export type SpecStatus = z.infer<typeof SpecStatus>;

/**
 * Governance assurance level (SPEC-024, host-optional). The board surfaces this so a viewer knows how
 * strongly the second-human approval invariant is enforced:
 * - `host-enforced` — a git host is configured; PR review + branch protection enforce approver ≠ owner.
 * - `team`          — no host, but an in-app approver identity (≠ owner) attests each approval.
 * - `solo`          — no host and no distinct approver; self-approval is permitted but flagged + audited.
 */
export const GovernanceLevel = z.enum(["host-enforced", "team", "solo"]);
export type GovernanceLevel = z.infer<typeof GovernanceLevel>;

/**
 * Logical model tiers. Agents reference tiers, resolved per project to a gateway (FR-4, D10):
 * - `capable` — authoring & review (the strongest model)
 * - `mid`     — implementation
 * - `fast`    — routine, classification & projection drafts (the cheapest/quickest model)
 */
export const ModelTier = z.enum(["capable", "mid", "fast"]);
export type ModelTier = z.infer<typeof ModelTier>;

/** Frontmatter block at the head of every specification file. */
export const SpecFrontmatter = z.object({
  specId: z.string(), // e.g. "SPEC-016"
  slug: z.string(), // e.g. "webhook-verify"
  title: z.string(),
  status: SpecStatus,
  owner: z.string(),
  branch: z.string(), // feature branch the working draft lives on
  sourceOfTruth: z.literal("git").default("git"),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  prNumber: z.number().int().optional(),
});
export type SpecFrontmatter = z.infer<typeof SpecFrontmatter>;

/**
 * The specification anatomy (FR-1). The cockpit renders the working file section by
 * section against this outline; it is a view, not a second copy of the spec.
 */
export const SPEC_ANATOMY = [
  // Why / What changes lead the template and are where a blank-slate conversation starts (SPEC-020);
  // without them in the anatomy, the agent's earliest writes were invisible in the live preview.
  { key: "why", title: "Why", sections: [] },
  { key: "what-changes", title: "What changes", sections: [] },
  {
    key: "requirements",
    title: "Requirements",
    sections: ["summary", "scope", "acceptance criteria", "open questions"],
  },
  {
    key: "design",
    title: "Design",
    sections: [
      "architectural decision",
      "target architecture",
      "data model",
      "API contracts",
      "application services",
      "security",
      "performance",
    ],
  },
  {
    key: "tasks",
    title: "Tasks",
    sections: ["implementation plan", "testing", "definition of done", "decision log"],
  },
] as const;
