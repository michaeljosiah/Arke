import { WebSocketServer, type WebSocket } from "ws";
import { DomainEvent, type HarnessAdapter } from "@specone/contracts";
import { ReadModel } from "./read-model.js";
import { Trace } from "./trace.js";
import { MockAdapter } from "./mock-adapter.js";

/**
 * Coordinator entry point (PRD §8.5).
 *
 * Ingests provider events through a {@link HarnessAdapter}, normalizes + validates them
 * at the boundary, folds them into a {@link ReadModel}, persists each to an append-only
 * {@link Trace}, and pushes them to connected clients over WebSocket — ordered,
 * monotonically sequenced per connection, schema-validated (NFR-8). No cloud backend
 * sits on the hot path; this process runs on the harness host, inside the trust boundary.
 */
const PORT = Number(process.env.SPECONE_COORDINATOR_PORT ?? 4319);
const TRACE_PATH = process.env.SPECONE_TRACE_PATH ?? ".specone/trace.ndjson";

class Coordinator {
  private seq = 0;
  private readonly clients = new Set<WebSocket>();
  private readonly read = new ReadModel();
  private readonly trace = new Trace(TRACE_PATH);
  private readonly adapter: HarnessAdapter;

  constructor(adapter: HarnessAdapter) {
    this.adapter = adapter;
  }

  start(): void {
    const wss = new WebSocketServer({ port: PORT });
    wss.on("connection", (ws) => this.onConnection(ws));
    console.log(`[coordinator] WebSocket listening on ws://127.0.0.1:${PORT}`);
    console.log(`[coordinator] adapter=${this.adapter.id} caps=${[...this.adapter.capabilities()].join(",")}`);
    void this.pump();
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    // Replay current state on (re)subscribe so a reconnecting client catches up (NFR-8).
    ws.send(JSON.stringify({ type: "snapshot", cards: this.read.snapshot() }));
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", (raw) => this.onClientMessage(ws, raw.toString()));
  }

  private onClientMessage(_ws: WebSocket, raw: string): void {
    // Outbound requests (sendMessage, respondToPermission, ...) are routed to the
    // adapter here. Stubbed in the skeleton; the contract is in @specone/contracts.
    try {
      const msg = JSON.parse(raw) as { type?: string };
      void this.trace.write({ kind: "client.request", request: msg });
    } catch {
      /* ignore malformed client input */
    }
  }

  /** Ingest → validate → normalize → persist → push. */
  private async pump(): Promise<void> {
    for await (const incoming of this.adapter.streamEvents()) {
      const event = DomainEvent.parse({ ...incoming, seq: ++this.seq, ts: Date.now() });
      this.read.apply(event);
      await this.trace.write({ kind: "event", event });
      const payload = JSON.stringify({ type: "event", event });
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    }
  }
}

new Coordinator(new MockAdapter()).start();
