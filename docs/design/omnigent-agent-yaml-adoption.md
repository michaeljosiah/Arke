# Adopting the Omnigent agent YAML structure in Arke

**Status:** ✅ implemented (breaking; SPEC-016 revised) — the sections below are the design that was executed.
**Author:** (drafted with Claude)
**Scope:** how Arke defines agents and specifies models/providers — adopt Omnigent's
declarative `executor`-based YAML 100% (copying the *structure*, not depending on the Omnigent
runtime), as the foundation for a light abstraction over Omnigent later.

**What shipped:** agent images declare `executor: { type: omnigent, config: { harness, model, options?, auth: { profile } } }`;
the loader rejects an inline `api_key` (NFR-1) but accepts the public `model`. `.arke/config.json` is now a
`providers` map of host-side provider/auth profiles (endpoint + `credentialsRef`), not a tier→model registry.
The coordinator's new `AgentRegistry` resolves each agent's declared model and dispatch sends it directly on
`SendMessageInput.model`; the review panel checks reviewer independence from the agents' declared models; the
registry projection is now `{ harnesses, agents, warnings }`. The client cockpit shows each agent's declared
model (read-only) instead of a per-turn tier selector. Scaffolding writes the new provider-profile config plus
self-describing agent images. Both the OpenCode and Omnigent adapters map `model` onto their wire. The whole
logical-tier indirection (`capable|mid|fast`, `RegistryResolver`, tier serves/roster) is removed from the live path.

---

## 1. TL;DR

Arke's agent files are already **~80% Omnigent-shaped**: both use `agents/<name>/config.yaml`,
`spec_version: 1`, `name`, `description`, `instructions`/`prompt`, a tools block, nested sub-agents,
and a permission/policy posture. The single fundamental difference is **where the model and provider
are declared**:

| | Arke today | Omnigent |
|---|---|---|
| Model source | agent names a **logical `tier`** (`capable\|mid\|fast`); the `.arke/config.json` **registry** maps `tier → provider/model` per instance, and a `roster` binds each role → tier/instance | agent's **`executor` block** names the harness and (optionally) the model + provider auth directly |
| Agent self-contained? | No — needs the registry to know its model | Yes — the YAML fully declares its runtime |
| Model in the repo? | No (deliberately host-side, `loadAgentImage` **hard-rejects** a `model:` field) | Yes (`executor.config.model` lives in the committed YAML) |

**Adopting Omnigent 100% means inverting the model-resolution architecture:** move harness + model +
provider from the registry's tier-indirection *into* each agent's `executor` block, and demote the
`.arke/config.json` registry from a *model router* to a thin *credential/provider profile* store (so
Arke's credential boundary, NFR-1, survives — models are public, keys are not).

The good news: because the file layout and most fields already match, this is a **schema swap on one
axis (model resolution)** plus mechanical field renames — not a rewrite. The blast radius is well
bounded (7 consumers of the tier indirection, all listed in §6).

---

## 2. The Omnigent structure we are copying

Verbatim shape, from `omnigent-ai/omnigent` (`docs/AGENT_YAML_SPEC.md` + real
`examples/*/agents/*/config.yaml`). Two executor forms exist; the wrapped form is canonical in the
current examples:

```yaml
spec_version: 1
name: implementer
description: OpenCode coding sub-agent — implements a scoped task in its own worktree.

# --- runtime: harness + model + provider auth, per agent ---
executor:
  type: omnigent               # executor KIND (the seam for delegating to Omnigent later)
  context_window: 1000000      # optional
  config:
    harness: opencode-native   # claude-sdk | opencode-native | codex | codex-native | cursor-native | hermes-native | pi | claude-native
    model: github-copilot/gpt-5.5   # OPTIONAL — omit to use the provider's default
    # auth: { type: provider|api_key|databricks, profile: <name>, base_url: <url> }  # OPTIONAL provider pin

prompt: |                       # inline system prompt (or `instructions: <path>`)
  You are OpenCode, a coding sub-agent ...

os_env:                         # optional — registers sys_os_read/write/edit/shell + sandbox
  type: caller_process
  cwd: .
  sandbox:
    type: none                  # none | linux_bwrap | darwin_seatbelt

guardrails:                     # optional — code-handler policies on request/response/tool_call
  policies:
    blast_radius:
      type: function
      on: [tool_call]
      function:
        path: omnigent.inner.nessie.policies.blast_radius
        arguments: { gate_pushes: false }
    read_only_os:
      type: function
      on: [tool_call]
      function: { path: omnigent.inner.nessie.policies.read_only_os }

tools:                          # optional — keyed map, not an array
  github:
    type: mcp
    command: uv
    args: [run, python, -m, my_package.github_mcp]
  summarize:
    type: function
    callable: my_package.tools.summarize
  agents:                       # sub-agents inline OR as agents/<name>/config.yaml files
    reviewer: { type: agent, executor: { config: { harness: codex } }, prompt: "..." }

# other optional top-level keys: spawn, async, cancellable, timers, params, terminals
```

**Direct (unwrapped) executor form** (also valid, from `examples/kimi_hello.yaml`):

```yaml
executor:
  harness: kimi
  model: kimi-k2-turbo   # optional
```

Top-level key reference (from the spec):

| Key | Type | Purpose |
|---|---|---|
| `spec_version` | int | schema version |
| `name` | string | stable id |
| `prompt` / `instructions` | string / path | system prompt (inline or file) |
| `executor` | object | **harness + model + provider auth** |
| `tools` | object | keyed map of `mcp` / `function` / `agent` (+ `inherit`/`self`) |
| `guardrails.policies` | object | code-handler guardrails on `[request\|response\|tool_call]` |
| `os_env` | object | file/shell tool access + sandbox |
| `policies`/`params`/`terminals`/`async`/`cancellable`/`timers`/`spawn`/`context_window` | various | optional |

**Model & provider (the point of this doc):** `executor.config.harness` picks the runtime;
`executor.config.model` optionally pins the model; `executor.config.auth` (`type` +
`profile`/`api_key`/`base_url`) pins the provider. With no model/auth pinned, the harness resolves
the globally-configured provider's default (Omnigent's `omnigent setup`).

---

## 3. Arke today (the tier indirection)

On-disk agent (`agents/<name>/config.yaml`), parsed by `loadAgentImage()`
(`packages/agent-image/src/index.ts:34`) into `AgentImage`
(`packages/contracts/src/agent-image.ts:40`):

```yaml
spec_version: 1
name: architect
description: "Fills the Design depth: architecture, data model, interfaces."
tier: capable                 # LOGICAL tier — the loader REJECTS a `model:` field (index.ts:47)
instructions: AGENTS.md
interaction: { conversational: true, mode: primary }   # mode: primary|subagent|all
permission: { read: allow, edit: allow, bash: ask }    # allow|ask|deny per tool
# tools discovered from tools/{python,typescript,mcp}/ ; sub-agents from agents/<name>/
```

Model resolution is a four-hop indirection (SPEC-005 / FR-4):

```
agent (tier: capable)                     agents/<name>/config.yaml  →  .opencode/agents/<name>.md (materialized, frontmatter `tier:`)
   → roster[role] → { tier, instance? }   .arke/config.json  (registry.roster)
   → instance.serves[tier] → "provider/model" (+reasoningEffort)   .arke/config.json (registry.instances[].serves)
   → adapter.resolveModel(tier) → { providerID, modelID, options } wire body   adapter-opencode/src/index.ts:329
```

Key types (`packages/coordinator/src/registry.ts`): `ServesEntry {tier, model, reasoningEffort?}`,
`InstanceConfig {id, driver, host, cwd, credentialsRef, serves[]}`, `RosterEntry {tier, instance?}`,
`ModelSelection {instanceId, tier, model, reasoningEffort?}`. The client only ever sees tier
**labels** (`"capable — opencode"`), never model strings — except the roster resolution which now
surfaces the resolved model+effort for operator verification.

---

## 4. Field-by-field mapping (Omnigent ⇄ Arke)

| Omnigent | Arke today | Change |
|---|---|---|
| `spec_version: 1` | `spec_version: 1` | none |
| `name` | `name` | none |
| `description` | `description` | none |
| `prompt` (inline) | `instructions` (path or inline) | **add** `prompt` inline alongside `instructions` |
| `executor.config.harness` | `driver` on the registry *instance* (not the agent) | **move to agent**: agent declares its harness |
| `executor.config.model` | `tier` + registry `serves[tier].model` | **replace `tier` with a declared model** (registry no longer resolves it) |
| `executor.config.auth.{type,profile,base_url}` | `instance.credentialsRef` + `host`/`port`/`baseUrl` | **move to agent** as an auth *profile reference*; keep the secret host-side (§7) |
| `executor.config` model options (e.g. reasoning) | `serves[].reasoningEffort` | **move to agent** `executor.config.options.reasoningEffort` |
| `executor.type: omnigent` / `context_window` | — | **add** (the delegation seam + tuning) |
| `os_env.{type,cwd,sandbox}` | `permission` (which tools) + harness cwd/worktree | **add `os_env`**; map `permission` → registered tools; adopt `sandbox` field (may be a no-op initially) |
| `guardrails.policies.<name>` | `permission: {tool: allow\|ask\|deny}` + coordinator `PermissionCoordinator` | **represent Arke's ask/deny as built-in guardrail policies** (e.g. `require_human_approval` on `tool_call` = "ask"; `read_only_os` = edit/write "deny") |
| `tools.<name>: {type: function\|mcp\|agent}` (keyed map) | `tools: [{name, kind: function\|mcp\|agent}]` (array) | **reshape** array → keyed map |
| `tools.agents.<name>` / `agents/<name>/config.yaml` | recursive `subAgents` from `agents/<name>/` | already matches (keep) |
| `spawn`, `async`, `cancellable`, `timers`, `params`, `terminals` | — | **add** as optional passthrough |
| `interaction.mode` (Arke) | — (Omnigent infers primary vs sub-agent by nesting) | keep `interaction.mode` as an Arke extension, or fold into top-level `mode` |

**Net:** ~8 fields already identical; `executor` is the one structural addition that carries model +
provider + harness; `tier` and the registry's tier→model map are the one deletion. `permission` maps
onto `os_env` + `guardrails`.

---

## 5. Where the model reaches the harness (the seam that moves)

Today the model is resolved **late**, at dispatch, from the tier:
`adapter.messageBody()` calls `this.resolveModel(input.tier)` and emits
`model: {providerID, modelID, options:{reasoningEffort}}` (`adapter-opencode/src/index.ts:329-375`).
`SendMessageInput` carries only `{agent, tier, parts}` (`contracts/src/adapter.ts:42`).

After adoption the model is **declared on the agent**, so it can be bound **early**, two clean ways:

1. **Materialize it** — `materializeAgent()` writes the model into the OpenCode agent frontmatter
   (`.opencode/agents/<name>.md` supports `model:`), so OpenCode uses the agent's own model and Arke
   need not send `model` per turn. (`adapter-opencode/src/index.ts:246` `agentMarkdown()` today emits
   only `tier:` — change it to emit `model:`, `options:`, and the permission→policy mapping.)
2. **Carry it on the dispatch** — extend `SendMessageInput` with the resolved `{model, provider,
   options}` (from the agent's executor) instead of `tier`, and keep `messageBody()` emitting it.

Recommended: **(1) as the primary path** (agent is self-describing to the harness, matching Omnigent)
with **(2)** as an override for per-turn model changes (the `/model` affordance Omnigent also has).

---

## 6. Blast radius — the 7 consumers of the tier indirection

Every place that must change when "agent → tier → registry → model" becomes "agent declares model":

1. **`loadAgentImage()`** `agent-image/src/index.ts:47` — **remove** the "reject `model:`" guard;
   **add** `executor` parsing.
2. **`AgentImage` schema** `contracts/src/agent-image.ts:40` — replace `tier` with `executor`; add
   `prompt`, `osEnv`, `guardrails`, `spawn`, etc.
3. **`materializeAgent()/agentMarkdown()`** `adapter-opencode/src/index.ts:246` — emit `model`/options
   + permission→policy instead of `tier`.
4. **Registry** `coordinator/src/registry.ts` — `ServesEntry`/`RosterEntry`/`ModelSelection` and
   `resolve()` (`:229`) become an **auth/provider profile** store; tier→model map removed.
5. **`SessionRouter`** `coordinator/src/session-router.ts:94` — routing and **tier-failover** (`:143`)
   rework: route by the agent's declared harness/provider; failover keyed on provider profile, or
   dropped for v1.
6. **Review-panel distinctness** `coordinator/src/review-panel.ts:176` — `validateReviewers()` must
   compare the reviewer **agents' declared `executor.model`** for pairwise distinctness, instead of
   "distinct capable models in the registry."
7. **Client projection + scaffold** `coordinator/src/project-context.ts:325` &
   `coordinator/src/scaffold.ts:355` — the roster/harness UI already surfaces model+effort (recent
   change); update it to read from the agents' executors; the scaffold emits Omnigent-shaped agent
   YAMLs (with `executor`) + a light auth registry instead of the tier `serves[]` map.

Also touched: `SendMessageInput` (`contracts/src/adapter.ts:42`) and `panel.started` event
(`project-context.ts:1247`) — model attribution now comes from the agent, not the tier.

---

## 7. Preserving Arke's invariants while adopting the structure

- **Credential boundary (NFR-1).** Omnigent supports an inline `executor.config.auth.api_key` — Arke
  must **forbid inline keys in committed YAML** and require `auth: { type: provider, profile: <name> }`
  (or `credentialsRef`), resolving the profile to a real key **host-side only**. Model *ids* are not
  secret (public catalog), so putting `model:` in the repo is fine and matches Omnigent; only keys
  stay host-side. The client keeps seeing model+harness (already done), never credentials.
- **Reviewer independence (SPEC-007).** Re-express as: the reviewer agents' `executor.config.model`
  (and/or provider) must be pairwise distinct — validated at panel convene by reading the agents, not
  the registry. Arguably *stronger* and clearer than the tier-based check.
- **Determinism / lazy binding.** Materializing the model onto the agent keeps dispatch deterministic
  and removes a runtime lookup; the per-turn override path (§5.2) preserves flexibility.

---

## 8. The light abstraction over Omnigent (long-term)

`executor.type: omnigent` is the forward-compatibility seam:

- **Now (Arke-native runner):** Arke's loader reads the Omnigent YAML; a `HarnessRunner` registry maps
  `executor.config.harness` → an Arke adapter. Only `opencode-native` (today's `OpenCodeAdapter`) is
  wired initially; `claude-native`/`codex`/etc. are recognized-but-unsupported (clear error). Model +
  provider pass straight through from `executor.config` to the adapter.
- **Later (delegate to Omnigent):** an `OmnigentRunner` implements the same `HarnessAdapter` seam by
  shelling out to / embedding the real Omnigent, which already supports every harness. The **same YAML
  files** work unchanged — Arke becomes the spec-driven orchestration + review + delivery layer *over*
  Omnigent, rather than reimplementing harness runners.

This means: adopt the schema now, keep the one adapter we have, and the investment is
forward-carried when we swap the runner for Omnigent.

---

## 9. Migration plan (phased, non-breaking)

- **Phase 0 — dual-read.** Add the Omnigent `executor` schema to `AgentImage` as optional *alongside*
  `tier`. `loadAgentImage()` accepts both; if `executor.config.model` is present it wins, else fall
  back to tier→registry. No behaviour change for existing projects. (Ships the schema.)
- **Phase 1 — materialize + dispatch from executor.** `agentMarkdown()` emits `model`/options from the
  executor; `SendMessageInput` optionally carries the resolved model. Existing tier configs still work
  via the fallback.
- **Phase 2 — scaffold Omnigent-native.** New projects scaffold agent YAMLs with `executor` blocks and
  a **light auth/provider registry** (`.arke/providers.json` or a trimmed `config.json` with only
  `instances` as auth profiles). Update the client roster/harness UI to read executors.
- **Phase 3 — retire the tier map.** Move reviewer-distinctness + failover onto declared models;
  provide a one-shot **migrator** that rewrites existing `.arke/config.json` `serves[]` + `roster`
  into per-agent `executor` blocks. Keep `tier` only as optional sugar (a named default model), or
  drop it.
- **Phase 4 — Omnigent runner.** Implement `OmnigentRunner` behind the `HarnessRunner` seam; the same
  agent YAML now runs on any Omnigent harness.

---

## 10. Open decisions (recommendations in **bold**)

1. **Keep `tier` as optional sugar, or remove it?** — **Keep as optional sugar** during Phases 0–3
   (a named alias resolving to a default model) for a soft migration; remove once all projects declare
   models. Omnigent has no tiers, so long-term it's gone.
2. **Registry: remove, or keep as auth/provider profiles?** — **Keep, trimmed to auth/provider
   profiles** (endpoints + `credentialsRef`), referenced by `executor.config.auth.profile`. This
   preserves NFR-1 and gives one host-side place for credentials, matching Omnigent's `omnigent setup`.
3. **Adopt `os_env.sandbox` now?** — **Add the field now, treat as advisory** (map `permission` →
   registered tools; ignore `sandbox.type` until we add real isolation). Keeps the YAML 100% Omnigent.
4. **Model Arke permissions as guardrail policies, or keep the `permission` block?** — **Emit both**:
   keep the concise `permission: {tool: allow\|ask\|deny}` as an Arke ergonomic, and *derive* the
   Omnigent `guardrails.policies` (e.g. `read_only_os`, `require_human_approval`) from it at
   materialization, so the on-disk schema is Omnigent-shaped while authoring stays terse.
5. **Wrapped vs direct `executor` form?** — **Adopt the wrapped form** (`executor.type: omnigent` +
   `config`), since that is the delegation seam and the current Omnigent examples' canonical form.

---

## Appendix — reference file map

Arke (current): `contracts/src/agent-image.ts:40` (AgentImage), `agent-image/src/index.ts:34,47`
(loader + model-reject), `adapter-opencode/src/index.ts:246,329` (materialize + messageBody),
`coordinator/src/registry.ts:16-55,229` (types + resolve), `coordinator/src/session-router.ts:94,143`
(route + failover), `coordinator/src/review-panel.ts:176` (reviewer distinctness),
`coordinator/src/scaffold.ts:355-425` (ROSTER + agentFile + configFile),
`coordinator/src/project-context.ts:325` (client projection).

Omnigent: `docs/AGENT_YAML_SPEC.md`, `examples/polly/config.yaml`,
`examples/polly/agents/opencode/config.yaml`, `examples/sentinel/agents/reviewer/config.yaml`,
`examples/kimi_hello.yaml`.
