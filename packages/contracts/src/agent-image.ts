import { z } from "zod";

/**
 * Portable agent image — Omnigent-shaped (SPEC-016, revised).
 *
 * A self-contained, declarative definition of an agent — its identity, prompt/instructions, its
 * **executor** (which harness runs it, and the concrete model + provider it uses), declared tools,
 * skills, permission posture, OS access, and recursive sub-agents. Parsed from an image directory
 * (`config.yaml` + `AGENTS.md` + `skills/` + `tools/` + `agents/`) and materialised per harness
 * (for OpenCode, into `.opencode/agents/<name>.md`).
 *
 * The agent declares its **model and provider directly** in `executor.config` (the Omnigent model),
 * replacing the earlier logical-tier indirection. Vendor model ids are public and live in the YAML;
 * only credentials stay host-side, referenced by `executor.config.auth.profile` (NFR-1 — an inline
 * `api_key` in a committed image is rejected by the loader).
 */

/** The runtime harness that runs an agent. `opencode-native` is Arke's wired adapter today. */
export const Harness = z.enum([
  "opencode-native",
  "claude-sdk",
  "claude-native",
  "codex",
  "codex-native",
  "cursor-native",
  "hermes-native",
  "pi",
]);
export type Harness = z.infer<typeof Harness>;

/** Provider auth for an executor: a host-side profile reference (never an inline key in an image). */
export const ExecutorAuth = z.object({
  /** References a provider/auth profile in `.arke/config.json` (endpoint + credentialsRef, host-side). */
  profile: z.string().optional(),
  /** Structure parity with Omnigent: provider | api_key | databricks | … (advisory to Arke today). */
  type: z.string().optional(),
  /** Optional endpoint override (scheme-preserving). */
  baseUrl: z.string().optional(),
});
export type ExecutorAuth = z.infer<typeof ExecutorAuth>;

/** The harness + model + provider an executor runs on (Omnigent `executor.config`). */
export const ExecutorConfig = z.object({
  harness: Harness,
  /** Concrete `provider/model` (or bare model). Omit to use the provider's default model. */
  model: z.string().optional(),
  /** Model options passed to the harness, e.g. `{ reasoningEffort: "xhigh" }`. */
  options: z.record(z.string(), z.string()).optional(),
  auth: ExecutorAuth.optional(),
});
export type ExecutorConfig = z.infer<typeof ExecutorConfig>;

/** The Omnigent `executor` block. `type: omnigent` is the seam for delegating to Omnigent later. */
export const Executor = z.object({
  type: z.literal("omnigent").default("omnigent"),
  contextWindow: z.number().optional(),
  config: ExecutorConfig,
});
export type Executor = z.infer<typeof Executor>;

/**
 * A tool an agent may use (SPEC-021, Omnigent-shaped) — a keyed `tools` map, not an array. One entry
 * is an MCP server, a local function tool, or a sub-agent tool.
 */

/**
 * An MCP server tool — a **discriminated union** on `transport` (the loader infers it from `command`
 * vs `url`, so `command` XOR `url` is a type invariant, not a runtime check). Credential-bearing
 * fields carry a `${VAR}` reference resolved by the harness at spawn, never an inline literal (NFR-1).
 */
export const McpTool = z.discriminatedUnion("transport", [
  z.object({
    type: z.literal("mcp"),
    transport: z.literal("local"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    environment: z.record(z.string(), z.string()).optional(),
    tools: z.array(z.string()).optional(), // exposed-tool whitelist
    enabled: z.boolean().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("mcp"),
    transport: z.literal("remote"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    tools: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    description: z.string().optional(),
  }),
]);
export type McpTool = z.infer<typeof McpTool>;

/** A local code/function tool. A `callable` unless `runtime: client` (the orchestrator supplies it). */
export const FunctionTool = z.object({
  type: z.literal("function"),
  callable: z.string().optional(),
  runtime: z.literal("client").optional(),
  parameters: z.record(z.string(), z.unknown()).optional(), // JSON Schema
  containerImage: z.string().optional(),
  description: z.string().optional(),
});
export type FunctionTool = z.infer<typeof FunctionTool>;

/** A sub-agent tool — declares its own executor. The canonical sub-agent source is the `agents/` dir. */
export const AgentTool = z.object({
  type: z.literal("agent"),
  executor: z.lazy(() => Executor),
  prompt: z.string().optional(),
  osEnv: z.union([z.literal("inherit"), z.lazy(() => OsEnv)]).optional(),
  passHistory: z.boolean().optional(),
  maxSessions: z.number().optional(),
  description: z.string().optional(),
});
export type AgentTool = z.infer<typeof AgentTool>;

/** One entry in the `tools` map. */
export const Tool = z.union([McpTool, FunctionTool, AgentTool]);
export type Tool = z.infer<typeof Tool>;

/** The keyed `tools` map on an agent image (name → tool). Replaces the old `ToolDecl[]` array. */
export const Tools = z.record(z.string(), Tool);
export type Tools = z.infer<typeof Tools>;

export const SkillRef = z.object({
  name: z.string(),
  path: z.string().optional(),
});
export type SkillRef = z.infer<typeof SkillRef>;

/** The harness permission posture an image carries through to the materialised agent. */
export const AgentPermission = z.enum(["allow", "ask", "deny"]);
export type AgentPermission = z.infer<typeof AgentPermission>;

export const AgentInteraction = z.object({
  /** Maintain history across turns (default true). */
  conversational: z.boolean().default(true),
  mode: z.enum(["primary", "subagent", "all"]).default("primary"),
});
export type AgentInteraction = z.infer<typeof AgentInteraction>;

/** OS/filesystem access + sandbox (Omnigent `os_env`). Advisory to Arke today; carried for parity. */
export const OsEnv = z.object({
  type: z.string().default("caller_process"),
  cwd: z.string().optional(),
  sandbox: z.object({ type: z.enum(["none", "linux_bwrap", "darwin_seatbelt"]).default("none") }).optional(),
});
export type OsEnv = z.infer<typeof OsEnv>;

// Recursive schema (sub-agents) needs an explicit type + getter.
export interface AgentImage {
  name: string;
  description?: string;
  /** The harness + concrete model + provider this agent runs on (Omnigent `executor`). */
  executor: Executor;
  /** Inline system prompt (Omnigent `prompt`). */
  prompt?: string;
  /** Instruction body from a file (AGENTS.md) or inline; complements/overrides `prompt`. */
  instructions?: string;
  interaction: AgentInteraction;
  /** Keyed tools map (SPEC-021): name → MCP server / function tool / sub-agent tool. */
  tools: Tools;
  skills: SkillRef[];
  /** Per-capability permission posture (edit/bash/webfetch…) carried to the harness. */
  permission: Record<string, AgentPermission>;
  /** OS/filesystem access + sandbox (Omnigent `os_env`). */
  osEnv?: OsEnv;
  /** May spawn child sessions/agents (Omnigent `spawn`). */
  spawn?: boolean;
  subAgents: AgentImage[];
}

export const AgentImage: z.ZodType<AgentImage, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    name: z.string(),
    description: z.string().optional(),
    executor: Executor,
    prompt: z.string().optional(),
    instructions: z.string().optional(),
    interaction: AgentInteraction,
    tools: Tools.default({}),
    skills: z.array(SkillRef).default([]),
    permission: z.record(z.string(), AgentPermission).default({}),
    osEnv: OsEnv.optional(),
    spawn: z.boolean().optional(),
    subAgents: z.array(AgentImage).default([]),
  }),
  // The lazy ZodObject (with `.default()`ed fields) infers an input/output shape that does not
  // structurally unify with the AgentImage interface under every inference order; the cast pins it
  // to the declared recursive type. Runtime behaviour is unchanged — this is a types-only assertion.
) as unknown as z.ZodType<AgentImage, z.ZodTypeDef, unknown>;
