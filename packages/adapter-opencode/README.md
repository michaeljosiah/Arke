# @arke/adapter-opencode

The first harness adapter (PRD §15; SPEC-002). Implements the backend-agnostic
`HarnessAdapter` against a live `opencode serve`, normalising OpenCode's native events into
the canonical `DomainEvent` model. Everything OpenCode-specific is absorbed here so the
coordinator and client learn no OpenCode fact. See the **OpenCode Integration Guide** in
[`docs/analysis`](../../docs/analysis) for the endpoints, event names and auth model.

```ts
import { OpenCodeAdapter, FileSessionStore } from "@arke/adapter-opencode";

const adapter = new OpenCodeAdapter(
  {
    baseUrl: "http://127.0.0.1:4096",
    password: process.env.OPENCODE_SERVER_PASSWORD, // host-only; never reaches the client
    projectRoot: process.cwd(), // canonicalised + validated; scopes every request
    resolveModel: (tier) => ({ provider: "gateway", name: tier === "capable" ? "big" : "small" }),
  },
  { sessionStore: new FileSessionStore(".arke/sessions.ndjson") }, // durable ownership graph
);

await adapter.init(); // probe capabilities + recover ownership
if (!adapter.readiness().ready) throw new Error(adapter.readiness().reason);

for await (const event of adapter.streamEvents()) {
  // normalised, identity-attached, schema-validated domain events
}
```

## What it does

- **Connects** to a configured server with HTTP Basic auth; scopes every request to the
  canonicalised, traversal-validated project root. Credentials stay on the host.
- **Probes capabilities** at startup from `GET /doc` — it advertises only what the live
  server exposes, and fails readiness (with a reason) when a required capability is missing.
- **Owns identity.** A durable session graph maps `sessionId → { kind, parentSessionId,
  spec_id }`, rebuilt from REST on every (re)connect and persisted so a coordinator restart
  recovers ownership. An event for an unknown session is resolved via REST before emission.
- **Drives roles at a tier** with a correlation id (`messageID`), sync (`sendMessage`) and
  non-blocking (`dispatchAsync`); turn completion is signalled by `session.idle`, never guessed.
- **Normalises + validates** each event, attaching canonical identity; unmappable or invalid
  events are **dead-lettered** (raw payload + reason + count), never silently dropped.
- **Confirms permissions by event**, not HTTP status (the reply endpoint returns 200 for stale
  ids). Handles timeout → unconfirmed, stale ids, duplicate-idempotency, and reconnect-reconcile.

## Tests

```bash
npm run test --workspace @arke/adapter-opencode
```

Unit (directory/auth/normalisation/capabilities/model-resolution/session-graph/permissions),
integration (an in-process stub OpenCode HTTP+SSE server exercising create→message→todo→diff
→permission, a forced disconnect proving the graph rebuilds, an unknown-session REST resolve),
and a contract test that pins the `GET /doc` shape and fails on drift.
