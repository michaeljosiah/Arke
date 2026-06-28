# @arke/contracts

Schema-first domain contracts shared by the client, the coordinator and every harness
adapter (PRD §12, §21.1). zod-first and validated at the boundary, so a malformed event
from any backend is caught rather than silently corrupting the board.

- `spec.ts` — specification lifecycle, frontmatter, model tiers, the spec anatomy.
- `events.ts` — the normalized `DomainEvent` union, the per-connection event envelope,
  and the computed board columns.
- `adapter.ts` — the backend-agnostic `HarnessAdapter` interface and capability flags.

The adapter interface, not any one harness, is what the product is built against.
