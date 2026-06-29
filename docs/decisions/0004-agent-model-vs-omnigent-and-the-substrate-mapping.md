# ADR 0004 — Keep Arke's harness-agnostic, tier-indirected agent model; map onto Omnigent at the boundary

- **Status:** proposed
- **Date:** 2026-06-29
- **Relates:** [ADR 0002](0002-omnigent-as-candidate-harness-substrate.md) (Omnigent as substrate — spike now GREEN, PR #11), [ADR 0001](0001-thin-client-local-coordinator.md) (the `HarnessAdapter` seam). Grounds: SPEC-016 (portable agent images), SPEC-005 (harness & model registry).

## Context

The Omnigent spike proved the **execution/event seam** maps cleanly (a real OpenCode turn ran through `@arke/adapter-omnigent`'s exact event path). What it did **not** settle — and what this ADR decides — is the **agent / tier / approval** mapping, plus the sharper question the spike forced: **is Arke's agent model better or worse than Omnigent's, and should we copy theirs?**

This is grounded in reading both models in source, not impressions:
- **Arke** — `AgentImage` (SPEC-016, `@arke/contracts/agent-image.ts`): a directory bundle (`config.yaml` + `AGENTS.md` + `skills/` + `tools/` + recursive `agents/`) parsed to a typed image, **materialised per harness** (e.g. `.opencode/agents/<name>.md`). It references a **logical tier** (`capable`/`mid`/`fast`), never a vendor model id — resolution lives in the project registry behind a gateway.
- **Omnigent** — the **agent spec** (`docs/AGENT_YAML_SPEC.md`, `examples/*`, `docs/POLICIES.md`): a YAML bundle (`config.yaml` + nested `agents/<name>/config.yaml` + `skills/<name>/SKILL.md`). Harness + concrete model bound in `executor` (swappable per-run via `--harness`/`--model`); **concrete model ids only**; a 3-level (session/agent/server) ALLOW/DENY/ASK **policy** engine; static **and** dynamic (`spawn: true`) sub-agents that run as separate inbox-linked sessions in their own git worktrees.

Two corrections to earlier assumptions, both from source: Omnigent has **no "agent image" artifact and no agent registry** (agents are git-shared YAML, only *policies* have a registry); and there is **no logical-tier abstraction** anywhere (concrete model ids + an automatic per-turn cost-picker).

## The two models, side by side

| Dimension | Arke `AgentImage` | Omnigent agent spec |
|---|---|---|
| Packaging | dir bundle (`config.yaml`+`AGENTS.md`+`skills/`+`tools/`+`agents/`) | dir/YAML bundle (`config.yaml`+`agents/`+`skills/`) — **Arke borrowed this shape (SPEC-016)** |
| Harness | **none — agnostic**, materialised into each harness's native form | bound in `executor.harness` (per-run/per-sub-agent overridable) |
| Model | **logical tier** (`capable`/`mid`/`fast`), resolved per-project in the registry | **concrete model ids** (image default + `--model`/`/model`/per-dispatch `args.model`) + auto cost-picker |
| Vendor ids | live in **one place** (registry), never in agent files or the client | scattered across specs/sub-agents/dispatches |
| Governance | per-capability `allow/ask/deny` posture **+** coordinator risk-tier gate (low/medium/high → in-band / confirm / durable Proposal) | 3-level phase-based ALLOW/DENY/ASK policy functions; ASK → elicitation card |
| Sub-agents | **static** (recursive `agents/` in the image) | **static + dynamic** (`spawn:true` → runtime-authored sessions, inbox-linked, own worktree) |
| Skills | declared `SkillRef{name,path}` — thin runtime | first-class `SKILL.md` procedures loaded by a `Skill` tool, governed by `block_skills` |
| Sandbox/env | not modelled in the image | declarative `os_env`/`sandbox`/`terminals`/`params`/`timers` |
| Distribution | none yet (materialised into the repo) | git-shared YAML bundles; an internal `AgentStore` (create/list/update/delete + **versioning**) backs `GET /v1/agents`, but there is **no public create-agent API** |
| Maturity | one reference harness (OpenCode) | ~15 harnesses, cost advisor, model catalog |

## Better or worse?

Not a single winner — they optimise for different things, and the honest read is **Arke's model is the better *abstraction* for Arke's goals; Omnigent's is the more mature *runtime*.**

**Where Arke is genuinely better (keep these):**
- **Logical tiers + registry indirection.** Agents say "capable/mid/fast"; the project registry maps tier→model behind a gateway, so vendor ids never touch agent files or the client. Omnigent has *no* equivalent — concrete ids everywhere. For a multi-product, multi-deployment, **financial** platform this is the cleaner and safer abstraction, and it is a deliberate differentiator, not an accident.
- **Harness-agnostic image + materialisation.** One roster runs on any harness, and the harness keeps working standalone ("adopt, don't replace"). Omnigent's spec is harness-shaped; cross-harness mixing is per-sub-agent. Our separation of *what the agent is* from *what runs it* is cleaner.
- **Risk-tier → autonomy → approval coupling.** Our low/medium/high tiering ties the gate to *action risk* (high = money movement → never in-band, marshalled to a durable `Proposal` executed only by the dispatcher). Omnigent's policies are powerful and composable but generic; they have no "this class of action may never auto-execute" financial-grade semantic. For AONIK's domain, ours fits better.

**Where Omnigent is genuinely better (selectively adopt):**
- **Dynamic sub-agents.** Runtime self-authored sub-agents as isolated, inbox-linked sessions in their own worktrees is materially more capable than our static recursive `agents/`. This is the strongest idea to borrow.
- **Skills as a real runtime.** `SKILL.md` + a `Skill` tool + `block_skills` governance is a developed pattern; our `SkillRef` is a stub by comparison.
- **Declarative execution environment.** `os_env`/`sandbox`/`terminals` in the spec is something our image doesn't model at all.
- **Composable, phase-based policies** (request/response/tool_call/tool_result) are a good *lower* layer — under, not replacing, our risk-tier gate.

## Decision

1. **Keep Arke's agent abstraction. Do not adopt Omnigent's harness-bound, concrete-model model.** The harness-agnostic image + logical tier + risk-tier governance is the moat, and it is *more* defensible now that we know Omnigent has no logical-tier layer (and no public agent-creation API). **Confirmed:** the **tier stays the only model knob on an agent** — agents reference `capable`/`mid`/`fast`, never a vendor model id; when finer control is needed the answer is *add a tier* (as we did with `fast`), not pin a model onto an agent. This keeps images portable and keeps vendor ids out of agent files and the client.
2. **Do not copy wholesale; adopt selectively.** Pull in the runtime ideas Omnigent does better, expressed in *our* abstraction: dynamic sub-agent spawning with worktree/inbox isolation; a real skills runtime; declarative sandbox/env on the image; phase-based policies as a layer beneath the risk-tier gate. Each is its own future spec, not this ADR.
3. **Bridge to Omnigent by projection, at the adapter boundary.** When Omnigent is the substrate, `@arke/adapter-omnigent` *generates* an Omnigent agent spec from an Arke image — filling in `executor.harness` (the project's harness) and `executor.model` (registry-resolved from the image's tier). Because Omnigent exposes **no public create-agent API**, provisioning is out-of-band: drop the spec into an agent dir loaded via `omnigent server --agent` / `omnigent run <dir>`, then bind it per session. *Binding correction (verified against live openapi):* rebinding a session to a registered agent is `POST /v1/sessions/{id}/switch-agent` (by `agent_id` from `GET /v1/agents`); `PUT /v1/sessions/{id}/agent` *replaces the uploaded bundle* of a session-scoped agent — not a generic bind. Arke images stay the source of truth; Omnigent specs are a compiled artifact.
4. **A possible differentiator: a first-class agent-image registry.** *Correction:* Omnigent is not a blank slate here — it has an internal `AgentStore` with create/list/update/delete + versioning behind `GET /v1/agents`; what it lacks is a *public create-agent API* and any content-addressed, portable image-distribution story. So the differentiator is narrower than "they have no registry": a **harness-agnostic, tier-indirected, content-addressed image registry with push/pull** would be ours to own. Validate the gap against their `AgentStore` before committing a spec to it.

## Mapping design (Arke → Omnigent, substrate mode)

| Arke | Omnigent | Notes |
|---|---|---|
| **Project** (per-project context, SPEC-018) | **workspace** (git path) on a **host** | architecturally aligned — same control-plane/runner split |
| **Spec / task session** (`SessionKind`) | session + **sub_agent** sessions | adapter records identity per session (done) |
| **Roster image** (harness-agnostic, tier) | **generated agent spec** (`executor.harness` + resolved `executor.model`) | projection at the boundary; provisioned out-of-band (no create-API) |
| **Logical tier** → registry | `executor.model` / per-session `model_override` / `args.model` | tier resolution stays in Arke |
| **Tools / skills / sub-agents** | `tools` (`mcp`/`function`/`agent`) / `skills/` / nested `agents/` | `ToolDecl.kind` aligns with Omnigent's kinds but is **not** a 1:1 projection — Omnigent tools need kind-specific payloads (`callable`+`parameters` for `function`, `command`/`url`+headers for `mcp`, `prompt`/`executor`/`spec` for `agent`). Arke's `ToolDecl` (name/kind/description) lacks these; projection needs a manifest/inference step (open question) |
| **Approval — low** | run in-band | unchanged |
| **Approval — medium** | `POST /v1/sessions/{id}/events` with an **approval-type event** carrying the elicitation result | *Verified:* there is **no** `/elicitations/{id}/resolve` endpoint; the reply rides the events channel. Arke gate remains authoritative; this is the transport |
| **Approval — high** (money/ledger) | **stays in Arke** — `Proposal` + dispatcher; never delegated to Omnigent policies | hard rule; Omnigent is execution, not the gate of record |

## Consequences

- **Substrate-ready without surrendering the model.** Arke can run on Omnigent (inheriting ~15 harnesses) while keeping its tier/governance abstraction — the adapter compiles down to Omnigent at the edge.
- **Out-of-band agent provisioning is a real constraint** (no create-API): the adapter must write/refresh agent specs on the host and keep them in sync with the roster. Document and test this path before any wiring.
- **High-risk gating is never delegated.** Even on Omnigent, money-movement marshals through Arke's dispatcher. This must survive review of any future integration.
- **Selective-adoption backlog** (each its own spec): dynamic sub-agents, skills runtime, declarative sandbox, layered policies, agent registry/versioning.

## Open questions

- Where exactly do generated Omnigent specs live on a host, and what keeps them in sync with the Arke roster (regenerate-on-open vs a sync step)?
- Do we mirror medium approvals as Omnigent ASK policies for defence-in-depth, or keep the gate solely in the coordinator?
- Does the agent registry (decision 4) belong in SPEC-005's registry or a new spec of its own?
