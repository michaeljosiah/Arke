import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentImage, type SkillRef, type ToolDecl } from "@arke/contracts";

/**
 * Loads a portable agent image directory into a typed {@link AgentImage} (SPEC-016).
 *
 * Layout: `config.yaml` (required) + optional `AGENTS.md` (instructions), `skills/<name>/SKILL.md`,
 * `tools/{mcp,python,typescript}/…`, and recursive `agents/<name>/`. An image references a
 * **logical tier** (`capable`/`mid`), never a vendor model id; a model id is a hard error. Loading
 * is all-or-nothing: any problem throws {@link AgentImageError} and nothing is partially returned.
 */
export class AgentImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentImageError";
  }
}

interface RawConfig {
  spec_version?: number;
  name?: string;
  description?: string;
  tier?: string;
  instructions?: string;
  model?: unknown;
  llm?: { model?: unknown };
  interaction?: { conversational?: boolean; mode?: string };
  permission?: Record<string, string>;
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

  // A vendor model id never belongs in an image — resolution stays in the registry (FR-4).
  if (raw.model !== undefined || raw.llm?.model !== undefined) {
    throw new AgentImageError(
      `agent image '${raw.name ?? dir}' must reference a logical tier, not a vendor model id`,
    );
  }

  const candidate = {
    name: raw.name,
    description: raw.description,
    tier: raw.tier,
    instructions: resolveInstructions(dir, raw.instructions),
    interaction: {
      conversational: raw.interaction?.conversational ?? true,
      mode: raw.interaction?.mode ?? "primary",
    },
    tools: [...declaredTools(raw.tools), ...discoverTools(join(dir, "tools"))],
    skills: discoverSkills(join(dir, "skills")),
    permission: raw.permission ?? {},
    subAgents: discoverSubAgents(join(dir, "agents")),
  };

  const result = AgentImage.safeParse(candidate);
  if (!result.success) {
    throw new AgentImageError(`invalid agent image '${raw.name ?? dir}': ${result.error.message}`);
  }
  return result.data;
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
