import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
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
    tools: { ...discoverTools(join(dir, "tools")), ...parseTools(raw.tools, raw.name ?? dir) },
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
    subAgents: discoverSubAgents(join(dir, "agents")),
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
const HAS_VAR_REF = /\$\{[^}]+\}/;

/** Reject an inline literal secret in a credential-named `headers`/`environment` key (NFR-1, SPEC-021). */
function assertNoInlineSecret(map: Record<string, string> | undefined, who: string, tool: string): void {
  if (!map) return;
  for (const [k, v] of Object.entries(map)) {
    if (CREDENTIAL_FIELD.test(k) && typeof v === "string" && v.trim() !== "" && !HAS_VAR_REF.test(v)) {
      throw new AgentImageError(
        `agent image '${who}' tool '${tool}' inlines a literal secret in credential field '${k}' — use a \${VAR} reference or a host-side profile (NFR-1)`,
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
      try {
        const e = (parseYaml(readFileSync(join(mcp, f), "utf8")) ?? {}) as RawTool;
        out[name] = parseMcpEntry(name, e, name);
      } catch {
        /* an unreadable/invalid discovered MCP file is skipped rather than failing the whole image */
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
