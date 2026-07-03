import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { AgentImage, type SkillRef, type ToolDecl } from "@arke/contracts";

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

interface RawExecutor {
  type?: string;
  context_window?: number;
  contextWindow?: number;
  harness?: string; // direct (unwrapped) Omnigent form
  model?: unknown;
  config?: {
    harness?: string;
    model?: unknown;
    options?: Record<string, unknown>;
    auth?: { profile?: string; type?: string; base_url?: string; baseUrl?: string; api_key?: unknown; apiKey?: unknown };
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
  tools?: Array<{ name?: string; kind?: string; description?: string }>;
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
    tools: [...declaredTools(raw.tools), ...discoverTools(join(dir, "tools"))],
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
    doc.deleteIn(["executor", "config", "options", "reasoningEffort"]);
    // Drop an options map that is now empty, so we don't leave a bare `options:` key behind.
    const options = doc.getIn(["executor", "config", "options"]) as { items?: unknown[] } | undefined;
    if (options && Array.isArray(options.items) && options.items.length === 0) {
      doc.deleteIn(["executor", "config", "options"]);
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
  const auth = cfg.auth;
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

function declaredTools(tools: RawConfig["tools"]): ToolDecl[] {
  if (!Array.isArray(tools)) return [];
  const out: ToolDecl[] = [];
  for (const t of tools) {
    if (!t?.name) continue;
    const kind = t.kind === "mcp" || t.kind === "agent" ? t.kind : "function";
    out.push({ name: t.name, kind, ...(t.description ? { description: t.description } : {}) });
  }
  return out;
}

function discoverTools(toolsDir: string): ToolDecl[] {
  if (!isDir(toolsDir)) return [];
  const out: ToolDecl[] = [];
  for (const lang of ["python", "typescript"]) {
    const d = join(toolsDir, lang);
    if (isDir(d)) {
      for (const f of readdirSync(d)) {
        if (f.endsWith(".py") || f.endsWith(".ts")) out.push({ name: stripExt(f), kind: "function" });
      }
    }
  }
  const mcp = join(toolsDir, "mcp");
  if (isDir(mcp)) {
    for (const f of readdirSync(mcp)) {
      if (f.endsWith(".yaml") || f.endsWith(".yml")) out.push({ name: stripExt(f), kind: "mcp" });
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
