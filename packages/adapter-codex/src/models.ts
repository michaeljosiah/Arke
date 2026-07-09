import type { ModelInfo } from "@arke/contracts";

/**
 * The Codex model catalog is CONFIG-DRIVEN, not queried (SPEC-034 Decision #3). Codex exposes no
 * model-enumeration API — OpenAI closed that request (github.com/openai/codex#8871) — so `listModels`
 * serves a known/configured list rather than a live query. This default set tracks the current Codex
 * `gpt-5.*` family; a project may override it via {@link CodexConfig.models}. All are the `openai` provider.
 */
export const CODEX_KNOWN_MODELS: readonly string[] = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
];

/** Project the (configured or default) Codex model list into the adapter's {@link ModelInfo} catalog. */
export function codexModelCatalog(models?: string[]): ModelInfo[] {
  const ids = models && models.length > 0 ? models : CODEX_KNOWN_MODELS;
  return ids.map((id) => ({ id, provider: "openai" }));
}
