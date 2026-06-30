import { SPEC_ANATOMY } from "./spec.js";

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
  for (const line of inner.split("\n")) {
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
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v.replace(/\s+#.*$/, "").trim();
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
