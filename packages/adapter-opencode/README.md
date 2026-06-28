# @specone/adapter-opencode

The first harness adapter (PRD §15). Maps SpecOne capabilities onto OpenCode's headless
server API and event stream, and normalizes OpenCode's native events into the canonical
`DomainEvent` model.

This is a **skeleton**: the interface and the capability mapping are in place; the concrete
HTTP/SSE calls are TODOs to fill against a running `opencode serve`. See the
**OpenCode Integration Guide** in [`docs/analysis`](../../docs/analysis) for the exact
endpoints, event names and auth model used to complete it.

```ts
import { OpenCodeAdapter } from "@specone/adapter-opencode";

const adapter = new OpenCodeAdapter({ baseUrl: "http://127.0.0.1:4096", password: process.env.OPENCODE_PASSWORD });
```
