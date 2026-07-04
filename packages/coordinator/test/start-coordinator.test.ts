import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { startCoordinator } from "../src/start.js";

/**
 * SPEC-022: `startCoordinator()` is the additive programmatic entry the desktop shell embeds. It roots
 * a NEUTRAL default context (NullAdapter, no managed harness, no stray `.arke/` under the app bundle),
 * returns the bound `ws://` URL, and exposes `workInFlight()` + a graceful `stop()`.
 */

function firstSnapshot(url: string, ms = 4000): Promise<any> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.close(); rej(new Error("no snapshot")); }, ms);
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.type === "snapshot") { clearTimeout(t); ws.close(); res(f); }
    });
    ws.on("error", rej);
  });
}

test("startCoordinator binds an ephemeral port and returns its ws:// URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "arke-desktop-"));
  const co = await startCoordinator({ root });
  after(() => co.stop());
  assert.match(co.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  // the URL is reachable and yields a snapshot
  const snap = await firstSnapshot(co.url);
  assert.equal(snap.type, "snapshot");
});

test("the default context is a neutral NullAdapter — no harness, no work in flight", async () => {
  const root = mkdtempSync(join(tmpdir(), "arke-desktop-"));
  const co = await startCoordinator({ root });
  after(() => co.stop());
  const snap = await firstSnapshot(co.url);
  // NullAdapter surfaces as harness id "none" (no opencode spawned for the neutral root).
  assert.equal(snap.harness, "none");
  assert.equal(co.workInFlight(), false); // nothing dispatched → idle
});

test("startCoordinator writes its state UNDER the given root (SPEC-022 packaged-app trap)", async () => {
  const root = mkdtempSync(join(tmpdir(), "arke-desktop-"));
  const co = await startCoordinator({ root });
  after(() => co.stop());
  await firstSnapshot(co.url);
  // the neutral root's `.arke/` (trace + grants) is created under `root`, so a packaged app writes to
  // its userData dir, never process.cwd() (which in a package is the read-only resources dir).
  assert.ok(existsSync(resolve(root, ".arke")), ".arke created under the neutral root");
  assert.ok(existsSync(resolve(root, ".arke", "trace.ndjson")), "trace.ndjson under the neutral root");
});

test("stop() resolves and closes the listener", async () => {
  const root = mkdtempSync(join(tmpdir(), "arke-desktop-"));
  const co = await startCoordinator({ root });
  await firstSnapshot(co.url);
  await co.stop(); // must resolve (transitive Trace.drain + context stop)
  // a fresh connection to the stopped server should fail
  await assert.rejects(() => firstSnapshot(co.url, 800));
});
