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
6. **Each agent image declares its own concrete model** — provider-qualified (`provider/model`)
   plus config-time effort — in its versioned config (`agents/<name>/config.yaml`), edited via
   the agent editor, never hardcoded in coordinator or client code. "The agent is the model"
   (SPEC-016 revised): the logical-tier resolver (`capable`/`mid`) was removed; tier fields in
   `.arke/config.json` are inert legacy storage, and reviewer independence is enforced by
   comparing the models agents declare (`validateReviewers`), not by tier indirection.

## Architecture (where things live)

- `packages/contracts` — schema-first domain contracts (zod): spec lifecycle, normalized
  domain events, the backend-agnostic `HarnessAdapter` interface + capability flags.
- `packages/coordinator` — thin local Node WebSocket coordinator: ingests provider events,
  normalizes + validates them, folds a read model, persists the audit trace, pushes
  ordered/sequenced events to the client. No cloud backend on the hot path.
- `packages/adapter-opencode` — the first harness adapter (OpenCode headless server + SSE).
- `packages/adapter-codex` — the second **leaf** harness adapter (OpenAI Codex over `codex app-server`
  JSON-RPC/stdio), proving the neutral `HarnessAdapter` seam against a transport that shares nothing with
  OpenCode's HTTP/SSE (SPEC-034). Selected when a project pins a `codex` instance in `.arke/config.json`.
  (`packages/adapter-omnigent` is the separate *meta-harness* substrate spike, ADR-0002.)
- `packages/client` — the React orchestrator UI (cockpit, board, review, generation, …).
- `apps/desktop` — Electron shell that embeds the coordinator (one signed app).
- `.opencode/agents` — the harness-materialised agent roster (spec-author, architect,
  reviewer-a, reviewer-b, implementer, researcher). The portable source of truth is the agent
  image (`agents/<name>/config.yaml`, loaded by the coordinator's `AgentRegistry`): each role
  declares its own concrete `provider/model` and effort there — there is no runtime tier
  resolution (SPEC-016 revised). See
  [`docs/agent-roster-and-model-resolution.md`](docs/agent-roster-and-model-resolution.md)
  (note: that document still describes the removed tier-resolution model and needs its own
  update).
- `docs/specifications` — the specifications themselves + `specification.template.md`.
- `.claude/skills/arke-design` — the **canonical design template** for Arke (the `arke-design`
  skill): the shadcn/ui neutral monochrome token contract (`_ds/.../tokens/`), Geist
  typography, Lucide icons, the brand voice, the prototype screens (`app/*.jsx`), and the
  launch-screen designs (`Arke Launch Screen Light.html`). All UI work — and every spec that
  touches a UI — follows it rather than re-deriving styling. See its
  [`SKILL.md`](.claude/skills/arke-design/SKILL.md).
- `.arke/config.json` — the **single project configuration file**: the harness/model registry
  (instances + roster bindings), coordinator settings (port, concurrency, timeouts, query limits,
  OTLP endpoint), and integrations config. `ARKE_*` env vars override individual keys. It is the
  one tracked file under `.arke/`; everything else there (`trace.ndjson`, `sessions.ndjson`,
  `scaffold-manifest.json`, `projection-fallback.ndjson`) is runtime **state**, git-ignored. The
  config model is defined in SPEC-005.

## The `docs/` tree is OKF (SPEC-026)

Every folder under `docs/` is an **Open Knowledge Format** bundle — just markdown: each authored
document carries a `type:` in its frontmatter, concepts link with ordinary markdown links, and each
bundle has an **`index.md`**. That `index.md` is **generated** by the coordinator (a deterministic
projection of the folder's frontmatter, regenerated on every relevant change) — **do not hand-edit
it**; edit the documents and let it regenerate. Consult the relevant `index.md` to see what exists and
follow its links to related documents. Foundational grounding (product/business/domain context) lives
as typed OKF documents anywhere in `docs/` and is selected by `type`, not by folder (SPEC-027) — there
is no dedicated grounding folder.

**Reviewer checklist — committing a grounding document is a leak surface (SPEC-027).** A grounding
document under `docs/` (`type: product-overview` / `business-context` / `domain-glossary` /
`architecture` / `convention`) is tracked, public-safe project truth — it ships in a fresh clone. When
adding or editing one, review it for anything that must not be public: secrets, tokens, private
endpoints, client or customer detail. Sensitive or private material belongs in the git-ignored
**`.arke/grounding/`** local tier instead, which grounds the local agent but is never committed or
auto-promoted into the tracked tree. There is no automated secret scan — this review is the control.

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
