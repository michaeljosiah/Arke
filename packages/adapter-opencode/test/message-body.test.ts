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
