<div align="center">

# Arke

**The Specification Orchestrator** — a React client and a thin local coordinator that sit
on top of a coding-agent harness and make the **specification the unit of work**, from
authoring through delivery.

`one specification · authored once · drives the whole delivery`

</div>

---

## What this is

AI code generation is fast but unreliable without structure. Arke turns the
specification-centric engineering method into a working product: the specification is
co-authored by a human and AI, grounded in the codebase, and becomes the single source of
truth. Everything downstream — tasks, code, tickets, tests, tracking, docs — is a
**generated projection** of it and is kept in step with it.

Arke does **not** replace the coding agent and does **not** become a system of record.
It is the cockpit a Product Engineer works in to orchestrate three things: authoring a
specification, dispatching the agents that work against it, and a live kanban view of the
specification moving across delivery. The harness owns execution; the orchestrator owns
realisation, visualisation and coordination.

The first harness is **OpenCode** (headless server, typed API, granular event stream,
open-source and self-hostable). A backend-agnostic adapter keeps the orchestration logic
independent of any single harness, so Claude Code, Copilot and others can be added later.

> Full product definition: [`docs/PRD-Specification-Orchestrator.html`](docs/PRD-Specification-Orchestrator.html).
> Design baseline: [`docs/design/specification-orchestrator-prototype.html`](docs/design/specification-orchestrator-prototype.html).

## Principles

- **The specification is the source of truth** — a file in `docs/specifications`, versioned
  and reviewed via pull request. Projections never flow back into it.
- **The harness owns execution and credentials** — the browser is never in the credential
  path and never calls a system of record.
- **Propose · decide · execute** — no agent output is acted on without a human decision in
  between.
- **Projections to systems of record are deterministic code**, logged with their trigger.
- **Every governed action is recorded** — in git, and in an append-only local trace.

## Repository layout

```
Arke/
├─ packages/
│  ├─ contracts/        schema-first domain contracts (zod): spec, events, adapter
│  ├─ coordinator/      thin local WebSocket coordinator + read model + audit trace
│  ├─ adapter-opencode/ first harness adapter (OpenCode server + SSE)
│  └─ client/           the React orchestrator UI (cockpit, board, review, …)
├─ apps/
│  └─ desktop/          Electron shell skeleton (embeds the coordinator)
├─ .opencode/agents/    versioned agent roster (PO, architect, engineering, impl, reviewer)
├─ docs/
│  ├─ specifications/   the specs + specification.template.md
│  ├─ decisions/        ADRs
│  ├─ design/           the approved design prototype
│  └─ analysis/         delivery reports & the OpenCode integration guide
└─ AGENTS.md            grounding for coding agents (mirrored by CLAUDE.md)
```

## Getting started

```bash
# Requirements: Node >= 20, npm >= 10
npm install

# Run the React client (design baseline)
npm run dev                 # → http://localhost:5173

# Run the local coordinator (mock adapter — emits a scripted event stream)
npm run dev:coordinator     # → ws://127.0.0.1:4319

# Build / typecheck everything
npm run build
npm run typecheck
```

## Status

Early foundation (Phase 1 — "prove the loop"). Landed: the monorepo, schema-first
contracts, the coordinator skeleton (mock-driven), the OpenCode adapter interface +
skeleton, the React client reproducing the design baseline, and the method scaffolding
(agent roster, specification template, grounding). Next: wire the client transport to the
coordinator and implement the OpenCode adapter against a live server. See
[`docs/analysis`](docs/analysis) for the delivery report and the OpenCode integration guide,
and [`docs/specifications/001.foundation-and-scaffold.md`](docs/specifications/001.foundation-and-scaffold.md)
for the foundation spec.

## License

[MIT](LICENSE) · open source for any team practising spec-centric engineering.
