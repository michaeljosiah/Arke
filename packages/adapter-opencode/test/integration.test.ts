import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";
import {
  ArrayDeadLetterSink,
  InMemorySessionStore,
  OpenCodeAdapter,
  canonicalizeRoot,
  type OpenCodeConfig,
} from "../src/index.js";
import { EventCollector } from "./helpers/collector.js";
import { StubOpenCodeServer } from "./helpers/stub-server.js";

let server: StubOpenCodeServer;
let baseUrl: string;

beforeEach(async () => {
  server = new StubOpenCodeServer();
  baseUrl = await server.start();
});

afterEach(async () => {
  await server.stop();
});

function makeAdapter(extra?: Partial<OpenCodeConfig>) {
  const config: OpenCodeConfig = {
    baseUrl,
    projectRoot: canonicalizeRoot(tmpdir()),
    permissionTimeoutMs: 200,
    reconnectBaseMs: 10,
    reconnectMaxMs: 50,
    ...extra,
  };
  const sink = new ArrayDeadLetterSink();
  const adapter = new OpenCodeAdapter(config, {
    sessionStore: new InMemorySessionStore(),
    deadLetterSink: sink,
  });
  return { adapter, sink };
}

test("createSession records spec and task identity; task is a child of its spec", async () => {
  const { adapter } = makeAdapter();
  const spec = await adapter.createSession({ specId: "SPEC-A" });
  const task = await adapter.createSession({ specId: "SPEC-A", parent: spec.sessionId });
  assert.notEqual(spec.sessionId, task.sessionId);

  // The server recorded the child relationship via parentID.
  await adapter.rebuildSessionGraph();
  const resolved = await adapter.resolveSession(task.sessionId);
  assert.equal(resolved?.kind, "task");
  assert.equal(resolved?.parentSessionId, spec.sessionId);
  assert.equal(resolved?.specId, "SPEC-A");
});

test("getTodos and getDiff return canonical shapes", async () => {
  const { adapter } = makeAdapter();
  const spec = await adapter.createSession({ specId: "SPEC-A" });
  server.setTodos(spec.sessionId, [
    { id: "t1", text: "do it", completed: true },
    { id: "t2", text: "later", completed: false },
  ]);
  server.setDiff(spec.sessionId, [
    { additions: 10, deletions: 2 },
    { additions: 5, deletions: 0 },
  ]);
  assert.deepEqual(await adapter.getTodos(spec), [
    { id: "t1", text: "do it", done: true },
    { id: "t2", text: "later", done: false },
  ]);
  assert.deepEqual(await adapter.getDiff(spec), { files: 2, added: 15, removed: 2 });
});

test("dispatchAsync returns immediately with a correlation id", async () => {
  const { adapter } = makeAdapter();
  const spec = await adapter.createSession({ specId: "SPEC-A" });
  const receipt = await adapter.dispatchAsync({
    sessionId: spec.sessionId,
    agent: "implementer",
    tier: "mid",
    parts: [{ type: "text", text: "go" }],
  });
  assert.equal(receipt.sessionId, spec.sessionId);
  assert.match(receipt.correlationId, /^msg_/);
  assert.equal(server.count("POST /session/:id/prompt_async"), 1);
});

test("events produced during a dispatched turn carry its correlation id", async () => {
  const { adapter } = makeAdapter();
  await adapter.init();
  const spec = await adapter.createSession({ specId: "SPEC-A" });

  const ac = new AbortController();
  const collector = new EventCollector(adapter.streamEvents(ac.signal));
  await waitUntil(() => server.sseClientCount > 0);

  const receipt = await adapter.dispatchAsync({
    sessionId: spec.sessionId,
    agent: "implementer",
    tier: "mid",
    correlationId: "corr_xyz",
    parts: [{ type: "text", text: "go" }],
  });
  // a status event mid-turn must attribute to the originating request
  server.push({ type: "session.status", properties: { session_id: spec.sessionId, status: "busy" } });
  const event = await collector.waitFor(
    (e) => e.type === "session.status" && "sessionId" in e && e.sessionId === spec.sessionId,
  );
  assert.equal(event.correlationId, receipt.correlationId);
  assert.equal(receipt.correlationId, "corr_xyz");
  ac.abort();
});

test("streamEvents enriches a live event with the owning spec identity", async () => {
  const { adapter } = makeAdapter();
  await adapter.init();
  const spec = await adapter.createSession({ specId: "SPEC-A" });

  const ac = new AbortController();
  const collector = new EventCollector(adapter.streamEvents(ac.signal));
  // wait until the SSE subscription is live, then push a session event
  await waitUntil(() => server.sseClientCount > 0);
  server.push({ type: "session.idle", properties: { session_id: spec.sessionId } });

  const event = await collector.waitFor(
    (e) => e.type === "session.status" && "sessionId" in e && e.sessionId === spec.sessionId,
  );
  assert.equal(event.type, "session.status");
  if (event.type !== "session.status") return;
  assert.equal(event.status, "idle");
  assert.equal(event.specId, "SPEC-A");
  assert.equal(event.kind, "spec");
  ac.abort();
});

test("an event for an unknown session triggers a REST resolve before emission", async () => {
  const { adapter, sink } = makeAdapter();
  await adapter.init();
  const ac = new AbortController();
  const collector = new EventCollector(adapter.streamEvents(ac.signal));
  await waitUntil(() => server.sseClientCount > 0);

  // A session the adapter has never seen is created directly on the server, then emits.
  server.addSession({ id: "ses_orphan", title: "SPEC-Z" });
  server.push({ type: "session.idle", properties: { session_id: "ses_orphan" } });

  const event = await collector.waitFor(
    (e) => "sessionId" in e && e.sessionId === "ses_orphan" && e.type === "session.status",
  );
  if (event.type !== "session.status") return assert.fail();
  assert.equal(event.specId, "SPEC-Z", "ownership resolved via REST, not guessed");
  assert.equal(sink.records.length, 0, "a resolvable session must not be dead-lettered");
  ac.abort();
});

test("an unmappable event is dead-lettered, not silently dropped", async () => {
  const { adapter, sink } = makeAdapter();
  await adapter.init();
  const ac = new AbortController();
  const collector = new EventCollector(adapter.streamEvents(ac.signal));
  await waitUntil(() => server.sseClientCount > 0);

  server.push({ type: "totally.unknown", properties: {} });
  await waitUntil(() => sink.records.length > 0);
  assert.equal(sink.records[0]!.kind, "dead-letter");
  assert.equal(adapter.deadLetters(), sink.records.length);
  ac.abort();
});

test("permission decision is confirmed by the replied event, not the 200", async () => {
  const { adapter } = makeAdapter();
  await adapter.init();
  const spec = await adapter.createSession({ specId: "SPEC-A" });
  server.setPending(["perm_1"]);

  const ac = new AbortController();
  const collector = new EventCollector(adapter.streamEvents(ac.signal));
  await waitUntil(() => server.sseClientCount > 0);

  const decisionP = adapter.respondToPermission({ permissionId: "perm_1", decision: "once" });
  // the stub returns 200 immediately, but confirmation must wait for the event
  server.push({
    type: "permission.replied",
    properties: { session_id: spec.sessionId, permission_id: "perm_1", response: "approve" },
  });
  const ack = await decisionP;
  assert.equal(ack.status, "confirmed");
  ac.abort();
  await collector.waitFor(() => true, 50).catch(() => undefined);
});

test("reconnect rebuilds the ownership graph and keeps enriching events", async () => {
  const { adapter } = makeAdapter();
  await adapter.init();
  const spec = await adapter.createSession({ specId: "SPEC-A" });

  const ac = new AbortController();
  const collector = new EventCollector(adapter.streamEvents(ac.signal));
  await waitUntil(() => server.sseClientCount > 0);
  const listsBefore = server.count("GET /session");

  // drop the stream; the adapter must reconnect and resync from REST
  server.dropConnections();
  await waitUntil(() => server.count("GET /session") > listsBefore);
  await waitUntil(() => server.sseClientCount > 0);

  // a post-reconnect event is still enriched with correct ownership
  server.push({ type: "session.idle", properties: { session_id: spec.sessionId } });
  const event = await collector.waitFor(
    (e) =>
      e.type === "session.status" &&
      "sessionId" in e &&
      e.sessionId === spec.sessionId &&
      e.status === "idle",
  );
  if (event.type !== "session.status") return assert.fail();
  assert.equal(event.specId, "SPEC-A");
  ac.abort();
});

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
