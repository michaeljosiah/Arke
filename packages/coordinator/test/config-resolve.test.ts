import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProcessSettings } from "../src/config-resolve.js";

/**
 * Process-wide settings resolution (SPEC-019 R3): the global `settings` block overlaid by `ARKE_*`
 * env, env winning. A project can never supply these — the boundary is structural. (The logical-tier
 * config-merge/resolver this file also used to cover was removed with the tier machinery: agents are
 * self-describing now — SPEC-016 revised.)
 */

test("ARKE_* env overrides a global settings value (env wins)", () => {
  const s = resolveProcessSettings({ maxProjects: 5, coordinatorPort: 4319 }, { ARKE_MAX_PROJECTS: "8" });
  assert.equal(s?.maxProjects, 8); // env wins
  assert.equal(s?.coordinatorPort, 4319); // global value kept when env is silent
});

test("resolveProcessSettings returns undefined when nothing supplies a value", () => {
  assert.equal(resolveProcessSettings(undefined, {}), undefined);
});

test("a non-numeric ARKE_* value is ignored (keeps the global value)", () => {
  const s = resolveProcessSettings({ maxProjects: 5 }, { ARKE_MAX_PROJECTS: "not-a-number" });
  assert.equal(s?.maxProjects, 5);
});

test("the OTLP endpoint is taken from ARKE_OTLP_ENDPOINT when set", () => {
  const s = resolveProcessSettings(undefined, { ARKE_OTLP_ENDPOINT: "http://collector:4318" });
  assert.equal(s?.otlpEndpoint, "http://collector:4318");
});
