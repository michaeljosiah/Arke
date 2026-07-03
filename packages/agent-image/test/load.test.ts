import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentImageError, loadAgentImage, setAgentModel } from "../src/index.js";

function imageDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-image-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

test("a valid image parses into a typed AgentImage with its executor (harness + model)", () => {
  const dir = imageDir({
    "config.yaml":
      "spec_version: 1\nname: implementer\nexecutor:\n  type: omnigent\n  config:\n    harness: opencode-native\n    model: github-copilot/gpt-5.5\n    options:\n      reasoningEffort: xhigh\ninstructions: AGENTS.md\ninteraction:\n  mode: subagent\npermission:\n  edit: allow\n",
    "AGENTS.md": "You implement the spec.",
  });
  const image = loadAgentImage(dir);
  assert.equal(image.name, "implementer");
  assert.equal(image.executor.type, "omnigent");
  assert.equal(image.executor.config.harness, "opencode-native");
  assert.equal(image.executor.config.model, "github-copilot/gpt-5.5");
  assert.equal(image.executor.config.options?.reasoningEffort, "xhigh");
  assert.equal(image.interaction.mode, "subagent");
  assert.equal(image.instructions, "You implement the spec.");
  assert.equal(image.permission.edit, "allow");
});

test("the direct (unwrapped) executor form is accepted", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: k\nexecutor:\n  harness: pi\n  model: kimi-k2-turbo\n" });
  const image = loadAgentImage(dir);
  assert.equal(image.executor.config.harness, "pi");
  assert.equal(image.executor.config.model, "kimi-k2-turbo");
});

test("an executor with no model is allowed (harness resolves the provider default)", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: brain\nexecutor:\n  config:\n    harness: claude-sdk\n" });
  const image = loadAgentImage(dir);
  assert.equal(image.executor.config.harness, "claude-sdk");
  assert.equal(image.executor.config.model, undefined);
});

test("sub-agents load recursively", () => {
  const dir = imageDir({
    "config.yaml": "spec_version: 1\nname: lead\nexecutor:\n  config:\n    harness: claude-sdk\n",
    "agents/helper/config.yaml": "spec_version: 1\nname: helper\nexecutor:\n  config:\n    harness: opencode-native\n    model: x/y\n",
  });
  const image = loadAgentImage(dir);
  assert.equal(image.subAgents.length, 1);
  assert.equal(image.subAgents[0]!.name, "helper");
  assert.equal(image.subAgents[0]!.executor.config.harness, "opencode-native");
});

test("setAgentModel rewrites the declared model + reasoning effort, preserving the rest", () => {
  const dir = imageDir({
    "config.yaml":
      "spec_version: 1\nname: implementer\ndescription: writes code\nexecutor:\n  type: omnigent\n  config:\n    harness: opencode-native\n    model: gateway/implementer\n    auth:\n      profile: opencode-local\ninteraction:\n  mode: subagent\npermission:\n  edit: allow\n",
  });
  setAgentModel(dir, "github-copilot/gpt-5.5", "xhigh");
  const image = loadAgentImage(dir);
  assert.equal(image.executor.config.model, "github-copilot/gpt-5.5");
  assert.equal(image.executor.config.options?.reasoningEffort, "xhigh");
  // untouched fields survive the surgical edit
  assert.equal(image.executor.config.harness, "opencode-native");
  assert.equal(image.executor.config.auth?.profile, "opencode-local");
  assert.equal(image.description, "writes code");
  assert.equal(image.permission.edit, "allow");
});

test("setAgentModel with no effort drops a previously-set reasoning effort", () => {
  const dir = imageDir({
    "config.yaml":
      "spec_version: 1\nname: r\nexecutor:\n  config:\n    harness: opencode-native\n    model: github-copilot/gpt-5.5\n    options:\n      reasoningEffort: xhigh\n",
  });
  setAgentModel(dir, "github-copilot/claude-opus-4.8"); // no effort
  const image = loadAgentImage(dir);
  assert.equal(image.executor.config.model, "github-copilot/claude-opus-4.8");
  assert.equal(image.executor.config.options?.reasoningEffort, undefined);
});

test("a missing config.yaml is rejected whole", () => {
  const dir = imageDir({ "AGENTS.md": "no config" });
  assert.throws(() => loadAgentImage(dir), AgentImageError);
});

test("an image that inlines a provider api_key is rejected (credentials stay host-side, NFR-1)", () => {
  const dir = imageDir({
    "config.yaml": "spec_version: 1\nname: x\nexecutor:\n  config:\n    harness: opencode-native\n    model: openai/gpt-5.5\n    auth:\n      api_key: sk-secret\n",
  });
  assert.throws(() => loadAgentImage(dir), /api_key/);
});

test("an image with no executor is rejected", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: x\n" });
  assert.throws(() => loadAgentImage(dir), /executor/);
});

test("an image with an unknown harness is rejected", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: x\nexecutor:\n  config:\n    harness: gigabrain\n" });
  assert.throws(() => loadAgentImage(dir), AgentImageError);
});

test("the canonical roster images on disk all parse with an opencode-native executor", () => {
  // agents/ lives at the repo root, three levels up from this test file's package.
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  for (const name of ["spec-author", "architect", "reviewer-a", "reviewer-b", "implementer", "researcher"]) {
    const image = loadAgentImage(join(repoRoot, "agents", name));
    assert.equal(image.name, name);
    assert.equal(image.executor.config.harness, "opencode-native");
    assert.ok(image.instructions && image.instructions.length > 0);
  }
});
