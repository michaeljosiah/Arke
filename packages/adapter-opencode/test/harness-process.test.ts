import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { HarnessProcess } from "../src/index.js";

/**
 * A real spawned child stands in for `opencode serve`: a tiny Node HTTP server that answers a
 * health endpoint. Proves the supervisor starts a process, waits for health, and stops it.
 */
const SERVER_SRC = `
const http = require("http");
const port = Number(process.env.PORT || 0);
http.createServer((req, res) => { res.writeHead(200); res.end("ok"); }).listen(port, "127.0.0.1");
`;

function freePortHealth(port: number): () => Promise<boolean> {
  return async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  };
}

test("starts a process, waits for health, then stops it", async () => {
  const port = 5392; // fixed test port for the fake server
  const proc = new HarnessProcess({
    command: ["node", "-e", SERVER_SRC],
    cwd: process.cwd(),
    env: { PORT: String(port) },
    healthCheck: freePortHealth(port),
    healthTimeoutMs: 5000,
  });
  await proc.start();
  assert.ok(proc.running, "process should be running after a successful start");
  assert.equal(await freePortHealth(port)(), true, "server should answer health while running");

  await proc.stop();
  assert.equal(proc.running, false, "process should be stopped");
  // after stop, the server no longer answers
  assert.equal(await freePortHealth(port)(), false);
});

test("start fails (and cleans up) when the process never becomes healthy", async () => {
  const proc = new HarnessProcess({
    command: ["node", "-e", "setInterval(() => {}, 1e9)"], // runs but serves no health
    cwd: process.cwd(),
    healthCheck: async () => false,
    healthTimeoutMs: 600,
  });
  await assert.rejects(() => proc.start(), /did not become healthy/);
  assert.equal(proc.running, false);
});

test("adopts an already-running healthy server instead of double-spawning (crash recovery)", async () => {
  const port = 5393;
  // A real pre-existing server stands in for a managed harness orphaned by a crashed coordinator.
  const orphan = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  orphan.listen(port, "127.0.0.1");
  await once(orphan, "listening");
  try {
    const proc = new HarnessProcess({
      command: ["node", "-e", "process.exit(1)"], // would FAIL immediately if actually spawned
      cwd: process.cwd(),
      healthCheck: freePortHealth(port), // the pre-existing server already answers
      healthTimeoutMs: 2000,
    });
    await proc.start(); // must ADOPT (health already passes) rather than spawn the failing command
    assert.equal(proc.wasAdopted, true, "should adopt the pre-existing healthy server");
    assert.ok(proc.running);
    assert.equal(proc.pid, undefined, "no child was spawned");

    await proc.stop(); // must NOT kill a server it did not spawn
    assert.equal(await freePortHealth(port)(), true, "the adopted server is left running after stop");
    assert.equal(proc.running, false);
  } finally {
    orphan.close();
  }
});

test("stop is a no-op when nothing was started (attach mode)", async () => {
  const proc = new HarnessProcess({
    command: ["node", "-e", ""],
    cwd: process.cwd(),
    healthCheck: async () => true,
  });
  await proc.stop(); // never started → must not throw
  assert.equal(proc.running, false);
});
