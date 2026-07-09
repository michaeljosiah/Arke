---
type: product-overview
title: Arke — the Specification Orchestrator
created: 2026-07-09
updated: 2026-07-09
---

# Arke — the Specification Orchestrator

Arke makes the **specification the unit of work**. It is a React client plus a thin local coordinator
that sits on top of a coding-agent harness (OpenCode first) and drives a spec from authoring, through
independent multi-model review, to reviewed delivery — while a human decides at every governed step.
The orchestrator realises, visualises, and coordinates; the harness owns execution and credentials.

## Who it is for

Engineers and teams who want AI agents to do real delivery work against a repository **without**
surrendering control of what ships. The person authoring the spec stays the decision-maker: agents
propose, the human decides, the harness executes.

## The core loop

1. **Author** — a blank-slate spec grows in a live cockpit as the engineer converses with the
   spec-author agent. Foundational grounding (this document and its siblings) and the existing spec
   corpus are injected so every draft is consistent with the product and does not duplicate the corpus.
2. **Review** — a panel of independent, provably-distinct models critiques the draft; agreement across
   reviewers is surfaced. A draft may not advance until it is well-formed and has a completed review.
3. **Approve** — a single gated promotion door moves the spec through its lifecycle
   (`draft → in-review → approved → …`); every transition is recorded.
4. **Deliver** — one implementer session receives the approved spec's task checklist, works in an
   isolated git worktree, checks tasks off as it goes, and (when the project opts in) opens the pull
   request itself. The board shows one card per spec, folding its sessions.

## What makes it different

- **The spec is the source of truth.** Its canonical copy is a reviewed markdown file in
  `docs/specifications`; projections (tickets, tests, docs) are generated from it and never flow back.
- **Propose · decide · execute.** No agent output reaches the repository or a teammate without a
  human decision in between.
- **The browser is never in the credential path.** All repo, agent, CLI, and MCP access happens inside
  the harness host; every governed action is recorded in an append-only trace.
- **Format, not platform.** Knowledge lives as plain markdown in git under the Open Knowledge Format
  (OKF) convention — no runtime lock-in.

See [`docs/PRD-Arke.html`](PRD-Arke.html) for the full product definition and
[`docs/business-context.md`](business-context.md) for why Arke exists.
