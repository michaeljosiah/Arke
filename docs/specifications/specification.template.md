---
specId: SPEC-000
slug: short-kebab-slug
title: One-line feature title
status: draft            # draft → in-review → approved → merged
owner: your.handle
branch: spec/short-kebab-slug
sourceOfTruth: git
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

<!--
  SpecOne · Canonical specification template (PRD §12.2, D18).

  One specification file per feature. It is the unit of work: the cockpit previews it,
  the review panel critiques it, the board projects it, and the generation workspace
  fans it out into tickets, tests, docs and tracking. The spec is the source of truth —
  downstream artifacts are generated projections and never flow back into it.

  Method rules baked into this template:
  - Requirements are normative SHALL statements; each carries at least one WHEN/THEN
    scenario so it is testable.
  - Changes after first approval are marked with in-place delta tags
    {+added+} / {-removed-} / {~changed~} that flatten into plain contract on merge.
  - The file is authored on `branch`, reviewed via pull request, and only becomes
    authoritative on approval.
-->

# 1 · Requirements

## 1.1 Summary
_What this feature is and why, in two or three sentences._

## 1.2 Scope
**In scope**
- …

**Out of scope**
- …

## 1.3 Acceptance criteria
Each requirement is a SHALL statement with at least one WHEN/THEN scenario.

- **R-1** The system SHALL …
  - **WHEN** … **THEN** …
- **R-2** The system SHALL …
  - **WHEN** … **THEN** …

## 1.4 Open questions
- …

# 2 · Design

## 2.1 Architectural decision
_The decision taken and the alternatives rejected._

## 2.2 Target architecture
_Components, boundaries, and how this fits the existing system._

## 2.3 Data model
_Entities, fields, relationships, migrations._

## 2.4 API contracts
_Endpoints / messages / events, request and response shapes, error paths._

## 2.5 Application services
_Where the logic lives; service responsibilities._

## 2.6 Security
_AuthN/Z, secrets, trust boundaries, data handling._

## 2.7 Performance
_Targets, hot paths, expected load._

# 3 · Tasks

## 3.1 Implementation plan
Atomic, independently dispatchable tasks (each becomes a child session, FR-8).

- [ ] **T-1** …
- [ ] **T-2** …

## 3.2 Testing
_Unit, integration, and acceptance coverage mapped back to the R-n criteria._

## 3.3 Definition of done
- [ ] Typecheck and checks pass
- [ ] Acceptance criteria met and demonstrated
- [ ] Reviewer approved the spec and the generated change

## 3.4 Decision log
| # | Decision | Rationale |
|---|----------|-----------|
| D1 | … | … |
