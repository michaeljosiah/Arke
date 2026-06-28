<!--
==============================================================================
  SPECIFICATION TEMPLATE
  One file per feature. This file is the source of truth for the change.
  Artifacts (tickets, tests, tracking, docs) are generated from it, not beside it.

  THE FORMAT IN ONE BREATH
  - One specification.md per feature, authored on the feature branch, living in
    docs/specifications/ for the whole life of the branch.
  - The BODY always reads as the current contract. Delta tags mark what THIS
    change does while it is in flight; they flatten away on merge.
  - Requirements use SHALL / MUST and every requirement carries at least one
    Scenario in WHEN / THEN form. Scenarios use exactly four hashes (####).
  - Depth is scalable: a small change fills Why, Requirements and Tasks; a large
    one fills the Design sub-sections too. Drop sections you do not need; do not
    drop the rules above.

  HOW THIS FILE EVOLVES is written out at the very bottom. Read it once.
  Delete this comment block when you scaffold a real spec, or keep it as a guide.
==============================================================================
-->

---
spec_id: SPEC-YYYY-MM-DD-<slug>
title: <human title>
status: draft            # draft -> in-review -> approved   (a commit, never a merge)
branch: <feature-branch>
owner: <product engineer>
capabilities: [<capability-a>, <capability-b>]   # the domains this change touches
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# <Title>

## Why
<!-- 1-2 sentences. The problem or opportunity, and why now. Not the how. -->

## What changes
<!-- Bullets. Be specific about new, modified and removed behaviour.
     Tag each line with its delta verb and mark breaking changes. -->
- ADDED <capability> — <what becomes possible>
- MODIFIED <capability> — <what behaviour changes>   (breaking: no)
- REMOVED <capability> — <what goes away>

---

## Requirements
<!-- THE WHAT. This is the contract. Each requirement is normative (SHALL/MUST)
     and carries at least one scenario. The metadata line names the capability,
     and — only while this change is in flight — the delta operation and the
     branch that owns it. On merge the delta tag is removed (see lifecycle). -->

### Requirement: <name>
`capability: <capability>` · `delta: ADDED (<branch>)`

The system SHALL <observable, testable behaviour>.

#### Scenario: <name>
- **WHEN** <trigger / precondition>
- **THEN** <observable outcome>
- **AND** <further outcome, optional>

<!-- Repeat per requirement. A requirement with no delta tag is settled,
     enduring contract. A tag means it is being changed on this branch. -->

### Requirement: <name>
`capability: <capability>` · `delta: MODIFIED (<branch>)`

The system SHALL <full updated behaviour — write the WHOLE requirement, not a fragment>.

#### Scenario: <name>
- **WHEN** <trigger>
- **THEN** <outcome>

---

## Design
<!-- THE HOW. Scale to the change. Small changes: a paragraph. Large changes:
     fill the sub-sections that apply and delete the rest. Implementation detail
     lives here, not in Requirements. -->

### Architectural decision
<!-- The decision and the one-line rationale. -->

### Target architecture
<!-- Components and how they fit. A diagram reference is fine. -->

### Data model
<!-- Entities, fields, migrations. -->

### Interfaces and contracts
<!-- APIs, events, schemas the change introduces or alters. -->

### Cross-cutting
<!-- Security, performance, observability, accessibility — whichever apply.
     For any UI, reference the canonical design template (the `arke-design` skill) rather
     than re-deriving styling, e.g.:
     - **Design template:** the UI follows the `arke-design` skill (`.claude/skills/arke-design/`)
       — shadcn neutral tokens, Geist, Lucide, and the prototype screens. -->
- **Design template:** the UI follows the `arke-design` skill (`.claude/skills/arke-design/`).

---

## Tasks
<!-- THE EXECUTION. An ordered, checkable list. The agent works these; the board
     projects them. Group into phases for larger changes. -->
- [ ] <task>
- [ ] <task>
- [ ] <task>

### Testing
<!-- Unit / integration / manual. Acceptance is already covered by the Scenarios
     above; this is how they are verified. -->

### Definition of done
<!-- The bar for "approved". E.g. all scenarios pass, checks green, reviewer signed off. -->

---

## Decision log
<!-- Durable decisions and their rationale, append-only. -->
| # | Decision | Rationale |
|---|----------|-----------|
| 1 | <decision> | <why> |

## Open questions
<!-- Unresolved items that should not block a draft but must close before approved. -->
- <question>

## Change history
<!-- Appended at each lifecycle transition. The lineage of the contract. -->
- YYYY-MM-DD · <branch> · <status reached> — <one-line summary of the delta>

<!--
==============================================================================
  HOW THIS SPECIFICATION EVOLVES
  ------------------------------------------------------------------------------
  STATUS is a committed value in the frontmatter, never a merge to main:
      draft       being authored; incomplete is fine
      in-review   complete enough to critique; review panel + human run here
      approved    agreed; fan-out to tickets/tests/tracking may proceed
  A material change to an approved spec drops it back to in-review and ripples
  to anything projected from it. Status is reversible.

  WHILE IN FLIGHT (on the feature branch)
  - The requirements this change touches carry a `delta:` tag naming the
    operation and the branch. Untagged requirements are the settled contract.
  - The cockpit highlights the tagged requirements, so the live preview reads as
    a contract-level diff: reviewers see exactly what this change does.
  - Delta operations:
      ADDED      a new requirement
      MODIFIED   changed behaviour — write the FULL updated requirement, not a
                 fragment, so nothing is lost when it flattens
      REMOVED    a requirement going away — keep a tombstone (see below)
      RENAMED    a name change only — note FROM / TO in the change history

  ON MERGE (the feature merges to main once, at the end) the deltas FLATTEN:
  - ADDED / MODIFIED  -> drop the `delta:` tag. The requirement is now plain,
                         enduring contract, indistinguishable from the rest.
  - REMOVED           -> cut the requirement from the body and leave one
                         tombstone line under a "## Removed" note:
                         > REMOVED <capability>/<name> — Reason: <why> ·
                           Migration: <what to do instead>
  - RENAMED           -> apply the new name in place.
  - Append one line to Change history recording the net effect.
  After flatten, the BODY again reads purely as the current contract, the
  delta tags are gone, and Change history holds the lineage. One file, one
  preview, one approval, full history.

  SCOPE NOTE
  The unit is the feature spec, so a single file stays scoped and readable; it
  does not grow without bound. "The complete current contract for capability X"
  is therefore assembled across the feature specs that touched X. If a
  per-capability current-truth view is wanted later, GENERATE it as a read-only
  roll-up from these files — do not fragment where people author.
==============================================================================
-->
