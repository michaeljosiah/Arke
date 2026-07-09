---
type: index
generated: true
---

<!-- GENERATED FILE — do not edit by hand. Regenerated from this folder's document frontmatter
     by the Arke coordinator (SPEC-026). Edit the documents, not this index. -->

# Docs

| Type | Title | Description |
|------|-------|-------------|
| architecture | [Agent roster & model resolution](agent-roster-and-model-resolution.md) | The canonical, harness-agnostic definition of the agents a project ships, and the config that resolves a logical model tier to a concrete model on a concrete harness instance. The method owns these definitions; each adapter materialises them into its harness's format (for OpenCode, committed markdown under `.opencode/agents/`). |
| product-overview | [Arke — the Specification Orchestrator](product-overview.md) | Arke makes the **specification the unit of work**. It is a React client plus a thin local coordinator that sits on top of a coding-agent harness (OpenCode first) and drives a spec from authoring, through independent multi-model review, to reviewed delivery — while a human decides at every governed step. The orchestrator realises, visualises, and coordinates; the harness owns execution and credentials. |
| domain-glossary | [Arke domain glossary](domain-glossary.md) | The shared vocabulary of Arke — the terms a specification, an agent, or a reviewer should use consistently. Definitions here are the canonical meaning; when a spec uses one of these words it means this, not a looser everyday sense. |
| business-context | [Why Arke exists — the problem and the wager](business-context.md) | Coding agents are now capable enough to implement real changes, but teams cannot let them touch a system of record unsupervised: an agent that is right most of the time is still wrong often enough that ungoverned autonomy is unacceptable in a repository people depend on. Arke's wager is that the missing piece is not a smarter agent but a **governed workflow** — one where a durable, reviewed specification is the unit of work, and a human decision sits between every agent proposal and every irreversible act. |
