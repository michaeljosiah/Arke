import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Trace, WriteQueue, sanitizeSpanAttributes } from "../src/trace.js";

const tracePath = () => join(mkdtempSync(join(tmpdir(), "arke-trace-")), "trace.ndjson");

test("WriteQueue serialises tasks so concurrent appends never interleave", async () => {
  const path = tracePath();
  const t = new Trace(path);
  // Fire 20 writes "concurrently"; the queue must serialise them into 20 complete JSON lines.
  await Promise.all(Array.from({ length: 20 }, (_, i) => t.write({ kind: "x", n: i })));
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 20);
  for (const l of lines) JSON.parse(l); // every line is complete + parseable (no interleave)
});

test("seq is monotonically increasing and unique", async () => {
  const path = tracePath();
  const t = new Trace(path);
  await Promise.all(Array.from({ length: 10 }, (_, i) => t.write({ kind: "x", n: i })));
  const seqs = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "already sorted (monotonic)");
  assert.equal(new Set(seqs).size, 10, "all unique");
  assert.equal(seqs[0], 1);
});

test("seq resumes from the tail after a restart (new Trace on the same file)", async () => {
  const path = tracePath();
  const a = new Trace(path);
  await a.write({ kind: "x" });
  await a.write({ kind: "x" }); // seq 1, 2
  const b = new Trace(path); // "restart"
  await b.write({ kind: "x" });
  const seqs = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, [1, 2, 3], "no duplicate seq across the restart boundary");
});

test("query matches specId at top-level, event.specId, and span attributes; caps + totals", async () => {
  const path = tracePath();
  const t = new Trace(path);
  await t.write({ kind: "permission.decision", specId: "SPEC-A" });
  await t.write({ kind: "event", event: { type: "projection.write", specId: "SPEC-A" } });
  await t.write({ kind: "span", attributes: { "arke.specId": "SPEC-A", "arke.operation": "dispatchAsync" } });
  await t.write({ kind: "event", event: { type: "spec.status", specId: "SPEC-OTHER" } });
  const { records, total } = await t.query("SPEC-A");
  assert.equal(total, 3, "matched at all three locations; the other spec excluded");
  assert.equal(records.length, 3);

  const capped = await t.query("SPEC-A", 0, 2);
  assert.equal(capped.total, 3, "total is the full match count");
  assert.equal(capped.records.length, 2, "capped to the limit");
});

test("query honours the `since` cursor", async () => {
  const path = tracePath();
  const t = new Trace(path);
  await t.write({ kind: "event", event: { specId: "S" } });
  const cutoff = Date.now() + 5;
  await new Promise((r) => setTimeout(r, 10));
  await t.write({ kind: "event", event: { specId: "S" } });
  const { total } = await t.query("S", cutoff);
  assert.equal(total, 1, "only the record at/after the cursor");
});

test("sanitizeSpanAttributes keeps only the allowlist and truncates error.message", () => {
  const out = sanitizeSpanAttributes({
    "arke.specId": "SPEC-1",
    "arke.operation": "dispatchAsync",
    "spec.body": "SECRET SPEC CONTENT",
    promptText: "do not leak",
    "error.message": "x".repeat(400),
  });
  assert.deepEqual(Object.keys(out).sort(), ["arke.operation", "arke.specId", "error.message"]);
  assert.equal((out["error.message"] as string).length, 256, "truncated");
  assert.equal(JSON.stringify(out).includes("SECRET"), false, "spec content dropped");
});

test("drain() resolves after all enqueued writes land", async () => {
  const path = tracePath();
  const t = new Trace(path);
  for (let i = 0; i < 5; i++) void t.write({ kind: "x", n: i });
  await t.drain();
  assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 5);
});

test("write() is best-effort (resolves on failure); writeOrThrow() rejects — the fail-safe contract", async () => {
  // An unwritable path: a file used as a directory component makes mkdir/appendFile fail.
  const dir = mkdtempSync(join(tmpdir(), "arke-ro-"));
  const blocker = join(dir, "blk");
  writeFileSync(blocker, "x"); // `blocker` is a file…
  const t = new Trace(join(blocker, "trace.ndjson")); // …so writing under it fails (ENOTDIR)
  await t.write({ kind: "x" }); // best-effort: must NOT reject (no crash, degraded audit)
  await assert.rejects(() => t.writeOrThrow({ kind: "permission.decision" }), "fail-safe write rejects so the relay is blocked");
});

test("WriteQueue keeps running after a task throws (chain not poisoned)", async () => {
  const q = new WriteQueue();
  await q.enqueue(async () => {
    throw new Error("boom");
  }).catch(() => {});
  let ran = false;
  await q.enqueue(async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
