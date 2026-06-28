# AGENTS.md — Arke grounding

> This is the single canonical grounding file for coding agents working in Arke.
> `CLAUDE.md` mirrors it so both conventions resolve to the same guidance (PRD §12.2).

## What Arke is

Arke is the **Specification Orchestrator**: a React client plus a thin local
coordinator that sits on top of a coding-agent harness (OpenCode first) and makes the
**specification the unit of work**, from authoring through delivery. The orchestrator
realises, visualises and coordinates; the harness owns execution.

Read `docs/PRD-Arke.html` for the full product definition.

## Non-negotiable rules

1. **The specification is the source of truth.** Its canonical copy is a markdown file in
   `docs/specifications`, versioned and reviewed via pull request. Nothing downstream
   overrides it; projections (tickets, tests, docs, tracking) are generated from it and
   never flow back into it.
2. **The harness owns execution and credentials.** All repo, agent, CLI and MCP access
   happens inside the harness host. The browser is never in the credential path and never
   calls a system of record.
3. **Propose · decide · execute.** No agent output reaches the repository, a system of
   record, or a teammate without a human decision in between.
4. **Projections to systems of record are deterministic code**, not free-form agent
   behaviour, and every projection write is logged with its trigger.
5. **Every governed action is recorded.** Spec history is in git; permission decisions and
   projections are in the append-only trace (`.arke/trace.ndjson`).
6. **Agents reference logical model tiers** (`capable`, `mid`), resolved per project to the
   internal model gateway — never hardcoded vendor model IDs.

## Architecture (where things live)

- `packages/contracts` — schema-first domain contracts (zod): spec lifecycle, normalized
  domain events, the backend-agnostic `HarnessAdapter` interface + capability flags.
- `packages/coordinator` — thin local Node WebSocket coordinator: ingests provider events,
  normalizes + validates them, folds a read model, persists the audit trace, pushes
  ordered/sequenced events to the client. No cloud backend on the hot path.
- `packages/adapter-opencode` — the first harness adapter (OpenCode headless server + SSE).
- `packages/client` — the React orchestrator UI (cockpit, board, review, generation, …).
- `apps/desktop` — Electron shell that embeds the coordinator (one signed app).
- `.opencode/agents` — the versioned agent roster (product-owner, technical-architect,
  engineering, implementation, reviewer).
- `docs/specifications` — the specifications themselves + `specification.template.md`.

## Completion gates

Before any task is "done":

- `npm run typecheck` passes for the packages you touched.
- `npm run build` succeeds.
- The change satisfies the relevant `R-n` acceptance criteria in its specification.

## Priorities & conventions

- TypeScript, `type: module`, npm workspaces. Contracts are zod-first and validated at the
  boundary; a malformed event from any backend is caught, not silently trusted.
- Keep the client a thin realisation layer — it holds no authoritative state.
- Keep adapters honest about capabilities; the board degrades to a backend's real surface.
- Prefer patterns from the vendored reference implementations (under `.repos/`, when added)
  over guesses or web search.

## Reference repositories (grounding)

- OpenCode — headless server, plugins, agents: https://opencode.ai/docs
- T3 Code — a multi-provider GUI over coding agents (architectural reference, not a
  competitor): https://github.com/pingdotgg/t3code
- Agent Client Protocol (ACP) — the agent-client normalisation standard.

When these are vendored read-only under `.repos/`, prefer their proven patterns.
