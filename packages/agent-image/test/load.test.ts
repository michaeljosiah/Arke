import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentImageError, loadAgentImage, setAgentMode, setAgentModel, setAgentPermission, setAgentTools, writeNewAgent } from "../src/index.js";

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

test("an inline api_key is rejected in BOTH the wrapped and the direct executor form (NFR-1)", () => {
  const wrapped = imageDir({ "config.yaml": "spec_version: 1\nname: w\nexecutor:\n  config:\n    harness: opencode-native\n    auth:\n      api_key: sk-secret\n" });
  assert.throws(() => loadAgentImage(wrapped), /must not inline a provider api_key/);
  // Regression: the direct form (executor.auth, not executor.config.auth) must also be rejected.
  const direct = imageDir({ "config.yaml": "spec_version: 1\nname: d\nexecutor:\n  harness: opencode-native\n  auth:\n    api_key: sk-secret\n" });
  assert.throws(() => loadAgentImage(direct), /must not inline a provider api_key/);
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

test("a keyed tools map parses MCP (local + remote) and function tools with full wiring", () => {
  const dir = imageDir({
    "config.yaml":
      "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n" +
      "  github:\n    type: mcp\n    command: uv\n    args: [run, python, -m, pkg.github_mcp]\n    tools: [search_issues]\n" +
      "  docs:\n    type: mcp\n    url: https://example.com/mcp\n    headers:\n      Authorization: \"Bearer ${DOCS_TOKEN}\"\n" +
      "  summarize:\n    type: function\n    callable: pkg.tools.summarize\n",
  });
  const img = loadAgentImage(dir);
  const gh = img.tools.github as any;
  assert.equal(gh.type, "mcp");
  assert.equal(gh.transport, "local");
  assert.equal(gh.command, "uv");
  assert.deepEqual(gh.args, ["run", "python", "-m", "pkg.github_mcp"]);
  assert.deepEqual(gh.tools, ["search_issues"]);
  const docs = img.tools.docs as any;
  assert.equal(docs.transport, "remote");
  assert.equal(docs.url, "https://example.com/mcp");
  assert.equal(docs.headers.Authorization, "Bearer ${DOCS_TOKEN}"); // ${VAR} kept unresolved
  const sum = img.tools.summarize as any;
  assert.equal(sum.type, "function");
  assert.equal(sum.callable, "pkg.tools.summarize");
});

test("an OpenCode-style single command array flattens to command + args", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  x:\n    type: mcp\n    command: [npx, -y, some-mcp]\n" });
  const x = loadAgentImage(dir).tools.x as any;
  assert.equal(x.command, "npx");
  assert.deepEqual(x.args, ["-y", "some-mcp"]);
});

test("an inline literal secret in a credential-named field is rejected; ${VAR} passes", () => {
  const bad = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  d:\n    type: mcp\n    url: https://x/mcp\n    headers:\n      Authorization: \"Bearer sk-LITERAL\"\n" });
  assert.throws(() => loadAgentImage(bad), /literal secret in credential field 'Authorization'/);
  // A benign literal in a non-credential field is fine; a ${VAR} in the credential field passes.
  const ok = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  d:\n    type: mcp\n    url: https://x/mcp\n    headers:\n      Authorization: \"Bearer ${T}\"\n      Content-Type: application/json\n" });
  const d = loadAgentImage(ok).tools.d as any;
  assert.equal(d.headers["Content-Type"], "application/json");
});

test("a credential value mixing a literal secret WITH a ${VAR} is still rejected (not just substring)", () => {
  // Regression (PR #37 review P1): `HAS_VAR_REF.test` let a value THROUGH as long as it contained any
  // ${VAR}, so `Bearer sk-live ${TOKEN}` leaked the literal `sk-live` into the tracked config. The
  // whole value must reduce to interpolations + scheme keyword + separators — no literal residue.
  const mixed = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  d:\n    type: mcp\n    url: https://x/mcp\n    headers:\n      Authorization: \"Bearer sk-live ${DOCS_TOKEN}\"\n" });
  assert.throws(() => loadAgentImage(mixed), /literal secret in credential field 'Authorization'/);
  // Legit composed forms still pass: `Basic ${CREDS}` and `${USER}:${PASS}`.
  const ok = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  a:\n    type: mcp\n    url: https://x/mcp\n    headers:\n      Authorization: \"Basic ${CREDS}\"\n  b:\n    type: mcp\n    url: https://y/mcp\n    headers:\n      Authorization: \"${USER}:${PASS}\"\n" });
  const a = loadAgentImage(ok).tools.a as any;
  assert.equal(a.headers.Authorization, "Basic ${CREDS}");
});

test("an inline `type: agent` tool is folded into subAgents so it materialises (SPEC-021)", () => {
  const dir = imageDir({
    "config.yaml":
      "spec_version: 1\nname: lead\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  helper:\n    type: agent\n    executor:\n      config:\n        harness: opencode-native\n        model: x/y\n    prompt: You assist the lead.\n",
  });
  const img = loadAgentImage(dir);
  assert.equal((img.tools.helper as any).type, "agent"); // still documented in tools
  const helper = img.subAgents.find((s) => s.name === "helper");
  assert.ok(helper, "the agent-tool became an addressable sub-agent");
  assert.equal(helper!.executor.config.harness, "opencode-native");
  assert.equal(helper!.interaction.mode, "subagent");
});

test("a malformed discovered MCP file fails the image loudly (not silently dropped)", () => {
  // Neither command nor url: parseMcpEntry's own AgentImageError propagates (fail loud), same as an
  // equivalent inline entry — no longer silently swallowed (PR #37 review).
  const invalid = imageDir({
    "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\n",
    "tools/mcp/broken.yaml": "description: has neither command nor url\n",
  });
  assert.throws(() => loadAgentImage(invalid), /MCP tool 'broken' must have exactly one of 'command'/);
  // Unparseable YAML is wrapped with the file name so the author can find it.
  const unparseable = imageDir({
    "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\n",
    "tools/mcp/bad.yaml": "command: [unclosed\n",
  });
  assert.throws(() => loadAgentImage(unparseable), /discovered MCP tool 'bad.yaml' is invalid/);
});

test("setAgentMode rewrites the interaction mode, preserving the rest (SPEC-021)", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: r\ndescription: keep\nexecutor:\n  config:\n    harness: opencode-native\n    model: x/y\ninteraction:\n  mode: subagent\n" });
  setAgentMode(dir, "primary");
  const img = loadAgentImage(dir);
  assert.equal(img.interaction.mode, "primary");
  assert.equal(img.description, "keep");
  assert.equal(img.executor.config.model, "x/y");
});

test("an MCP entry with neither command nor url is rejected as malformed", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  x:\n    type: mcp\n    description: broken\n" });
  assert.throws(() => loadAgentImage(dir), /must have exactly one of 'command' .* or 'url'/);
});

test("an inline environment secret in an MCP local server is rejected", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  g:\n    type: mcp\n    command: mcp-server\n    environment:\n      GITHUB_TOKEN: ghp_LITERALVALUE\n" });
  assert.throws(() => loadAgentImage(dir), /literal secret in credential field 'GITHUB_TOKEN'/);
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

test("setAgentModel on an image with no options block does not throw (effort omitted)", () => {
  // Regression: deleteIn(...options...) threw "Expected YAML collection at options" when no options
  // map existed (e.g. spec-author), aborting the write. Setting a model with no effort must succeed.
  const dir = imageDir({
    "config.yaml": "spec_version: 1\nname: spec-author\nexecutor:\n  type: omnigent\n  config:\n    harness: opencode-native\n    model: github-copilot/claude-opus-4.8\n    auth:\n      profile: opencode-local\n",
  });
  setAgentModel(dir, "github-copilot/claude-sonnet-4.5"); // no options block, no effort → must not throw
  const image = loadAgentImage(dir);
  assert.equal(image.executor.config.model, "github-copilot/claude-sonnet-4.5");
  assert.equal(image.executor.config.options?.reasoningEffort, undefined);
  assert.equal(image.executor.config.auth?.profile, "opencode-local");
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

test("setAgentPermission replaces the permission grid, preserving the rest (SPEC-021)", () => {
  const dir = imageDir({
    "config.yaml":
      "spec_version: 1\nname: r\ndescription: keep me\nexecutor:\n  config:\n    harness: opencode-native\n    model: x/y\npermission:\n  edit: allow\n",
  });
  setAgentPermission(dir, { edit: "ask", bash: "deny", github_mcp_search: "allow" });
  const image = loadAgentImage(dir);
  assert.equal(image.permission.edit, "ask");
  assert.equal(image.permission.bash, "deny");
  assert.equal(image.permission.github_mcp_search, "allow");
  assert.equal(image.description, "keep me"); // untouched
  assert.equal(image.executor.config.model, "x/y");
});

test("setAgentTools writes the keyed tools map, preserving the rest, and round-trips (SPEC-021)", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\n    model: anthropic/opus\npermission:\n  bash: ask\n" });
  setAgentTools(dir, {
    github: { type: "mcp", transport: "local", command: "uv", args: ["run", "gh"], environment: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
    docs: { type: "mcp", transport: "remote", url: "https://x/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
  } as any);
  const img = loadAgentImage(dir);
  const gh = img.tools.github as any;
  assert.equal(gh.transport, "local");
  assert.equal(gh.command, "uv");
  assert.deepEqual(gh.args, ["run", "gh"]);
  assert.equal(gh.environment.GITHUB_TOKEN, "${GITHUB_TOKEN}");
  assert.equal((img.tools.docs as any).url, "https://x/mcp");
  assert.equal((img.tools.docs as any).headers.Authorization, "Bearer ${DOCS_TOKEN}");
  // Untouched: the executor model and the permission block survive the tools rewrite.
  assert.equal(img.executor.config.model, "anthropic/opus");
  assert.equal(img.permission.bash, "ask");
});

test("setAgentTools with an empty map removes the tools block", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  x:\n    type: mcp\n    command: uv\n" });
  setAgentTools(dir, {} as any);
  assert.equal(Object.keys(loadAgentImage(dir).tools).length, 0);
});

test("setAgentTools rejects an inline literal secret and rolls back the file (NFR-1)", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: t\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  keep:\n    type: mcp\n    command: uv\n" });
  const before = readFileSync(join(dir, "config.yaml"), "utf8");
  assert.throws(
    () => setAgentTools(dir, { bad: { type: "mcp", transport: "remote", url: "https://x", headers: { Authorization: "Bearer sk-LITERAL" } } } as any),
    AgentImageError,
  );
  // Rolled back: the original tools survive and the rejected edit left nothing behind.
  assert.equal(readFileSync(join(dir, "config.yaml"), "utf8"), before, "the file is restored on a rejected edit");
  assert.ok(loadAgentImage(dir).tools.keep, "the original tool is intact");
});

test("setAgentPermission with an empty map removes the permission block", () => {
  const dir = imageDir({ "config.yaml": "spec_version: 1\nname: r\nexecutor:\n  config:\n    harness: opencode-native\npermission:\n  edit: allow\n" });
  setAgentPermission(dir, {});
  assert.deepEqual(loadAgentImage(dir).permission, {});
});

test("writeNewAgent creates a valid image directory from a structured spec (SPEC-021)", () => {
  const agentsRoot = mkdtempSync(join(tmpdir(), "arke-agents-"));
  const dir = writeNewAgent(agentsRoot, {
    name: "scout",
    description: "does recon",
    harness: "opencode-native",
    model: "github-copilot/gpt-5.5",
    reasoningEffort: "high",
    authProfile: "opencode-local",
    mode: "subagent",
    instructions: "You scout the codebase.",
    permission: { read: "allow", edit: "ask" },
    tools: {
      github: { type: "mcp", transport: "local", command: "uv", args: ["run", "mcp"], environment: { GITHUB_TOKEN: "${GH_TOKEN}" } },
    },
  });
  assert.equal(dir, join(agentsRoot, "scout"));
  const image = loadAgentImage(dir);
  assert.equal(image.name, "scout");
  assert.equal(image.executor.config.harness, "opencode-native");
  assert.equal(image.executor.config.model, "github-copilot/gpt-5.5");
  assert.equal(image.executor.config.options?.reasoningEffort, "high");
  assert.equal(image.executor.config.auth?.profile, "opencode-local");
  assert.equal(image.interaction.mode, "subagent");
  assert.equal(image.permission.read, "allow");
  const gh = image.tools.github as any;
  assert.equal(gh.transport, "local");
  assert.equal(gh.environment.GITHUB_TOKEN, "${GH_TOKEN}"); // ${VAR} kept unresolved
});

test("writeNewAgent refuses to overwrite an existing agent", () => {
  const agentsRoot = mkdtempSync(join(tmpdir(), "arke-agents-"));
  writeNewAgent(agentsRoot, { name: "dup", harness: "opencode-native" });
  assert.throws(() => writeNewAgent(agentsRoot, { name: "dup", harness: "opencode-native" }), /already exists/);
});

test("writeNewAgent rejects an inline secret and leaves no broken image behind (NFR-1)", () => {
  const agentsRoot = mkdtempSync(join(tmpdir(), "arke-agents-"));
  assert.throws(
    () =>
      writeNewAgent(agentsRoot, {
        name: "leaky",
        harness: "opencode-native",
        tools: { d: { type: "mcp", transport: "remote", url: "https://x/mcp", headers: { Authorization: "Bearer sk-LITERAL" } } },
      }),
    /literal secret/,
  );
  // the rejected create must not leave a half-written config.yaml on disk
  assert.equal(existsSync(join(agentsRoot, "leaky", "config.yaml")), false);
});

test("writeNewAgent rejects an invalid agent name (path guard)", () => {
  const agentsRoot = mkdtempSync(join(tmpdir(), "arke-agents-"));
  assert.throws(() => writeNewAgent(agentsRoot, { name: "../escape", harness: "opencode-native" }), /invalid agent name/);
});

test("writeNewAgent applies a governed default permission when none is given (review R8)", () => {
  const agentsRoot = mkdtempSync(join(tmpdir(), "arke-agents-"));
  const dir = writeNewAgent(agentsRoot, { name: "bare", harness: "opencode-native" });
  const img = loadAgentImage(dir);
  // OpenCode defaults unset ops to allow — a create with no grid must NOT leave edit/bash ungoverned.
  assert.equal(img.permission.edit, "ask");
  assert.equal(img.permission.bash, "ask");
});

test("a directory sub-agent WINS a same-name inline agent-tool conflict (review R7)", () => {
  const dir = imageDir({
    "config.yaml":
      "spec_version: 1\nname: lead\nexecutor:\n  config:\n    harness: opencode-native\ntools:\n  helper:\n    type: agent\n    executor:\n      config:\n        harness: opencode-native\n        model: inline/model\n    prompt: inline helper\n",
    "agents/helper/config.yaml": "spec_version: 1\nname: helper\nexecutor:\n  config:\n    harness: opencode-native\n    model: dir/model\n",
  });
  const img = loadAgentImage(dir);
  const helpers = img.subAgents.filter((s) => s.name === "helper");
  assert.equal(helpers.length, 1, "no duplicate helper");
  assert.equal(helpers[0]!.executor.config.model, "dir/model"); // the directory one, not the inline one
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
