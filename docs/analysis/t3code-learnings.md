# T3 Code — Learnings for SpecOne

> **Editor's note (verify before relying):** T3 Code is the PRD's cited architectural
> reference ([github.com/pingdotgg/t3code](https://github.com/pingdotgg/t3code)). This
> document was compiled from the repo's README, its `docs/architecture/*` docs, and
> third-party write-ups. **Specific file paths and TypeScript signatures below are
> indicative** — some were inferred from summaries rather than read from source — and must
> be confirmed against the live repository before being copied. Treat the *patterns* as the
> takeaway, not the exact paths.

## Repo & Stack

**URL:** `https://github.com/pingdotgg/t3code`.

**What it is:** A minimal open-source web/desktop GUI that wraps coding-agent CLI harnesses
(Codex, Claude Code, OpenCode, Cursor, Grok) behind a single unified interface. You bring
your own keys; T3 orchestrates the installed agent. Electron desktop + a local web app, both
talking to a local Node/Bun server over WebSocket.

| Concern | Technology |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Server | Node.js/Bun (`apps/server`) |
| Desktop | Electron (`apps/desktop`) |
| Web client | React + Vite (`apps/web`) |
| Type-safe RPC & effects | [Effect](https://effect.website/) (Schema, RPC, Layers, Fiber/queue) |
| Client state | Effect atoms + Zustand (UI-local) |
| Terminal | xterm.js · **DB** SQLite · **Styling** Tailwind · **Chat list** LegendList (virtualized) |

Source paths referenced: `apps/server/src/`, `apps/web/src/`, `packages/contracts/src/`,
`packages/effect-acp/src/`, `packages/client-runtime/src/`, `docs/architecture/`.

---

## Harness Integration

### Provider Driver SPI (`ProviderDriver<Config, R>`)
A typed Service Provider Interface every harness implements. `create(config, deps)` returns a
scoped `ProviderInstance` bundling three closures: `snapshot` (health), `adapter` (session
lifecycle: start/send/interrupt/approve/stop), `textGeneration` (inference). **Isolation:** two
`create` calls with different config yield instances with no shared mutable state (enforced by
Effect scope). Concrete drivers: `CodexDriver`, `ClaudeDriver`, `OpenCodeDriver`, etc.

### ACP as the normalizing protocol
T3 uses the **Agent Client Protocol** (JSON-RPC over stdio) as its primary normalization layer
for Claude Code / Codex / Cursor / Grok. A `packages/effect-acp` wraps ACP in Effect types
(code-generated schema). At the server, an ACP session runtime spawns the agent CLI, routes
events through an unbounded queue, guards startup idempotency with a deferred, and serializes
prompt submissions with a semaphore. **OpenCode is the exception** — it connects via OpenCode's
own HTTP SDK (its server speaks HTTP/SSE), not ACP. Raw provider events are mapped to a canonical
`ProviderRuntimeEvent` while preserving the raw payload for traceability.

### Transport: browser ↔ server
WebSocket RPC using Effect's typed RPC. Push envelopes carry `{ channel, sequence, ...payload }`
across channels: `server.welcome` (snapshot on connect), `server.configUpdated`, `terminal.event`,
`orchestration.domainEvent`. The `sequence` field gives ordered delivery for replay. The client
transport is a five-state machine (`connecting → open → reconnecting → closed → disposed`) that
queues outbound requests while disconnected and replays the latest push on reconnect.

### Server orchestration: three queue-backed worker layers
**Ingestion** (consume provider events) → **Command reaction** (dispatch provider calls from a
pure *decider*) → **Checkpoint capture** (git snapshots around each turn). All queue-backed to
remove timing races and give tests a deterministic idle signal. **Runtime signals** are typed
receipts emitted when async milestones complete (`checkpointCaptured`, `turnQuiescent`); tests
await signals instead of polling.

### State, persistence, checkpoints, modes
- Read model via a **pure `projectEvent(readModel, event)` fold** — deterministic, no side effects.
- SQLite persistence on the server (sessions, auth, runtime).
- **Git checkpoints** persist a SHA per turn; diffs computed between checkpoints; revert projects
  the read model to a prior checkpoint. Sessions can run in isolated **git worktrees**.
- **Runtime modes:** Full Access (`approvalPolicy: never`, `sandbox: danger-full-access`) vs
  Supervised (`approvalPolicy: on-request`, `sandbox: workspace-write`), mapped to ACP session
  init params; supervised emits approval-request events the UI gates on.
- **Multi-instance identity:** `ProviderDriverKind` (which implementation) is distinct from
  `ProviderInstanceId` (a routing key), so several instances of one driver run isolated.

---

## Chat Interface

### Message/part model
`role` (user/assistant/system), `text` (accumulated via streaming concat), `isStreaming` (append
deltas while true), `attachments` (images, base64, ~10 MB cap), `turnId`, timestamps. A
`CanonicalItemType` unifies user/assistant message, reasoning, planning, command execution, file
change, web search, image view, MCP tool call — all under one lifecycle
(`item.started → item.updated → item.completed`).

### Timeline component
Virtualized (LegendList, anchored scroll). Messages derived through a **pure transform** from
domain state to renderable rows. Tool calls grouped into collapsible work sections. Notable:
**self-ticking elapsed-time labels** update DOM text nodes directly without a React commit per
second (avoids re-render churn during long streaming turns); memoized rows via React Context.

### Streaming = server-owned (not optimistic)
Agent emits content deltas → wrapped with synthetic started/completed bookends → projector appends
to the read model (`isStreaming: true`) → server pushes updated thread state on the WS channel →
client atoms invalidate → components re-render.

### Composer
Textarea + attachments, a **pending-approval panel** (renders on an approval request, blocks input
until approve/reject), a **pending-user-input panel** (mid-turn elicitation), a per-turn
provider/model picker, and slash commands with search.

### Component hierarchy (indicative)
`ChatView → ChatHeader (provider/model, mode toggle) → MessagesTimeline (virtualized) →
WorkGroupSection → AssistantChangedFilesSection; ChatComposer → ComposerPendingApprovalPanel /
ComposerPendingUserInputPanel / ProviderModelPicker; BranchToolbar; DiffPanel`.

### Observability
Automatic OpenTelemetry spans per RPC call, structured metrics, and browser traces forwarded to
the server for correlation.

---

## Cross-cutting patterns mapped to our PRD

| PRD adoption | T3 implementation |
|---|---|
| Thin coordinator | `apps/server` is pure orchestration: WS RPC + worker queues + provider spawning, no model calls |
| Schema-first contracts | All boundary types as Effect Schema in `packages/contracts`, runtime-validated |
| Normalized domain events | Provider events → canonical `ProviderRuntimeEvent` → folded into a read model |
| ACP | `packages/effect-acp` (JSON-RPC/stdio) for Claude/Codex/Cursor/Grok; OpenCode via HTTP SDK |
| Resilient streaming | Queued-outbound-drain transport, capped backoff, replay-on-reconnect |
| Git checkpoints | Per-turn snapshots, diff between checkpoints, revert via read-model projection |
| Runtime modes | Supervised vs full-access mapped to ACP init params; approval events gate execution |
| Observability as audit | OTel on RPC/queues/browser; typed runtime-signal receipts for milestones |

---

## Concrete recommendations for SpecOne

**Copy directly**
1. The **`ProviderDriver` SPI shape** (snapshot / adapter / lifecycle) and the
   `DriverKind` vs `InstanceId` split — maps onto our `HarnessAdapter` + capability flags and
   future multi-instance routing.
2. **Contracts-first monorepo** — already our `packages/contracts`. Mirror the file-per-domain
   split; we have `spec.ts` / `events.ts` / `adapter.ts`, add `review.ts` and source-control types
   later.
3. The **session-runtime pattern** (startup-idempotency deferred, prompt-serialization semaphore,
   unbounded event queue) for our coordinator's harness runner.
4. **Per-event-category normalization factories** — we already do this in
   `adapter-opencode/normalize`; keep one function per event category, well tested.
5. **Decider + pure projector** for deterministic state in the coordinator (we have `ReadModel`;
   add a command *decider* when we wire real dispatch).
6. **Typed runtime-signal receipts** (`turnQuiescent`, `diffFinalized`, `specSnapshotReady`) over
   polling — matches NFR-8.
7. The **five-state reconnecting WS transport** with queued-outbound-drain + replay for our client.
8. **Virtualized streaming timeline** (anchored scroll, self-ticking time, `isStreaming` flag) for
   the cockpit chat and session-detail transcript.
9. The **approval / elicitation composer panels** — they are exactly our propose-decide-execute UI.
10. **Offline-first atoms** that never let stale cache overwrite newer live data on reconnect.

**Adapt**
11. Per-turn model picker, but also record `harness + model` on every spec turn for the audit trail.
12. Three-panel layout, but the right pane splits **chat + live spec preview** (the cockpit), and
    the diff component doubles as a spec-revision diff view.
13. Checkpoints track **spec snapshot state per turn**, not only git SHAs (the spec is the truth).
14. SQLite on the coordinator — add `AuditLog` and `SpecSnapshot` tables alongside session tables.

**Skip**
15. Electron is optional for us (browser-first; desktop is a later phase) — we keep a skeleton only.
16. Relay/tunnel/SSH remote access — out of scope; we run locally / as a service.
17. Mobile, marketing apps — out of scope.
18. The `textGeneration` closure — SpecOne delegates all inference to the harness; `snapshot` +
    lifecycle suffice for our adapters.

---

## What we deliberately differ on (per the PRD)

| T3 | SpecOne |
|---|---|
| Threads are generic chat containers; the spec is implicit | **Spec is a first-class, versioned aggregate**; the chat thread is a child of the spec |
| Agents write to the working tree directly (full-access) | **Propose · decide · execute** — agent mutations become a proposal a human approves before materialisation |
| Projector is a UI-performance read model | **Deterministic projection is the product** — the spec snapshot is the deliverable, reproducible and exportable |
| Autonomy is a global mode switch | **Risk-tiered autonomy** — mutations classified low/medium/high; no global override of human approval |
| Audit is observability for debugging | **Audit is the product** — every turn, proposal, approval and snapshot transition is an append-only domain event, queryable and exported with the spec |
| Human-in-the-loop is optional | **A human reviewer is required** to move a spec `draft → approved`, regardless of mode |
| Multi-harness is a per-session provider choice | **Multi-harness is a normalization strategy** — a turn from OpenCode and one from Claude Code are structurally identical; harness identity is metadata on the turn |

**Sources:** [pingdotgg/t3code](https://github.com/pingdotgg/t3code) · its `docs/architecture/{overview,providers,connection-runtime,runtime-modes,remote}.md` · README · third-party write-ups (Better Stack, PyShine, Szaradowski). File paths/signatures are indicative — verify against source.
