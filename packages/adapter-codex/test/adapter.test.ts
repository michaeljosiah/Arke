import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CodexAdapter, CodexAppServer, type CodexTransport, type JsonRpcMessage } from "../src/index.js";

/**
 * SPEC-034 integration: the adapter driven against a FAKE in-process app-server (Codex is not installed /
 * needs OpenAI auth here — the live smoke test is a DoD follow-up). The fake auto-responds to client
 * requests and lets the test push notifications + server→client approval requests, so the full protocol
 * round-trip is exercised against the documented JSON-RPC shapes.
 */
class FakeTransport implements CodexTransport {
  sent: JsonRpcMessage[] = [];
  private cb: (m: JsonRpcMessage) => void = () => {};
  constructor(private readonly responder: (method: string, params: unknown) => unknown = defaultResponder) {}
  send(m: JsonRpcMessage): void {
    this.sent.push(m);
    // Auto-respond to a client→server REQUEST (has both id and method); a response/notification has one.
    if (m.id !== undefined && typeof m.method === "string") {
      const result = this.responder(m.method, m.params);
      queueMicrotask(() => this.cb({ jsonrpc: "2.0", id: m.id, result }));
    }
  }
  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.cb = cb;
  }
  onClose(): void {}
  close(): void {}
  /** Drive an incoming notification or server→client request from "Codex". */
  emit(m: JsonRpcMessage): void {
    this.cb(m);
  }
  byMethod(method: string): JsonRpcMessage | undefined {
    return this.sent.find((m) => m.method === method);
  }
}

function defaultResponder(method: string): unknown {
  // Real shapes: ThreadStartResponse = { thread: Thread }; TurnStartResponse carries the turn.
  if (method === "thread/start") return { thread: { id: "T1" } };
  if (method === "turn/start") return { turn: { id: "turn-1" } };
  return {};
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function harness() {
  const transport = new FakeTransport();
  const adapter = new CodexAdapter({ cwd: "/repo" }, () => new CodexAppServer(transport, 1000));
  const events: any[] = [];
  const ac = new AbortController();
  void (async () => {
    for await (const ev of adapter.streamEvents(ac.signal)) events.push(ev);
  })();
  after(() => ac.abort());
  return { transport, adapter, events, ac };
}

test("init handshakes; createSession starts a thread; a prompt starts a turn", async () => {
  const { transport, adapter } = harness();
  await adapter.init();
  assert.equal(transport.sent[0]!.method, "initialize");
  assert.ok(transport.sent.some((m) => m.method === "initialized"));

  const ref = await adapter.createSession({ specId: "S1" });
  const threadStart = transport.byMethod("thread/start")!;
  assert.ok(threadStart, "thread/start was sent");
  assert.equal((threadStart.params as any).approvalPolicy, "on-request", "defaults to on-request so approvals round-trip");
  assert.equal((threadStart.params as any).cwd, "/repo");

  // dispatchAsync starts the turn without blocking on completion (sendMessage is the awaiting path).
  await adapter.dispatchAsync({ sessionId: ref.sessionId, agent: "impl", model: { provider: "openai", name: "gpt-5.4" }, parts: [{ type: "text", text: "hi" }] });
  const turnStart = transport.byMethod("turn/start")!;
  assert.equal((turnStart.params as any).threadId, "T1", "the turn targets the session's bound thread");
  assert.deepEqual((turnStart.params as any).input, [{ type: "text", text: "hi", text_elements: [] }]);
  assert.equal((turnStart.params as any).model, "gpt-5.4", "the agent's model id is passed through");
});

test("sendMessage resolves only when the turn completes; dispatchAsync does not block", async () => {
  const { transport, adapter } = harness();
  await adapter.init();
  const ref = await adapter.createSession({ specId: "S1" });
  await tick();

  let resolved = false;
  const p = adapter.sendMessage({ sessionId: ref.sessionId, agent: "impl", parts: [{ type: "text", text: "go" }] }).then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false, "sendMessage stays pending while the turn runs");
  transport.emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "T1", turn: { id: "turn-1" } } });
  await p;
  assert.equal(resolved, true, "sendMessage resolves once turn/completed arrives");
});

test("a non-approval server request is answered with an error, never left hanging", async () => {
  const { transport, adapter } = harness();
  await adapter.init();
  await adapter.createSession({ specId: "S1" });
  await tick();
  // A permissions-scope request (or MCP elicitation, tool user-input, …) isn't a decision Arke can gate.
  transport.emit({ jsonrpc: "2.0", id: 42, method: "item/permissions/requestApproval", params: { threadId: "T1" } });
  await tick();
  const reply = transport.sent.find((m) => m.id === 42);
  assert.ok(reply, "the server request was answered");
  assert.ok((reply as any).error, "answered with a JSON-RPC error (declined), so Codex isn't left waiting");
});

test("notifications normalise into the event stream", async () => {
  const { transport, adapter, events } = harness();
  await adapter.init();
  const ref = await adapter.createSession({ specId: "S1" });
  await tick();

  transport.emit({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "T1", turn: { id: "turn-1", model: "gpt-5.4" } } });
  transport.emit({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "T1", item: { id: "m1", type: "agentMessage", text: "Hello" } } });
  transport.emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "T1", turn: { id: "turn-1" } } });
  await tick();

  const types = events.map((e) => e.type);
  assert.ok(types.includes("session.status"), "running/idle status emitted");
  const msg = events.find((e) => e.type === "message.updated");
  assert.equal(msg.text, "Hello");
  assert.ok(events.some((e) => e.type === "turn.quiescent"), "quiescence receipt emitted");
  assert.equal(events.find((e) => e.type === "session.status" && e.status === "idle") !== undefined, true);
  void ref;
});

test("a Codex approval request routes through the human gate and back", async () => {
  const { transport, adapter, events } = harness();
  await adapter.init();
  await adapter.createSession({ specId: "S1" });
  await tick();

  // Codex asks (server→client request with an id the client must answer).
  transport.emit({ jsonrpc: "2.0", id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "T1", command: "ls -la", reason: "list files" } });
  await tick();
  const asked = events.find((e) => e.type === "permission.asked");
  assert.ok(asked, "permission.asked surfaced");
  assert.equal(asked.permissionId, "codex-approval-99");
  assert.match(asked.title, /ls -la/);

  // The human decides `once` → the adapter replies `accept` to the exact JSON-RPC id and confirms.
  const ack = await adapter.respondToPermission({ permissionId: "codex-approval-99", decision: "once" });
  assert.equal(ack.status, "confirmed");
  const reply = transport.sent.find((m) => m.id === 99 && m.method === undefined);
  assert.ok(reply, "a JSON-RPC response to id 99 was sent");
  assert.deepEqual(reply!.result, { decision: "accept" }, "the real response shape is { decision }, not a bare string");
  await tick();
  assert.ok(events.some((e) => e.type === "permission.replied" && e.granted === true), "permission.replied granted");

  // A decision for an unknown/stale permission id is refused, not a false success.
  const stale = await adapter.respondToPermission({ permissionId: "codex-approval-nope", decision: "reject" });
  assert.equal(stale.status, "stale");
});

test("a rejected approval replies decline", async () => {
  const { transport, adapter } = harness();
  await adapter.init();
  await adapter.createSession({ specId: "S1" });
  await tick();
  transport.emit({ jsonrpc: "2.0", id: 7, method: "item/fileChange/requestApproval", params: { threadId: "T1", changes: [{ path: "a.ts", kind: "edit" }] } });
  await tick();
  await adapter.respondToPermission({ permissionId: "codex-approval-7", decision: "reject" });
  assert.deepEqual(transport.sent.find((m) => m.id === 7 && m.method === undefined)!.result, { decision: "decline" });
});

test("todos come from plan_update; listModels serves the config-driven catalog", async () => {
  const { transport, adapter } = harness();
  await adapter.init();
  const ref = await adapter.createSession({ specId: "S1" });
  await tick();
  transport.emit({ jsonrpc: "2.0", method: "turn/plan/updated", params: { threadId: "T1", plan: [{ step: "One", status: "completed" }, { step: "Two", status: "pending" }] } });
  await tick();
  const todos = await adapter.getTodos({ sessionId: ref.sessionId });
  assert.deepEqual(todos, [{ id: "plan-0", text: "One", done: true }, { id: "plan-1", text: "Two", done: false }]);

  const models = await adapter.listModels();
  assert.ok(models.length > 0);
  assert.ok(models.every((m) => m.provider === "openai"));
});

test("capabilities are advertised honestly", () => {
  const { adapter } = harness();
  const caps = adapter.capabilities();
  for (const c of ["events", "permissions", "diff", "todos", "models"]) assert.ok(caps.has(c as any), `advertises ${c}`);
  assert.ok(!caps.has("commands" as any), "does not advertise commands");
});
