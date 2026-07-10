---
type: index
generated: true
---

<!-- GENERATED FILE — do not edit by hand. Regenerated from this folder's document frontmatter
     by the Arke coordinator (SPEC-026). Edit the documents, not this index. -->

# Decisions

| Type | Title | Description |
|------|-------|-------------|
| convention | [ADR 0001 — Thin client over a harness, with a thin local coordinator](0001-thin-client-local-coordinator.md) | - **Status:** accepted - **Date:** 2026-06-28 - **PRD decisions:** D2 (no cloud backend on the hot path), D12 (thin local coordinator) |
| convention | [ADR 0002 — Omnigent is a candidate harness *substrate*, not a rival; keep the adapter seam neutral](0002-omnigent-as-candidate-harness-substrate.md) | - **Status:** proposed - **Date:** 2026-06-29 - **PRD decisions:** D11 (tier→model→harness routing through one adapter seam), D14 (ACP/meta-harness as the future normalisation path) - **Supersedes/relates:** [ADR 0001](0001-thin-client-local-coordinator.md) (the coordinator + `HarnessAdapter` seam this builds on) |
| convention | [ADR 0003 — WebSocket (not SSE+REST) for the coordinator→client leg](0003-websocket-over-sse-for-the-client-leg.md) | - **Status:** accepted - **Date:** 2026-06-29 - **PRD decisions:** D2 (no cloud backend on the hot path), D12 (thin local coordinator) - **Relates:** [ADR 0001](0001-thin-client-local-coordinator.md), [SPEC-003](../specifications/003.coordinator-domain-model-and-transport.md), [SPEC-017](../specifications/017.arke-cli.md) |
| convention | [ADR 0004 — Keep Arke's harness-agnostic, tier-indirected agent model; map onto Omnigent at the boundary](0004-agent-model-vs-omnigent-and-the-substrate-mapping.md) | - **Status:** proposed - **Date:** 2026-06-29 - **Relates:** [ADR 0002](0002-omnigent-as-candidate-harness-substrate.md) (Omnigent as substrate — spike now GREEN, PR #11), [ADR 0001](0001-thin-client-local-coordinator.md) (the `HarnessAdapter` seam). Grounds: SPEC-016 (portable agent images), SPEC-005 (harness & model registry). |
| convention | [ADR 0005 — Multi-codebase specifications: one canonical spec in the owning repo; ripples and projections everywhere else](0005-multi-codebase-spec-storage.md) | - **Status:** proposed - **Date:** 2026-07-08 - **PRD decisions:** D3 (the specification is the source of truth), D4 (deterministic projection), D18 (one spec file per feature; roll-up views are generated read-only, never authored) - **Relates:** AGENTS.md rules 1 & 4 (spec as source of truth; deterministic projections), [`specification.template.md`](../specifications/specification.template.md) (the scope note: "generate roll-ups, do not fragment where people author"), [SPEC-018](../specifications/018.multi-project-workspaces.md) (multi-project workspaces), [SPEC-026](../specifications/026.okf-bundle-indexes.md) (generated indexes as the projection precedent). Grounds: [SPEC-030](../specifications/030.cross-repo-specifications.md) (cross-repo specification linkage). |
