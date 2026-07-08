# ADR 0005 — Multi-codebase specifications: one canonical spec in the owning repo; ripples and projections everywhere else

- **Status:** proposed
- **Date:** 2026-07-08
- **PRD decisions:** D3 (the specification is the source of truth), D4 (deterministic projection),
  D18 (one spec file per feature; roll-up views are generated read-only, never authored)
- **Relates:** AGENTS.md rules 1 & 4 (spec as source of truth; deterministic projections),
  [`specification.template.md`](../specifications/specification.template.md) (the scope note:
  "generate roll-ups, do not fragment where people author"),
  [SPEC-018](../specifications/018.multi-project-workspaces.md) (multi-project workspaces),
  [SPEC-026](../specifications/026.okf-bundle-indexes.md) (generated indexes as the projection precedent).
  Grounds: [SPEC-030](../specifications/030.cross-repo-specifications.md) (cross-repo specification linkage).

## Context

A specification sometimes describes a change that touches **multiple codebases** — a contract
change that lands in a service repo and two consumer repos, a protocol change spanning client
and server, a capability whose system of record lives in one repo but whose surface lives in
another. The question is where the specification's canonical copy lives.

Arke's existing conventions constrain the answer more than they first appear to:

- **Rule 1** — the spec's canonical copy is a versioned markdown file in `docs/specifications`,
  authored on the feature branch and reviewed via pull request. The lifecycle (status commits,
  delta tags naming the owning branch, flatten-on-merge) is welded to *one repo's* git history,
  deliberately: contract review and code review happen in the same PR stream.
- **Rules 1 & 4** — nothing downstream overrides the spec, and everything derived from it is a
  deterministic, logged projection that never flows back. Two *authored* copies of one spec is
  two sources of truth that will drift; duplication is disqualified by construction.
- **The template's scope note** — "the complete current contract for capability X is assembled
  across the feature specs that touched X … if a roll-up view is wanted, *generate* it read-only;
  do not fragment where people author." Author in exactly one place; generate views elsewhere.
- **SPEC-018** — the coordinator is one control plane over N isolated project contexts, but each
  project's spec library, trace, and sessions are deliberately per-project. A cross-project
  board was considered and deferred. Today, "one spec, several repos" has no first-class support.

The tempting alternatives each break a convention: **duplicating** the spec into every affected
repo breaks single-source-of-truth; a **dedicated specs repo** divorces contract review from code
review, breaks the branch-coupled delta lifecycle (delta tags name a feature branch in a repo the
code doesn't live in), and recreates exactly the fragmentation the scope note warns against.

## Decision

1. **Notice when the question is a symptom.** If a set of codebases *routinely* needs joint
   specification, that is evidence they are one system: co-location (a monorepo) dissolves the
   problem — one repo, one `docs/specifications`. This is Arke's own answer to itself (SPEC-001).
   Only when co-location is not available does the rest of this ADR apply.

2. **The canonical spec lives in the repo that owns the capability.** Every spec declares
   `capabilities:` in its frontmatter and slices follow capability boundaries. Extended across
   repos: the repo holding the shared contract/schema — or the system of record for the specified
   behaviour — owns the canonical spec, authored and reviewed there per the existing lifecycle.
   The other repos are *affected*, not owners.

3. **Affected repos get ripples, never copies.** Each affected repo receives exactly one of:
   - **A thin delta ripple spec** (when its own contract changes): a locally authored spec whose
     requirements carry normal `delta:` tags for *that repo's* portion of the change, plus an
     explicit machine-readable back-reference to the canonical spec. This keeps each repo's spec
     library a complete local contract — which matters, because that library grounds the agents
     working in that repo.
   - **A generated read-only pointer** (when nothing in its local contract changes): a projection
     in the rule-4 sense — produced by deterministic code, logged with its trigger, never
     hand-edited (the same posture as SPEC-026's generated `index.md` files).

4. **No neutral "specs repo".** Reserved only for genuinely repo-less specifications (org-wide
   policy, protocol standards owned by no implementation) — and even then each consuming repo's
   view is a generated projection, not a second authored copy.

5. **Linkage is frontmatter, both directions.** The canonical spec enumerates its ripples
   (`ripples:`); every ripple names its canonical (`canonical:`). The exact fields, validation,
   and coordinator behaviour are specified in SPEC-030, not here.

## Consequences

- **One source of truth survives multi-repo reality.** Review, status, and history stay in one
  place; drift between repos is structurally impossible for the authored contract.
- **Each repo's library stays locally complete.** An agent (or human) in an affected repo sees
  that repo's real contract plus a pointer to the driver — never a stale copy.
- **Lifecycle coupling becomes an obligation.** A material change to a canonical spec must
  surface on its ripples (they cannot silently go stale); this is a coordinator responsibility
  and part of SPEC-030's scope.
- **The deferred cross-project board (SPEC-010/018) gains a concrete justification** beyond
  convenience: visualising a canonical spec and its ripples across project contexts.
- **Choosing the owning repo is a judgement call** the convention only guides (contract/schema
  holder, or system of record). Contested ownership is decided at review time and recorded in
  the canonical spec's decision log.
