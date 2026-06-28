# OpenCode Integration Guide for Arke

**adapter target:** `packages/adapter-opencode`
**sources verified against:** opencode.ai/docs, pkg.go.dev/github.com/sst/opencode-sdk-go, github.com/anomalyco/opencode (archived mirror), github.com/anomalyco/opencode-sdk-js, deepwiki/opencode, GitHub issues.

> **Repository note:** The canonical upstream is [github.com/opencode-ai/opencode](https://github.com/opencode-ai/opencode). A widely-forked mirror exists at `anomalyco/opencode`. The JavaScript SDK is `npm install @opencode-ai/sdk`. Endpoint paths and event names below were cross-checked against the Go SDK package docs and issue tracker. **Always validate against the live OpenAPI spec at `GET /doc` on your target version** — OpenCode is early and breaking changes happen.

---

## 1. Running the Server

```bash
opencode serve [--port <number>] [--hostname <string>] [--cors <origin>] [--mdns] [--mdns-domain <domain>]
```

| Flag | Default |
|------|---------|
| `--port` | `4096` |
| `--hostname` | `127.0.0.1` |
| `--mdns` | disabled |
| `--mdns-domain` | `opencode.local` |

Config-file equivalent (`opencode.json`, lower precedence than CLI):

```json
{ "server": { "port": 4096, "hostname": "0.0.0.0", "cors": ["http://localhost:5173"] } }
```

Other relevant CLI commands: `opencode run [message]` (one-shot, no server), `opencode web`
(serve + static web UI), `opencode attach [url]` (TUI to remote backend), `opencode acp`
(ACP JSON-RPC over stdio — **not** the HTTP path).

The server is built on **Hono** and auto-generates an OpenAPI 3.1 spec, always browseable at
`GET http://<hostname>:<port>/doc`.

Sources: [opencode.ai/docs/server/](https://opencode.ai/docs/server/), [opencode.ai/docs/cli/](https://opencode.ai/docs/cli/)

---

## 2. Auth & CORS

**Basic auth** — set before starting:

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve   # username defaults to "opencode"
OPENCODE_SERVER_USERNAME=myuser opencode serve          # optional
```

When the password is set, every request needs `Authorization: Basic <base64(user:pass)>`.

**CORS** — built-in allowlist: `localhost` (any port), `127.0.0.1`, `tauri://localhost`,
`https://*.opencode.ai`. Add origins with `--cors <origin>` or `server.cors`.

**Directory scoping** — pass `?directory=<path>` query or `x-opencode-directory` header to
scope a request to a working directory. Arke's adapter should always pass the project dir.

Sources: [opencode.ai/docs/server/](https://opencode.ai/docs/server/), [issue #11616](https://github.com/anomalyco/opencode/issues/11616)

---

## 3. HTTP API Surface

Paths relative to `http://<hostname>:<port>`. Full spec at `GET /doc`.

### Sessions
- `POST /session` — create; body `{ parentID?, title? }`. **`parentID` makes a child (task) session.**
- `POST /session/:id/fork` — fork; body `{ messageID? }`.
- `GET /session` · `GET /session/:id` · `PATCH /session/:id` `{title}` · `DELETE /session/:id`
- `GET /session/:id/children` — list child sessions.
- `POST /session/:id/abort` — stop a running session.

### Messages / prompting (same body schema)
- `POST /session/:id/message` — **synchronous** (blocks; returns assistant `Message`).
- `POST /session/:id/prompt_async` — **non-blocking** (returns `204`; track via SSE).
- `GET /session/:id/message` — list messages (replay).

Body:
```json
{
  "messageID": "optional idempotency key",
  "model": { "provider": "anthropic", "name": "claude-sonnet-4-20250514" },
  "agent": "optional agent id",
  "system": "optional system override",
  "parts": [ { "type": "text", "text": "..." } ]
}
```
Part types: `text`, `file` (`path` + `source`), `agent`, `symbol` (`path` + `range`).

### Todo / Diff
- `GET /session/:id/todo` → `Todo[]` (`id`, `text`, `completed`).
- `GET /session/:id/diff` → `FileDiff[]`.

### Permissions
- `GET /permission/` — pending requests (**not persisted across restarts** — issue #15386).
- `POST /permission/:requestID/reply` — body `{ "response": "approve" | "deny" }`.
  (UI surfaces `once`/`always`/`reject`; server accepts `approve`/`deny` per the Go SDK.)

### Questions (agent-prompted input)
- `GET /question/` · `POST /question/:requestID/reply` · `POST /question/:requestID/reject`

### Revert / Unrevert (rescue)
- `POST /session/:id/revert` — body `{ messageID }` (rolls back to pre-message snapshot).
- `POST /session/:id/unrevert` — restore. Requires the `snapshot` feature (default on).

### Commands / shell
- `POST /session/:id/command` — `{ command: "/undo", arguments?: [...], agent?, model? }`.
- `POST /session/:id/shell` — `{ command }` → `{ output, exit_code }`.

### Global / discovery
- `GET /global/health` · `GET /global/event` (SSE) · `GET /event` (SSE)
- `GET /agent` · `GET /command` · `GET /config` · `GET /config/providers` · `GET /provider`
- `GET /experimental/tool/ids` · `GET /experimental/tool?provider=&model=` (**experimental**)
- `POST /mcp` · `GET /vcs` · `GET /find?pattern=` · `GET /find/file?query=` · `GET /find/symbol?query=` · `GET /file/content?path=` · `GET /file/status` · `POST /log`

Sources: [opencode.ai/docs/server/](https://opencode.ai/docs/server/), [pkg.go.dev/.../opencode-sdk-go](https://pkg.go.dev/github.com/sst/opencode-sdk-go)

---

## 4. Event Stream (SSE)

Subscribe to `GET /global/event` (all sessions) or `GET /event` with `Accept: text/event-stream`.
The server emits `server.connected` on connect and a heartbeat every **30s**. **No
`Last-Event-ID`** (issue #25657) — re-fetch state via REST on reconnect.

Wire shape: `{ "type": "<event>", "properties": { ... } }`.

| Event | Signals | Key properties |
|-------|---------|----------------|
| `server.connected` | SSE accepted | — |
| `session.created` / `.updated` / `.deleted` | session lifecycle | `session` / `session_id` |
| `session.status` | exec state (`idle`/`busy`/`retry`) | `session_id`, `status` |
| `session.idle` | agent finished all work | `session_id` |
| `session.error` | agent failed | `session_id`, `error.{name,data}` |
| `session.diff` | file-change summary updated | `session_id` |
| `session.compacted` | context compacted | `session_id` |
| `message.updated` / `.removed` | message lifecycle | `session_id`, `message_id`, `message` |
| `message.part.updated` | streaming delta / tool-state | `session_id`, `message_id`, `part_index`, `part` (optional `delta`) |
| `permission.asked` | tool permission requested | `request_id`, `session_id`, details |
| `permission.replied` | permission answered | `permission_id`, `response` |
| `question.asked` / `.replied` / `.rejected` | agent question lifecycle | `request_id`, `session_id` |
| `todo.updated` | todo list changed | `todo` |
| `file.edited` / `file.watcher.updated` | file changes | `path` |
| `lsp.client.diagnostics` / `lsp.updated` | LSP | — |

**Casing note:** plugin hooks use dot-lowercase (`session.idle`); the Go SDK constants use
underscores (`session_idle`). The SSE `type` on the wire uses the dot form — confirm at `/doc`.

**Regression:** v1.14.42+ stopped delivering `message.updated` / `message.part.updated` over
`/event` for some versions (issue #27966). Verify on your target version.

Sources: [deepwiki SSE](https://deepwiki.com/chriswritescode-dev/opencode-manager/3.3-real-time-streaming-and-sse), issues [#11616](https://github.com/anomalyco/opencode/issues/11616), [#27966](https://github.com/anomalyco/opencode/issues/27966), [#25657](https://github.com/anomalyco/opencode/issues/25657)

---

## 5. Agents

| Scope | Path |
|-------|------|
| Project | `.opencode/agents/<name>.md` |
| Global | `~/.config/opencode/agents/<name>.md` |
| Inline | `opencode.json` under `"agent"` |

Filename (minus `.md`) = agent id. Create via `opencode agent create`.

```yaml
---
description: "Required — what this agent does and when to use it."
mode: primary            # primary | subagent | all
model: "anthropic/claude-sonnet-4-20250514"   # provider/model
temperature: 0.7
permission:              # preferred over the deprecated `tools:` booleans
  read: allow
  edit: ask
  bash: deny
  webfetch: allow
disable: false
---
System prompt as Markdown body.
```

Confirmed frontmatter: `description`, `mode`, `model`, `temperature`, `permission`, `disable`.
The legacy `tools:` (enable/disable booleans) is **deprecated** in favour of `permission:`.

Select per message via `"agent": "<id>"` in the message body; enumerate via `GET /agent`.
Subagents (`@mention` or auto-invoked) create **child sessions** linked by `parentID`;
`session.created` fires for the child carrying its `parentID`.

Built-ins: `build` (primary, full access), `plan` (primary, read-only), `general`/`explore`/
`scout` (subagents).

Sources: [opencode.ai/docs/agents/](https://opencode.ai/docs/agents/), [deepwiki sessions](https://deepwiki.com/sst/opencode/2.1-session-management)

---

## 6. Models / Providers

Model refs are `provider/model` (e.g. `anthropic/claude-sonnet-4-20250514`).

Selection precedence: `--model` CLI > message-body `model` > `opencode.json` `model` >
last-used > provider default.

**Internal gateway** (any OpenAI-compatible endpoint) — this is how Arke resolves its
logical tiers to controlled infrastructure (NFR-5, FR-18):

```json
{
  "provider": {
    "gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Internal Gateway",
      "options": { "baseURL": "https://gateway.internal/v1", "apiKey": "{env:GATEWAY_KEY}" },
      "models": { "capable-tier": { "name": "Capable" }, "mid-tier": { "name": "Mid" } }
    }
  }
}
```

Enumerate via `GET /config/providers`. Filter via `provider.<id>.models.whitelist/blacklist`.

Sources: [providers](https://opencode.ai/docs/providers/), [models](https://opencode.ai/docs/models/), [config](https://opencode.ai/docs/config/)

---

## 7. Plugins

| Scope | Path | Order |
|-------|------|-------|
| Global | `~/.config/opencode/plugins/*.{js,ts}` | first |
| Project | `.opencode/plugins/*.{js,ts}` | second (overrides) |
| npm | `opencode.json` `"plugin": [...]` | auto-installed via Bun |

Plugins run under **Bun**, not Node. Plugin tools override built-ins of the same name.

```typescript
import type { Plugin } from "@opencode-ai/plugin"
export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool === "read" && input.args.filePath?.includes(".env")) {
      throw new Error("blocked")   // throwing BLOCKS the tool call
    }
  },
  "session.idle": async ({ sessionID }) => { /* react */ },
})
```

Hooks: `tool.execute.before` / `.after`; `session.created/updated/idle/error/compacted/deleted/status`;
`message.updated/removed/part.updated`; `file.edited` / `file.watcher.updated`;
`permission.updated/replied`; `shell.env`; `stop`; and **experimental**
`experimental.session.compacting`, `experimental.chat.system.transform`.

**For Arke:** the deterministic projection plugin (FR-7) reacts to `session.idle` /
`message.updated` and writes to the system of record the same way every time; the policy hook
(direction-of-truth, §9 PRD) uses `tool.execute.before`.

Sources: [opencode.ai/docs/plugins/](https://opencode.ai/docs/plugins/)

---

## 8. ACP

OpenCode supports ACP as a **subprocess JSON-RPC over stdio** (`opencode acp`), used by editors
(Zed, JetBrains, Avante.nvim, CodeCompanion.nvim). All core capabilities work over ACP except
`/undo` and `/redo`. **ACP is not HTTP** — Arke's `adapter-opencode` integrates via the HTTP
server, not ACP. (ACP remains the future normalisation path for other harnesses per PRD D14.)

Source: opencode.ai/docs/acp/ (confirm path)

---

## 9. Caveats & Known Gotchas

| Issue | Impact | Status |
|-------|--------|--------|
| No `Last-Event-ID` on SSE ([#25657](https://github.com/anomalyco/opencode/issues/25657)) | Missed events on reconnect can't be replayed → adapter must re-fetch via REST | Open |
| SSE drops `message.*` in v1.14.42+ ([#27966](https://github.com/anomalyco/opencode/issues/27966)) | Real-time message streaming broken on some versions | Open |
| `permission reply` returns 200 for stale IDs ([#15386](https://github.com/anomalyco/opencode/issues/15386)) | Can't detect stale permissions from status | Open |
| Permissions not persisted across restarts (#15386) | Paused sessions get stuck after restart | Open |
| `prompt_async` returns no message id ([#22925](https://github.com/anomalyco/opencode/issues/22925)) | Can't correlate async prompt → assistant message without polling | Feature request |
| Experimental `/experimental/tool*` + compaction/system-transform hooks | API may change | Experimental |
| Upstream `opencode-ai/opencode` archived 2025-09-18; dev moved (Crush) / `anomalyco` fork | Pin a known release; validate `/doc` | Note |

Browser/Node notes: handle the 30s SSE heartbeat; always pass `?directory=`/`x-opencode-directory`;
plugins require Bun; CORS default only covers localhost + `*.opencode.ai`.

---

## 10. Arke Capability → OpenCode Primitive

| Arke capability | OpenCode primitive | Endpoint / event |
|---|---|---|
| Start a spec session | create session | `POST /session` `{title}` |
| Create a child/task session | create child | `POST /session` `{parentID}` |
| Fork at a checkpoint | fork | `POST /session/:id/fork` `{messageID?}` |
| Send spec prompt (blocking) | sync message | `POST /session/:id/message` |
| Dispatch task (non-blocking) | async prompt | `POST /session/:id/prompt_async` (204) |
| Select agent role | agent field | `"agent":"<id>"`; `GET /agent` |
| Select model tier | model field | `"model":{provider,name}` |
| Resolve tier → internal gateway | custom provider | `opencode.json` `@ai-sdk/openai-compatible` baseURL |
| Stream delivery state | SSE | `GET /global/event`; `message.part.updated` |
| Detect idle / error | events | `session.idle` / `session.error` |
| Board task signal | todo | `GET /session/:id/todo` + `todo.updated` |
| Column transitions | events | `session.status` / `.idle` / `.error` / `.diff` |
| Read diff for review | diff | `GET /session/:id/diff` |
| Human-in-the-loop | permission | `permission.asked` → `POST /permission/:id/reply` `{response}` |
| Rescue (revert/restore) | revert | `POST /session/:id/revert` / `/unrevert` |
| Abort a run | abort | `POST /session/:id/abort` |
| Policy gate (direction of truth) | plugin | `tool.execute.before` (throw to block) |
| Deterministic projection | plugin | `session.idle` / `message.updated` hooks |
| Run a command | command | `POST /session/:id/command` |
| Replay transcript | messages | `GET /session/:id/message` |
| Typed TS client | SDK | `@opencode-ai/sdk` `createOpencodeClient({ baseUrl })` |

---

### Recommendation for the adapter

Use the official **`@opencode-ai/sdk`** (`createOpencodeClient({ baseUrl })`) rather than
hand-rolling `fetch` — it tracks the OpenAPI spec and gives typed sessions/messages/events.
Normalize OpenCode events → Arke `DomainEvent` in `packages/adapter-opencode`, and on SSE
reconnect re-fetch session/message/todo/diff state via REST (no `Last-Event-ID`). Map
`permission.asked`→`DomainEvent.permission.asked`, `session.idle/error/status`→`session.status`,
`todo.updated`→`todo.updated`, `session.diff`+`GET /diff`→`diff.finalized`.

**Sources index:** opencode.ai/docs/{server,plugins,agents,config,sdk,providers,models,cli}/ ·
pkg.go.dev/github.com/sst/opencode-sdk-go · github.com/anomalyco/{opencode,opencode-sdk-js} ·
deepwiki opencode · issues #11616, #22925, #15386, #27966, #25657, #13488.
