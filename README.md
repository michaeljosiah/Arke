<div align="center">

# Arke

### Author the spec. Orchestrate the build. Keep the record.

**Arke is the Specification Orchestrator** — a React client and a thin local coordinator
that sit on top of a coding-agent harness and make the **specification the unit of work**,
from authoring through delivery, across any coding agent.

</div>

![AI Engineering: from "vibe coding" to enterprise-grade specifications](docs/assets/ai-engineering-maturity-roadmap.png)

<div align="center"><sub>The maturity ladder Arke is built for: from quick prompts, to context engineering, to a single authoritative <code>specification.md</code> that drives the whole delivery.</sub></div>

---

## Why Arke exists

AI code generation is fast but unreliable without structure. Teams climb a maturity ladder
to fix that (the picture above):

1. **Vibe coding** — free-flow prompting. Fun and fast for prototypes, but error-prone,
   standard-less, and unfit for production.
2. **Context engineering** — ground the AI in the codebase with `AGENTS.md` (the baseline
   identity), guides (the rules of the game) and reusable prompts (task execution).
3. **Specification-driven development** — add process on top. The heavy form split work
   across `requirements.md`, `specifications.md` and `tasks.md`; the mature form **collapses
   them into one `specification.md`** that holds intent, design, constraints and tasks in a
   single authoritative file.

At that top rung, the specification becomes the centre of gravity — and the engineer's role
shifts from writing lines of code to **owning what gets built**: closer to a *Product
Engineer* than a coder. The method works on paper, but it has had no home: engineers drive
agents by hand, keep tickets and tests in step with the spec manually, and track delivery in
tools built for human-authored cards.

**Arke is that home.** It turns the specification-centric method into a working product.

## What Arke is

Arke is the cockpit a Product Engineer works in to orchestrate three things:

- **Author** a specification — co-authored by a human and AI, grounded in the codebase,
  reviewed by a multi-model panel, and committed to the repo as the single source of truth.
- **Orchestrate** the agents that build against it — dispatched as parallel, non-blocking
  sessions, with human approval at every permission and decision point.
- **Keep the record** — a live kanban board that reflects *real* delivery state from the
  harness's event stream (a card moves because the work moved), plus an audit trail of who
  approved what.

Everything downstream — tasks, code, tickets, tests, tracking, docs — is a **generated
projection** of the specification and is kept in step with it. When the spec changes, the
projections are regenerated; nothing downstream flows back into the spec.

```
        author ──▶ review ──▶ approve ──▶ fan out ──▶ sync
          ▲                                              │
          └──────── a change to the spec re-runs the loop
```

## What Arke is not

- **Not a coding agent.** The *harness* (OpenCode first) owns all execution, the repository
  working tree, and the credentials. Arke realises, visualises and coordinates — it does not
  execute.
- **Not a system of record.** The repository and the integrated tools (git, Jira, Azure
  DevOps) hold the truth. Arke holds no authoritative state in the browser.
- **Not a Jira/GitHub replacement.** It drives those tools through their own interfaces.
- **Not an autonomous pipeline.** A human reviewer stays in the loop for what ships.

## How it works

The first harness is **OpenCode** (headless server, typed API, granular event stream,
open-source and self-hostable). A **backend-agnostic adapter** keeps the orchestration logic
independent of any single harness, so Claude Code, Copilot and others can be added later.
A **thin local coordinator** normalises each harness's events into one schema-validated
domain model and pushes ordered, sequenced state to the client over WebSocket — no cloud
backend on the hot path, everything inside the trust boundary.

Three rules shape every part of it:

- **The specification is the source of truth** — a file in `docs/specifications`, versioned
  and reviewed via pull request. Projections never flow back into it.
- **The harness owns execution and credentials** — the browser is never in the credential
  path and never calls a system of record.
- **Propose · decide · execute** — no agent output reaches the repository, a system of
  record, or a teammate without a human decision in between; projections to systems of
  record are deterministic, logged code; every governed action is recorded in git and in an
  append-only local trace.

> Full product definition: [`docs/PRD-Arke.html`](docs/PRD-Arke.html) ·
> design baseline: [`docs/design/specification-orchestrator-prototype.html`](docs/design/specification-orchestrator-prototype.html) ·
> delivery report & integration guides: [`docs/analysis`](docs/analysis).

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
├─ .opencode/agents/    versioned agent roster (spec-author, architect, reviewer-a/-b, implementer, researcher)
├─ docs/
│  ├─ specifications/   the specs + specification.template.md
│  ├─ decisions/        ADRs
│  ├─ design/           the approved design prototype
│  ├─ assets/           images used by the docs
│  └─ analysis/         delivery report, OpenCode integration guide, T3 Code learnings
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
contracts, the coordinator (mock-driven, verified booting and serving sequenced events), the
OpenCode adapter mapped to the real HTTP/SSE surface, the React client reproducing the design
baseline, and the method scaffolding (agent roster, specification template, grounding).
Next: wire the client transport to the coordinator and exercise the OpenCode adapter against
a live server. See the [delivery report](docs/analysis/delivery-report.html) and
[`docs/specifications/001.foundation-and-scaffold.md`](docs/specifications/001.foundation-and-scaffold.md).

## The name

In Greek myth, **Arke** was the messenger of the Titans — the counterpart to Iris, messenger
of the Olympians. The name fits a tool whose job is to carry intent faithfully between the
human who decides and the agents that build.

## License

[MIT](LICENSE) · open source for any team practising spec-centric engineering.
