import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type ProbeClient, probeCapabilities } from "../src/index.js";

/**
 * Contract guard (SPEC-002 Testing → Contract). The adapter calls a fixed set of endpoints
 * and probes capabilities from the server's OpenAPI document. We snapshot the pinned shape of
 * that document and fail on drift, so a server upgrade cannot silently break normalisation.
 */
const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(join(here, "fixtures", "opencode-doc.json"), "utf8")) as {
  paths: Record<string, unknown>;
};

/** Every endpoint the adapter actually calls — drift here breaks the live driver. */
const REQUIRED_PATHS = [
  "/global/health",
  "/global/event",
  "/session",
  "/session/{id}",
  "/session/{id}/message",
  "/session/{id}/prompt_async",
  "/session/{id}/todo",
  "/session/{id}/diff",
  "/session/{id}/command",
  "/permission/",
  "/permission/{requestID}/reply",
];

test("the pinned /doc snapshot contains every endpoint the adapter depends on", () => {
  for (const path of REQUIRED_PATHS) {
    assert.ok(path in doc.paths, `pinned /doc is missing required path ${path}`);
  }
});

test("capability probe against the pinned /doc yields the full capability set", async () => {
  const client: ProbeClient = {
    async req<T>(_method: string, path: string): Promise<T> {
      if (path === "/global/health") return { status: "ok" } as T;
      if (path === "/doc") return doc as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  const { capabilities, readiness } = await probeCapabilities(client);
  assert.equal(readiness.ready, true);
  for (const cap of ["events", "todos", "diff", "permissions", "commands"]) {
    assert.ok(capabilities.has(cap as never), `pinned /doc should support ${cap}`);
  }
});
