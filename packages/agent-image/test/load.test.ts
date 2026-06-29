import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentImageError, loadAgentImage } from "../src/index.js";

function imageDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-image-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

test("a valid image parses into a typed AgentImage referencing a logical tier", () => {
  const dir = imageDir({
    "config.yaml": "spec_version: 1\nname: implementer\ntier: mid\ninstructions: AGENTS.md\ninteraction:\n  mode: subagent\npermission:\n  edit: allow\n",
    "AGENTS.md": "You implement the spec.",
  });
  const image = loadAgentImage(dir);
  assert.equal(image.name, "implementer");
  assert.equal(image.tier, "mid");
  assert.equal(image.interaction.mode, "subagent");
  assert.equal(image.instructions, "You implement the spec.");
  assert.equal(image.permission.edit, "allow");
});

test("sub-agents load recursively", () => {
  const dir = imageDir({
    "config.yaml": "spec_version: 1\nname: lead\ntier: capable\n",
    "agents/helper/config.yaml": "spec_version: 1\nname: helper\ntier: mid\n",
  });
  const image = loadAgentImage(dir);
  assert.equal(image.subAgents.length, 1);
  assert.equal(image.subAgents[0]!.name, "helper");
});

test("a missing config.yaml is rejected whole", () => {
  const dir = imageDir({ "AGENTS.md": "no config" });
  assert.throws(() => loadAgentImage(dir), AgentImageError);
});

test("an image with a vendor model id is rejected (tier-only contract)", () => {
  const dir = imageDir({
    "config.yaml": "spec_version: 1\nname: x\ntier: mid\nllm:\n  model: anthropic/claude-opus\n",
  });
  assert.throws(() => loadAgentImage(dir), /vendor model id/);
});

test("an image with an invalid tier is rejected", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: x\ntier: gigabrain\n" });
  assert.throws(() => loadAgentImage(dir), AgentImageError);
});

test("the canonical roster images on disk all parse", () => {
  // agents/ lives at the repo root, three levels up from this test file's package.
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  for (const name of ["spec-author", "architect", "reviewer-a", "reviewer-b", "implementer", "researcher"]) {
    const image = loadAgentImage(join(repoRoot, "agents", name));
    assert.equal(image.name, name);
    assert.ok(image.tier === "capable" || image.tier === "mid");
    assert.ok(image.instructions && image.instructions.length > 0);
  }
});
