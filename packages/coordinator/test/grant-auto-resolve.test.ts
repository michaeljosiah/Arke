import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type {
  Capability,
  DomainEvent,
  HarnessAdapter,
  PermissionAck,
  PermissionDecision,
  Readiness,
  SendReceipt,
} from "@arke/contracts";
import { Coordinator } from "../src/server.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";

/**
 * A minimal adapter that emits one permission.asked and records decisions relayed to it,
 * so we can prove the coordinator auto-resolves a request matching a remembered grant.
 */
class PermissionAdapter implements HarnessAdapter {
  readonly id = "Test";
  readonly decisions: PermissionDecision[] = [];
  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["events", "permissions"]);
  }
  readiness(): Readiness {
    return { ready: true };
  }
  async createSession() {
    return { sessionId: "T-5" };
  }
  async sendMessage(): Promise<SendReceipt> {
    return { sessionId: "T-5", correlationId: "c" };
  }
  async dispatchAsync(): Promise<SendReceipt> {
    return { sessionId: "T-5", correlationId: "c" };
  }
  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    this.decisions.push(decision);
    return { permissionId: decision.permissionId, status: "confirmed" };
  }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    yield {
      seq: 0,
      ts: 0,
      harness: this.id,
      type: "permission.asked",
      sessionId: "T-5",
      permissionId: "perm_1",
      title: "Write migration file",
    };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

test("a request matching a remembered grant auto-resolves, traced, with no human prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arke-autogrant-"));
  const tracePath = join(dir, "trace.ndjson");
  const grants = new GrantStore(join(dir, "grants.ndjson"));
  grants.load();
  const grant = grants.remember({
    sessionId: "T-5",
    actionClass: "Write migration file",
    createdBy: "human",
  });

  const adapter = new PermissionAdapter();
  const coordinator = new Coordinator(adapter, new Trace(tracePath), grants, 0);
  const port = await coordinator.start();
  after(() => coordinator.stop());

  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  // give the pump a moment to process the single permission.asked
  await new Promise((r) => setTimeout(r, 200));

  // the decision was relayed automatically as a single "once"
  assert.equal(adapter.decisions.length, 1);
  assert.equal(adapter.decisions[0]!.decision, "once");

  // no permission.asked reached the client (no needs-human flash)
  assert.equal(frames.some((f) => f.type === "event" && f.event.type === "permission.asked"), false);

  // the auto-grant is recorded in the trace with the rule that authorised it
  const trace = readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const auto = trace.find((r) => r.kind === "permission.auto-grant");
  assert.ok(auto, "expected a permission.auto-grant trace record");
  assert.equal(auto.ruleId, grant.id);

  ws.close();
});
