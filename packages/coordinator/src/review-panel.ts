import { createHash } from "node:crypto";
import type { ReviewSeverity } from "@arke/contracts";
import type { RegistryResolver } from "./registry.js";

/**
 * Pure helpers for the multi-model review panel (SPEC-007): reviewer-model validation (pairwise
 * distinctness + registry sufficiency), the versioned issue-extraction prompt, parsing reviewer
 * output into structured issues, section hashing (for stale-file detection + agreement), and
 * cross-reviewer agreement detection. Kept side-effect-free so the panel manager in ProjectContext
 * stays thin and these are unit-testable.
 */

/** The issue-extraction prompt is versioned alongside the source; bumped when its shape changes. */
export const ISSUE_EXTRACTION_PROMPT_VERSION = "v2";

/**
 * Build the reviewer prompt. Reviewers are agentic personas that naturally explore the repo and
 * write prose analysis, so demanding "ONLY JSON, no prose" (v1) failed in practice — the critique
 * arrived as prose and parsed to zero issues. v2 instead PERMITS the analysis and requires the reply
 * to END WITH a single fenced ```json block, backed by a worked example and a "machine-parsed —
 * missing block means your review is discarded" contract, which agentic models comply with reliably.
 */
export function buildReviewerPrompt(specText: string, grounding: string): string {
  return [
    "You are an independent specification reviewer (SPEC-007). Critique the specification below for",
    "correctness, completeness, ambiguity, and testability. You MAY read project files first to ground",
    "your critique in the actual repository.",
    "",
    "When your analysis is complete, your reply MUST END WITH a single fenced code block containing a",
    "JSON array of the issues you found. A machine parses ONLY that block; any prose before it is",
    "ignored, and if the block is missing your review is discarded and does not count.",
    "",
    'Each issue is an object: {"section": string, "severity": "blocking"|"suggestion"|"question", "text": string}',
    '  • section  — the spec section the issue concerns, e.g. "Requirements > FR-08" or "Design > Data model".',
    '  • severity — "blocking" (must fix before approval), "suggestion" (improvement), or "question" (needs clarification).',
    "  • text     — one concrete, actionable issue. Be specific; quote the requirement id where you can.",
    "If, after a genuine review, you find no issues, end with an empty array: []",
    "",
    "Your reply must end with exactly this shape (values illustrative):",
    "```json",
    "[",
    '  {"section": "Requirements > FR-08", "severity": "blocking", "text": "Spread timing contradicts FR-10 because ..."},',
    '  {"section": "Design > Data model", "severity": "suggestion", "text": "The cell-state enum omits the telegraphed pre-spread state used by FR-08."}',
    "]",
    "```",
    "",
    grounding ? `## Project grounding\n${grounding}\n` : "",
    "## Specification under review",
    specText,
  ].join("\n");
}

export interface ParsedIssue {
  section: string;
  severity: ReviewSeverity;
  text: string;
}

const SEVERITIES = new Set(["blocking", "suggestion", "question"]);

/**
 * Parse a reviewer's output into structured issues. Reviewers write prose analysis and end with a
 * fenced JSON array (see {@link buildReviewerPrompt}), so this must find the REAL issues array amid
 * prose littered with stray brackets (`[STRETCH]`, `[FR-01]`, markdown links). The old approach —
 * `text.indexOf("[")`…`lastIndexOf("]")` — swallowed the whole span between the first and last
 * bracket and failed to parse, silently yielding zero issues on a rich review. Instead we enumerate
 * every *balanced* array candidate (fenced blocks first) and keep the one that yields the most
 * well-formed issues. Unparseable output still yields [].
 */
export function parseReviewerIssues(text: string): ParsedIssue[] {
  let best: ParsedIssue[] = [];
  for (const candidate of jsonArrayCandidates(text)) {
    let arr: unknown;
    try {
      arr = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const parsed = coerceIssues(arr);
    // Prefer the candidate yielding the most well-formed issues; ties keep the earlier (fenced) one.
    if (parsed.length > best.length) best = parsed;
  }
  return best;
}

/** Keep only well-formed issue objects; default a missing section to "general" and normalise severity. */
function coerceIssues(arr: unknown[]): ParsedIssue[] {
  const out: ParsedIssue[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const txt = typeof r.text === "string" ? r.text.trim() : "";
    if (!txt) continue; // an issue with no text is not actionable
    // A missing/blank section is no longer a reason to DROP the issue — an unsectioned critique is
    // still a real finding; anchor it to "general" so agreement/adjudication still work.
    const section = typeof r.section === "string" && r.section.trim() ? r.section.trim() : "general";
    const severity = (typeof r.severity === "string" && SEVERITIES.has(r.severity) ? r.severity : "suggestion") as ReviewSeverity;
    out.push({ section, severity, text: txt });
  }
  return out;
}

/**
 * Yield plausible JSON-array candidates from reviewer output, best-first: arrays inside ```json
 * fences (last fence first — the reviewer's final block), then any balanced top-level `[...]` span.
 */
function* jsonArrayCandidates(text: string): Generator<string> {
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  const fenced: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    for (const arr of balancedArrays(m[1]!)) fenced.push(arr);
  }
  for (let i = fenced.length - 1; i >= 0; i--) yield fenced[i]!; // last fence is the intended output
  yield* balancedArrays(text); // fall back to bare arrays anywhere in the prose
}

/** Yield every balanced top-level `[...]` span, honouring quoted strings so brackets in text don't miscount. */
function* balancedArrays(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          i = j; // resume past this array; nested arrays are captured when JSON.parse sees the parent
          break;
        }
      }
    }
  }
}

/** A short, stable content hash for a section's text — for stale-file detection + agreement. */
export function sectionHashOf(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex").slice(0, 16);
}

export interface ReviewerConfig {
  role: string;
  instanceId?: string;
}

export interface ResolvedReviewer {
  role: string;
  instanceId: string;
  model: string; // concrete model string (host-only; never sent to the client)
  label: string; // client-safe tier label
}

export interface ReviewerValidation {
  ok: boolean;
  reason?: string;
  reviewers: ResolvedReviewer[];
}

/**
 * Resolve every reviewer to a concrete model and enforce SPEC-007's constraints: at least two
 * reviewers, EVERY pair distinct (not merely all-identical), and the registry must supply enough
 * distinct capable models for the requested reviewer count.
 */
export function validateReviewers(resolver: RegistryResolver, reviewers: ReviewerConfig[]): ReviewerValidation {
  if (reviewers.length < 2) {
    return { ok: false, reason: `a review panel needs at least two reviewers (got ${reviewers.length})`, reviewers: [] };
  }
  const resolved: ResolvedReviewer[] = [];
  for (const rc of reviewers) {
    try {
      let model: string | undefined;
      let instanceId: string | undefined;
      if (rc.instanceId) {
        // Pinned override: take the instance's capable model directly.
        const inst = resolver.instance(rc.instanceId);
        if (!inst) return { ok: false, reason: `reviewer '${rc.role}' pins unknown instance '${rc.instanceId}'`, reviewers: [] };
        model = inst.serves.find((s) => s.tier === "capable")?.model;
        instanceId = rc.instanceId;
        if (!model) return { ok: false, reason: `instance '${rc.instanceId}' serves no capable model for reviewer '${rc.role}'`, reviewers: [] };
      } else {
        const sel = resolver.resolve(rc.role);
        model = sel.model;
        instanceId = sel.instanceId;
      }
      const driver = resolver.instance(instanceId)?.driver ?? "unknown";
      resolved.push({ role: rc.role, instanceId, model, label: `capable — ${driver}` });
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err), reviewers: [] };
    }
  }
  // Pairwise distinctness: any two reviewers on the same model is a gap in independence.
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (resolved[i]!.model === resolved[j]!.model) {
        return { ok: false, reason: `reviewers '${resolved[i]!.role}' and '${resolved[j]!.role}' resolve to the same model`, reviewers: [] };
      }
    }
  }
  // Registry sufficiency: enough distinct capable models to satisfy the reviewer count.
  const distinctCapable = new Set<string>();
  for (const inst of resolver.instances()) {
    const m = inst.serves.find((s) => s.tier === "capable")?.model;
    if (m) distinctCapable.add(m);
  }
  if (distinctCapable.size < reviewers.length) {
    return { ok: false, reason: `insufficient distinct capable models: need ${reviewers.length}, have ${distinctCapable.size}`, reviewers: [] };
  }
  return { ok: true, reviewers: resolved };
}

export interface AgreementGroup {
  section: string;
  sectionHash: string;
  issueIds: string[];
}

/**
 * Detect agreement: issues sharing a section hash raised by two or more DISTINCT reviewers. Matching
 * by content hash (not section key alone) so only concerns about the same actual text are grouped.
 */
export function detectAgreement(
  issues: Array<{ issueId: string; reviewerRole: string; section: string; sectionHash: string }>,
): AgreementGroup[] {
  const byHash = new Map<string, { section: string; entries: Array<{ issueId: string; reviewerRole: string }> }>();
  for (const i of issues) {
    let g = byHash.get(i.sectionHash);
    if (!g) {
      g = { section: i.section, entries: [] };
      byHash.set(i.sectionHash, g);
    }
    g.entries.push({ issueId: i.issueId, reviewerRole: i.reviewerRole });
  }
  const groups: AgreementGroup[] = [];
  for (const [sectionHash, g] of byHash) {
    const roles = new Set(g.entries.map((e) => e.reviewerRole));
    if (roles.size >= 2) {
      groups.push({ section: g.section, sectionHash, issueIds: g.entries.map((e) => e.issueId) });
    }
  }
  return groups;
}
