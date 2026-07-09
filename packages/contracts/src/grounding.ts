import { parseFrontmatter } from "./spec-doc.js";

/**
 * Pure assembly + rendering of the typed grounding digest (SPEC-027). Grounding is a **read-only
 * injection layer** over the OKF `docs/` tree (SPEC-026): foundational product/business/domain context
 * is authored as typed OKF documents anywhere under `docs/` and selected **by `type`, not by folder**.
 * These helpers are pure — the coordinator does the filesystem I/O (walk `docs/`, read the spec index,
 * list `.arke/grounding/`) and feeds the parsed inputs here; everything below is a total function of its
 * inputs, so it is deterministic and unit-testable.
 *
 * The digest has three clearly-labelled parts (Requirement: "precisely-specified typed grounding digest"):
 *   (a) business grounding — the grounding-typed `docs/` documents (foundational context to be consistent with);
 *   (b) spec-index digest — the existing spec corpus (avoid duplicating/contradicting; cross-link);
 *   (c) session uploads — the `.arke/grounding/` local tier, by EXPLICIT path (search can't reach a git-ignored dot-dir).
 * A per-document summary budget and a total digest budget keep the injected text bounded as the corpus grows.
 */

// ---- the grounding type vocabulary ------------------------------------------------------------

/**
 * The `type:` values that mark a `docs/` document as foundational grounding (SPEC-027, aligned with
 * SPEC-026's open vocabulary). Selection is on the document's EXPLICIT frontmatter `type` — a doc with
 * no `type` is NOT grounding. (SPEC-026 *derives* `type: convention` for legacy untyped docs so its
 * index can list them; deliberately NOT applied here, else every untyped doc under `docs/` — decisions,
 * design notes — would be swept into grounding and the digest would be neither bounded nor foundational.)
 */
export const GROUNDING_TYPES = [
  "product-overview",
  "business-context",
  "domain-glossary",
  "architecture",
  "convention",
] as const;
export type GroundingType = (typeof GROUNDING_TYPES)[number];

const GROUNDING_TYPE_SET = new Set<string>(GROUNDING_TYPES);

/** True when a frontmatter `type:` value is one of the grounding types (explicit match, not derived). */
export function isGroundingType(type: string | undefined | null): type is GroundingType {
  return typeof type === "string" && GROUNDING_TYPE_SET.has(type);
}

// ---- digest shapes ----------------------------------------------------------------------------

/** A single grounding document: its type, title, repo-relative path, and a bounded summary. */
export interface GroundingDoc {
  type: string;
  title: string;
  /** Repo-relative POSIX path, e.g. `docs/product-overview.md`. */
  path: string;
  /** First non-empty markdown paragraph after the frontmatter, truncated to the summary budget. */
  summary: string;
}

/** One row of the spec-index digest (part b) — the compact, high-signal projection reviewers/authors see. */
export interface GroundingSpecEntry {
  /** The `NNN` prefix, e.g. `"026"`. */
  number: string;
  title: string;
  status: string;
  capabilities: string[];
  /** Repo-relative POSIX path, e.g. `docs/specifications/026.okf-bundle-indexes.md`. */
  path: string;
}

/** The three-part typed grounding digest. Both injection sites (review + authoring) render this. */
export interface GroundingDigest {
  /** (a) grounding-typed `docs/` documents — foundational context the spec must be consistent with. */
  businessGrounding: GroundingDoc[];
  /** (b) the existing spec corpus — to avoid duplicating/contradicting and to cross-link. */
  specIndex: GroundingSpecEntry[];
  /** (c) `.arke/grounding/` local uploads — source material for this discussion, referenced by explicit path. */
  sessionUploads: { path: string }[];
}

// ---- per-document parsing (pure over path + text) ---------------------------------------------

export const DEFAULT_SUMMARY_BUDGET = 500;
export const DEFAULT_DIGEST_BUDGET = 12000;

export interface GroundingDocOptions {
  /** Max characters of the per-document summary (default {@link DEFAULT_SUMMARY_BUDGET}). */
  summaryBudget?: number;
}

/**
 * Build a {@link GroundingDoc} from a `docs/` document's repo-relative path + text, or `null` when it is
 * not grounding (its explicit `type:` is not a grounding type). The title is the frontmatter `title`,
 * else the first `# H1`, else the filename; the summary is the first meaningful paragraph, truncated.
 */
export function groundingDocFromFile(path: string, text: string, opts: GroundingDocOptions = {}): GroundingDoc | null {
  const { data, body } = parseFrontmatter(text);
  if (!isGroundingType(data.type)) return null;
  const title = (data.title ?? firstH1(body) ?? baseName(path)).trim();
  const summary = truncate(firstMeaningfulParagraph(body), opts.summaryBudget ?? DEFAULT_SUMMARY_BUDGET);
  return { type: data.type, title, path, summary };
}

/** First non-empty paragraph after the frontmatter, skipping headings, HTML comments, and blockquotes. */
export function firstMeaningfulParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || t.startsWith("#") || t.startsWith("<!--") || t.startsWith(">")) continue;
    return t.replace(/\s+/g, " ");
  }
  return "";
}

function firstH1(body: string): string | undefined {
  return /^#\s+(.+?)\s*$/m.exec(body)?.[1];
}

function baseName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
}

/** Truncate to a character budget, appending an ellipsis when it actually cuts (never mid-nothing). */
function truncate(s: string, budget: number): string {
  if (budget <= 0 || s.length <= budget) return s;
  return s.slice(0, Math.max(0, budget - 1)).trimEnd() + "…";
}

// ---- rendering (pure over the digest) ---------------------------------------------------------

export interface RenderGroundingOptions {
  /** Total character budget for the whole digest text (default {@link DEFAULT_DIGEST_BUDGET}). */
  totalBudget?: number;
}

/**
 * Render the digest into the three clearly-labelled sections injected at both sites. Empty parts are
 * omitted; when all three are empty the result is `""` (callers suppress the surrounding heading). The
 * total budget bounds the growing parts (a business grounding, then b the spec corpus); session uploads
 * (c) are rendered in full first — they are few, session-specific, and MUST stay reachable by explicit
 * path — and the remainder feeds a then b, each dropping trailing entries with an omitted-count note.
 */
export function renderGroundingDigest(digest: GroundingDigest, opts: RenderGroundingOptions = {}): string {
  const budget = opts.totalBudget ?? DEFAULT_DIGEST_BUDGET;

  // (c) uploads — rendered whole, first, so their cost is reserved before a/b consume the remainder.
  const uploadLines = digest.sessionUploads.map((u) => `- \`${u.path}\``);
  const remainingAfterC = Math.max(0, budget - joinedLength(uploadLines));

  // (a) business grounding — foundational; gets first claim on the remaining budget.
  const aEntries = digest.businessGrounding.map(
    (d) => `- **${d.type}** — ${d.title} (\`${d.path}\`)${d.summary ? `\n  ${d.summary}` : ""}`,
  );
  const aFit = fit(aEntries, remainingAfterC);

  // (b) spec-index digest — compact one-liners; fills whatever budget business grounding left.
  const bEntries = digest.specIndex.map(
    (e) =>
      `- **${e.number}** ${e.title} — ${e.status || "(no status)"}` +
      `${e.capabilities.length ? ` · ${e.capabilities.join(", ")}` : ""} (\`${e.path}\`)`,
  );
  const bFit = fit(bEntries, Math.max(0, remainingAfterC - aFit.used));

  const sections: string[] = [];
  if (aFit.kept.length > 0) {
    sections.push(
      section(
        "### Business grounding — foundational product/business/domain context this specification MUST be consistent with",
        aFit.kept,
        aFit.omitted,
        "grounding document",
      ),
    );
  }
  if (bFit.kept.length > 0) {
    sections.push(
      section(
        "### Existing specification corpus — do not duplicate or contradict these; cross-link where related",
        bFit.kept,
        bFit.omitted,
        "specification",
      ),
    );
  }
  if (uploadLines.length > 0) {
    sections.push(
      section(
        "### Session uploads — source material for THIS discussion; read them at these exact paths (they will not appear in file searches)",
        uploadLines,
        0,
        "upload",
      ),
    );
  }
  return sections.join("\n\n");
}

/** One rendered section: heading, its kept entry lines, and a note for any budget-omitted tail. */
function section(heading: string, kept: string[], omitted: number, noun: string): string {
  const lines = [heading, "", ...kept];
  if (omitted > 0) lines.push(`- _(${omitted} more ${noun}${omitted === 1 ? "" : "s"} omitted to stay within the grounding budget)_`);
  return lines.join("\n");
}

/** Greedily keep entries while they fit the remaining budget; report how many were dropped + chars used. */
function fit(entries: string[], remaining: number): { kept: string[]; omitted: number; used: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < entries.length; i++) {
    const cost = entries[i]!.length + 1; // +1 for the joining newline
    // Always keep the first entry (an empty section is worse than one slightly-over-budget row — and a
    // single row is bounded, since each summary is pre-truncated to the per-document budget).
    if (used + cost > remaining && kept.length > 0) {
      return { kept, omitted: entries.length - i, used };
    }
    kept.push(entries[i]!);
    used += cost;
  }
  return { kept, omitted: 0, used };
}

function joinedLength(lines: string[]): number {
  return lines.length === 0 ? 0 : lines.join("\n").length;
}
