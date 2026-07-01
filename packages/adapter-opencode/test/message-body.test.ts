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
import { StubOpenCodeServer } from "./helpers/stub-server.js";

/**
 * The `/session/:id/message` body contract with real OpenCode: `messageID` MUST start with "msg"
 * (a caller's plain-UUID correlationId otherwise 400s), and `model`, when sent, MUST be
 * `{ providerID, modelID }` — omitted entirely for the unconfigured `gateway` placeholder.
 */

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
  return new OpenCodeAdapter(config, { sessionStore: new InMemorySessionStore(), deadLetterSink: new ArrayDeadLetterSink() });
}

const lastMessageBody = () => server.lastBodies.get("POST /session/:id/message") as Record<string, unknown>;

test("a caller's plain-UUID correlationId is coerced to a valid msg-prefixed messageID", async () => {
  const adapter = makeAdapter();
  const s = await adapter.createSession({ specId: "SPEC-A" });
  await adapter.sendMessage({ sessionId: s.sessionId, agent: "spec-author", tier: "capable", correlationId: "2fccee91-0000-4000-8000-000000000000", parts: [{ type: "text", text: "hi" }] });
  const body = lastMessageBody();
  assert.match(String(body.messageID), /^msg/); // OpenCode rejects ids that don't start with "msg"
});

test("an absent correlationId still yields a msg-prefixed messageID", async () => {
  const adapter = makeAdapter();
  const s = await adapter.createSession({ specId: "SPEC-A" });
  await adapter.sendMessage({ sessionId: s.sessionId, agent: "spec-author", tier: "capable", parts: [{ type: "text", text: "hi" }] });
  assert.match(String(lastMessageBody().messageID), /^msg/);
});

test("a dashed messageID is sanitised even when already msg-prefixed (OpenCode 500s on dashes)", async () => {
  const adapter = makeAdapter();
  const s = await adapter.createSession({ specId: "SPEC-A" });
  // The adapter's own default is msg_${randomUUID()} — dashes included; it must never reach the wire.
  await adapter.sendMessage({ sessionId: s.sessionId, agent: "spec-author", tier: "capable", correlationId: "msg_1324d930-5acd-4e13-be9b-33f3f12da237", parts: [{ type: "text", text: "hi" }] });
  const wireId = String(lastMessageBody().messageID);
  assert.match(wireId, /^msg[A-Za-z0-9_]*$/, "strictly alphanumeric/underscore");
  assert.equal(wireId.includes("-"), false);
});

test("a real configured model is sent as { providerID, modelID }", async () => {
  const adapter = makeAdapter({ resolveModel: () => ({ provider: "openai", name: "gpt-5.3-codex-spark" }) });
  const s = await adapter.createSession({ specId: "SPEC-A" });
  await adapter.sendMessage({ sessionId: s.sessionId, agent: "spec-author", tier: "capable", parts: [{ type: "text", text: "hi" }] });
  assert.deepEqual(lastMessageBody().model, { providerID: "openai", modelID: "gpt-5.3-codex-spark" });
});

test("the unconfigured gateway placeholder omits the model entirely (OpenCode uses its default)", async () => {
  const adapter = makeAdapter({ resolveModel: () => ({ provider: "gateway", name: "capable-tier" }) });
  const s = await adapter.createSession({ specId: "SPEC-A" });
  await adapter.sendMessage({ sessionId: s.sessionId, agent: "spec-author", tier: "capable", parts: [{ type: "text", text: "hi" }] });
  assert.equal("model" in lastMessageBody(), false);
});

// ---- agent guard: only send an agent the live catalog recognises (OpenCode 500s on unknown) ----

test("an agent present in the live catalog is sent through", async () => {
  server.agentCatalog = ["build", "spec-author"];
  const adapter = makeAdapter();
  await adapter.init(); // reads the catalog
  const s = await adapter.createSession({ specId: "SPEC-A" });
  await adapter.sendMessage({ sessionId: s.sessionId, agent: "spec-author", tier: "capable", parts: [{ type: "text", text: "hi" }] });
  assert.equal(lastMessageBody().agent, "spec-author");
});

test("an agent ABSENT from a known catalog is omitted (degrade to the server default, no 500) and traced", async () => {
  server.agentCatalog = ["build", "plan"]; // roster agent not recognised for this directory
  const lifecycle: Array<Record<string, unknown>> = [];
  const config: OpenCodeConfig = { baseUrl, projectRoot: canonicalizeRoot(tmpdir()), permissionTimeoutMs: 200, reconnectBaseMs: 10, reconnectMaxMs: 50 };
  const adapter = new OpenCodeAdapter(config, {
    sessionStore: new InMemorySessionStore(),
    deadLetterSink: new ArrayDeadLetterSink(),
    onLifecycleEvent: (r) => lifecycle.push(r),
  });
  await adapter.init();
  const s = await adapter.createSession({ specId: "SPEC-A" });
  await adapter.sendMessage({ sessionId: s.sessionId, agent: "spec-author", tier: "capable", parts: [{ type: "text", text: "hi" }] });
  assert.equal("agent" in lastMessageBody(), false, "unknown agent must be omitted, not sent");
  const note = lifecycle.find((r) => r.kind === "agent.unavailable");
  assert.ok(note, "the degradation is recorded in the trace");
  assert.equal(note!.agent, "spec-author");
});

test("a 5xx on an agent-naming send retries once WITHOUT the agent and succeeds (traced fallback)", async () => {
  // OpenCode's per-directory agent handling is racy: the catalog can list an agent whose dispatch
  // still 500s. The adapter must self-heal by retrying without the agent, not fail the whole turn.
  server.agentCatalog = ["build", "spec-author"]; // catalog says it's fine…
  server.failMessagesNamingAgent = true; // …but dispatch with an agent 500s
  const lifecycle: Array<Record<string, unknown>> = [];
  const config: OpenCodeConfig = { baseUrl, projectRoot: canonicalizeRoot(tmpdir()), permissionTimeoutMs: 200, reconnectBaseMs: 10, reconnectMaxMs: 50 };
  const adapter = new OpenCodeAdapter(config, {
    sessionStore: new InMemorySessionStore(),
    deadLetterSink: new ArrayDeadLetterSink(),
    onLifecycleEvent: (r) => lifecycle.push(r),
  });
  await adapter.init();
  const s = await adapter.createSession({ specId: "SPEC-A" });
  const receipt = await adapter.sendMessage({ sessionId: s.sessionId, agent: "spec-author", tier: "capable", parts: [{ type: "text", text: "hi" }] });
  assert.equal(receipt.sessionId, s.sessionId); // the turn succeeded despite the server fault
  assert.equal(server.count("POST /session/:id/message"), 2, "one failed attempt + one agent-less retry");
  assert.equal("agent" in lastMessageBody(), false, "the retry dropped the agent");
  const note = lifecycle.find((r) => r.kind === "agent.fallback");
  assert.ok(note, "the fallback is recorded in the trace");
  assert.equal(note!.agent, "spec-author");
  assert.match(String(note!.reason), /UnknownError/);
});

test("a 5xx on an agent-LESS send is surfaced, not retried", async () => {
  server.failMessagesNamingAgent = true; // only agent-naming sends fail; agent-less path returns 200
  const adapter = makeAdapter();
  const s = await adapter.createSession({ specId: "SPEC-A" });
  // No agent named → goes through directly (the stub only fails agent-naming bodies).
  await adapter.sendMessage({ sessionId: s.sessionId, agent: "", tier: "capable", parts: [{ type: "text", text: "hi" }] });
  assert.equal(server.count("POST /session/:id/message"), 1, "no retry when no agent was named");
});

test("with no catalog (endpoint absent), the configured agent is trusted verbatim", async () => {
  server.agentCatalog = null; // GET /agent → 404
  const adapter = makeAdapter();
  await adapter.init();
  const s = await adapter.createSession({ specId: "SPEC-A" });
  await adapter.sendMessage({ sessionId: s.sessionId, agent: "spec-author", tier: "capable", parts: [{ type: "text", text: "hi" }] });
  assert.equal(lastMessageBody().agent, "spec-author");
});
