# ADR 0003 — WebSocket (not SSE+REST) for the coordinator→client leg

- **Status:** accepted
- **Date:** 2026-06-29
- **PRD decisions:** D2 (no cloud backend on the hot path), D12 (thin local coordinator)
- **Relates:** [ADR 0001](0001-thin-client-local-coordinator.md), [SPEC-003](../specifications/003.coordinator-domain-model-and-transport.md), [SPEC-017](../specifications/017.arke-cli.md)

## Context

Arke has three transport legs, and only one is ours to choose:

- **harness → adapter** — dictated by the harness. OpenCode is **HTTP + SSE**; ACP is **JSON-RPC over stdio**; Omnigent is **SSE + REST**. There is no common WebSocket across coding-agent harnesses, so "WS across the board" is not available — the coordinator's job is to *normalize* these heterogeneous transports into one domain model.
- **adapter → coordinator** — in-process (same Node process); not a network transport.
- **coordinator → client** (browser + the SPEC-017 CLI) — **the only leg we choose.** SPEC-003 already uses a WebSocket here; SPEC-017 asked whether one-shot CLI ops should instead use HTTP, leaving a WS-vs-SSE+REST question open. Omnigent is a useful counterpoint: it uses **SSE for its client stream + REST for ops**, reserving WS only for terminal-attach and runner tunnels.

## Decision

Keep **WebSocket** as the single coordinator→client transport, for both the browser and the CLI. The CLI reuses the same WS request/response surface rather than adding an HTTP+SSE surface alongside it.

## Rationale

1. **The leg is bidirectional.** The client both receives the event stream *and* sends back permission decisions, steering, and (CLI) operations. WS carries both directions on one connection; SSE is server→client only, forcing a second channel (SSE down + HTTP POST up) and the cross-channel correlation that brings — e.g. a `permission decide` whose confirmation arrives on the stream (SPEC-002's confirm-by-event).
2. **Arke is local-first.** `ws://127.0.0.1`, no cloud backend on the hot path (ADR-0001). SSE's headline advantage — sailing through proxies, load balancers, CDNs, and firewalls that can break the WS upgrade — is **moot between localhost and localhost**. We pay none of WS's traversal cost.
3. **One surface, one auth, one trace chokepoint.** A single WS listener means one place to enforce the loopback/origin boundary and one ingress to record in the trace. Adding HTTP+SSE for the CLI would be a *second* client surface alongside the existing WS (more to secure, test, and keep consistent) for no local benefit.
4. **It already exists and is proven.** SPEC-003's five-state reconnecting transport, snapshot-on-connect, and per-connection `seq` are built and tested. The CLI opening a `ClientWebSocket` for a one-shot op is ~10 lines; an agent driving Arke already holds a `watch` stream open, so ops over that same connection get reply-correlation for free.

Why Omnigent differs (and is still right *for them*): it is a hosted, multi-device, cloud-sandbox product, so proxy/CDN traversal and an API-first, `curl`-able, SDK-generated REST surface are worth a lot — SSE+REST buys those. Arke is local-first and bidirectional, so the trade lands the other way. Both choices are correct in context.

## Consequences

- SPEC-017's CLI is **all-WS**: a request/response command surface over the existing coordinator WebSocket, plus the event subscription for `watch`. No HTTP control endpoint is added.
- One transport to document and version; one CSWSH/loopback guard; one trace ingress.
- We forgo trivial `curl`-ability of one-shot ops. Accepted: the consumers are the browser client and the C#/Spectre CLI, both of which speak WS comfortably.
- **Revisit trigger:** if Arke ever runs **hosted/remote** — a coordinator reached across a network with proxies/CDNs, or browser clients outside localhost — re-evaluate. At that point SSE+REST's traversal and API-first story become compelling enough to weigh migrating *both* legs, rather than bolting a second surface onto the local design.
