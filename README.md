<div align="center">

# Arke

### The delivery tool for the product engineer.

**Author the spec. Orchestrate the build. Keep the record.**

AI writes the code now; the job became directing it. Arke makes the **specification the
source of truth and the unit of work**, so one product engineer can take a feature from
intent to shipped — at pace, with a full account of what was built — on top of the coding
agent they already run.

</div>

![AI Engineering: from "vibe coding" to enterprise-grade specifications](docs/assets/ai-engineering-maturity-roadmap.png)

<div align="center"><sub>The maturity ladder Arke is built for: from quick prompts, to context engineering, to a single authoritative <code>specification.md</code> that drives the whole delivery.</sub></div>

---

## The missing tool between the issue and the merge

Your tracker gets you to a ticket. After that, the building — increasingly done by agents —
happens in a scatter of terminals and chat windows with no spec, no record, and no one in
charge. As one engineer directs many agents, the bottleneck moves from *writing code* to
**specifying intent and accounting for what got built**. The plan lives in the tracker, the
build happens in a void, and what shipped is hard to reconstruct.

**Arke owns that space.** It is the one place a product engineer writes the spec, directs the
agents that build it, watches the work, and keeps the record — end to end. Not a tracker, not
a chat window, not another agent to run. The place the feature actually gets delivered.

## Built for the product engineer

The hand-offs between product, engineering and QA have collapsed into one person directing
AI. The product engineer owns the whole feature, not just the code — and every decision in
Arke is made from their point of view:

| Specify | Direct | Review | Ship | Answer for it |
|---|---|---|---|---|
| write the contract | steer the agents | across models | tickets, tests, PRs | the record |

## Three jobs, one tool

The work, organised the way it actually runs. _This is the product Arke is being built to
be — the launch feature set. Items marked **(in progress)** / **(planned)** are not wired into
the current build yet; see [Status](#status) for what works today._

### 01 · Author — the spec as source of truth
- **Authoring cockpit** — co-author the spec with agents beside a live preview of the file in your repo.
- **One spec, one file** — requirements as testable `SHALL` statements with `WHEN`/`THEN` scenarios; the file *is* the contract.
- **Multi-model review** — independent agents on different models critique the spec before you finalise it.
- **Open a folder and go** — greenfield or existing code, Arke inspects and adapts. It never assumes your setup.

### 02 · Orchestrate — direct the build
- **Generation** _(in progress)_ — turn the approved spec into tickets, tests and pull requests on a *propose → approve → execute* pattern.
- **Delivery board** — a live view of agents at work, computed from real execution. A card moves because the work moved — not a board you drag.
- **Session detail** — watch and steer the agent building each task: transcript, todos, diff, restore checkpoint, open PR.
- **Runs on your agent** — **OpenCode today**; Claude Code and Codex are on the roadmap behind the same backend-agnostic adapter. Your keys never leave your machine.

### 03 · Keep the record — answer for what ships
- **Audit & activity** — every agent action and every approval, on the record and queryable.
- **Integrations** _(planned)_ — connect GitHub, Jira and Azure DevOps; finish a task on the board and the matching ticket moves on its own. No double entry.
- **Governed by default** — supervised execution with approvals on the moments that matter; the spec drops back to review when intent changes.
- **Your spec, your repo** — specifications live in `docs/specifications`, config in `.arke/`. Portable, reviewable, never hostage to the tool.

## What makes it different

- **Not a second tracker.** Arke's board is a live view of execution, not a backlog to maintain. Your tracker keeps planning; Arke keeps the record of what actually shipped.
- **Not a chat window.** The spec is the unit of work. Decisions land in a contract you can review, not in a transcript that scrolls away.
- **Runs on your agent, doesn't replace it.** Bring Claude Code, OpenCode or Codex. Arke is the controls; the agent still runs the code, on your machine.
- **Accountable by design.** What was built, by which agent, approved by whom, against which spec — captured as you go, not reconstructed after.

## Yours, not rented

The all-in-one platforms absorb your context, your code, and your agents into a cloud you
rent. Arke takes the other bet:

`spec in your repo` · `agent on your machine` · `keys never leave you` · `open source` · `the spec is the contract`

## How it fits

Picture Arke as the **steering wheel and the dashboard**. The coding agent you already
run is the **engine**, working locally on your machine (**OpenCode is the first supported
harness; Claude Code and Codex are on the roadmap**). You direct and watch; it does the
building, and your keys stay with you.

A **backend-agnostic adapter** keeps the orchestration independent of any single harness, and
a **thin local coordinator** normalises each harness's events into one schema-validated
domain model, pushing ordered, sequenced state to the client over WebSocket — no cloud
backend on the hot path, everything inside your trust boundary. Already use more than one
agent? An _(experimental)_ [Omnigent](docs/decisions/0004-agent-model-vs-omnigent-and-the-substrate-mapping.md)
substrate adapter is the path to reaching them all from one place.

Three rules shape every part of it:

- **The specification is the source of truth** — a file in `docs/specifications`, versioned and reviewed via pull request. Projections never flow back into it.
- **The harness owns execution and credentials** — the browser is never in the credential path and never calls a system of record.
- **Propose · decide · execute** — no agent output reaches the repository, a system of record, or a teammate without a human decision in between; every governed action is recorded in git and in an append-only local trace.

## What you need

- A supported coding agent — **OpenCode today**; Claude Code and Codex are on the roadmap behind the same backend-agnostic adapter
- A **git repository** — greenfield or existing
- A **browser** (a desktop app is in progress)
- **Your model access** — keys or subscription stay on your machine

## Getting started

```bash
# Requirements: Node >= 20, npm >= 10
npm install

# Run the React client (the product engineer's cockpit)
npm run dev                 # → http://localhost:5173

# Run the local coordinator. Point it at a project that has a .arke/config.json;
# ARKE_MOCK=1 gives a populated, reachable view without a running harness.
ARKE_MOCK=1 ARKE_PROJECT_ROOT=<your-project> npm run dev:coordinator   # → ws://127.0.0.1:4319

# Build / typecheck everything
npm run build
npm run typecheck
```

## Repository layout

```
Arke/
├─ packages/
│  ├─ contracts/        schema-first domain contracts (zod): spec, events, adapter
│  ├─ coordinator/      thin local WebSocket coordinator + read model + audit trace + registry
│  ├─ adapter-opencode/ first harness adapter (OpenCode server + SSE)
│  ├─ adapter-omnigent/ meta-harness adapter (reach many agents through one substrate)
│  └─ client/           the React orchestrator UI (cockpit, board, review, harnesses, …)
├─ apps/
│  └─ desktop/          Electron shell skeleton (embeds the coordinator)
├─ .opencode/agents/    versioned agent roster (spec-author, architect, reviewer-a/-b, implementer, researcher)
└─ docs/
   ├─ specifications/   the specs + specification.template.md
   ├─ decisions/        ADRs
   ├─ design/           the approved design prototype
   └─ analysis/         delivery report, OpenCode integration guide, learnings
```

## Status

Active development, built spec by spec. **Working today:** schema-first contracts, the local
coordinator (read model, audit trace, multi-project workspaces), the OpenCode adapter against
the live HTTP/SSE surface, the agent-image roster, the CLI, and the harness & model registry
(tier → model **resolution** and a live registry projection rendered in the client).
**Being wired now:** multi-instance harness routing through the registry, generation
(spec → tickets/tests/PRs), and the system-of-record integrations (Jira/Azure/GitHub
projections). **Single supported harness today: OpenCode** — the adapter seam is what makes
Claude Code and Codex additive later. See the [specifications](docs/specifications) and the
[delivery report](docs/analysis/delivery-report.html).

## The name

In Greek myth, **Arke** was the messenger of the Titans — the counterpart to Iris, messenger
of the Olympians. The name fits a tool whose job is to carry intent faithfully between the
human who decides and the agents that build.

## License

[MIT](LICENSE) · open source for any product engineer practising spec-centric delivery.
