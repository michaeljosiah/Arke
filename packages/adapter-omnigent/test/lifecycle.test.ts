import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isCompatibleOmnigentVersion, OMNIGENT_TARGET_VERSION } from "../src/config.js";
import { SessionGraph } from "../src/session-graph.js";

/** SPEC-037 Increment 3: version pinning + the durable session store. */

test("isCompatibleOmnigentVersion matches major.minor, tolerates a patch drift, rejects otherwise", () => {
  assert.equal(OMNIGENT_TARGET_VERSION, "0.3.0");
  assert.equal(isCompatibleOmnigentVersion("0.3.0"), true);
  assert.equal(isCompatibleOmnigentVersion("0.3.7"), true, "a patch bump is compatible");
  assert.equal(isCompatibleOmnigentVersion("0.4.0"), false, "a minor bump is not");
  assert.equal(isCompatibleOmnigentVersion("1.3.0"), false, "a major bump is not");
  assert.equal(isCompatibleOmnigentVersion(undefined), false, "missing → incompatible (fail loud)");
  assert.equal(isCompatibleOmnigentVersion(""), false);
  assert.equal(isCompatibleOmnigentVersion("garbage"), false);
});

test("the session store is durable — identity re-loads across a fresh SessionGraph (restart)", () => {
  const path = join(mkdtempSync(join(tmpdir(), "arke-omni-")), "sessions.ndjson");
  const a = new SessionGraph(path);
  a.record("conv_1", { specId: "SPEC-A", kind: "spec" });
  a.record("conv_2", { specId: "SPEC-B", kind: "task" });

  // A brand-new instance (simulating an adapter/coordinator restart) re-attaches from disk.
  const b = new SessionGraph(path);
  assert.deepEqual(b.get("conv_1"), { specId: "SPEC-A", kind: "spec" });
  assert.deepEqual(b.get("conv_2"), { specId: "SPEC-B", kind: "task" });
  assert.deepEqual(b.ids().sort(), ["conv_1", "conv_2"]);
});

test("a re-record is last-write-wins after reload", () => {
  const path = join(mkdtempSync(join(tmpdir(), "arke-omni-")), "sessions.ndjson");
  const a = new SessionGraph(path);
  a.record("conv_1", { specId: "SPEC-OLD", kind: "spec" });
  a.record("conv_1", { specId: "SPEC-NEW", kind: "spec" }); // e.g. an untitled→titled rename
  const b = new SessionGraph(path);
  assert.deepEqual(b.get("conv_1"), { specId: "SPEC-NEW", kind: "spec" });
});

test("an in-memory graph (no path) works and persists nothing", () => {
  const g = new SessionGraph();
  g.record("conv_1", { specId: "SPEC-A", kind: "spec" });
  assert.deepEqual(g.get("conv_1"), { specId: "SPEC-A", kind: "spec" });
  assert.deepEqual(g.ids(), ["conv_1"]);
});
