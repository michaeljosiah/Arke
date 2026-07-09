import { createHash } from "node:crypto";
import type { ReviewSeverity } from "@arke/contracts";
import type { AgentRegistry } from "./agent-registry.js";

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

/** The adjudication prompt is versioned alongside the source (SPEC-035); bumped when its shape changes. */
export const ADJUDICATION_PROMPT_VERSION = "v1";

/** One issue handed to the author's adjudication turn (identity + severity + who raised it). */
export interface AdjudicationIssue {
  issueId: string;
  reviewerRole: string;
  section: string;
  severity: string;
  text: string;
  agreed: boolean;
}

/**
 * Build the spec-author's adjudication prompt (SPEC-035). The author reads every reviewer issue and,
 * in ONE turn, (a) decides accept/dismiss per issue, (b) EDITS the working spec file to apply each
 * accepted issue (it is the singular writer — reviewers are read-only), and (c) ends with a fenced
 * JSON array of dispositions. `blocking` issues must be accepted-and-applied or dismissed WITH a
 * concrete reason — an unjustified blocker is not a valid disposition (enforced by the coordinator).
 */
export function buildAdjudicationPrompt(
  specText: string,
  grounding: string,
  issues: AdjudicationIssue[],
  relPath: string,
): string {
  const lines = issues.map(
    (i) =>
      `- [${i.issueId}] (${i.severity}${i.agreed ? ", concurred by ≥2 reviewers" : ""}, raised by ${i.reviewerRole}, section "${i.section}"): ${i.text}`,
  );
  return [
    "You are the specification author adjudicating an independent multi-model review of YOUR draft (SPEC-035).",
    `For every issue below, decide whether to ACCEPT it (fold the fix into the spec) or DISMISS it (reject it,`,
    "with a specific reason). This is your judgement — a reviewer can be wrong; do not accept a critique you",
    "believe is mistaken, but you must justify a dismissal.",
    "",
    `The working specification file is \`${relPath}\`. For EVERY issue you accept, EDIT that file now to`,
    "resolve it (you have write access; the reviewers did not). Apply all accepted edits before you answer.",
    "",
    "Rules:",
    '  • Every "blocking" issue MUST be either accepted-and-applied or dismissed with a concrete rationale.',
    '  • "suggestion" / "question" issues are yours to accept or dismiss at your discretion.',
    "  • Keep the specification well-formed (Requirements with SHALL/MUST statements and WHEN/THEN scenarios).",
    "",
    "When your edits are done, your reply MUST END WITH a single fenced code block containing a JSON array",
    "with one object per issue — a machine parses ONLY that block:",
    "```json",
    "[",
    '  {"issueId": "issue-abc", "action": "accept",  "rationale": "Quantified the retention window to 30 days in FR-08."},',
    '  {"issueId": "issue-def", "action": "dismiss", "rationale": "The cited contradiction does not hold — FR-10 governs a different path."}',
    "]",
    "```",
    "Every issueId below must appear exactly once. action is \"accept\" or \"dismiss\". rationale is one concrete sentence.",
    "",
    "## Issues to adjudicate",
    lines.length ? lines.join("\n") : "(none)",
    "",
    grounding ? `## Project grounding\n${grounding}\n` : "",
    "## Specification under review",
    specText,
  ].join("\n");
}

export interface ParsedDisposition {
  issueId: string;
  action: "accept" | "dismiss";
  rationale: string;
}

/**
 * Parse the author's adjudication turn into structured dispositions (SPEC-035). Mirrors
 * {@link parseReviewerIssues}: the author writes prose + edits, then ends with a fenced JSON array, so
 * this enumerates every balanced array candidate (fenced first) and keeps the one yielding the most
 * well-formed dispositions. Unparseable output yields [] (the coordinator then re-prompts / fails).
 */
export function parseDispositions(text: string): ParsedDisposition[] {
  let best: ParsedDisposition[] = [];
  for (const candidate of jsonArrayCandidates(text)) {
    let arr: unknown;
    try {
      arr = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const parsed = coerceDispositions(arr);
    if (parsed.length > best.length) best = parsed;
  }
  return best;
}

/** Keep only well-formed dispositions: a non-empty issueId, an accept|dismiss action, and a rationale. */
function coerceDispositions(arr: unknown[]): ParsedDisposition[] {
  const out: ParsedDisposition[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const issueId = typeof r.issueId === "string" ? r.issueId.trim() : "";
    const action = r.action === "accept" || r.action === "dismiss" ? r.action : undefined;
    if (!issueId || !action) continue;
    const rationale = typeof r.rationale === "string" ? r.rationale.trim() : "";
    out.push({ issueId, action, rationale });
  }
  return out;
}

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
}

export interface ResolvedReviewer {
  role: string;
  model: string; // the reviewer agent's declared `executor.config.model`
  harness: string;
  label: string; // client-safe label (harness · model)
}

export interface ReviewerValidation {
  ok: boolean;
  reason?: string;
  reviewers: ResolvedReviewer[];
}

/**
 * Enforce SPEC-007 review independence directly from the reviewer AGENTS' declared models (Omnigent
 * model): at least two reviewers, each with an agent image that pins a concrete model, and EVERY pair
 * distinct (not merely all-identical). No tiers, no registry indirection — the agent IS the model.
 */
export function validateReviewers(agents: AgentRegistry, reviewers: ReviewerConfig[]): ReviewerValidation {
  if (reviewers.length < 2) {
    return { ok: false, reason: `a review panel needs at least two reviewers (got ${reviewers.length})`, reviewers: [] };
  }
  const resolved: ResolvedReviewer[] = [];
  for (const rc of reviewers) {
    const img = agents.image(rc.role);
    if (!img) return { ok: false, reason: `reviewer '${rc.role}' has no agent image`, reviewers: [] };
    const model = img.executor.config.model;
    if (!model) return { ok: false, reason: `reviewer '${rc.role}' declares no model in its executor`, reviewers: [] };
    // A bare name or a `gateway/…` placeholder is NOT a concrete model: the adapter omits the gateway
    // provider from the dispatch, so the harness picks its own default — meaning two such reviewers
    // silently run on the SAME model. Require a provider-qualified, non-gateway model (SPEC-007).
    if (!model.includes("/") || model.startsWith("gateway/")) {
      return { ok: false, reason: `reviewer '${rc.role}' declares a non-concrete model ('${model}') — pin a provider-qualified model (e.g. github-copilot/claude-opus-4.8) so review independence is verifiable`, reviewers: [] };
    }
    const harness = img.executor.config.harness;
    resolved.push({ role: rc.role, model, harness, label: `${harness} · ${model}` });
  }
  // Pairwise distinctness: any two reviewers on the same model is a gap in independence.
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (resolved[i]!.model === resolved[j]!.model) {
        return { ok: false, reason: `reviewers '${resolved[i]!.role}' and '${resolved[j]!.role}' declare the same model (${resolved[i]!.model})`, reviewers: [] };
      }
    }
  }
  return { ok: true, reviewers: resolved };
}

/**
 * SPEC-035 adjudicator independence: the spec-author now judges critiques of its own draft, so its
 * resolved model SHOULD differ from every reviewer's. Return each reviewer whose model matches the
 * author's. A match is a WARNING, never a gate (the reviewers stay cross-model against each other, so
 * adversarial pressure survives; hard-blocking would strand panels on a thin registry). An unknown
 * author model (no image / no concrete model) yields no collision — nothing verifiable to compare.
 */
export function detectAdjudicatorCollisions(
  authorModel: string | undefined,
  reviewers: Array<{ role: string; model: string }>,
): Array<{ reviewerRole: string; model: string }> {
  if (!authorModel) return [];
  return reviewers.filter((r) => r.model === authorModel).map((r) => ({ reviewerRole: r.role, model: r.model }));
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
