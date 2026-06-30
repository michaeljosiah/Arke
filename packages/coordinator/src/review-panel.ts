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
export const ISSUE_EXTRACTION_PROMPT_VERSION = "v1";

/** Build the reviewer prompt: critique the spec, output issues as a strict JSON array. */
export function buildReviewerPrompt(specText: string, grounding: string): string {
  return [
    "You are an independent specification reviewer. Critique the specification below for correctness,",
    "completeness, ambiguity, and testability. Ground your critique in the project context.",
    "",
    "Return ONLY a JSON array of issues, each: {\"section\": string, \"severity\": \"blocking\"|\"suggestion\"|\"question\", \"text\": string}.",
    "`section` is the spec section the issue concerns (e.g. \"requirements > Requirement: <name>\"). No prose outside the JSON.",
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
 * Parse a reviewer's output into structured issues. Tolerant: extracts the first JSON array (raw or
 * inside a ```json fence) and keeps only well-formed entries; anything unparseable yields [].
 */
export function parseReviewerIssues(text: string): ParsedIssue[] {
  const json = extractJsonArray(text);
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ParsedIssue[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const section = typeof r.section === "string" ? r.section.trim() : "";
    const txt = typeof r.text === "string" ? r.text.trim() : "";
    if (!section || !txt) continue;
    const severity = (typeof r.severity === "string" && SEVERITIES.has(r.severity) ? r.severity : "suggestion") as ReviewSeverity;
    out.push({ section, severity, text: txt });
  }
  return out;
}

/** Find the first top-level JSON array in a blob (handles ```json fences and surrounding prose). */
function extractJsonArray(text: string): string | null {
  const fence = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text);
  if (fence) return fence[1]!;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
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
