import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Capability,
  CreateSessionInput,
  DomainEvent,
  HarnessAdapter,
  SendMessageInput,
  SendReceipt,
  SessionRef,
} from "@arke/contracts";
import { NoInstanceForTierError, RegistryResolver, blockKey, type RegistryConfig } from "../src/registry.js";
import {
  NoAdapterError,
  SessionRouter,
  TierMismatchError,
  type RegistryWarningReason,
} from "../src/session-router.js";

/** A stub adapter — only its id is exercised by the router. */
class StubAdapter implements HarnessAdapter {
  constructor(readonly id: string) {}
  capabilities(): ReadonlySet<Capability> {
    return new Set();
  }
  async createSession(_input: CreateSessionInput): Promise<SessionRef> {
    return { sessionId: `${this.id}-s` };
  }
  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: input.sessionId, correlationId: "c" };
  }
  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    return { sessionId: input.sessionId, correlationId: "c" };
  }
  // eslint-disable-next-line require-yield
  async *streamEvents(): AsyncIterable<DomainEvent> {
    return;
  }
}

/** Two capable instances (claude first), opencode also mid; reviewers pinned to distinct instances. */
function config(): RegistryConfig {
  return {
    instances: [
      {
        id: "claude-local",
        driver: "claude-code",
        host: "localhost",
        cwd: ".",
        credentialsRef: "claude-code/default",
        serves: [{ tier: "capable", model: "anthropic/opus" }],
      },
      {
        id: "opencode-local",
        driver: "opencode",
        host: "localhost",
        cwd: ".",
        credentialsRef: "opencode/gateway",
        serves: [
          { tier: "capable", model: "copilot/gpt" },
          { tier: "mid", model: "copilot/sonnet" },
        ],
      },
    ],
    roster: {
      "spec-author": { tier: "capable" },
      implementer: { tier: "mid" },
      "reviewer-a": { tier: "capable", instance: "claude-local" },
      "reviewer-b": { tier: "capable", instance: "opencode-local" },
    },
  };
}

function adapters(): Map<string, HarnessAdapter> {
  return new Map([
    ["claude-local", new StubAdapter("claude-local")],
    ["opencode-local", new StubAdapter("opencode-local")],
  ]);
}

class RecordingEmitter {
  warnings: Array<{ reason: RegistryWarningReason; detail: string }> = [];
  reach: Array<{ instanceId: string; reachable: boolean }> = [];
  interrupted: string[] = [];
  warn(reason: RegistryWarningReason, detail: string) {
    this.warnings.push({ reason, detail });
  }
  reachability(instanceId: string, reachable: boolean) {
    this.reach.push({ instanceId, reachable });
  }
  sessionInterrupted(sessionId: string) {
    this.interrupted.push(sessionId);
  }
}

test("route maps an unpinned role to the first instance serving its tier", () => {
  const router = new SessionRouter(new RegistryResolver(config()), adapters());
  const r = router.route("spec-author");
  assert.equal(r.adapter.id, "claude-local");
  assert.equal(r.selection.tier, "capable");
});

test("the resolveModel closure returns the concrete model and throws TierMismatchError off-tier", () => {
  const router = new SessionRouter(new RegistryResolver(config()), adapters());
  const r = router.route("implementer"); // mid
  assert.deepEqual(r.resolveModel("mid"), { provider: "copilot", name: "sonnet" });
  assert.throws(() => r.resolveModel("capable"), TierMismatchError);
});

test("a selection naming an instance with no adapter throws NoAdapterError", () => {
  const router = new SessionRouter(new RegistryResolver(config()), new Map());
  assert.throws(() => router.route("spec-author"), NoAdapterError);
});

test("instance loss with a fallback: interrupts in-flight, emits failover, reroutes new sessions", () => {
  const emitter = new RecordingEmitter();
  const router = new SessionRouter(new RegistryResolver(config()), adapters(), emitter);
  router.trackSession("claude-local", "sess-1");

  const summary = router.markInstanceUnreachable("claude-local");
  assert.deepEqual(summary.interrupted, ["sess-1"]);
  assert.deepEqual(router.interruptedSessions(), ["sess-1"]);
  assert.deepEqual(emitter.interrupted, ["sess-1"]); // emitted for client session.status
  assert.equal(summary.fallbackByTier["capable"], "opencode-local");
  assert.ok(emitter.warnings.some((w) => w.reason === "instance-failover"));
  assert.ok(emitter.reach.some((r) => r.instanceId === "claude-local" && r.reachable === false));

  // A new unpinned capable session now routes to the surviving instance.
  assert.equal(router.route("spec-author").adapter.id, "opencode-local");
});

test("a pinned role does not fail over — its lost instance makes routing refuse", () => {
  const router = new SessionRouter(new RegistryResolver(config()), adapters());
  router.markInstanceUnreachable("claude-local");
  assert.throws(() => router.route("reviewer-a"), NoInstanceForTierError);
});

test("instance loss with no fallback emits no-instance-for-tier and refuses new sessions", () => {
  const c = config();
  c.instances = [c.instances[0]!]; // only claude (capable); no other instance serves capable
  const emitter = new RecordingEmitter();
  const router = new SessionRouter(
    new RegistryResolver(c),
    new Map([["claude-local", new StubAdapter("claude-local")]]),
    emitter,
  );
  router.markInstanceUnreachable("claude-local");
  assert.ok(emitter.warnings.some((w) => w.reason === "no-instance-for-tier"));
  assert.throws(() => router.route("spec-author"), NoInstanceForTierError);
});

test("a catalog-blocked (instance, tier) is skipped — an unpinned role fails over past it", () => {
  const router = new SessionRouter(new RegistryResolver(config()), adapters());
  router.setBlocked([blockKey("claude-local", "capable")]);
  // claude's capable slot is blocked → the unpinned spec-author falls over to opencode.
  assert.equal(router.route("spec-author").adapter.id, "opencode-local");
});
