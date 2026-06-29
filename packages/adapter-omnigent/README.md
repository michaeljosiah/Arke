# @arke/adapter-omnigent (SPIKE)

A `HarnessAdapter` over **Omnigent**'s v1 HTTP API — the open-source *meta-harness* evaluated as a
candidate **substrate** one level up from OpenCode. This is the ADR-0002 spike; it is **kept off
`main`** until the live conformance fully proves out. See
[ADR-0002](../../docs/decisions/0002-omnigent-as-candidate-harness-substrate.md).

## What it maps (live-verified against Omnigent 0.3.0)

| Arke | Omnigent v1 |
|---|---|
| init / readiness | `GET /v1/sessions?limit=1` |
| `createSession` | `POST /v1/sessions` (**`agent_id` required**; id returned as `id`/`conv_…`) |
| `sendMessage`/`dispatchAsync` | `POST /v1/sessions/{id}/events` `{type:"message",data:{role,content:[{type:"input_text",text}]}}` |
| `streamEvents` | `GET /v1/sessions/{id}/stream` (per-session SSE, fanned into one channel) |
| `respondToPermission` | elicitations `POST /v1/sessions/{id}/elicitations/{id}/resolve` |

Capabilities are honestly limited to `events` + `permissions` (no REST diff; `/items` is history, not
todos).

## Run the live conformance

```bash
docker build -f packages/adapter-omnigent/spike/Dockerfile -t arke-omnigent-spike .
docker run -d --name arke-omnigent -p 6767:6767 arke-omnigent-spike
curl http://127.0.0.1:6767/v1/sessions?limit=1     # 200, no auth (local single-user)
```

The container is the **control plane only**. A real agent turn needs a **runner/host** bound to the
session (`omnigent host`) with the harness (e.g. Claude Code) and a model API key; without one,
`POST …/events` returns `503 runner_unavailable`. This server/runner split mirrors Arke's own
coordinator/runner model (SPEC-018).

## Status

Control-plane conformance is green (auth boundary, session create, SSE parsing, send-event shape).
The model-driven turn is gated on a runner + an operator-supplied model key — **exit YELLOW** in
ADR-0002. Unit tests (`npm test -w @arke/adapter-omnigent`) cover the normaliser + SSE parser against
captured frame shapes.
