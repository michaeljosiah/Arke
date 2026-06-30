import { createHash } from "node:crypto";

/**
 * Generation workspace (SPEC-013): pure helpers for the propose→decide→execute flow. The agent
 * proposes downstream artefacts from the approved spec; the coordinator parses + validates them here
 * (side-effect-free), buffers the proposal, and writes nothing until the human approves. The spec is
 * the sole generation input — these helpers never read downstream artefacts.
 */

export type ArtifactTarget = "docs" | "tests" | "ticket" | "tracking";
export type SorTarget = "jira" | "azure-devops" | "github";

export interface ArtifactProposal {
  id: string;
  target: ArtifactTarget;
  title: string;
  content: string;
  sorTarget?: SorTarget;
  invalid?: string; // validation message when the artefact can't be approved as-is
}

export const DEFAULT_GENERATION_TIMEOUT_MS = 300_000;
export const GENERATION_PROMPT_VERSION = "v1";

/** The dispatch prompt: asks the agent for a JSON array of artefacts derived ONLY from the spec. */
export function buildGenerationPrompt(specMarkdown: string): string {
  return [
    "You are generating downstream artefacts from an approved specification.",
    "Read ONLY the specification below — do not invent or read any other source.",
    'Return a JSON array (in a ```json fence) of artefacts, each: { "target": "docs"|"tests"|"ticket"|"tracking", "title": string, "content": string, "sorTarget"?: "jira"|"azure-devops"|"github" }.',
    'A "ticket" or "tracking" artefact MUST include a "sorTarget".',
    "",
    "--- SPECIFICATION ---",
    specMarkdown,
  ].join("\n");
}

const VALID_TARGETS: ReadonlySet<string> = new Set(["docs", "tests", "ticket", "tracking"]);
const VALID_SOR: ReadonlySet<string> = new Set(["jira", "azure-devops", "github"]);

/** Extract the first JSON array from agent text (raw or ```json-fenced); [] on failure. */
function extractJsonArray(text: string): unknown[] {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fence?.[1], text].filter(Boolean) as string[];
  for (const c of candidates) {
    const start = c.indexOf("[");
    const end = c.lastIndexOf("]");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(c.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

/**
 * Parse + validate the agent's structured output into `ArtifactProposal[]`. Assigns stable ids
 * (`art-<n>`), drops entries with no usable target/title/content, and marks a ticket/tracking
 * artefact with no `sorTarget` as `invalid` (surfaced to the human, never silently skipped). Returns
 * [] when nothing parseable is found — the caller treats that as a generation error.
 */
export function parseArtifacts(text: string): ArtifactProposal[] {
  const out: ArtifactProposal[] = [];
  let n = 0;
  for (const raw of extractJsonArray(text)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const target = String(r.target ?? "");
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const content = typeof r.content === "string" ? r.content : "";
    if (!VALID_TARGETS.has(target) || !title || !content) continue;
    const sorTarget = typeof r.sorTarget === "string" && VALID_SOR.has(r.sorTarget) ? (r.sorTarget as SorTarget) : undefined;
    const item: ArtifactProposal = { id: `art-${n++}`, target: target as ArtifactTarget, title, content, ...(sorTarget ? { sorTarget } : {}) };
    if ((target === "ticket" || target === "tracking") && !sorTarget) {
      item.invalid = "Invalid — no integration target specified";
    }
    out.push(item);
  }
  return out;
}

/** SHA-256 of the spec file content (LF-normalised) — the change signal for regeneration. */
export function specContentHash(md: string): string {
  return createHash("sha256").update(md.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/**
 * Resolve the final artefacts to write for an approval decision: filter to `approvedArtifactIds`
 * (absent ⇒ all), apply `edits` (human-reviewed content overrides the buffered proposal), and refuse
 * any still-`invalid` artefact. Returns `{ artifacts, error? }`.
 */
export function resolveApproval(
  proposal: ArtifactProposal[],
  approvedArtifactIds: string[] | undefined,
  edits: Array<{ id: string; content: string }> | undefined,
): { artifacts: ArtifactProposal[]; error?: string } {
  const editMap = new Map((edits ?? []).map((e) => [e.id, e.content]));
  const selected = approvedArtifactIds ? proposal.filter((a) => approvedArtifactIds.includes(a.id)) : proposal.slice();
  const resolved = selected.map((a) => (editMap.has(a.id) ? { ...a, content: editMap.get(a.id)!, invalid: revalidate(a, editMap.get(a.id)!) } : a));
  const stillInvalid = resolved.find((a) => a.invalid);
  if (stillInvalid) return { artifacts: [], error: `artefact '${stillInvalid.id}' is invalid: ${stillInvalid.invalid}` };
  return { artifacts: resolved };
}

/** An edit can fix an invalid artefact (e.g. add a sorTarget in content) only if it had no hard gap;
 *  for ticket/tracking the sorTarget is structural, so an edited-but-still-no-sorTarget stays invalid. */
function revalidate(a: ArtifactProposal, _newContent: string): string | undefined {
  if ((a.target === "ticket" || a.target === "tracking") && !a.sorTarget) return a.invalid;
  return undefined;
}
