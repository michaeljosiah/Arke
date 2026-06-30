import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parseFrontmatter, parseSpecDoc, appendChangeHistory } from "@arke/contracts";

/**
 * Pure spec-lifecycle helpers (SPEC-008). Status is governed by pull-request state via webhooks; this
 * module holds the deterministic, side-effect-free core the coordinator drives: the material-change
 * detector (normative hash), the merge-time delta-tag flattener (idempotent), the GitHub webhook
 * signature check, and the webhook→transition mapping. The file in git stays the source of truth — these
 * helpers read and rewrite text, they never hold state.
 */

// ---- material-change detection -------------------------------------------------------------------

/** Hash algorithm + the sections it covers — logged with every regression event (SPEC-008). */
export const NORMATIVE_HASH_ALGO = "sha256";
export const NORMATIVE_SECTIONS = ["requirements", "design"] as const;

/**
 * SHA-256 over the Requirements + Design sections only, LF-normalised — excludes the frontmatter
 * (incl. `updated`), Change history, Open questions and Decision log, so routine metadata edits don't
 * read as a material change (SPEC-008).
 */
export function normativeHash(md: string): string {
  const doc = parseSpecDoc(md);
  const parts = NORMATIVE_SECTIONS.map((k) => doc.sections.find((s) => s.key === k)?.markdown ?? "");
  const normalised = parts.join("\n\n").replace(/\r\n/g, "\n").trim();
  return createHash(NORMATIVE_HASH_ALGO).update(normalised, "utf8").digest("hex");
}

/** True when the normative sections of `md` differ from a previously-stored hash. */
export function isMaterialChange(previousHash: string | undefined, md: string): boolean {
  if (!previousHash) return false; // no baseline (spec wasn't approved) → nothing to regress
  return normativeHash(md) !== previousHash;
}

// ---- delta-tag flattening (merge time, idempotent) -----------------------------------------------

export interface FlattenResult {
  text: string;
  /** False when the input had no delta tags — the caller skips the commit (idempotency). */
  changed: boolean;
  summary: { added: number; modified: number; removed: number; renamed: number };
}

const DELTA_TOKEN = /\s*·?\s*`?delta:\s*([^`\n]+?)`?\s*$/im;

/** Strip the `delta: …` token (and a leading ` · ` separator) from a requirement metadata line. */
function stripDeltaToken(line: string): string {
  // ``capability: x` · `delta: ADDED (b)`` → ``capability: x``; a line that was only the delta → "".
  const cleaned = line
    .replace(/`delta:\s*[^`]+`/i, "")
    .replace(/\bdelta:\s*\S.*$/i, "")
    .replace(/\s*·\s*$/, "")
    .replace(/\s+$/, "");
  return cleaned;
}

/**
 * Flatten all delta tags per the template lifecycle rules (SPEC-008), idempotently:
 *  - ADDED / MODIFIED → drop the delta token, keep the requirement body;
 *  - REMOVED → cut the requirement block, append a `## Removed` tombstone (deduped);
 *  - RENAMED (from: old) → keep the (already-new) heading, drop the token, note the rename;
 *  - append a Change history line summarising the net delta.
 * A file with no delta tags is returned unchanged with `changed: false` — no Change history line,
 * no duplicate tombstone — so re-running on an already-flattened file is a no-op.
 */
export function flattenDeltaTags(md: string, branch: string, date: string): FlattenResult {
  const summary = { added: 0, modified: 0, removed: 0, renamed: 0 };
  if (!/\bdelta:/i.test(md)) return { text: md, changed: false, summary };

  const lines = md.split("\n");
  const out: string[] = [];
  const tombstones: string[] = [];
  const renameNotes: string[] = [];

  // Walk requirement blocks: a `### Requirement: <name>` heading owns lines until the next `###`/`##`.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const reqMatch = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    if (!reqMatch) {
      out.push(line);
      i++;
      continue;
    }
    const heading = line;
    const name = reqMatch[1]!;
    const block: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^###\s+/.test(lines[j]!) || /^##\s+/.test(lines[j]!)) break;
      block.push(lines[j]!);
    }
    const blockText = block.join("\n");
    const deltaMatch = /delta:\s*`?([^`\n]+?)`?\s*$/im.exec(blockText);
    const delta = deltaMatch?.[1]?.trim() ?? "";

    if (/^REMOVED\b/i.test(delta)) {
      summary.removed++;
      const capability = /capability:\s*`?([a-z0-9-]+)`?/i.exec(blockText)?.[1] ?? "unknown";
      const reason = /Reason:\s*([^·\n]+)/i.exec(delta)?.[1]?.trim() ?? "see Change history";
      const tomb = `> REMOVED ${capability}/${name} — Reason: ${reason} · Migration: see Change history`;
      // Idempotency guard: don't append a duplicate tombstone for the same capability/name.
      if (!new RegExp(`REMOVED\\s+${escapeRe(capability)}/${escapeRe(name)}\\b`).test(md)) tombstones.push(tomb);
      i = j; // drop the whole block
      continue;
    }

    if (/^RENAMED\b/i.test(delta)) {
      summary.renamed++;
      const from = /from:\s*([^)\n]+?)\s*\)?\s*$/i.exec(delta)?.[1]?.trim() ?? "?";
      renameNotes.push(`RENAMED ${from} → ${name}`);
      out.push(heading);
      for (const b of block) out.push(DELTA_TOKEN.test(b) ? stripDeltaToken(b) : b);
      i = j;
      continue;
    }

    if (/^ADDED\b/i.test(delta)) summary.added++;
    else if (/^MODIFIED\b/i.test(delta)) summary.modified++;
    out.push(heading);
    for (const b of block) out.push(DELTA_TOKEN.test(b) ? stripDeltaToken(b) : b);
    i = j;
  }

  let result = out.join("\n");

  // Append tombstones under a `## Removed` heading (create it once if absent).
  if (tombstones.length) {
    if (!/^##\s+Removed\s*$/im.test(result)) result = result.replace(/\s*$/, "") + "\n\n## Removed\n";
    const anchor = /^##\s+Removed\s*$/im.exec(result)!;
    const at = anchor.index + anchor[0].length;
    result = result.slice(0, at) + "\n" + tombstones.join("\n") + result.slice(at);
  }

  // Change history line: net-delta summary (auto-derived; "What changes" prose is left to the author).
  const parts: string[] = [];
  if (summary.added) parts.push(`ADDED: ${summary.added}`);
  if (summary.modified) parts.push(`MODIFIED: ${summary.modified}`);
  if (summary.removed) parts.push(`REMOVED: ${summary.removed}`);
  if (summary.renamed) parts.push(`RENAMED: ${summary.renamed}`);
  const summaryText = parts.length ? parts.join("; ") : "flattened delta tags";
  result = appendChangeHistory(result, `${date} · ${branch} · approved — ${summaryText}`);
  for (const note of renameNotes) result = appendChangeHistory(result, `${date} · ${branch} · approved — ${note}`);

  return { text: result, changed: true, summary };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- webhook signature + event mapping -----------------------------------------------------------

/** Validate a GitHub `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body) — constant-time. */
export function verifyGithubSignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type LifecycleTransition =
  | { kind: "opened"; branch: string; prNumber: number }
  | { kind: "synchronized"; branch: string; prNumber: number }
  | { kind: "approved"; branch: string; prNumber: number; approver: string }
  | { kind: "closed-unmerged"; branch: string; prNumber: number }
  | { kind: "reopened"; branch: string; prNumber: number }
  | { kind: "merged"; branch: string; prNumber: number }
  | { kind: "force-push"; branch: string }
  | { kind: "ignored"; reason: string };

/**
 * Map a GitHub webhook (event name + parsed payload) to a lifecycle transition (SPEC-008). Pure: the
 * caller resolves the owning project, applies status, and runs the self-approval / branch checks.
 */
export function mapWebhookEvent(eventName: string, payload: any): LifecycleTransition {
  if (eventName === "pull_request") {
    const branch = String(payload?.pull_request?.head?.ref ?? "");
    const prNumber = Number(payload?.pull_request?.number ?? 0);
    const action = String(payload?.action ?? "");
    if (action === "opened" || action === "ready_for_review") return { kind: "opened", branch, prNumber };
    // A new push to an open PR is NOT a re-open: it only regresses an APPROVED spec, and only when the
    // push changed the normative sections (the coordinator runs the material-change check).
    if (action === "synchronize") return { kind: "synchronized", branch, prNumber };
    if (action === "reopened") return { kind: "reopened", branch, prNumber };
    if (action === "closed") {
      return payload?.pull_request?.merged ? { kind: "merged", branch, prNumber } : { kind: "closed-unmerged", branch, prNumber };
    }
    return { kind: "ignored", reason: `pull_request action '${action}'` };
  }
  if (eventName === "pull_request_review") {
    if (String(payload?.review?.state ?? "").toLowerCase() !== "approved") return { kind: "ignored", reason: "review not approved" };
    return {
      kind: "approved",
      branch: String(payload?.pull_request?.head?.ref ?? ""),
      prNumber: Number(payload?.pull_request?.number ?? 0),
      approver: String(payload?.review?.user?.login ?? ""),
    };
  }
  if (eventName === "push" && payload?.forced === true) {
    return { kind: "force-push", branch: String(payload?.ref ?? "").replace(/^refs\/heads\//, "") };
  }
  return { kind: "ignored", reason: `event '${eventName}'` };
}

/** True when a PR approver is the spec owner — a self-approval that must NOT advance to approved. */
export function isSelfApproval(approver: string, owner: string | undefined): boolean {
  if (!owner) return false;
  return approver.trim().toLowerCase() === owner.trim().toLowerCase();
}

/** Normalise a git remote URL (https or ssh) to `host/owner/repo` for routing webhooks to a project. */
export function normaliseRemote(url: string | undefined): string | null {
  if (!url) return null;
  const m = /(?:git@|https?:\/\/)([^/:]+)[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}/${m[3]}`.toLowerCase() : null;
}

/** Build a library record's capabilities array from a spec's frontmatter `capabilities:` field. */
export function parseCapabilities(frontmatter: Record<string, string>): string[] {
  const raw = frontmatter.capabilities ?? "";
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export { parseFrontmatter };
