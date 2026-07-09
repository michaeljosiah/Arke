---
type: business-context
title: Why Arke exists — the problem and the wager
created: 2026-07-09
updated: 2026-07-09
---

# Why Arke exists — the problem and the wager

Coding agents are now capable enough to implement real changes, but teams cannot let them touch a
system of record unsupervised: an agent that is right most of the time is still wrong often enough
that ungoverned autonomy is unacceptable in a repository people depend on. Arke's wager is that the
missing piece is not a smarter agent but a **governed workflow** — one where a durable, reviewed
specification is the unit of work, and a human decision sits between every agent proposal and every
irreversible act.

## The problem

- **Prompt-driven work is not durable.** A chat transcript is not a reviewable artefact; it cannot be
  diffed, approved, or pointed to as the reason something shipped.
- **Autonomy without a gate is a liability.** The failure mode that matters is not "the agent is slow"
  — it is "the agent changed a system of record and no human chose to let it."
- **Grounding drifts.** Agents author against whatever context happens to be in the prompt, so drafts
  duplicate existing work, contradict the product, or miss the domain's own vocabulary.

## The approach as a value proposition

- **A reviewed spec is the contract.** It is a markdown file in git, versioned and reviewed via pull
  request; everything downstream is a projection of it.
- **Independence is verifiable.** Review runs on at least two provably-distinct models, so agreement
  is meaningful rather than one model grading its own homework.
- **Governance is the product, not a setting.** The lifecycle gate, the human-in-the-loop permission
  step, and the append-only audit trace are the reasons a team can safely delegate delivery.

## Boundaries

Arke is a coordination and governance layer, **not** a coding-agent harness and **not** a hosted
service on the delivery hot path. It stays backend-agnostic (OpenCode is the first adapter) and keeps
credentials host-side. Sensitive, non-public material (client detail, private endpoints) belongs in
the git-ignored `.arke/grounding/` local tier — never in the tracked `docs/` tree.

See [`docs/product-overview.md`](product-overview.md) for what Arke is and
[`docs/domain-glossary.md`](domain-glossary.md) for the vocabulary.
