import { z } from "zod";
import { ModelTier } from "./spec.js";

/**
 * Portable agent image (SPEC-016).
 *
 * A self-contained, harness-agnostic definition of an agent — its identity, instructions,
 * logical model tier, declared tools, skills, and recursive sub-agents. Parsed from an image
 * directory (`config.yaml` + `AGENTS.md` + `skills/` + `tools/` + `agents/`) and materialised
 * per harness (for OpenCode, into `.opencode/agents/<name>.md`). It references a **logical tier**,
 * never a vendor model id — resolution stays in the registry (FR-4, SPEC-005).
 */

/** A declared tool the agent may use. `kind` distinguishes local code, an MCP server, or a sub-agent. */
export const ToolDecl = z.object({
  name: z.string(),
  kind: z.enum(["function", "mcp", "agent"]),
  description: z.string().optional(),
});
export type ToolDecl = z.infer<typeof ToolDecl>;

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

// Recursive schema (sub-agents) needs an explicit type + getter.
export interface AgentImage {
  name: string;
  description?: string;
  /** Logical tier — resolved to a concrete model by the registry, never hard-coded here. */
  tier: ModelTier;
  /** Instruction body (from AGENTS.md or inline). */
  instructions?: string;
  interaction: AgentInteraction;
  tools: ToolDecl[];
  skills: SkillRef[];
  /** Per-capability permission posture (edit/bash/webfetch…) carried to the harness. */
  permission: Record<string, AgentPermission>;
  subAgents: AgentImage[];
}

export const AgentImage: z.ZodType<AgentImage, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    name: z.string(),
    description: z.string().optional(),
    tier: ModelTier,
    instructions: z.string().optional(),
    interaction: AgentInteraction,
    tools: z.array(ToolDecl).default([]),
    skills: z.array(SkillRef).default([]),
    permission: z.record(z.string(), AgentPermission).default({}),
    subAgents: z.array(AgentImage).default([]),
  }),
  // The lazy ZodObject (with `.default()`ed fields) infers an input/output shape that does not
  // structurally unify with the AgentImage interface under every inference order; the cast pins it
  // to the declared recursive type. Runtime behaviour is unchanged — this is a types-only assertion.
) as unknown as z.ZodType<AgentImage, z.ZodTypeDef, unknown>;
