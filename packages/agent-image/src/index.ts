import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { AgentImage, type SkillRef, type Tool, type Tools } from "@arke/contracts";

/**
 * Loads a portable agent image directory into a typed {@link AgentImage} (SPEC-016).
 *
 * Layout: `config.yaml` (required) + optional `AGENTS.md` (instructions), `skills/<name>/SKILL.md`,
 * `tools/{mcp,python,typescript}/…`, and recursive `agents/<name>/`. The image declares its runtime
 * in an Omnigent-shaped `executor` block (harness + concrete model + provider auth). Credentials are
 * host-side only: an inline `executor.config.auth.api_key` in a committed image is a hard error
 * (NFR-1) — reference a host-side profile instead. Loading is all-or-nothing: any problem throws
 * {@link AgentImageError} and nothing is partially returned.
 */
export class AgentImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentImageError";
  }
}

interface RawAuth {
  profile?: string;
  type?: string;
  base_url?: string;
  baseUrl?: string;
  api_key?: unknown;
  apiKey?: unknown;
}

interface RawExecutor {
  type?: string;
  context_window?: number;
  contextWindow?: number;
  harness?: string; // direct (unwrapped) Omnigent form
  model?: unknown;
  auth?: RawAuth; // direct-form auth (executor.auth), mirrored by config.auth in the wrapped form
  config?: {
    harness?: string;
    model?: unknown;
    options?: Record<string, unknown>;
    auth?: RawAuth;
  };
}

interface RawConfig {
  spec_version?: number;
  name?: string;
  description?: string;
  executor?: RawExecutor;
  prompt?: string;
  instructions?: string;
  interaction?: { conversational?: boolean; mode?: string };
  permission?: Record<string, string>;
  os_env?: { type?: string; cwd?: string; sandbox?: { type?: string } };
  osEnv?: { type?: string; cwd?: string; sandbox?: { type?: string } };
  spawn?: boolean;
  /** Omnigent-shaped keyed tools map (SPEC-021): name → { type: mcp|function|agent, … }. */
  tools?: Record<string, RawTool>;
}

interface RawTool {
  type?: string;
  // mcp
  command?: string | string[];
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
  tools?: string[];
  enabled?: boolean;
  // function
  callable?: string;
  runtime?: string;
  parameters?: Record<string, unknown>;
  container_image?: string;
  containerImage?: string;
  // agent
  executor?: RawExecutor;
  prompt?: string;
  os_env?: unknown;
  osEnv?: unknown;
  pass_history?: boolean;
  passHistory?: boolean;
  max_sessions?: number;
  maxSessions?: number;
  description?: string;
}

export function loadAgentImage(dir: string): AgentImage {
  const configPath = join(dir, "config.yaml");
  if (!existsSync(configPath)) {
    throw new AgentImageError(`missing required config.yaml in ${dir}`);
  }
  let raw: RawConfig;
  try {
    raw = (parseYaml(readFileSync(configPath, "utf8")) ?? {}) as RawConfig;
  } catch (err) {
    throw new AgentImageError(`config.yaml is not valid YAML: ${reason(err)}`);
  }

  const executor = parseExecutor(raw.executor, raw.name ?? dir);
  const osEnvRaw = raw.os_env ?? raw.osEnv;

  const tools = { ...discoverTools(join(dir, "tools")), ...parseTools(raw.tools, raw.name ?? dir) };
  // An inline `type: agent` tool is an addressable sub-agent — fold it into `subAgents` so the harness
  // materialises it (a keyed agent-tool entry alone is never written to `.opencode/agents`) — SPEC-021.
  // The DIRECTORY form (`agents/<name>/`) is canonical and WINS a same-name conflict: skip an inline
  // agent-tool whose name a discovered sub-agent already claims (else the inline one would overwrite it).
  const directorySubs = discoverSubAgents(join(dir, "agents"));
  const directoryNames = new Set(directorySubs.map((s) => s.name));
  const inlineAgentSubs = Object.entries(tools)
    .filter(([name, t]) => t.type === "agent" && !directoryNames.has(name))
    .map(([name, t]) => agentToolAsSubImage(name, t as Extract<Tool, { type: "agent" }>));

  const candidate = {
    name: raw.name,
    description: raw.description,
    executor,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    instructions: resolveInstructions(dir, raw.instructions),
    interaction: {
      conversational: raw.interaction?.conversational ?? true,
      mode: raw.interaction?.mode ?? "primary",
    },
    tools,
    skills: discoverSkills(join(dir, "skills")),
    permission: raw.permission ?? {},
    ...(osEnvRaw
      ? {
          osEnv: {
            type: osEnvRaw.type ?? "caller_process",
            ...(osEnvRaw.cwd ? { cwd: osEnvRaw.cwd } : {}),
            ...(osEnvRaw.sandbox?.type ? { sandbox: { type: osEnvRaw.sandbox.type } } : {}),
          },
        }
      : {}),
    ...(typeof raw.spawn === "boolean" ? { spawn: raw.spawn } : {}),
    subAgents: [...directorySubs, ...inlineAgentSubs],
  };

  const result = AgentImage.safeParse(candidate);
  if (!result.success) {
    throw new AgentImageError(`invalid agent image '${raw.name ?? dir}': ${result.error.message}`);
  }
  return result.data;
}

/**
 * Rewrite an agent image's declared model (and optional reasoning effort) in place — the write half of
 * the model-selection UX (SPEC-016 revised). Edits ONLY `executor.config.model` and
 * `executor.config.options.reasoningEffort` in the image's `config.yaml`, preserving the rest of the
 * document (other fields, formatting, comments) via the YAML Document API. `model` is a full
 * `provider/model` string (or a bare gateway name). Passing no `reasoningEffort` removes it (and drops
 * an `options` block left empty). Throws {@link AgentImageError} if the image or its config is missing.
 */
export function setAgentModel(dir: string, model: string, reasoningEffort?: string): void {
  const configPath = join(dir, "config.yaml");
  if (!existsSync(configPath)) throw new AgentImageError(`missing required config.yaml in ${dir}`);
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new AgentImageError(`config.yaml is not valid YAML: ${reason(err)}`);
  }
  doc.setIn(["executor", "config", "model"], model);
  if (reasoningEffort) {
    doc.setIn(["executor", "config", "options", "reasoningEffort"], reasoningEffort);
  } else {
    // Remove a previously-set effort — but ONLY when an `options` map actually exists, else the YAML
    // Document API throws ("Expected YAML collection at options") traversing a non-existent path.
    const options = doc.getIn(["executor", "config", "options"]) as { items?: unknown[] } | undefined;
    if (options) {
      doc.deleteIn(["executor", "config", "options", "reasoningEffort"]);
      // Drop an options map that is now empty, so we don't leave a bare `options:` key behind.
      const after = doc.getIn(["executor", "config", "options"]) as { items?: unknown[] } | undefined;
      if (after && Array.isArray(after.items) && after.items.length === 0) {
        doc.deleteIn(["executor", "config", "options"]);
      }
    }
  }
  writeFileSync(configPath, String(doc), "utf8");
}

/**
 * Surgically rewrite an agent image's `permission` map in place (SPEC-021) — the write half of the
 * capability-aware editor's permission grid. Replaces ONLY the top-level `permission:` block in the
 * image's `config.yaml`, preserving the rest of the document (executor, tools, comments, formatting)
 * via the YAML Document API. An empty map removes the `permission:` key entirely. Throws
 * {@link AgentImageError} if the image or its config is missing.
 */
export function setAgentPermission(dir: string, permission: Record<string, string>): void {
  const configPath = join(dir, "config.yaml");
  if (!existsSync(configPath)) throw new AgentImageError(`missing required config.yaml in ${dir}`);
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new AgentImageError(`config.yaml is not valid YAML: ${reason(err)}`);
  }
  const entries = Object.entries(permission).filter(([, v]) => typeof v === "string" && v.trim() !== "");
  if (entries.length === 0) {
    if (doc.getIn(["permission"]) !== undefined) doc.deleteIn(["permission"]);
  } else {
    doc.setIn(["permission"], Object.fromEntries(entries));
  }
  writeFileSync(configPath, String(doc), "utf8");
}

/**
 * Surgically rewrite an agent image's interaction `mode` (`primary` | `subagent`) in place (SPEC-021).
 * Edits ONLY `interaction.mode` in `config.yaml`, preserving the rest of the document via the YAML
 * Document API. Throws {@link AgentImageError} if the image or its config is missing.
 */
export function setAgentMode(dir: string, mode: string): void {
  const configPath = join(dir, "config.yaml");
  if (!existsSync(configPath)) throw new AgentImageError(`missing required config.yaml in ${dir}`);
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new AgentImageError(`config.yaml is not valid YAML: ${reason(err)}`);
  }
  doc.setIn(["interaction", "mode"], mode);
  writeFileSync(configPath, String(doc), "utf8");
}

/**
 * Surgically rewrite an agent image's keyed `tools:` map in place (SPEC-021) — the write half of the
 * capability editor's MCP/tools panel, peer of {@link setAgentPermission}/{@link setAgentMode}. Replaces
 * ONLY the top-level `tools:` block (via the YAML Document API, preserving executor/permission/comments);
 * an empty map removes the key. `tools` is the FULL merged map the editor intends — the caller preserves
 * any non-MCP entries (function/agent tools the MCP editor doesn't touch) so they are not dropped. After
 * writing, the image is round-tripped through {@link loadAgentImage} (NFR-1: an inline literal secret or
 * a malformed entry is rejected) and the ORIGINAL config is restored on failure, so a bad edit never
 * leaves a broken image on disk. Throws {@link AgentImageError} if the image or its config is missing.
 */
export function setAgentTools(dir: string, tools: Tools): void {
  const configPath = join(dir, "config.yaml");
  if (!existsSync(configPath)) throw new AgentImageError(`missing required config.yaml in ${dir}`);
  const original = readFileSync(configPath, "utf8");
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(original);
  } catch (err) {
    throw new AgentImageError(`config.yaml is not valid YAML: ${reason(err)}`);
  }
  const entries = Object.entries(tools);
  if (entries.length === 0) {
    if (doc.getIn(["tools"]) !== undefined) doc.deleteIn(["tools"]);
  } else {
    doc.setIn(["tools"], Object.fromEntries(entries.map(([n, t]) => [n, toolToRaw(t)])));
  }
  writeFileSync(configPath, String(doc), "utf8");
  try {
    loadAgentImage(dir); // NFR-1 + malformed-entry validation of the just-written tools
  } catch (err) {
    writeFileSync(configPath, original, "utf8"); // roll back a rejected edit
    throw err instanceof AgentImageError ? err : new AgentImageError(`could not update tools in ${dir}: ${reason(err)}`);
  }
}

/** A structured request to create a new agent image (SPEC-021) — the write half of the editor's create flow. */
export interface NewAgentSpec {
  name: string;
  description?: string;
  harness: string;
  /** Full `provider/model` string (or a bare gateway name); omitted → the harness default. */
  model?: string;
  reasoningEffort?: string;
  /** Host-side auth profile the executor references (never an inline credential — NFR-1). */
  authProfile?: string;
  mode?: string; // interaction.mode (primary | subagent | …)
  conversational?: boolean;
  /** Inline system prompt written as the config `prompt` (skills/instructions folders are separate). */
  instructions?: string;
  permission?: Record<string, string>;
  /** Declared MCP / function tools; agent sub-tools use the `agents/<name>/` convention instead. */
  tools?: Tools;
}

/**
 * The governed default permission posture applied to a newly-created agent that declares no `permission`
 * (SPEC-021). OpenCode defaults an unset operation to ALLOWED, so without this a fresh agent could edit
 * files and run shell commands ungoverned; gate the mutating / exec / network operations by default.
 */
export const DEFAULT_AGENT_PERMISSION: Record<string, string> = { edit: "ask", bash: "ask", webfetch: "ask" };

/**
 * Create a NEW agent image directory `<agentsRoot>/<name>/config.yaml` from a structured spec
 * (SPEC-021). Builds the Omnigent-shaped `config.yaml`, writes it, then round-trips it through
 * {@link loadAgentImage} to validate — if the result is invalid (or would inline a secret), the
 * partially-written file/dir this call created is removed and it throws {@link AgentImageError}, so a
 * bad create never leaves a broken image on disk. Refuses to overwrite an existing agent.
 */
export function writeNewAgent(agentsRoot: string, spec: NewAgentSpec): string {
  const name = String(spec.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new AgentImageError(`invalid agent name '${name}'`);
  const dir = join(agentsRoot, name);
  if (existsSync(join(dir, "config.yaml"))) throw new AgentImageError(`agent '${name}' already exists`);

  const config: Record<string, unknown> = {
    spec_version: 1,
    name,
    ...(spec.description ? { description: spec.description } : {}),
    executor: {
      type: "omnigent",
      config: {
        harness: spec.harness,
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.reasoningEffort ? { options: { reasoningEffort: spec.reasoningEffort } } : {}),
        ...(spec.authProfile ? { auth: { profile: spec.authProfile } } : {}),
      },
    },
    ...(spec.instructions ? { prompt: spec.instructions } : {}),
    interaction: { conversational: spec.conversational ?? true, mode: spec.mode ?? "subagent" },
    // A create with no permission grid gets a GOVERNED default, not OpenCode's implicit allow-all
    // (which would let a new agent edit/run shell ungoverned) — the editor can loosen it (SPEC-021).
    permission: spec.permission && Object.keys(spec.permission).length ? spec.permission : DEFAULT_AGENT_PERMISSION,
    ...(spec.tools && Object.keys(spec.tools).length ? { tools: Object.fromEntries(Object.entries(spec.tools).map(([n, t]) => [n, toolToRaw(t)])) } : {}),
  };

  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, stringifyYaml(config), "utf8");
  try {
    loadAgentImage(dir); // validate the just-written image (executor, tools, no inline secrets — NFR-1)
  } catch (err) {
    // Clean up what we created so a rejected create leaves no broken image behind.
    try {
      if (dirExisted) rmSync(configPath, { force: true });
      else rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err instanceof AgentImageError ? err : new AgentImageError(`could not create agent '${name}': ${reason(err)}`);
  }
  return dir;
}

/** Serialise a typed {@link Tool} back to its raw YAML shape (drops the Arke-internal `transport` tag). */
function toolToRaw(t: Tool): Record<string, unknown> {
  if (t.type === "mcp") {
    if (t.transport === "local") {
      return {
        type: "mcp", command: t.command,
        ...(t.args?.length ? { args: t.args } : {}),
        ...(t.environment ? { environment: t.environment } : {}),
        ...(t.tools ? { tools: t.tools } : {}),
        ...(t.enabled !== undefined ? { enabled: t.enabled } : {}),
        ...(t.description ? { description: t.description } : {}),
      };
    }
    return {
      type: "mcp", url: t.url,
      ...(t.headers ? { headers: t.headers } : {}),
      ...(t.tools ? { tools: t.tools } : {}),
      ...(t.enabled !== undefined ? { enabled: t.enabled } : {}),
      ...(t.description ? { description: t.description } : {}),
    };
  }
  if (t.type === "function") {
    return {
      type: "function",
      ...(t.callable ? { callable: t.callable } : {}),
      ...(t.runtime ? { runtime: t.runtime } : {}),
      ...(t.parameters ? { parameters: t.parameters } : {}),
      ...(t.containerImage ? { container_image: t.containerImage } : {}),
      ...(t.description ? { description: t.description } : {}),
    };
  }
  // agent sub-tool: keep the executor block and its options (out of the common editor path).
  return {
    type: "agent", executor: t.executor,
    ...(t.prompt ? { prompt: t.prompt } : {}),
    ...(t.passHistory !== undefined ? { pass_history: t.passHistory } : {}),
    ...(t.maxSessions !== undefined ? { max_sessions: t.maxSessions } : {}),
    ...(t.description ? { description: t.description } : {}),
  };
}

/**
 * Parse the Omnigent `executor` block into the typed Executor shape. Accepts the canonical wrapped
 * form (`executor.type: omnigent`, `executor.config.harness`) and the direct form
 * (`executor.harness`/`executor.model`). Rejects an inline provider key in a committed image (NFR-1):
 * credentials are referenced by `executor.config.auth.profile` and resolved host-side.
 */
function parseExecutor(raw: RawExecutor | undefined, who: string): unknown {
  if (!raw) throw new AgentImageError(`agent image '${who}' is missing an 'executor' block (harness + model)`);
  const cfg = raw.config ?? {};
  const harness = cfg.harness ?? raw.harness;
  if (!harness) throw new AgentImageError(`agent image '${who}' executor is missing a harness`);
  const model = cfg.model ?? raw.model;
  const auth = cfg.auth ?? raw.auth; // check BOTH the wrapped (config.auth) and direct (executor.auth) forms
  if (auth && (auth.api_key !== undefined || auth.apiKey !== undefined)) {
    throw new AgentImageError(
      `agent image '${who}' must not inline a provider api_key — reference a host-side auth profile instead (NFR-1)`,
    );
  }
  const options = cfg.options
    ? Object.fromEntries(Object.entries(cfg.options).map(([k, v]) => [k, String(v)]))
    : undefined;
  return {
    type: raw.type ?? "omnigent",
    ...(raw.context_window ?? raw.contextWindow ? { contextWindow: raw.context_window ?? raw.contextWindow } : {}),
    config: {
      harness,
      ...(model !== undefined ? { model: String(model) } : {}),
      ...(options ? { options } : {}),
      ...(auth
        ? {
            auth: {
              ...(auth.profile ? { profile: auth.profile } : {}),
              ...(auth.type ? { type: auth.type } : {}),
              ...(auth.base_url ?? auth.baseUrl ? { baseUrl: auth.base_url ?? auth.baseUrl } : {}),
            },
          }
        : {}),
    },
  };
}

function resolveInstructions(dir: string, instr: string | undefined): string | undefined {
  if (typeof instr === "string" && instr.endsWith(".md")) {
    const p = join(dir, instr);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }
  if (typeof instr === "string") return instr; // inline
  const agentsMd = join(dir, "AGENTS.md");
  return existsSync(agentsMd) ? readFileSync(agentsMd, "utf8") : undefined;
}

/** A value in a credential-bearing field must be a `${VAR}`/profile reference, never an inline literal. */
const CREDENTIAL_FIELD = /^(authorization|.*token.*|.*api[-_]?key.*|.*secret.*|.*password.*|.*credential.*|.*bearer.*)$/i;

/**
 * Whether a credential-field value contains an inline literal secret (NFR-1). A safe value is composed
 * ONLY of `${VAR}` interpolations, an auth-scheme keyword (Bearer/Basic/…), and separators/whitespace —
 * anything left over after stripping those is a literal. This rejects both a bare secret (`sk-live…`,
 * no var at all) AND a var mixed with a literal (`Bearer sk-live ${TOKEN}`), which a substring `${…}`
 * check would have let through, while still allowing the legitimate `Bearer ${TOKEN}` / `${U}:${P}` forms.
 */
function hasInlineLiteralSecret(v: string): boolean {
  if (typeof v !== "string" || v.trim() === "") return false; // empty is not a secret
  let residue = v.replace(/\$\{[^}]+\}/g, " "); // drop ${VAR} interpolations
  residue = residue.replace(/\b(bearer|basic|token|digest|apikey|api[-_]?key)\b/gi, " "); // drop scheme keywords
  residue = residue.replace(/[\s:;,=]+/g, ""); // drop separators + whitespace
  return residue.length > 0; // any literal residue → an inline secret
}

/** Reject an inline literal secret in a credential-named `headers`/`environment` key (NFR-1, SPEC-021). */
function assertNoInlineSecret(map: Record<string, string> | undefined, who: string, tool: string): void {
  if (!map) return;
  for (const [k, v] of Object.entries(map)) {
    if (CREDENTIAL_FIELD.test(k) && hasInlineLiteralSecret(v)) {
      throw new AgentImageError(
        `agent image '${who}' tool '${tool}' inlines a literal secret in credential field '${k}' — the value may contain only \${VAR} references (NFR-1)`,
      );
    }
  }
}

/** Parse one MCP entry into the discriminated {@link Tool}, inferring `transport` from `command` vs `url`. */
function parseMcpEntry(name: string, e: RawTool, who: string): Tool {
  const hasCommand = e.command !== undefined;
  const hasUrl = typeof e.url === "string";
  if (hasCommand === hasUrl) {
    throw new AgentImageError(`agent image '${who}' MCP tool '${name}' must have exactly one of 'command' (local) or 'url' (remote)`);
  }
  if (hasCommand) {
    // Omnigent form is `command: <exe>` + `args: [...]`; an OpenCode-style single `command: [...]`
    // array flattens to the same shape (first element is the exe, the rest are args).
    let command: string;
    let args = Array.isArray(e.args) ? e.args : undefined;
    if (Array.isArray(e.command)) { command = String(e.command[0] ?? ""); args = [...e.command.slice(1), ...(args ?? [])]; }
    else command = String(e.command);
    assertNoInlineSecret(e.environment, who, name);
    return {
      type: "mcp", transport: "local", command,
      ...(args && args.length ? { args } : {}),
      ...(e.environment ? { environment: e.environment } : {}),
      ...(Array.isArray(e.tools) ? { tools: e.tools } : {}),
      ...(typeof e.enabled === "boolean" ? { enabled: e.enabled } : {}),
      ...(e.description ? { description: e.description } : {}),
    };
  }
  assertNoInlineSecret(e.headers, who, name);
  return {
    type: "mcp", transport: "remote", url: e.url!,
    ...(e.headers ? { headers: e.headers } : {}),
    ...(Array.isArray(e.tools) ? { tools: e.tools } : {}),
    ...(typeof e.enabled === "boolean" ? { enabled: e.enabled } : {}),
    ...(e.description ? { description: e.description } : {}),
  };
}

/** Parse the Omnigent-shaped keyed `tools` map (SPEC-021). `agents` is handled via the `agents/` dir. */
function parseTools(raw: RawConfig["tools"], who: string): Tools {
  const out: Tools = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out; // keyed map only
  for (const [name, e] of Object.entries(raw)) {
    if (name === "agents" || !e || typeof e !== "object") continue; // sub-agents come from agents/<name>/
    const type = e.type
      ?? (e.command !== undefined || e.url !== undefined ? "mcp"
        : e.callable !== undefined || e.runtime !== undefined ? "function"
        : e.executor !== undefined ? "agent" : undefined);
    if (type === "mcp") out[name] = parseMcpEntry(name, e, who);
    else if (type === "function") {
      if (e.callable === undefined && e.runtime !== "client") {
        throw new AgentImageError(`agent image '${who}' function tool '${name}' needs a 'callable' (or 'runtime: client')`);
      }
      out[name] = {
        type: "function",
        ...(e.callable ? { callable: e.callable } : {}),
        ...(e.runtime === "client" ? { runtime: "client" as const } : {}),
        ...(e.parameters ? { parameters: e.parameters } : {}),
        ...(e.container_image ?? e.containerImage ? { containerImage: (e.container_image ?? e.containerImage)! } : {}),
        ...(e.description ? { description: e.description } : {}),
      };
    } else if (type === "agent") {
      if (!e.executor) throw new AgentImageError(`agent image '${who}' sub-agent tool '${name}' needs an 'executor'`);
      out[name] = {
        type: "agent",
        executor: parseExecutor(e.executor, `${who}.${name}`) as never,
        ...(e.prompt ? { prompt: e.prompt } : {}),
        ...(typeof (e.pass_history ?? e.passHistory) === "boolean" ? { passHistory: (e.pass_history ?? e.passHistory)! } : {}),
        ...(typeof (e.max_sessions ?? e.maxSessions) === "number" ? { maxSessions: (e.max_sessions ?? e.maxSessions)! } : {}),
        ...(e.description ? { description: e.description } : {}),
      };
    } else {
      throw new AgentImageError(`agent image '${who}' tool '${name}' has no recognised type (mcp / function / agent)`);
    }
  }
  return out;
}

/** Synthesise a sub-agent {@link AgentImage} candidate from an inline `type: agent` tool (SPEC-021). */
function agentToolAsSubImage(name: string, t: Extract<Tool, { type: "agent" }>): unknown {
  return {
    name,
    ...(t.description ? { description: t.description } : {}),
    executor: t.executor,
    ...(t.prompt ? { prompt: t.prompt, instructions: t.prompt } : {}),
    interaction: { conversational: true, mode: "subagent" },
    tools: {},
    skills: [],
    permission: {},
    subAgents: [],
  };
}

/** Discover tools from the `tools/` directory into keyed entries (folded UNDER declared tools). */
function discoverTools(toolsDir: string): Tools {
  if (!isDir(toolsDir)) return {};
  const out: Tools = {};
  for (const lang of ["python", "typescript"]) {
    const d = join(toolsDir, lang);
    if (isDir(d)) {
      for (const f of readdirSync(d)) {
        if (f.endsWith(".py") || f.endsWith(".ts")) out[stripExt(f)] = { type: "function" };
      }
    }
  }
  const mcp = join(toolsDir, "mcp");
  if (isDir(mcp)) {
    for (const f of readdirSync(mcp)) {
      if (!(f.endsWith(".yaml") || f.endsWith(".yml"))) continue;
      const name = stripExt(f);
      // A malformed discovered MCP file fails the image loudly, exactly like an equivalent inline
      // `tools:` entry — silently dropping it would leave the capability un-materialised with no error
      // for the author to see (SPEC-021).
      try {
        const e = (parseYaml(readFileSync(join(mcp, f), "utf8")) ?? {}) as RawTool;
        out[name] = parseMcpEntry(name, e, name);
      } catch (err) {
        if (err instanceof AgentImageError) throw err;
        throw new AgentImageError(`discovered MCP tool '${f}' is invalid: ${reason(err)}`);
      }
    }
  }
  return out;
}

function discoverSkills(skillsDir: string): SkillRef[] {
  if (!isDir(skillsDir)) return [];
  const out: SkillRef[] = [];
  for (const name of readdirSync(skillsDir)) {
    const skillMd = join(skillsDir, name, "SKILL.md");
    if (existsSync(skillMd)) out.push({ name, path: skillMd });
  }
  return out;
}

function discoverSubAgents(agentsDir: string): AgentImage[] {
  if (!isDir(agentsDir)) return [];
  const out: AgentImage[] = [];
  for (const name of readdirSync(agentsDir)) {
    const sub = join(agentsDir, name);
    if (isDir(sub) && existsSync(join(sub, "config.yaml"))) out.push(loadAgentImage(sub));
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function stripExt(f: string): string {
  const i = f.lastIndexOf(".");
  return i > 0 ? f.slice(0, i) : f;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
