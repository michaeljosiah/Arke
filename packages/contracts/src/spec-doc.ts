import { SPEC_ANATOMY } from "./spec.js";
import type { CanonicalLink, RippleLink } from "./spec.js";

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

/** Split a `---`-fenced YAML frontmatter block off the head of the document (flat key: value). */
export function parseFrontmatter(md: string): SplitFrontmatter {
  const text = md.replace(/^﻿/, "");
  if (!text.startsWith("---")) return { data: {}, raw: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, raw: "", body: text };
  const afterFence = text.indexOf("\n", end + 1);
  const raw = text.slice(0, afterFence === -1 ? text.length : afterFence + 1);
  const inner = text.slice(text.indexOf("\n") + 1, end);
  const body = afterFence === -1 ? "" : text.slice(afterFence + 1);
  const data: Record<string, string> = {};
  for (const rawLine of inner.split("\n")) {
    // Strip a trailing CR so CRLF frontmatter (git `autocrlf` checkout on Windows) parses: `.` in the
    // value regex does not match `\r`, so without this every key silently failed and the doc parsed empty.
    const line = rawLine.replace(/\r$/, "");
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (m) data[m[1]!] = normalizeScalar(m[2]!.trim());
  }
  return { data, raw, body };
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

/** The raw inner text of a spec's `---`-fenced frontmatter block (between the fences), or "". */
function frontmatterInner(md: string): string {
  const text = md.replace(/^﻿/, "");
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

/** Parse a spec markdown doc into frontmatter, requirements (with delta), and anatomy sections. */
export function parseSpecDoc(md: string): ParsedSpecDoc {
  const { data, body } = parseFrontmatter(md);
  const sectionText = splitSections(body); // lowercased H2 title → markdown under it
  const sections: ParsedSection[] = SPEC_ANATOMY.map((a) => {
    const markdown = sectionText.get(a.title.toLowerCase()) ?? "";
    return { key: a.key, title: a.title, present: sectionText.has(a.title.toLowerCase()), markdown };
  });
  const requirementsMd = sectionText.get("requirements") ?? "";
  return { frontmatter: data, requirements: parseRequirements(requirementsMd), sections };
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
export function validateWellFormed(md: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const { body } = parseFrontmatter(md);
  const requirements = parseSpecDoc(md).sections.find((s) => s.key === "requirements");
  const reqMd = requirements?.markdown ?? "";
  // (a) the Requirements section — the one SPEC_ANATOMY section that carries the normative content —
  // must be present and non-empty; a draft with no requirements has nothing to review.
  if (!requirements?.present || reqMd.trim() === "") missing.push("requirements section");
  // (b) at least one normative statement (SHALL or MUST) in the requirements prose.
  if (!/\b(?:SHALL|MUST)\b/.test(reqMd)) missing.push("normative statements");
  // (c) at least one acceptance scenario with both a trigger and an outcome. Scan each
  // `#### Scenario:` block (up to the next heading) for a WHEN and a THEN, case-insensitively and
  // tolerant of markdown emphasis (`- **WHEN**`).
  const scenarios = body.split(/^####\s+Scenario:/im).slice(1);
  const hasWhenThen = scenarios.some((block) => {
    const upToNextHeading = block.split(/^#{2,4}\s+/m)[0] ?? block;
    return /\bWHEN\b/i.test(upToNextHeading) && /\bTHEN\b/i.test(upToNextHeading);
  });
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
 * Append a line under the `## Change history` section (creating the section if absent). The line is
 * prefixed with `- ` if it is not already a list item.
 */
export function appendChangeHistory(md: string, line: string): string {
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
