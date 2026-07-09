---
type: domain-glossary
title: Arke domain glossary
created: 2026-07-09
updated: 2026-07-09
---

# Arke domain glossary

The shared vocabulary of Arke — the terms a specification, an agent, or a reviewer should use
consistently. Definitions here are the canonical meaning; when a spec uses one of these words it means
this, not a looser everyday sense.

## Core concepts

- **Specification (spec)** — the unit of work: a reviewed markdown file under `docs/specifications`.
  Its canonical copy in git is the source of truth; projections never flow back into it.
- **Lifecycle** — the governed states a spec moves through: `draft → in-review → approved → delivering
  → delivered` (plus `archived`). Transitions pass through a single gated promotion door and are
  recorded.
- **Coordinator** — the thin local Node service that ingests harness events, normalises and validates
  them, folds a read model, persists the audit trace, and serves the client over WebSocket. No cloud
  backend sits on the hot path.
- **Harness** — the coding-agent execution host (OpenCode first) that owns the repository, agents,
  CLI, MCP servers, and credentials. Arke coordinates it; it does the work.
- **Adapter** — the backend-specific bridge implementing the `HarnessAdapter` contract, normalising a
  harness's native events/capabilities into Arke's domain model. The board degrades to the adapter's
  real surface.
- **Agent image / roster** — the versioned definition of an agent role (spec-author, architect,
  reviewer-a/-b, implementer, researcher), including the model it pins. The agent *is* the model.

## Governance & review

- **Review panel** — a multi-model review of a draft: at least two provably-distinct models critique
  it independently; cross-reviewer agreement is surfaced. A completed review gates promotion.
- **Permission (human-in-the-loop)** — the decision step between an agent proposal and any governed
  act. Propose · decide · execute: nothing reaches a system of record without a human choosing it.
- **Trace** — the append-only audit log (`.arke/trace.ndjson`): permission decisions, projections, and
  index regenerations, each with its trigger. Spec history itself lives in git.
- **Projection** — deterministic, code-generated output derived from a spec (tickets, tests, docs,
  bundle indexes). Always code, never free-form agent behaviour; every write is logged.

## Delivery

- **Delivery (single-session)** — one implementer session receives an approved spec's `## Tasks`
  checklist and works the whole list, checking items off as it completes them. That checklist is the
  completion oracle.
- **Delivery worktree** — the isolated git worktree (a `--delivery` sibling branch) the delivery
  session runs in, so its edits never disturb the human's working tree.
- **Auto-PR** — the per-project option for the implementer to open the pull request itself on
  delivery (targeting the feature branch), instead of stopping at the diff-review gate.
- **Board** — the delivery view: one card per spec, folding that spec's sessions.

## Knowledge & grounding

- **OKF (Open Knowledge Format)** — the convention that the whole `docs/` tree is markdown bundles:
  each authored document carries a `type:`, concepts link with markdown links, and each bundle has a
  **generated** `index.md`. Adopted as format, not platform.
- **Grounding** — read-only context injected into authoring and review. Two tiers: **committed**
  grounding is the typed OKF documents under `docs/` (public-safe, selected by `type`, not folder);
  **local** grounding is the git-ignored `.arke/grounding/` tier for sensitive or per-effort material.
- **Grounding type** — a document `type:` that marks it foundational: `product-overview`,
  `business-context`, `domain-glossary`, `architecture`, or `convention`. These are selected into the
  grounding digest wherever they live under `docs/`.

See [`docs/product-overview.md`](product-overview.md) and [`docs/business-context.md`](business-context.md).
