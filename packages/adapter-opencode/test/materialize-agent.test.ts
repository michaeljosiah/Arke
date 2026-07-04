import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";
import type { AgentImage } from "@arke/contracts";
import { OpenCodeAdapter, canonicalizeRoot } from "../src/index.js";

function adapterIn(root: string): OpenCodeAdapter {
  return new OpenCodeAdapter({ baseUrl: "http://127.0.0.1:4096", projectRoot: root });
}

const image: AgentImage = {
  name: "implementer",
  description: "Executes the Tasks; writes code on the feature branch.",
  executor: { type: "omnigent", config: { harness: "opencode-native", model: "github-copilot/gpt-5.5", options: { reasoningEffort: "xhigh" } } },
  instructions: "You implement the approved specification's tasks.",
  interaction: { conversational: true, mode: "subagent" },
  tools: {},
  skills: [],
  permission: { read: "allow", edit: "allow", bash: "ask" },
  subAgents: [],
};

test("materializeAgent writes the OpenCode convention with the agent's declared model + options", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-materialize-")));
  await adapterIn(root).materializeAgent(image);

  const md = readFileSync(join(root, ".opencode", "agents", "implementer.md"), "utf8");
  assert.match(md, /^---/);
  assert.match(md, /mode: subagent/);
  assert.match(md, /model: github-copilot\/gpt-5.5/);
  assert.match(md, /options:/);
  assert.match(md, /reasoningEffort: xhigh/);
  assert.match(md, /permission:/);
  assert.match(md, /edit: allow/);
  assert.match(md, /You implement the approved specification/);
  // the tier indirection is gone — no `tier:` line
  assert.equal(/^tier:/m.test(md), false);
});

test("a gateway/bare placeholder model is OMITTED from the materialised frontmatter", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-materialize-")));
  await adapterIn(root).materializeAgent({
    ...image,
    name: "greenfield",
    executor: { type: "omnigent", config: { harness: "opencode-native", model: "gateway/greenfield" } },
  });
  const md = readFileSync(join(root, ".opencode", "agents", "greenfield.md"), "utf8");
  // gateway = "use the harness default" — writing `model: gateway/…` would make OpenCode resolve a
  // literal non-existent model, so it must be omitted (the agent falls back to the harness default).
  assert.equal(/^model:/m.test(md), false);
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

test("capabilitiesManifest reports OpenCode's native support (docs-derived)", () => {
  const m = adapterIn(canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-caps-")))).capabilitiesManifest();
  assert.equal(m.harness, "opencode");
  assert.deepEqual(m.mcp, { local: true, remote: true });
  assert.equal(m.skills.supported, true);
  assert.ok(m.skills.locations.includes(".opencode/skills") && m.skills.locations.includes(".claude/skills"));
  assert.equal(m.functionTools, false); // no Omnigent-style python callable
  assert.equal(m.toolGating, "permission");
  assert.ok(m.builtinTools.includes("bash") && m.builtinTools.includes("skill") && m.builtinTools.includes("webfetch"));
});

test("materializeCapabilities writes MCP servers, translating ${VAR} → {env:VAR} (usable + NFR-1)", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-caps-")));
  const r = await adapterIn(root).materializeCapabilities({
    ...image,
    tools: {
      github: { type: "mcp", transport: "local", command: "uv", args: ["run", "python", "-m", "pkg.github_mcp"], environment: { GITHUB_TOKEN: "${GH_TOKEN}" } },
      docs: { type: "mcp", transport: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
    },
  });
  assert.deepEqual(r.registered.sort(), ["docs", "github"]);
  const oc = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"));
  // ${VAR} is rewritten to OpenCode's {env:VAR} syntax so auth actually resolves at spawn (review R3).
  assert.deepEqual(oc.mcp.github, { type: "local", command: ["uv", "run", "python", "-m", "pkg.github_mcp"], environment: { GITHUB_TOKEN: "{env:GH_TOKEN}" } });
  assert.equal(oc.mcp.docs.type, "remote");
  assert.equal(oc.mcp.docs.headers.Authorization, "Bearer {env:DOCS_TOKEN}"); // literal prefix preserved
  // No resolved secret is written — only the {env:VAR} reference; and the raw ${VAR} form is gone.
  const raw = readFileSync(join(root, "opencode.json"), "utf8");
  assert.match(raw, /\{env:GH_TOKEN\}/);
  assert.doesNotMatch(raw, /\$\{GH_TOKEN\}/);
});

test("materializeCapabilities merges into an existing opencode.json, preserving other keys/servers", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-caps-")));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "opencode.json"), JSON.stringify({ $schema: "x", theme: "dark", mcp: { other: { type: "local", command: ["x"] } } }), "utf8");
  await adapterIn(root).materializeCapabilities({ ...image, tools: { github: { type: "mcp", transport: "local", command: "uv" } } });
  const oc = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"));
  assert.equal(oc.theme, "dark"); // preserved
  assert.ok(oc.mcp.other && oc.mcp.github); // both servers present
});

test("materializeCapabilities MERGES into a valid JSONC opencode.json, preserving comments (review R6)", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-caps-")));
  const { writeFileSync } = await import("node:fs");
  // OpenCode config is JSONC — comments + trailing commas are VALID, not corruption.
  writeFileSync(join(root, "opencode.json"), '{\n  // my config\n  "theme": "dark",\n  "mcp": {},\n}\n', "utf8");
  await adapterIn(root).materializeCapabilities({ ...image, tools: { g: { type: "mcp", transport: "local", command: "uv" } } });
  const raw = readFileSync(join(root, "opencode.json"), "utf8");
  assert.match(raw, /\/\/ my config/); // the comment survives the in-place edit
  const oc = parseJsonc(raw);
  assert.equal(oc.theme, "dark");
  assert.ok(oc.mcp.g); // the new server was merged in
});

test("materializeCapabilities REFUSES to overwrite a GENUINELY corrupt opencode.json (no silent loss)", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-caps-")));
  const { writeFileSync } = await import("node:fs");
  // Not JSONC — a real structural error (unclosed brace). The old code would silently discard it.
  writeFileSync(join(root, "opencode.json"), '{ "theme": "dark", "mcp": { ', "utf8");
  const before = readFileSync(join(root, "opencode.json"), "utf8");
  await assert.rejects(
    () => adapterIn(root).materializeCapabilities({ ...image, tools: { g: { type: "mcp", transport: "local", command: "uv" } } }),
    /not valid JSON\/JSONC/,
  );
  // the corrupt file is left untouched for the user to repair — NOT overwritten
  assert.equal(readFileSync(join(root, "opencode.json"), "utf8"), before);
});

test("re-materializeAgent preserves the existing instruction body when the image carries none (SPEC-021)", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-rematerialize-")));
  const a = adapterIn(root);
  // First materialise with a real body (from the image prompt).
  await a.materializeAgent({ ...image, name: "keeper", prompt: "You are the keeper. Guard the gate.", instructions: "" });
  const first = readFileSync(join(root, ".opencode", "agents", "keeper.md"), "utf8");
  assert.match(first, /Guard the gate/);
  // Now re-materialise the SAME name with a permission edit but NO instruction body (empty prompt):
  // the frontmatter updates, the body is preserved (not clobbered to empty).
  await a.materializeAgent({ ...image, name: "keeper", prompt: "", instructions: "", permission: { edit: "deny" } });
  const second = readFileSync(join(root, ".opencode", "agents", "keeper.md"), "utf8");
  assert.match(second, /edit: deny/); // frontmatter updated
  assert.match(second, /Guard the gate/); // body preserved
});

test("materializeCapabilities surfaces an MCP tool whitelist as unsupported (review R2)", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-caps-")));
  const r = await adapterIn(root).materializeCapabilities({
    ...image,
    tools: { github: { type: "mcp", transport: "local", command: "uv", tools: ["search_issues"] } },
  });
  assert.ok(r.registered.includes("github")); // the server still registers
  // ...but the exposed-tool whitelist can't be enforced in opencode.json — surfaced, not silently dropped.
  const caveat = r.unsupported.find((u) => u.name === "github.tools");
  assert.ok(caveat, "the tool whitelist is reported");
  assert.match(caveat!.reason, /whitelist|github_\*/);
});

test("materializeCapabilities records an unsupported function tool", async () => {
  const root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-caps-")));
  const r = await adapterIn(root).materializeCapabilities({ ...image, tools: { calc: { type: "function", callable: "pkg.calc" } } });
  assert.equal(r.registered.length, 0);
  assert.equal(r.unsupported.length, 1);
  assert.equal(r.unsupported[0].name, "calc");
  assert.match(r.unsupported[0].reason, /no Omnigent-style function tool/);
});
