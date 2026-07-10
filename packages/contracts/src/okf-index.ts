import { parseFrontmatter, detectSpecFormat, specFormatOf, stripTags } from "./spec-doc.js";

/**
 * Pure generation of a bundle's `index.md` (SPEC-026). A `docs/` bundle's index is a **deterministic
 * projection** of its documents' frontmatter — never hand- or agent-authored. These helpers are pure:
 * they take a bundle's files (name + text) and return the `index.md` text. The coordinator does the
 * filesystem I/O (scan the folder, write the file) and the change-detection; everything here is a total
 * function of its inputs, so regeneration is idempotent (same inputs → byte-identical output) and unit-
 * testable. Two renderers: {@link renderSpecIndex} (the rich `docs/specifications/` table) and
 * {@link renderBundleIndex} (the generic OKF table for every other bundle).
 *
 * Determinism rules that keep a no-op regeneration diff-free:
 * - stable order (specs by `NNN` then filename; generic by title then filename);
 * - NO wall-clock timestamp — any date is derived purely from indexed content (max spec `updated:`);
 * - `\n` line endings only (the coordinator pins `docs/** /index.md` to LF via `.gitattributes`).
 */

// ---- entry shapes (discriminated so an unparsed row needs no invented data) -------------------

export interface SpecIndexEntryParsed {
  parseState: "ok";
  /** The `NNN` prefix, e.g. "026". */
  number: string;
  specId: string;
  title: string;
  /** Raw frontmatter `status:` (kept as a string; not enum-validated, for tolerance). */
  status: string;
  capabilities: string[];
  /** Frontmatter `updated:` if present — used only to derive the index's content date. */
  updated?: string;
  /** Relative path within the bundle (the link target), e.g. "026.okf-bundle-indexes.md". */
  path: string;
}
export interface IndexEntryUnparsed {
  parseState: "unparsed";
  filename: string;
  path: string;
  error: string;
  /** The `NNN` prefix when derivable from the filename (specs only). */
  number?: string;
}
export type SpecIndexEntry = SpecIndexEntryParsed | IndexEntryUnparsed;

export interface BundleIndexEntryParsed {
  parseState: "ok";
  type: string;
  title: string;
  description?: string;
  path: string;
}
export type BundleIndexEntry = BundleIndexEntryParsed | IndexEntryUnparsed;

const GENERATED_BANNER =
  "<!-- GENERATED FILE — do not edit by hand. Regenerated from this folder's document frontmatter\n" +
  "     by the Arke coordinator (SPEC-026). Edit the documents, not this index. -->";

const NNN = /^(\d{3})\./;

/** Split a YAML flow sequence (`[a, b, c]`) into a string array; throws on an unclosed bracket. */
export function parseFlowSequence(raw: string | undefined): string[] {
  const v = (raw ?? "").trim();
  if (v === "") return [];
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) throw new Error("malformed array (unclosed bracket)");
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  // A bare scalar is a one-element list (tolerant of `capabilities: grounding`).
  return [v.replace(/^['"]|['"]$/g, "")];
}

/** Escape a value for a markdown table cell (pipes break the row; newlines collapse to spaces). */
function cell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** First non-empty markdown paragraph after the frontmatter (for a generic doc's description). */
function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (t && !t.startsWith("#") && !t.startsWith("<!--")) return t.replace(/\s+/g, " ");
  }
  return "";
}

/** First `# H1` heading text in the body, if any. */
function firstH1(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m ? m[1] : undefined;
}

/** The `<title>` element's text (SPEC-036) — the human title of an HTML doc without arke frontmatter.
 *  Entities are decoded and tags stripped so a `&amp;` or nested `<code>` renders as plain text. */
function htmlTitle(html: string): string | undefined {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? stripTags(m[1]!) : "";
  return t || undefined;
}

/** First `<h1>` heading text in an HTML body, if any (fallback title when there is no `<title>`). */
function firstHtmlH1(body: string): string | undefined {
  const m = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
  const t = m ? stripTags(m[1]!) : "";
  return t || undefined;
}

// ---- entry builders (parse + classify; pure over filename + text) -----------------------------

/** Build a {@link SpecIndexEntry} from a spec file's name + text. Unparseable → an `unparsed` row. */
export function specEntryFromFile(filename: string, text: string): SpecIndexEntry {
  const number = NNN.exec(filename)?.[1];
  try {
    const { data } = parseFrontmatter(text);
    // Tolerate both frontmatter conventions in the wild: `spec_id` (snake_case, the recent specs +
    // spec-doc parsing) and `specId` (camelCase, the zod SpecFrontmatter field name, e.g. SPEC-001).
    const specId = data.spec_id ?? data.specId;
    const title = data.title;
    if (!specId || !title) {
      return { parseState: "unparsed", filename, path: filename, error: "missing spec_id or title", ...(number ? { number } : {}) };
    }
    const capabilities = parseFlowSequence(data.capabilities); // throws on a malformed array
    return {
      parseState: "ok",
      number: number ?? "",
      specId,
      title,
      status: data.status ?? "",
      capabilities,
      ...(data.updated ? { updated: data.updated } : {}),
      path: filename,
    };
  } catch (err) {
    return { parseState: "unparsed", filename, path: filename, error: err instanceof Error ? err.message : String(err), ...(number ? { number } : {}) };
  }
}

/** Build a {@link BundleIndexEntry} from a generic OKF doc's name + text. `type` is derived when absent. */
export function bundleEntryFromFile(filename: string, text: string): BundleIndexEntry {
  try {
    const { data, body } = parseFrontmatter(text);
    // Tolerant type derivation (SPEC-026): explicit `type`, else `specification` for a spec_id-bearing
    // doc, else `convention` for any other authored doc.
    const type = data.type ?? (data.spec_id ? "specification" : "convention");
    // SPEC-036: an HTML doc's title comes from its `<title>`/`<h1>` (not a `# H1`), and its description
    // comes ONLY from an explicit arke `description:` — NEVER from the raw body. Falling through to
    // firstParagraph() on HTML would dump inline CSS + external <script> URLs into the index cell.
    const isHtml = specFormatOf(filename) === "html" || detectSpecFormat(text) === "html";
    if (isHtml) {
      const title = data.title ?? htmlTitle(text) ?? firstHtmlH1(body) ?? filename.replace(/\.html?$/i, "");
      const description = data.description; // no lede-mining for HTML — artifact exports have no clean paragraph
      return { parseState: "ok", type, title, ...(description ? { description } : {}), path: filename };
    }
    const title = data.title ?? firstH1(body) ?? filename.replace(/\.md$/, "");
    const description = data.description ?? firstParagraph(body);
    return { parseState: "ok", type, title, ...(description ? { description } : {}), path: filename };
  } catch (err) {
    return { parseState: "unparsed", filename, path: filename, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- file selection (pure predicates over a filename) -----------------------------------------

const ALWAYS_EXCLUDE = new Set(["index.md", "README.md", "readme.md"]);

/** A `docs/specifications/` spec file: `NNN.slug.md`, excluding the template/README/index. */
export function isSpecFile(filename: string): boolean {
  return NNN.test(filename) && filename !== "specification.template.md" && !ALWAYS_EXCLUDE.has(filename);
}

/** A generic bundle document: any `.md`/`.html` that is not the index/README/a template (SPEC-036). */
export function isBundleDoc(filename: string): boolean {
  return /\.(?:md|markdown|html?)$/i.test(filename) && !ALWAYS_EXCLUDE.has(filename) && !filename.endsWith(".template.md");
}

// ---- renderers --------------------------------------------------------------------------------

/** Highest `updated:` across parsed spec entries (content-derived index date; ISO dates sort lexically). */
function maxUpdated(entries: SpecIndexEntry[]): string | undefined {
  let max: string | undefined;
  for (const e of entries) if (e.parseState === "ok" && e.updated && (!max || e.updated > max)) max = e.updated;
  return max;
}

function header(updated?: string): string {
  return ["---", "type: index", "generated: true", ...(updated ? [`updated: ${updated}`] : []), "---", "", GENERATED_BANNER, ""].join("\n");
}

/**
 * Render `docs/specifications/index.md` — the rich spec table (SPEC-026). Parsed rows first, ordered by
 * `NNN` then filename; unparsed rows last, flagged `⚠`, ordered by filename. Frontmatter-derived columns
 * only (the curated Covers-PRD / Phase / ~pts columns arrive when their source-of-truth lands — see the
 * spec's open question); Windows-safe with `\n` endings.
 */
export function renderSpecIndex(entries: SpecIndexEntry[]): string {
  const ok = entries.filter((e): e is SpecIndexEntryParsed => e.parseState === "ok")
    .sort((a, b) => a.number.localeCompare(b.number) || a.path.localeCompare(b.path));
  const bad = entries.filter((e): e is IndexEntryUnparsed => e.parseState === "unparsed")
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const lines: string[] = [header(maxUpdated(entries)), "# Specifications", "", "| # | Spec | Status | Capabilities |", "|---|------|--------|--------------|"];
  for (const e of ok) {
    lines.push(`| ${cell(e.number)} | [${cell(e.title)}](${e.path}) | ${cell(e.status)} | ${cell(e.capabilities.join(", "))} |`);
  }
  for (const e of bad) {
    lines.push(`| ⚠ | \`${cell(e.filename)}\` — unparsed: ${cell(e.error)} | | |`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Render a generic OKF bundle `index.md` — one row per document (`Type | Title | Description`, linked).
 * Parsed rows ordered by title then filename; unparsed rows last, flagged `⚠`, ordered by filename.
 * `bundleName` titles the page (e.g. "decisions" → "# Decisions").
 */
export function renderBundleIndex(bundleName: string, entries: BundleIndexEntry[]): string {
  const ok = entries.filter((e): e is BundleIndexEntryParsed => e.parseState === "ok")
    .sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
  const bad = entries.filter((e): e is IndexEntryUnparsed => e.parseState === "unparsed")
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const heading = bundleName.charAt(0).toUpperCase() + bundleName.slice(1);
  const lines: string[] = [header(), `# ${heading}`, "", "| Type | Title | Description |", "|------|-------|-------------|"];
  for (const e of ok) {
    lines.push(`| ${cell(e.type)} | [${cell(e.title)}](${e.path}) | ${cell(e.description ?? "")} |`);
  }
  for (const e of bad) {
    lines.push(`| ⚠ | \`${cell(e.filename)}\` | unparsed: ${cell(e.error)} |`);
  }
  return lines.join("\n") + "\n";
}
