---
type: reference
title: Cross-repo specifications — a worked example
description: One canonical spec, one authored delta ripple, and one generated pointer stub (SPEC-030).
---

# Cross-repo specifications — a worked example

A worked illustration of the [SPEC-030](../030.cross-repo-specifications.md) convention (grounded in
[ADR-0005](../../decisions/0005-multi-codebase-spec-storage.md)): a payment-retry contract owned by
`acme/contracts` that ripples into two consumer repos — `acme/widgets` (which has its own contract change,
so it gets an authored **delta** ripple) and `acme/gizmos` (no local contract change, so it gets a generated
read-only **pointer** stub).

> These are illustrations, not live specs. `specLibrary()` scans only the top level of
> `docs/specifications/`, so files under `examples/` are never treated as real specifications.

## 1 · The canonical spec (in `acme/contracts`)

The owning repo authors the full specification and enumerates its ripples. `kind: delta` names a repo that
authors its own thin ripple; `kind: pointer` names a repo that only needs a generated back-reference.

```markdown
---
spec_id: SPEC-2026-07-10-payment-retry
title: Idempotent payment retry
status: approved
branch: feat/payment-retry
owner: alice
capabilities: [payment-retry]
ripples:
  - repo: acme/widgets
    spec: SPEC-2026-07-10-widget-retry
    kind: delta
  - repo: acme/gizmos
    spec: generated
    kind: pointer
---

# Idempotent payment retry
## Requirements
### Requirement: Retries are idempotent
The system SHALL treat a repeated webhook with a seen `idempotency_key` as a no-op.
#### Scenario: A repeated webhook is a no-op
- **WHEN** a webhook arrives whose `idempotency_key` was already processed
- **THEN** no second charge is made
```

## 2 · The authored delta ripple (in `acme/widgets`)

The widgets repo has its own contract surface to change, so it authors a thin ripple with normal `delta:`
tags for **its** portion, plus a machine-readable back-reference to the canonical. Its own library stays a
complete local contract — which matters, because that library grounds the agents working in that repo.

```markdown
---
spec_id: SPEC-2026-07-10-widget-retry
title: Widget-side retry handling
status: draft
branch: feat/widget-retry
owner: bob
canonical:
  repo: acme/contracts
  spec: SPEC-2026-07-10-payment-retry
---

# Widget-side retry handling
## Requirements
### Requirement: The widget forwards the idempotency key
`delta: ADDED (feat/widget-retry)`
The widget SHALL forward the canonical `idempotency_key` on every retry.
```

When the canonical materially changes, the coordinator marks this ripple **stale** in the widgets project —
surfaced in its library with the canonical trigger. A human clears it with `spec.ripple.ack` (a recorded
"reviewed / no local impact" decision), or by re-reviewing the ripple.

## 3 · The generated pointer stub (in `acme/gizmos`)

The gizmos repo has no local contract change, so `spec.ripple.project` generates a read-only pointer — a
deterministic projection carrying the canonical's frontmatter + summary and a do-not-hand-edit marker. It is
a pointer, **not** a copy: it never contains the canonical's requirement bodies, and its content never flows
back. Regeneration is idempotent and clears any staleness.

```markdown
---
spec_id: ripple-SPEC-2026-07-10-payment-retry
title: Idempotent payment retry (cross-repo pointer)
status: approved
type: pointer
generated: true
canonical:
  repo: acme/contracts
  spec: SPEC-2026-07-10-payment-retry
---

<!-- GENERATED POINTER — do not hand-edit. This repository is affected by a specification whose canonical
     copy lives in acme/contracts. Regenerated deterministically by the Arke coordinator (SPEC-030). -->

# Idempotent payment retry — cross-repo pointer
This repository is affected by **SPEC-2026-07-10-payment-retry**, whose canonical specification lives in
**acme/contracts**. There is no local contract change here — see the canonical for the full requirements.
```
