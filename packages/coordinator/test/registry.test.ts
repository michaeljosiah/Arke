import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "@arke/contracts";
import {
  NoInstanceForTierError,
  RegistryConfigError,
  RegistryResolver,
  UnknownRoleError,
  blockKey,
  modelMatchesCatalog,
  parseModel,
  type RegistryConfig,
} from "../src/registry.js";

/** Two distinct instances; opencode serves capable+mid+fast, claude serves capable only. */
function config(): RegistryConfig {
  return {
    instances: [
      {
        id: "claude-local",
        driver: "claude-code",
        host: "localhost",
        cwd: ".",
        credentialsRef: "claude-code/default",
        serves: [{ tier: "capable", model: "anthropic/claude-opus-4.8" }],
      },
      {
        id: "opencode-local",
        driver: "opencode",
        host: "localhost",
        cwd: ".",
        credentialsRef: "opencode/gateway",
        serves: [
          { tier: "capable", model: "github-copilot/gpt-5.5" },
          { tier: "mid", model: "github-copilot/claude-sonnet-4.6" },
          { tier: "fast", model: "github-copilot/gpt-5.5-fast" },
        ],
      },
    ],
    roster: {
      "spec-author": { tier: "capable" },
      architect: { tier: "capable" },
      "reviewer-a": { tier: "capable", instance: "claude-local" },
      "reviewer-b": { tier: "capable", instance: "opencode-local" },
      implementer: { tier: "mid" },
      researcher: { tier: "mid" },
    },
  };
}

test("an unpinned role resolves to the first instance in config order serving the tier", () => {
  const r = new RegistryResolver(config());
  const sel = r.resolve("spec-author");
  assert.equal(sel.instanceId, "claude-local"); // first in config order serving capable
  assert.equal(sel.tier, "capable");
  assert.equal(sel.model, "anthropic/claude-opus-4.8");
});

test("resolution is stable across repeated calls on an unchanged registry", () => {
  const r = new RegistryResolver(config());
  assert.deepEqual(r.resolve("architect"), r.resolve("architect"));
});

test("a pinned role resolves to its pinned instance + that instance's model for the tier", () => {
  const r = new RegistryResolver(config());
  const sel = r.resolve("reviewer-b");
  assert.equal(sel.instanceId, "opencode-local");
  assert.equal(sel.model, "github-copilot/gpt-5.5");
});

test("an unpinned mid role resolves to the only instance serving mid", () => {
  const r = new RegistryResolver(config());
  assert.equal(r.resolve("implementer").instanceId, "opencode-local");
});

test("a tier no instance serves throws NoInstanceForTierError naming role + tier", () => {
  const c = config();
  c.roster["specialist"] = { tier: "fast" };
  c.instances = c.instances.filter((i) => i.id !== "opencode-local"); // only claude (capable) left
  const r = new RegistryResolver(c);
  assert.throws(() => r.resolve("specialist"), (e) => e instanceof NoInstanceForTierError && e.tier === "fast");
});

test("an unknown role throws UnknownRoleError", () => {
  const r = new RegistryResolver(config());
  assert.throws(() => r.resolve("nobody"), UnknownRoleError);
});

test("a role pinning a missing instance throws RegistryConfigError", () => {
  const c = config();
  c.roster["reviewer-a"] = { tier: "capable", instance: "ghost" };
  const r = new RegistryResolver(c);
  assert.throws(() => r.resolve("reviewer-a"), RegistryConfigError);
});

test("assertReviewersDistinct accepts reviewers on different models", () => {
  const r = new RegistryResolver(config());
  assert.doesNotThrow(() => r.assertReviewersDistinct());
});

test("assertReviewersDistinct rejects reviewers resolving to the same model string", () => {
  const c = config();
  // Make both reviewers land on the same model.
  c.instances[0]!.serves[0]!.model = "github-copilot/gpt-5.5";
  const r = new RegistryResolver(c);
  assert.throws(() => r.assertReviewersDistinct(), RegistryConfigError);
});

test("listInstances projection carries tier labels — never credentialsRef or model strings", () => {
  const r = new RegistryResolver(config());
  const proj = r.listInstances();
  const json = JSON.stringify(proj);
  assert.ok(!json.includes("claude-code/default"));
  assert.ok(!json.includes("opencode/gateway"));
  assert.ok(!json.includes("claude-opus-4.8"));
  assert.ok(!json.includes("gpt-5.5"));
  assert.equal(proj[0]!.serves[0]!.label, "capable — claude-code");
});

// ---- catalog validation -----------------------------------------------------

const opencodeCatalog: ModelInfo[] = [
  { id: "gpt-5.5", provider: "github-copilot" },
  { id: "claude-sonnet-4.6", provider: "github-copilot" },
  { id: "gpt-5.5-fast", provider: "github-copilot" },
];
const claudeCatalog: ModelInfo[] = [{ id: "claude-opus-4.8", provider: "anthropic" }];

test("validateServesAgainstCatalog passes when every model is present", () => {
  const r = new RegistryResolver(config());
  const res = r.validateServesAgainstCatalog(
    new Map([
      ["claude-local", claudeCatalog],
      ["opencode-local", opencodeCatalog],
    ]),
  );
  assert.equal(res.ok, true);
  assert.equal(res.problems.length, 0);
});

test("a model absent from the catalog is a problem and blocks that (instance, tier)", () => {
  const c = config();
  c.instances[1]!.serves[1]!.model = "github-copilot/does-not-exist"; // mid tier on opencode
  const r = new RegistryResolver(c);
  const res = r.validateServesAgainstCatalog(
    new Map([
      ["claude-local", claudeCatalog],
      ["opencode-local", opencodeCatalog],
    ]),
  );
  assert.equal(res.ok, false);
  assert.equal(res.problems.length, 1);
  assert.equal(res.problems[0]!.tier, "mid");
  assert.ok(res.blocked.has(blockKey("opencode-local", "mid")));
  // The unaffected capable tier on the same instance is not blocked.
  assert.ok(!res.blocked.has(blockKey("opencode-local", "capable")));
});

test("an instance without a catalog is skipped and recorded as catalogUnavailable", () => {
  const r = new RegistryResolver(config());
  const res = r.validateServesAgainstCatalog(
    new Map([
      ["claude-local", null], // no catalog (capability models absent)
      ["opencode-local", opencodeCatalog],
    ]),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.catalogUnavailable, ["claude-local"]);
});

test("the catalog validation problem label leaks no vendor model id", () => {
  const c = config();
  c.instances[1]!.serves[0]!.model = "github-copilot/secret-model";
  const r = new RegistryResolver(c);
  const res = r.validateServesAgainstCatalog(new Map([["opencode-local", opencodeCatalog]]));
  assert.ok(!res.problems[0]!.label.includes("secret-model"));
});

test("modelMatchesCatalog matches provider/name and bare ids", () => {
  assert.equal(modelMatchesCatalog("github-copilot/gpt-5.5", opencodeCatalog), true);
  assert.equal(modelMatchesCatalog("gpt-5.5", opencodeCatalog), true); // bare id
  assert.equal(modelMatchesCatalog("other/gpt-5.5", opencodeCatalog), false); // wrong provider
  assert.equal(modelMatchesCatalog("github-copilot/nope", opencodeCatalog), false);
});

test("parseModel splits provider/name and leaves bare names provider-less", () => {
  assert.deepEqual(parseModel("a/b"), { provider: "a", name: "b" });
  assert.deepEqual(parseModel("bare"), { name: "bare" });
});
