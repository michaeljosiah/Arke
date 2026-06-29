import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessReachabilityProbe } from "../src/reachability.js";

test("reports reachable when health returns ok with a parseable body", async () => {
  const probe = new HarnessReachabilityProbe({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ caps: [] }) }),
  });
  const [r] = await probe.probe(["http://127.0.0.1:4096"]);
  assert.equal(r!.reachable, true);
});

test("reports the HTTP status as the reason on an error response (not 'unreachable')", async () => {
  const probe = new HarnessReachabilityProbe({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const [r] = await probe.probe(["http://127.0.0.1:4096"]);
  assert.equal(r!.reachable, false);
  assert.equal(r!.reason, "HTTP 503");
});

test("reports a timeout reason when the probe aborts", async () => {
  const probe = new HarnessReachabilityProbe({
    timeoutMs: 10,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
  });
  const [r] = await probe.probe(["http://127.0.0.1:4096"]);
  assert.equal(r!.reachable, false);
  assert.equal(r!.reason, "timeout");
});

test("reports a partial response distinctly when capabilities can't be confirmed", async () => {
  const probe = new HarnessReachabilityProbe({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }),
  });
  const [r] = await probe.probe(["http://127.0.0.1:4096"]);
  assert.equal(r!.reachable, false);
  assert.equal(r!.partial, true);
});

test("anyReachable is true if at least one endpoint answers", async () => {
  let n = 0;
  const probe = new HarnessReachabilityProbe({
    fetchImpl: async () => {
      n += 1;
      return n === 1
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const { reachable } = await probe.anyReachable(["http://a", "http://b"]);
  assert.equal(reachable, true);
});
