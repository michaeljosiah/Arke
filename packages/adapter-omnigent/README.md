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
docker run -d --name arke-omnigent -p 6767:6767 \
  -v arke-omnigent-data:/root/.omnigent \
  -v "<your>/opencode/auth.json:/root/.local/share/opencode/auth.json:ro" \
  arke-omnigent-spike
docker exec -d arke-omnigent sh -c 'omni host --server http://localhost:6767'   # bind a runner
curl http://127.0.0.1:6767/v1/sessions?limit=1     # 200, no auth (local single-user)
```

`omnigent server` is the **control plane only**. A turn executes on a **runner/host** bound via
`omni host`, which carries the harness (OpenCode here) and its model credential (the read-only
`auth.json` mount). Without a runner, `POST …/events` returns `503 runner_unavailable`. This
server/runner split mirrors Arke's own coordinator/runner model (SPEC-018).

## Status — exit GREEN (ADR-0002)

A real OpenCode turn was driven through the adapter's event path end-to-end: `POST …/events` → 202 →
`response.output_item.done` (assistant `"PONG"`, model `openai/gpt-5.5-fast`) → `response.completed`.
The substrate thesis is proven. The adapter remains on the spike branch pending a hardening spec
(correlation, event-confirmed approvals, reconnect, alpha-churn pinning). Unit tests
(`npm test -w @arke/adapter-omnigent`) cover the normaliser + SSE parser against captured **live**
frame shapes (incl. the nested `item.content[]` assistant snapshot).
