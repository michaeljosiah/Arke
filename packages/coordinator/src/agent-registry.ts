import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadAgentImage } from "@arke/agent-image";
import type { AgentImage, AgentModel } from "@arke/contracts";

/**
 * The agent + provider registry (SPEC-016 revised, Omnigent-shaped).
 *
 * Agents declare their own runtime — harness + concrete model + provider auth — in their image's
 * `executor` block, so there is no logical-tier indirection. This registry indexes the project's
 * agent images (`agents/<name>/config.yaml`, recursively) and the host-side provider/auth profiles
 * (`.arke/config.json` → `providers`, endpoint + credentialsRef), and answers the two questions the
 * coordinator asks: "what model does agent X run on?" (dispatch) and "which agents/providers exist?"
 * (review-panel independence + the client roster). Credentials never leave the host.
 */

/** A host-side provider/auth profile (endpoint + credentials) referenced by `executor.config.auth.profile`. */
export interface ProviderProfile {
  harness?: string;
  host?: string;
  port?: number;
  baseUrl?: string;
  cwd?: string;
  credentialsRef?: string;
}

/** A client-safe summary of one agent (its declared model IS shown — only credentials are secret). */
export interface AgentSummary {
  name: string;
  description?: string;
  harness: string;
  /** The concrete `provider/model` the agent declares, or undefined when it uses the provider default. */
  model?: string;
  reasoningEffort?: string;
  mode: string;
  authProfile?: string;
  permission: Record<string, string>;
}

/** Split a `provider/model` string into an {@link AgentModel}; a bare name uses the gateway sentinel. */
export function parseAgentModel(model: string, options?: Record<string, string>): AgentModel {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "gateway";
  const name = slash > 0 ? model.slice(slash + 1) : model;
  return { provider, name, ...(options && Object.keys(options).length > 0 ? { options } : {}) };
}

export class AgentRegistry {
  private readonly byName = new Map<string, AgentImage>();

  constructor(
    images: AgentImage[],
    readonly providers: Record<string, ProviderProfile> = {},
  ) {
    for (const img of images) this.index(img);
  }

  private index(img: AgentImage): void {
    this.byName.set(img.name, img);
    for (const sub of img.subAgents) this.index(sub); // sub-agents are addressable too
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  image(name: string): AgentImage | undefined {
    return this.byName.get(name);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * The concrete model an agent runs on, for the dispatch (`SendMessageInput.model`). Undefined when
   * the agent is unknown or pins no model — the adapter then omits it and the harness uses the agent's
   * own materialised/default model.
   */
  modelFor(name: string): AgentModel | undefined {
    const cfg = this.byName.get(name)?.executor.config;
    if (!cfg?.model) return undefined;
    return parseAgentModel(cfg.model, cfg.options);
  }

  /** Client-safe summaries of every agent, for the roster UI. */
  list(): AgentSummary[] {
    return [...this.byName.values()].map((img) => ({
      name: img.name,
      ...(img.description ? { description: img.description } : {}),
      harness: img.executor.config.harness,
      ...(img.executor.config.model ? { model: img.executor.config.model } : {}),
      ...(img.executor.config.options?.reasoningEffort ? { reasoningEffort: img.executor.config.options.reasoningEffort } : {}),
      mode: img.interaction.mode,
      ...(img.executor.config.auth?.profile ? { authProfile: img.executor.config.auth.profile } : {}),
      permission: img.permission,
    }));
  }
}

/** Load every agent image under `<root>/agents/<name>/` into an {@link AgentRegistry}. */
export function loadAgentRegistry(root: string, providers: Record<string, ProviderProfile> = {}): AgentRegistry {
  const agentsDir = resolve(root, "agents");
  const images: AgentImage[] = [];
  try {
    for (const name of readdirSync(agentsDir)) {
      const d = resolve(agentsDir, name);
      try {
        if (statSync(d).isDirectory() && existsSync(resolve(d, "config.yaml"))) images.push(loadAgentImage(d));
      } catch {
        /* skip an unreadable/invalid agent dir rather than failing the whole project */
      }
    }
  } catch {
    /* no agents/ dir — the registry is empty; the harness uses its materialised agents */
  }
  return new AgentRegistry(images, providers);
}
