# @specone/coordinator

The thin local coordinator (PRD §8.5, NFR-7, NFR-8). It runs on the harness host, inside
the trust boundary, and:

1. **Ingests** provider events through a `HarnessAdapter`.
2. **Normalizes + validates** them into the canonical `DomainEvent` model.
3. **Folds** them into a `ReadModel` (board cards computed from real signals).
4. **Persists** each to an append-only `Trace` (`.specone/trace.ndjson`) — the audit
   source of truth.
5. **Pushes** them to clients over WebSocket, ordered and monotonically sequenced per
   connection; replays current state on (re)subscribe.

No cloud backend sits on the hot path.

```bash
npm run dev --workspace @specone/coordinator   # ws://127.0.0.1:4319, mock adapter
```

Env: `SPECONE_COORDINATOR_PORT` (default 4319), `SPECONE_TRACE_PATH`
(default `.specone/trace.ndjson`).

The default `MockAdapter` emits a scripted stream so the loop runs without a live OpenCode
host. Swap in `@specone/adapter-opencode` once a harness host is available.
