# Decision records

The authoritative decision log for the product is the PRD (`docs/PRD-Arke.html`,
§20), decisions **D1–D19**. As the build progresses, decisions that need more depth than a
log row are promoted into their own ADR here.

| ADR | Title | PRD link |
|-----|-------|----------|
| [0001](0001-thin-client-local-coordinator.md) | Thin client over a harness, with a thin local coordinator | D2, D12 |
| [0002](0002-omnigent-as-candidate-harness-substrate.md) | Omnigent is a candidate harness *substrate*, not a rival; keep the adapter seam neutral | D11, D14 |
| [0003](0003-websocket-over-sse-for-the-client-leg.md) | WebSocket (not SSE+REST) for the coordinator→client leg | D2, D12 |
| [0004](0004-agent-model-vs-omnigent-and-the-substrate-mapping.md) | Keep Arke's harness-agnostic, tier-indirected agent model; map onto Omnigent at the boundary | D11, D14 |
| [0005](0005-multi-codebase-spec-storage.md) | Multi-codebase specifications: one canonical spec in the owning repo; ripples and projections everywhere else | D3, D4, D18 |

To add an ADR, copy an existing one, increment the number, and keep it short: context,
decision, consequences.
