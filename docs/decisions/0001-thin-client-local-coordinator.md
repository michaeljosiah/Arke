# ADR 0001 — Thin client over a harness, with a thin local coordinator

- **Status:** accepted
- **Date:** 2026-06-28
- **PRD decisions:** D2 (no cloud backend on the hot path), D12 (thin local coordinator)

## Context

The orchestrator must coordinate a coding-agent harness without becoming a system of record
or a heavy backend. A browser cannot speak every agent's native transport, events arrive in
heterogeneous shapes, and the UI must survive reconnects and present many concurrent agents
as one coherent picture.

## Decision

The React client is a thin realisation layer holding no authoritative state. It talks over a
WebSocket to a **thin local coordinator** that runs on the harness host, inside the trust and
credential boundary. The coordinator normalises each provider's native events into one
schema-validated domain model, persists them to an append-only trace, and pushes ordered,
sequenced events to the client. No cloud backend sits on the agent hot path. The harness owns
all execution and credentials.

## Consequences

- Harness capability differences are absorbed in the coordinator/adapter, not the client.
- The trace is the audit source of truth (NFR-7), exportable over OTLP later.
- The coordinator is a Node process, which makes an Electron desktop shell (embedding it) the
  natural packaging; the browser remains a first-class surface.
- For OpenCode (HTTP + SSE) the coordinator is thin; a stdio/bespoke agent makes it do more.
