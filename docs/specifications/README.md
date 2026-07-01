# Specifications

This is the spec library — the unit of work in Arke. Every feature is one
`specification.md` authored on its branch, reviewed, and approved here. Artifacts
(tickets, tests, tracking, docs) are generated *from* these files, never beside them.

- **Format:** [`specification.template.md`](specification.template.md) — the canonical
  shape and the lifecycle rules. A worked example: [`examples/user-data-export.md`](examples/user-data-export.md).
- **Roster the specs assume:** [`../agent-roster-and-model-resolution.md`](../agent-roster-and-model-resolution.md).
- **Source of truth for scope:** [`../PRD-Arke.html`](../PRD-Arke.html) (FR-1 … FR-22, NFR-1 … NFR-8).
- **Design template:** the [`arke-design` skill](../../.claude/skills/arke-design/SKILL.md)
  (`.claude/skills/arke-design/`) — the canonical Arke design system (shadcn neutral tokens,
  Geist, Lucide, the prototype screens, and the launch-screen designs). Every spec's UI
  references it rather than re-deriving styling.

## How this set was decomposed

The PRD's functional requirements were grouped into **coherent vertical slices**, each sized
to roughly an **8-story-point feature** — a single feature a Product Engineer could own end to
end in about a week, with its own branch, its own spec, and a board card that moves on its own.
Slices follow capability boundaries, not screens: a screen that is only meaningful with its
backend (the board, the cockpit) is specified together with that backend; small supporting
screens (settings, notifications, agent-roster viewer, command palette) ride along with the
feature they belong to rather than getting their own spec.

[`001.foundation-and-scaffold.md`](001.foundation-and-scaffold.md) is already built (the
monorepo, contracts, coordinator skeleton, adapter skeleton, client baseline, scaffolding);
its launch-screen requirement (R-6 — the splash + harness probe, per the `arke-design` skill)
is the remaining UI piece. The specs below are the proposed Phase-1 → Phase-2 build-out. All are `status: draft` — they
are the plan, to be authored/reviewed/approved through the cockpit before implementation.

## The feature specs

| # | Feature | Covers (PRD) | Phase | ~pts |
|---|---------|--------------|-------|------|
| 002 | [OpenCode harness adapter — live](002.opencode-harness-adapter.md) | FR-2, FR-4, FR-8; §15; NFR-5/8 | 1 | 8 |
| 003 | [Coordinator domain model & resilient transport](003.coordinator-domain-model-and-transport.md) | FR-9 (backend); NFR-3/8 | 1 | 8 |
| 004 | [Project setup: onboarding, scaffold & grounding](004.project-setup-and-grounding.md) | FR-3, FR-18, FR-20 | 1 | 8 |
| 005 | [Harness & model registry and routing](005.harness-and-model-registry.md) | FR-4, FR-19 | 1–2 | 8 |
| 006 | [Authoring cockpit: chat + live preview](006.authoring-cockpit.md) | FR-1, FR-14, FR-15 | 1 | 8 |
| 007 | [Multi-model review panel](007.multi-model-review-panel.md) | FR-16 | 1 | 8 |
| 008 | [Spec lifecycle, governance & library](008.spec-lifecycle-and-library.md) | FR-5, FR-12 | 1 | 8 |
| 009 | [Parallel task execution (fan-out)](009.parallel-task-execution.md) | FR-8 | 1 | 8 |
| 010 | [Delivery board as a live projection](010.delivery-board.md) | FR-9, FR-19 (board) | 1 | 8 |
| 011 | [Session detail, diff review, rescue & steering](011.session-detail-and-rescue.md) | FR-11, FR-22; NFR-4 | 1 | 8 |
| 012 | [Human-in-the-loop permissions & elicitation](012.human-in-the-loop-permissions.md) | FR-10 | 1 | 5–8 |
| 013 | [Generation workspace: propose · decide · execute](013.generation-workspace.md) | FR-6, FR-17 | 1–2 | 8 |
| 014 | [Deterministic projection & integrations registry](014.deterministic-projection-and-integrations.md) | FR-7, FR-21; §9/14 | 2 | 8 |
| 015 | [Audit, activity trace & observability](015.audit-trace-and-observability.md) | NFR-7, NFR-2 | 1–2 | 8 |
| 016 | [Managed harness lifecycle, richer approvals & portable agent images](016.harness-lifecycle-approvals-and-agent-images.md) | FR-4, FR-10; §12, §15; [ADR-0002](../decisions/0002-omnigent-as-candidate-harness-substrate.md) | 2 | 8 |
| 017 | [Arke CLI — spin up, open & drive the system headlessly](017.arke-cli.md) | FR-8/9/10 (operator surface); NFR-1/7 | 2 | 8 |
| 018 | [Multi-project workspaces — one coordinator, per-project runners](018.multi-project-workspaces.md) | FR-3/20 (multi-project); NFR-1/4/7 | 2 | 8 |
| 019 | [Global + project configuration merge and first-run harness setup](019.global-and-project-config-merge.md) | FR-3/4/19; NFR-1; [ADR-0004](../decisions/0004-agent-model-vs-omnigent-and-the-substrate-mapping.md) | 2 | 8 |

**Folded in (not separate specs):** command palette (FR-13, *could*) rides in the cockpit
(006) and board (010); settings / notifications / agent-roster viewer ride in the features
they serve. **Deferred to the team tier:** read-only delivery view, multi-human spec review,
central runners, managed roster sync — out of scope until Phase 3.

## Dependency order (suggested build sequence)

```
001 foundation ─┬─▶ 002 adapter ─▶ 003 coordinator+transport ─┬─▶ 010 board
                │                                              ├─▶ 011 session detail
                ├─▶ 004 project setup ─▶ 005 registry          └─▶ 012 permissions
                └─▶ 006 cockpit ─▶ 007 review ─▶ 008 lifecycle
                                                   └─▶ 009 fan-out ─▶ 013 generation ─▶ 014 projection
                    015 audit/observability spans every feature (build incrementally)
                    016 harness lifecycle + approvals + agent images builds on 002/005/012 (Phase 2)
                    017 arke CLI builds on 002/003/016 (Phase 2) — spin up + drive headlessly
                    018 multi-project builds on 003/004/016 (Phase 2) — one coordinator, per-project runners
                    019 global+project config merge builds on 004/005/018 (Phase 2) — configure the harness once, inherit per project
```

Author each in the cockpit, run the review panel, and approve before implementation — Arke,
building Arke.
