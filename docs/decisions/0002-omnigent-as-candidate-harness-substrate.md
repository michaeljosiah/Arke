# ADR 0002 — Omnigent is a candidate harness *substrate*, not a rival; keep the adapter seam neutral

- **Status:** proposed
- **Date:** 2026-06-29
- **PRD decisions:** D11 (tier→model→harness routing through one adapter seam), D14 (ACP/meta-harness as the future normalisation path)
- **Supersedes/relates:** [ADR 0001](0001-thin-client-local-coordinator.md) (the coordinator + `HarnessAdapter` seam this builds on)

## Context

[Omnigent](https://github.com/omnigent-ai/omnigent) is an open-source **meta-harness**:
"the open-source meta-harness for all your AI agents." Apache-2.0, ~5.3k stars, ~913 commits,
v0.3.0 (alpha, June 2026), Python-primary with a full HTTP API. It already ships what Arke's
*platform layer* aspires to: a backend-agnostic interface over ~15 harnesses (Claude Code,
Codex, Cursor, Goose, Hermes, Kimi, Pi, Qwen, Copilot, OpenCode, …), cloud sandboxing
(Modal/E2B/Daytona/K8s), a tiered policy/governance system, multi-device session sync, and
team collaboration.

This overlaps heavily with SPEC-002/SPEC-003 (our `HarnessAdapter`, OpenCode adapter, and
coordinator). We need a recorded decision: treat Omnigent as a competitor to out-build, or as
infrastructure to build *on*.

### What the source actually shows (read 2026-06-29)

- **Their "spec" is a different axis.** `omnigent/spec` is an **Agent Image Spec** — a portable
  artifact describing *what an agent is* (identity, instructions, LLM config, tools, skills,
  sub-agents); like an OCI image for an agent. It is **not** a work/feature specification.
  Omnigent's unit of work is a **conversation/session**. Arke's unit of work is a **feature
  specification** (requirements → design → tasks, git/PR as source of truth, deltas,
  projections to systems of record). Nothing in their tree does spec-as-deliverable, a computed
  delivery board, or one-way projections. **The Arke wedge is intact and now confirmed in
  source, not inferred.**
- **Their harness interface mirrors ours.** `NativeServerTransport` (a Python `Protocol`) is the
  direct analog of our `HarnessAdapter`: `create_or_resume_session`, `send_prompt`, `events`,
  `reply_permission`, `fork`, `abort`, `list_history`, plus process lifecycle
  (`start_server`/`stop_server`) and a TUI takeover (`build_tui_attach_command`).
- **Engineering deltas on OpenCode specifically** (their `opencode_http_transport.py`, 284 lines):
  they are *broader* — they spawn/manage `opencode serve`, support fork/abort/resume and a TUI
  handoff. We are *more defensive on the documented gotchas* — their `reply_permission` is
  fire-and-forget (no event-confirmation / timeout / stale-id / duplicate / reconnect-reconcile
  for issue #15386), whereas our `PermissionCoordinator` confirms by event; we also probe
  capabilities at startup, dead-letter unmappable events, persist the session-ownership graph,
  and do explicit reconnect + REST resync. (Caveat: some of that may live in their native
  permission hooks, which were not fully read.) Their permission vocabulary is richer
  (`once`/`always`/`reject` + message) than our `approve`/`deny`.
- **Their public v1 API is HTTP** (`openapi.json`, 54 paths), so Arke can target it the same way
  the coordinator targets OpenCode today.

## Decision

1. **Treat Omnigent as a candidate *substrate*, not a rival.** The same relationship Arke has
   with OpenCode, one level up: a harness backend behind our `HarnessAdapter` seam.
2. **Keep `HarnessAdapter` the single neutral seam.** Arke stays able to target OpenCode
   directly *and* Omnigent *and* a bespoke harness, captive to none. This is the hedge against
   betting on someone's alpha.
3. **Spike `@arke/adapter-omnigent`** against the public v1 HTTP API to validate the
   substrate thesis (plan + exit criteria below). Do not write it blind into `main`.
4. **Do not compete on harness breadth.** We would lose. `@arke/adapter-opencode` stays the
   lean reference adapter.
5. **Adopt two ideas now, regardless of the spike:** the richer permission vocabulary
   (`once`/`always`/`reject` + message) over our `approve`/`deny`; and their Agent Image Spec
   layout as the model for how Arke packages the *agents it dispatches* (distinct from, and
   complementary to, our work-specifications).
6. **Double down on the wedge.** SPEC-004/005/008 (project setup, registry, spec library +
   lifecycle), projections, the delta-based review — the things Omnigent does not do — are what
   make Arke not "a thinner Omnigent."

### Interface mapping (grounds the spike)

| Arke `HarnessAdapter` | Omnigent v1 endpoint | Notes |
|---|---|---|
| `createSession({specId, parent})` | `POST /v1/sessions`; child via `GET /v1/sessions/{id}/child_sessions` | their parent/child ≈ our spec/task graph |
| `sendMessage` / `dispatchAsync` | *(send-prompt path TBC — see open questions)* | public send endpoint not obvious; internal native transport uses `prompt_async` |
| `streamEvents()` | `GET /v1/sessions/{id}/stream` (SSE) | **per-session** stream vs our global `/global/event`; adapter would fan-in per session |
| `getTodos`/`getDiff` | `GET /v1/sessions/{id}/items`, `resources/environments/{id}/changes` | transcript/history + environment diff |
| `respondToPermission` | `/v1/sessions/{id}/policies` + `/policies/evaluate` | **governance is policies**, not the `/permissions` path |
| *(n/a — session sharing)* | `GET,PUT /v1/sessions/{id}/permissions` | **collaboration ACL** (who may access), not tool-gating — do not map here |
| `runCommand` / sandbox | `resources/environments/{id}/shell`, `.../filesystem`, `.../search` | sandboxed env access — free breadth if adopted |
| *(new)* fork | `POST /v1/sessions/{source_id}/fork` | rescue/branch capability we lack |

## Consequences

- **Upside if the spike holds:** Arke inherits ~15 harnesses + cloud sandboxing + multi-device
  sessions "for free," and spends its effort on the specification lifecycle — the differentiator.
- **Cost / risk:** a large dependency on an **alpha** (v0.3.0), Python-primary project; their API
  may churn. Mitigated by the neutral `HarnessAdapter` seam (we can always fall back to OpenCode
  direct) and by keeping the spike out of `main` until it proves out.
- **Governance mismatch to resolve:** Omnigent gates tools via a **policy engine**, Arke via
  per-action **propose·decide·execute** + tiered approval. An adapter must map our decision model
  onto their `/policies/evaluate`, or bypass it and gate in the coordinator. To be settled in the spike.
- **Stream shape differs:** per-session SSE vs our single global stream; the adapter fans in.
- **No lock-in created:** this ADR commits to a *spike and a seam*, not to adopting Omnigent.

### Spike plan & exit criteria

- Stand up Omnigent locally (Docker), create a session, drive one OpenCode turn through its v1
  API, and confirm the adapter can: create a session, stream events, read history/diff, and relay
  a decision.
- **Exit green** if `@arke/adapter-omnigent` satisfies the same `HarnessAdapter` conformance the
  OpenCode adapter does (identity on events, reconnect, permission relay) against a live Omnigent.
- **Exit red** (stay OpenCode-direct) if the send-prompt/permission-mapping gaps prove costly or
  the alpha API is too unstable.

## Open questions

- The **public send-prompt endpoint** — not obvious in `openapi.json`; the internal transport uses
  `prompt_async`. Confirm before the spike.
- **Auth model** of the v1 API (token/session) and whether it fits the host-only credential boundary.
- Whether to map Arke approvals onto Omnigent **policies** or gate in the coordinator and treat
  Omnigent purely as execution.
