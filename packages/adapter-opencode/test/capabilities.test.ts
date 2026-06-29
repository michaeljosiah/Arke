import assert from "node:assert/strict";
import { test } from "node:test";
import { type ProbeClient, probeCapabilities } from "../src/index.js";

const FULL_PATHS = {
  "/global/health": {},
  "/global/event": {},
  "/session/{id}/todo": {},
  "/session/{id}/diff": {},
  "/permission/{requestID}/reply": {},
  "/session/{id}/command": {},
};

function client(opts: {
  health?: boolean;
  doc?: boolean;
  paths?: Record<string, unknown>;
}): ProbeClient {
  return {
    async req<T>(_method: string, path: string): Promise<T> {
      if (path === "/global/health") {
        if (opts.health === false) throw new Error("ECONNREFUSED");
        return { status: "ok" } as T;
      }
      if (path === "/doc") {
        if (opts.doc === false) throw new Error("404");
        return { paths: opts.paths ?? FULL_PATHS } as T;
      }
      throw new Error(`unexpected probe path ${path}`);
    },
  };
}

test("a fully-featured server advertises every capability and is ready", async () => {
  const { capabilities, readiness } = await probeCapabilities(client({}));
  assert.equal(readiness.ready, true);
  for (const cap of ["events", "todos", "diff", "permissions", "commands"]) {
    assert.ok(capabilities.has(cap as never), `expected capability ${cap}`);
  }
});

test("the models capability is advertised when /config/providers is present (SPEC-005)", async () => {
  const paths = { ...FULL_PATHS, "/config/providers": {} };
  const { capabilities } = await probeCapabilities(client({ paths }));
  assert.equal(capabilities.has("models"), true);
});

test("the models capability is omitted when /config/providers is absent (SPEC-005)", async () => {
  const { capabilities } = await probeCapabilities(client({})); // FULL_PATHS has no providers
  assert.equal(capabilities.has("models"), false);
});

test("a missing optional endpoint is omitted, not assumed", async () => {
  const paths = { ...FULL_PATHS };
  delete (paths as Record<string, unknown>)["/session/{id}/diff"];
  const { capabilities, readiness } = await probeCapabilities(client({ paths }));
  assert.equal(readiness.ready, true);
  assert.equal(capabilities.has("diff"), false);
  assert.equal(capabilities.has("todos"), true);
});

test("a missing required capability (events) fails readiness with a reason", async () => {
  const paths = { ...FULL_PATHS };
  delete (paths as Record<string, unknown>)["/global/event"];
  const { capabilities, readiness } = await probeCapabilities(client({ paths }));
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason ?? "", /events/);
  assert.equal(capabilities.has("events"), false);
});

test("an unreachable server fails readiness at the health check", async () => {
  const { readiness } = await probeCapabilities(client({ health: false }));
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason ?? "", /health/);
});

test("a server with no /doc cannot be probed and fails readiness", async () => {
  const { readiness } = await probeCapabilities(client({ doc: false }));
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason ?? "", /doc/);
});
