import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { Coordinator } from "../src/server.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";

/**
 * End-to-end over the real WebSocket: a coordinator on the MockAdapter streams a snapshot
 * then ordered events to a connected client, derives turn.quiescent, preserves correlation
 * ids, and writes everything to the trace before pushing. This is the "wired" path the UI
 * relies on, exercised without a live OpenCode server.
 */
test("coordinator streams snapshot + ordered events with quiescence and correlation", async () => {
  const tracePath = join(mkdtempSync(join(tmpdir(), "arke-coord-")), "trace.ndjson");
  const coordinator = new Coordinator(new MockAdapter(), new Trace(tracePath), 0);
  const port = await coordinator.start();
  after(() => coordinator.stop());

  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  const waitFor = async (pred: () => boolean, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error("timeout waiting for frames");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  // The first frame is always the snapshot.
  await waitFor(() => frames.length >= 1);
  assert.equal(frames[0].type, "snapshot");
  assert.ok(Array.isArray(frames[0].cards));

  // A streaming turn produces message.part frames carrying the correlation id...
  await waitFor(() => frames.some((f) => f.type === "event" && f.event.type === "message.part"));
  const part = frames.find((f) => f.type === "event" && f.event.type === "message.part")!;
  assert.equal(part.event.correlationId, "m1");

  // ...and the coordinator emits a turn.quiescent receipt once the turn completes.
  await waitFor(() => frames.some((f) => f.type === "event" && f.event.type === "turn.quiescent"));
  const quiescent = frames.find((f) => f.type === "event" && f.event.type === "turn.quiescent")!;
  assert.equal(quiescent.event.sessionId, "T-3");

  // Per-connection seq starts at 1 and increases monotonically on the wire.
  const eventFrames = frames.filter((f) => f.type === "event");
  assert.equal(eventFrames[0].event.seq, 1);
  for (let i = 1; i < eventFrames.length; i++) {
    assert.equal(eventFrames[i].event.seq, eventFrames[i - 1].event.seq + 1);
  }

  // Everything is in the trace: the snapshot, events, and the derived quiescent receipt.
  const trace = readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(trace.some((r) => r.kind === "snapshot"));
  assert.ok(trace.some((r) => r.kind === "event" && r.event.type === "turn.quiescent"));

  ws.close();
});
