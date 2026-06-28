# Agent roster & model resolution

The canonical, harness-agnostic definition of the agents a project ships, and the
config that resolves a logical model tier to a concrete model on a concrete harness
instance. The method owns these definitions; each adapter materialises them into its
harness's format (for OpenCode, committed markdown under `.opencode/agents/`).

Agents reference a **logical tier**, never a vendor model id. Resolution happens once,
in the coordinator's registry, so models change without touching agent definitions or
the committed specification.

---

## 1. The canonical roster

| Role | Purpose | Tier | Writes | Used in |
|------|---------|------|--------|---------|
| `spec-author` | Co-authors the specification with the human: Why, Requirements, scenarios | capable | `docs/specifications/` | Authoring cockpit |
| `architect` | Fills the Design depth: architecture, data model, interfaces, cross-cutting | capable | `docs/specifications/` (design sections) | Authoring cockpit |
| `reviewer-a` | Independent critique of the spec, grounded in source | capable (model A) | nothing (proposes critiques) | Review panel |
| `reviewer-b` | Independent critique on a **different** model, grounded in source | capable (model B) | nothing (proposes critiques) | Review panel |
| `implementer` | Executes the Tasks; writes code on the feature branch | mid | workspace (code) | Generation / board |
| `researcher` | Gathers and summarises codebase + vendored context to ground authoring | mid | nothing (read-only) | Authoring (optional) |

Notes that keep the roster honest:

- **Reviewers are read-only.** They propose critiques into the panel; the human adjudicates
  and accepted critiques feed back into the draft. They never commit.
- **Two reviewers, two models.** `reviewer-a` and `reviewer-b` must resolve to *different*
  models so the critique is genuinely independent. This is the one place the roster pins a
  model distinction rather than just a tier.
- **The implementer is mid-tier on purpose.** A capable model authored the spec precisely so a
  mid model can implement it accurately and cheaply. If implementation needs the capable tier,
  the spec was probably underspecified.
- **Projection is not an agent.** Writing spec state into systems of record (Jira, Azure DevOps)
  is deterministic plugin code reacting to events, not a roster role. Keep it out of the agents.
- **The app is the conductor.** Do not give any harness its own orchestrator agent; the
  React app coordinates. Use the harness's task-permissions only as a guardrail.

### How a role materialises (OpenCode example)

`.opencode/agents/spec-author.md`

```markdown
---
description: Co-authors the specification with the human
mode: primary
tier: capable            # resolved to a model by the coordinator, not hardcoded
permission:
  edit: allow            # scoped to docs/specifications/ by policy
  bash: ask
---
You author and revise the specification with the human. Write requirements as
normative SHALL statements, each with at least one WHEN/THEN scenario. Ground every
claim in the codebase and the vendored references under .repos/. Never invent APIs.
```

The `tier: capable` line is the contract. The adapter rewrites it to the concrete model the
registry resolves for this project at session-create time.

---

## 2. Tier to model to instance

An **instance** is a configured binding of a driver to credentials, a host and a working
directory. It declares which tiers it can serve. A role asks for a tier; the router picks an
instance that serves it and returns a concrete selection. The role never names a harness.

```yaml
# coordinator registry (per project or per org)
instances:
  - id: claude-local
    driver: claude-code
    host: localhost
    cwd: .
    credentialsRef: claude-code/default     # resolved on the host, never sent to the client
    serves:
      - { tier: capable, model: <claude-capable-model> }

  - id: opencode-local
    driver: opencode
    host: localhost
    cwd: .
    credentialsRef: opencode/gateway
    serves:
      - { tier: capable, model: <other-capable-model> }   # a different family, for reviewer-b
      - { tier: mid,     model: <mid-model> }

# how roles bind to tiers (and, for reviewers, to distinct instances)
roster:
  spec-author:  { tier: capable }
  architect:    { tier: capable }
  reviewer-a:   { tier: capable, instance: claude-local }
  reviewer-b:   { tier: capable, instance: opencode-local }   # forced different model
  implementer:  { tier: mid }
  researcher:   { tier: mid }
```

### Resolution rule

```
resolve(role):
  if role pins an instance        -> use it; take the model that instance serves for the tier
  else pick any instance serving the role's tier,
       preferring one already running on the right host/cwd
  return ModelSelection { instanceId, tier, model }
```

This is the same mechanism as multi-harness routing in the PRD: because a tier resolves to an
instance, and an instance binds a driver, "use a capable model" and "use Claude Code" are the
same act. The engineer picks a role; the router places it.

### What ships, what is configured

- **Shipped by scaffolding (template-once):** the roster above, materialised into the harness
  convention, with `tier:` references and scoped permissions.
- **Configured per project or org:** the `instances` registry (drivers, credentials, models per
  tier). This is the one place vendor model ids live, behind the internal gateway.
- **Deferred:** managed sync that updates a scaffolded roster against this canonical set as a
  reviewable diff; arrives with the team tier.
