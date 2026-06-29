import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentImage } from "@arke/contracts";
import { OpenCodeAdapter, canonicalizeRoot } from "../src/index.js";

function adapterIn(root: string): OpenCodeAdapter {
  return new OpenCodeAdapter({ baseUrl: "http://127.0.0.1:4096", projectRoot: root });
}

const image: AgentImage = {
  name: "implementer",
  description: "Executes the Tasks; writes code on the feature branch.",
  tier: "mid",
  instructions: "You implement the approved specification's tasks.",
  interaction: { conversational: true, mode: "subagent" },
  tools: [],
  skills: [],
  permission: { read: "allow", edit: "allow", bash: "ask" },
  subAgents: [],
};

test("materializeAgent writes the OpenCode convention with a logical tier (not a model id)", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-materialize-")));
  await adapterIn(root).materializeAgent(image);

  const md = readFileSync(join(root, ".opencode", "agents", "implementer.md"), "utf8");
  assert.match(md, /^---/);
  assert.match(md, /mode: subagent/);
  assert.match(md, /tier: mid/);
  assert.match(md, /permission:/);
  assert.match(md, /edit: allow/);
  assert.match(md, /You implement the approved specification/);
  // the logical tier is the contract — no vendor model id is written
  assert.equal(/claude|gpt|gemini|sonnet|opus/i.test(md), false);
});

test("sub-agents are materialised as their own files", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-materialize-")));
  await adapterIn(root).materializeAgent({
    ...image,
    name: "lead",
    subAgents: [{ ...image, name: "helper" }],
  });
  assert.ok(readFileSync(join(root, ".opencode", "agents", "lead.md"), "utf8"));
  assert.ok(readFileSync(join(root, ".opencode", "agents", "helper.md"), "utf8"));
});
