import { SPEC_ANATOMY } from "./spec.js";
import type { CanonicalLink, RippleLink, SpecFormat } from "./spec.js";

/**
 * Pure parsing/editing of a specification markdown file (SPEC-006). Shared by the coordinator
 * (`approveDraft` reads the frontmatter, advances `status`, appends a Change history line) and the
 * client cockpit (the live preview renders section-by-section against {@link SPEC_ANATOMY} and
 * highlights delta-tagged requirements). The file in git is the source of truth — these helpers
 * never hold state; they read and rewrite the text.
 */

export type DeltaKind = "ADDED" | "MODIFIED" | "REMOVED";

export interface ParsedRequirement {
  /** Text after `### Requirement:`. */
  title: string;
  /** `capability:` token from the metadata line, if present. */
  capability?: string;
  /** The delta kind from the `delta:` token, if present (drives preview highlighting). */
  deltaKind?: DeltaKind;
  /** The raw delta string, e.g. `ADDED (feat/authoring-cockpit)`. */
  delta?: string;
  /** The requirement prose (everything from the heading to the next `###`/`##`). */
  body: string;
}

export interface ParsedSection {
  /** SPEC_ANATOMY key: `requirements` | `design` | `tasks`. */
  key: string;
  title: string;
  /** False when the working file has no `## <title>` heading for this anatomy section. */
  present: boolean;
  /** The raw markdown under the section heading (empty when absent). */
  markdown: string;
}

export interface ParsedSpecDoc {
  /** Parsed frontmatter key/value pairs (flat; arrays/nesting are left as raw strings). */
  frontmatter: Record<string, string>;
  /** The requirements parsed from the Requirements section, in document order. */
  requirements: ParsedRequirement[];
  /** Every anatomy section in SPEC_ANATOMY order, present or placeholder. */
  sections: ParsedSection[];
}

/** Map a `delta:` value (or a bare kind) to a {@link DeltaKind}, or undefined. */
export function deltaKindOf(value?: string): DeltaKind | undefined {
  if (!value) return undefined;
  const m = /\b(ADDED|MODIFIED|REMOVED)\b/.exec(value);
  return m ? (m[1] as DeltaKind) : undefined;
}

interface SplitFrontmatter {
  data: Record<string, string>;
  /** The frontmatter block including the fences, or "" when absent. */
  raw: string;
  /** The document body after the frontmatter. */
  body: string;
}

/** Parse the flat `key: value` scalars out of a `---`-fenced YAML inner block (shared by both formats). */
function parseYamlScalars(inner: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const rawLine of inner.split("\n")) {
    // Strip a trailing CR so CRLF frontmatter (git `autocrlf` checkout on Windows) parses: `.` in the
    // value regex does not match `\r`, so without this every key silently failed and the doc parsed empty.
    const line = rawLine.replace(/\r$/, "");
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (m) data[m[1]!] = normalizeScalar(m[2]!.trim());
  }
  return data;
}

/**
 * Split a `---`-fenced YAML frontmatter block off the head of the document (flat key: value). Handles both
 * serialisations (SPEC-036), **content-detected** so callers that pass only text can't mis-parse: a markdown
 * spec leads with a bare `---` fence; an HTML spec carries the same fenced YAML inside a leading
 * `<!--arke … -->` comment (keeping the file valid, browser-renderable HTML). `raw` is the exact leading
 * region a writer rewrites; `raw + body === text`, for both formats.
 */
export function parseFrontmatter(md: string): SplitFrontmatter {
  const text = md.replace(/^﻿/, "");
  // HTML spec: frontmatter is the `---`-fenced YAML inside a leading `<!--arke … -->` comment.
  if (/^<!--\s*arke\b/i.test(text)) {
    const close = text.indexOf("-->");
    if (close === -1) return { data: {}, raw: "", body: text };
    const nl = text.indexOf("\n", close);
    const rawEnd = nl === -1 ? text.length : nl + 1; // include the newline after `-->`
    const raw = text.slice(0, rawEnd);
    const body = text.slice(rawEnd);
    const comment = text.slice(0, close);
    const fenceStart = comment.indexOf("---");
    const fenceEnd = fenceStart === -1 ? -1 : comment.indexOf("\n---", fenceStart + 3);
    if (fenceStart === -1 || fenceEnd === -1) return { data: {}, raw, body };
    const inner = comment.slice(comment.indexOf("\n", fenceStart) + 1, fenceEnd);
    return { data: parseYamlScalars(inner), raw, body };
  }
  if (!text.startsWith("---")) return { data: {}, raw: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, raw: "", body: text };
  const afterFence = text.indexOf("\n", end + 1);
  const raw = text.slice(0, afterFence === -1 ? text.length : afterFence + 1);
  const inner = text.slice(text.indexOf("\n") + 1, end);
  const body = afterFence === -1 ? "" : text.slice(afterFence + 1);
  return { data: parseYamlScalars(inner), raw, body };
}

/** A specification's serialisation format from its filename (SPEC-036): `.html`/`.htm` → html, else markdown. */
export function specFormatOf(pathOrName: string): SpecFormat {
  return /\.html?$/i.test((pathOrName ?? "").trim()) ? "html" : "markdown";
}

/** Content-detect a spec's format from its text (SPEC-036): the self-describing HTML leading `<!--arke -->`
 *  comment ⇒ html, else markdown. Lets read-side callers that hold only text (normativeHash, grounding, the
 *  client preview) parse correctly without threading a `format` arg — no silent markdown mis-parse. */
export function detectSpecFormat(md: string): SpecFormat {
  return /^<!--\s*arke\b/i.test(md.replace(/^﻿/, "")) ? "html" : "markdown";
}

// ---- SPEC-036 HTML parsing helpers (tag-based, browser-safe — no DOM library) --------------------

/** Blank out the CONTENT of `<pre>/<code>/<script>/<style>` spans and HTML comments (with same-length
 *  spaces so indices still map back to the original), so a heading-like string inside them is never a
 *  false section boundary. An UNCLOSED such region is masked to end-of-input (`(?:</tag>|$)`) — a browser
 *  treats the rest of the document as inside it, so we must too (and it keeps the governance gate honest). */
function maskNonContent(html: string): string {
  return html.replace(/<pre\b[\s\S]*?(?:<\/pre>|$)|<code\b[\s\S]*?(?:<\/code>|$)|<script\b[\s\S]*?(?:<\/script>|$)|<style\b[\s\S]*?(?:<\/style>|$)|<!--[\s\S]*?(?:-->|$)/gi, (m) => " ".repeat(m.length));
}

/** Strip HTML to plain text for the token + normative checks (SPEC-036): drops `<script>/<style>/comment`
 *  CONTENT first (so a hidden token can't reach the governance gate), then tags, then decodes a minimal
 *  entity set. Collapses whitespace. The script/style/comment strips match an UNCLOSED region to end-of-input
 *  (`(?:</tag>|$)`) too — otherwise `<style>The system SHALL … WHEN … THEN` (no close) would smuggle passing
 *  tokens past `validateWellFormed`. */
export function stripTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<script\b[\s\S]*?(?:<\/script>|$)/gi, " ")
    .replace(/<style\b[\s\S]*?(?:<\/style>|$)/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&") // decode &amp; LAST so `&amp;lt;` → `&lt;`, not `<`
    .replace(/\s+/g, " ")
    .trim();
}

/** Yield each `<hN>` heading's stripped title + the body span beneath it (up to the next `<hN>`). Heading
 *  POSITIONS are found on a masked copy (so a heading inside pre/code/comments is ignored), but the title
 *  text and content are sliced from the ORIGINAL body (so inline tags in a title, e.g. `<code>`, survive). */
function htmlSections(body: string, tag: "h2" | "h3" | "h4"): Array<{ title: string; content: string; start: number }> {
  const masked = maskNonContent(body);
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
  const closeLen = tag.length + 3; // "</hN>" = "</" + tag + ">"
  const heads: Array<{ title: string; contentStart: number; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const openEnd = m.index + m[0].indexOf(">") + 1; // just past the opening `<hN …>`
    const title = stripTags(body.slice(openEnd, re.lastIndex - closeLen)).trim(); // from the ORIGINAL body
    heads.push({ title, start: m.index, contentStart: re.lastIndex });
  }
  return heads.map((h, i) => ({ title: h.title, start: h.start, content: body.slice(h.contentStart, i + 1 < heads.length ? heads[i + 1]!.start : body.length).trim() }));
}

/**
 * Normalise a YAML scalar value for lifecycle comparisons: unquote a simple `'…'`/`"…"` string
 * (so `status: "draft"` compares as `draft`), and drop a trailing inline comment (` # …`) from an
 * unquoted value (so the template's `status: draft # set by …` parses as `draft`).
 */
function normalizeScalar(value: string): string {
  const v = value.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    // A quoted scalar ends at its closing quote; anything after it (e.g. an inline ` # comment`) is
    // not part of the value. Matching on endsWith() missed this and returned a still-quoted string.
    const close = v.indexOf(q, 1);
    if (close !== -1) return v.slice(1, close);
  }
  // Unquoted: a `#` only starts a YAML comment when preceded by whitespace.
  return v.replace(/\s+#.*$/, "").trim();
}

export interface ParsedLinkage {
  /** Ripples declared on a canonical spec, in document order (SPEC-030). */
  ripples: RippleLink[];
  /** The back-reference to the canonical, when this is a ripple spec. */
  canonical?: CanonicalLink;
  /** Human-readable problems with the linkage blocks — surfaced, never fatal. */
  warnings: string[];
}

/** The raw inner text of a spec's `---`-fenced frontmatter block, or "". Content-detects the HTML
 *  leading-comment form (SPEC-036) so `parseLinkage` reads `ripples:`/`canonical:` from either format. */
function frontmatterInner(md: string): string {
  let text = md.replace(/^﻿/, "");
  if (/^<!--\s*arke\b/i.test(text)) {
    const close = text.indexOf("-->");
    if (close === -1) return "";
    text = text.slice(0, close); // the YAML fence lives inside the comment
    const start = text.indexOf("---");
    if (start === -1) return "";
    const end = text.indexOf("\n---", start + 3);
    return end === -1 ? "" : text.slice(text.indexOf("\n", start) + 1, end);
  }
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end === -1) return "";
  return text.slice(text.indexOf("\n") + 1, end);
}

/**
 * Parse the SPEC-030 cross-repo linkage blocks — a nested `ripples:` list and a `canonical:` map — from a
 * spec's frontmatter. The flat {@link parseFrontmatter} cannot read these nested structures, so this walks
 * the frontmatter's inner lines by indentation. Side-effect-free: a malformed entry yields a warning (never
 * a throw) and is dropped, so a bad ripple cannot break library loading. A spec with neither block yields
 * `{ ripples: [], warnings: [] }` — a plain single-repo spec.
 */
export function parseLinkage(md: string): ParsedLinkage {
  const warnings: string[] = [];
  const ripples: RippleLink[] = [];
  const canonKV: Record<string, string> = {};
  let mode: "none" | "ripples" | "canonical" = "none";
  let current: Record<string, string> | null = null;

  const flushRipple = () => {
    if (!current) return;
    const { repo, spec, kind } = current;
    if (!repo || !spec || !kind) warnings.push(`ripple entry is missing repo/spec/kind: ${JSON.stringify(current)}`);
    else if (kind !== "delta" && kind !== "pointer") warnings.push(`ripple '${repo}' has unknown kind '${kind}' (expected delta|pointer)`);
    else ripples.push({ repo, spec, kind });
    current = null;
  };

  for (const raw of frontmatterInner(md).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    // A top-level key (no indentation) opens or closes a block.
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (top && !/^\s/.test(line)) {
      flushRipple();
      mode = top[1] === "ripples" ? "ripples" : top[1] === "canonical" ? "canonical" : "none";
      continue;
    }
    if (mode === "ripples") {
      const item = /^\s*-\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(line); // "  - repo: x" starts a new item
      if (item) { flushRipple(); current = { [item[1]!]: normalizeScalar(item[2]!) }; continue; }
      if (/^\s*-\s*$/.test(line)) { flushRipple(); current = {}; continue; } // bare "-" then fields below
      const field = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line); // "    spec: y" continues the item
      if (field && current) { current[field[1]!] = normalizeScalar(field[2]!); continue; }
      warnings.push(`unrecognised ripples line: ${line.trim()}`);
    } else if (mode === "canonical") {
      const field = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (field) { canonKV[field[1]!] = normalizeScalar(field[2]!); continue; }
      warnings.push(`unrecognised canonical line: ${line.trim()}`);
    }
  }
  flushRipple();

  let canonical: CanonicalLink | undefined;
  if (canonKV.repo && canonKV.spec) canonical = { repo: canonKV.repo, spec: canonKV.spec };
  else if (canonKV.repo || canonKV.spec) warnings.push("canonical is missing repo or spec");

  return canonical ? { ripples, canonical, warnings } : { ripples, warnings };
}

/** Parse a spec doc into frontmatter, requirements (with delta), and anatomy sections. Format-dispatched
 *  (SPEC-036): markdown splits on `##`/`### Requirement:`; HTML on `<h2>`/`<h3>Requirement:`. Both return the
 *  same shape, so every downstream consumer is unchanged. `format` defaults to markdown. */
export function parseSpecDoc(md: string, format?: SpecFormat): ParsedSpecDoc {
  const { data, body } = parseFrontmatter(md);
  const fmt = format ?? detectSpecFormat(md); // content-detect when the caller has only text
  const sectionText = fmt === "html" ? splitSectionsHtml(body) : splitSections(body); // lowercased title → body
  const sections: ParsedSection[] = SPEC_ANATOMY.map((a) => {
    const markdown = sectionText.get(a.title.toLowerCase()) ?? "";
    return { key: a.key, title: a.title, present: sectionText.has(a.title.toLowerCase()), markdown };
  });
  const requirementsBody = sectionText.get("requirements") ?? "";
  const requirements = fmt === "html" ? parseRequirementsHtml(requirementsBody) : parseRequirements(requirementsBody);
  return { frontmatter: data, requirements, sections };
}

/** HTML analogue of {@link splitSections}: lowercased `<h2>` title → the HTML beneath it. */
function splitSectionsHtml(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of htmlSections(body, "h2")) out.set(s.title.toLowerCase(), s.content);
  return out;
}

/** HTML analogue of {@link parseRequirements}: `<h3>Requirement: …</h3>` blocks. `capability:` is read from
 *  the tag-stripped block text (it is a bounded slug); `delta:` is read from the RAW block bounded by the next
 *  tag/newline (`[^<\n]`), NOT the whitespace-collapsed text — the metadata is its own element, so bounding at
 *  `<` keeps the delta value from running into the requirement prose. The `body` keeps the raw HTML. */
function parseRequirementsHtml(html: string): ParsedRequirement[] {
  const out: ParsedRequirement[] = [];
  for (const s of htmlSections(html, "h3")) {
    if (!/^Requirement:/i.test(s.title)) continue;
    const title = s.title.replace(/^Requirement:\s*/i, "");
    const text = stripTags(s.content);
    const capability = /capability:\s*([a-z0-9-]+)/i.exec(text)?.[1];
    const delta = /delta:\s*([^<\n]+)/i.exec(s.content)?.[1]?.trim();
    out.push({
      title,
      ...(capability ? { capability } : {}),
      ...(delta ? { delta } : {}),
      ...(deltaKindOf(delta) ? { deltaKind: deltaKindOf(delta) } : {}),
      body: s.content.trim(),
    });
  }
  return out;
}

/** Split a document body into a map of lowercased `## <title>` → the markdown beneath it. */
function splitSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split("\n");
  let title: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (title !== null) out.set(title.toLowerCase(), buf.join("\n").trim());
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !line.startsWith("###")) {
      flush();
      title = m[1]!;
      buf = [];
    } else if (title !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** Parse `### Requirement:` blocks out of the Requirements section markdown. */
function parseRequirements(md: string): ParsedRequirement[] {
  const out: ParsedRequirement[] = [];
  const lines = md.split("\n");
  let cur: { title: string; buf: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.buf.join("\n").trim();
    const capability = /capability:\s*`?([a-z0-9-]+)`?/i.exec(body)?.[1];
    const delta = /delta:\s*`?([^`\n]+?)`?\s*$/im.exec(body)?.[1]?.trim();
    out.push({
      title: cur.title,
      ...(capability ? { capability } : {}),
      ...(delta ? { delta } : {}),
      ...(deltaKindOf(delta) ? { deltaKind: deltaKindOf(delta) } : {}),
      body,
    });
  };
  for (const line of lines) {
    const m = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      cur = { title: m[1]!, buf: [] };
    } else if (cur) {
      cur.buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Well-formedness gate for promoting a draft out of `draft` (SPEC-024). This is deliberately MORE than
 * {@link parseSpecDoc}'s section-presence walk: `SPEC_ANATOMY` models section headings but has no notion
 * of normative SHALL/MUST statements or WHEN/THEN scenarios, so this ADDS that parsing. A draft may not
 * advance to `in-review` unless (a) the Requirements section is present and non-empty, (b) at least one
 * requirement carries a SHALL or MUST statement, and (c) at least one `#### Scenario:` block contains
 * both a WHEN and a THEN. `missing` names each absent element — `"requirements section"` |
 * `"normative statements"` | `"scenarios"` — so the cockpit can tell the author exactly what to add.
 */
export function validateWellFormed(md: string, format?: SpecFormat): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const { body } = parseFrontmatter(md);
  const fmt = format ?? detectSpecFormat(md);
  const requirements = parseSpecDoc(md, fmt).sections.find((s) => s.key === "requirements");
  const reqBody = requirements?.markdown ?? "";
  // For HTML the normative word-checks run on tag-stripped text (SPEC-036) so inline markup is transparent
  // AND a token hidden in <script>/<style>/comment content cannot reach the governance gate.
  const reqText = fmt === "html" ? stripTags(reqBody) : reqBody;
  // (a) the Requirements section — the one SPEC_ANATOMY section that carries the normative content —
  // must be present and non-empty; a draft with no requirements has nothing to review.
  if (!requirements?.present || reqBody.trim() === "") missing.push("requirements section");
  // (b) at least one normative statement (SHALL or MUST) in the requirements prose.
  if (!/\b(?:SHALL|MUST)\b/.test(reqText)) missing.push("normative statements");
  // (c) at least one acceptance scenario with both a trigger and an outcome. Markdown scans each
  // `#### Scenario:` block; HTML scans each `<h4>Scenario:` block's tag-stripped text.
  const scenarioTexts = fmt === "html"
    ? htmlSections(body, "h4").filter((s) => /^Scenario:/i.test(s.title)).map((s) => stripTags(s.content))
    : body.split(/^####\s+Scenario:/im).slice(1).map((block) => block.split(/^#{2,4}\s+/m)[0] ?? block);
  const hasWhenThen = scenarioTexts.some((t) => /\bWHEN\b/i.test(t) && /\bTHEN\b/i.test(t));
  if (!hasWhenThen) missing.push("scenarios");
  return { ok: missing.length === 0, missing };
}

/** Rewrite the `status:` line in the frontmatter (inserting one if absent). */
export function setFrontmatterStatus(md: string, status: string): string {
  const { raw, body } = parseFrontmatter(md);
  if (!raw) {
    // No frontmatter — prepend a minimal block so the file remains parseable.
    return `---\nstatus: ${status}\n---\n\n${md}`;
  }
  let replaced = false;
  const newRaw = raw
    .split("\n")
    .map((line) => {
      if (/^status:\s*/.test(line)) {
        replaced = true;
        return `status: ${status}`;
      }
      return line;
    })
    .join("\n");
  const withStatus = replaced
    ? newRaw
    : newRaw.replace(/\n---(\r?\n?)$/, `\nstatus: ${status}\n---$1`);
  return withStatus + body;
}

/**
 * Append a line under the Change history section (creating it if absent), format-dispatched (SPEC-036). For
 * markdown the entry is a `- ` list item under `## Change history`; for HTML it is an `<li>` inside the list
 * under `<h2>Change history</h2>` (creating the section + `<ul>` if absent). Defaults to markdown.
 */
export function appendChangeHistory(md: string, line: string, format?: SpecFormat): string {
  if ((format ?? detectSpecFormat(md)) === "html") return appendChangeHistoryHtml(md, line);
  const item = line.trimStart().startsWith("- ") ? line.trimEnd() : `- ${line.trim()}`;
  const re = /^##\s+Change history\s*$/im;
  const match = re.exec(md);
  if (!match) {
    const sep = md.endsWith("\n") ? "" : "\n";
    return `${md}${sep}\n## Change history\n${item}\n`;
  }
  // Find the end of the Change history section (next `## ` heading or EOF) and insert before it.
  const start = match.index + match[0].length;
  const rest = md.slice(start);
  const nextH2 = /\n##\s+/.exec(rest);
  const insertAt = nextH2 ? start + nextH2.index : md.length;
  const before = md.slice(0, insertAt).replace(/\s*$/, "");
  const after = md.slice(insertAt);
  return `${before}\n${item}\n${after.startsWith("\n") ? after.slice(1) : after}`;
}

/** Escape a text run for safe insertion into HTML text content (e.g. a change-history `<li>` or a
 *  generated `<h1>`), so an author-supplied value can't inject tags or break out of its element. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML branch of {@link appendChangeHistory}: append an `<li>` under `<h2>Change history</h2>`'s list. */
function appendChangeHistoryHtml(html: string, line: string): string {
  const li = `<li>${escapeHtml(line.replace(/^\s*-\s*/, "").trim())}</li>`;
  const head = /<h2\b[^>]*>\s*Change history\s*<\/h2>/i.exec(html);
  if (!head) {
    const sep = html.endsWith("\n") ? "" : "\n";
    return `${html}${sep}<h2>Change history</h2>\n<ul>\n  ${li}\n</ul>\n`;
  }
  const start = head.index + head[0].length;
  const rest = html.slice(start);
  // Prefer to insert as the last item of the section's first <ul>/<ol> before the next <h2>.
  const nextH2 = /<h2\b/i.exec(rest);
  const sectionEnd = nextH2 ? start + nextH2.index : html.length;
  const section = html.slice(start, sectionEnd);
  const listClose = /<\/(ul|ol)>/i.exec(section);
  if (listClose) {
    const at = start + listClose.index;
    return `${html.slice(0, at).replace(/\s*$/, "")}\n  ${li}\n${html.slice(at)}`;
  }
  // No list yet in the section — create one right after the heading.
  return `${html.slice(0, start)}\n<ul>\n  ${li}\n</ul>${html.slice(start)}`;
}
