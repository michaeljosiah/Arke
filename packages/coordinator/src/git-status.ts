import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { RepoIdentityView, RepoStatusView } from "@arke/contracts";
import { gitAvailable, gitDefaultBranch, gitHeadBranch, gitOpts, GIT_TIMEOUT_MS } from "./project-context.js";

/**
 * SPEC-025: read-only git + GitHub PR status queries for the Overview's Repository panel.
 *
 * These extend the existing git shell-out convention in `project-context.ts` (the shared
 * `gitOpts()`/`GIT_TIMEOUT_MS` bounded-timeout, non-interactive env) rather than re-deriving a second
 * one. Every function is READ-ONLY — no `git push`/`commit`/`checkout`, no `gh pr create`/`merge`. Each
 * returns a discriminated `{ ok: true, ... } | { ok: false, reason }` so a failure (missing binary,
 * timeout, no upstream, unconfigured integration) becomes an honest degraded field, never a fabricated 0.
 */

export type Ok<T> = ({ ok: true } & T) | { ok: false; reason: string };

/** True when a ref resolves in `root` (used to prefer a remote-tracking ref over a local one). */
function refExists(root: string, ref: string): boolean {
  try {
    return spawnSync("git", ["rev-parse", "--verify", "-q", ref], gitOpts(root)).status === 0;
  } catch {
    return false;
  }
}

/** Prefer the remote-tracking ref `origin/<branch>` when it exists, else the local branch name. */
function resolveRef(root: string, branch: string): string {
  return refExists(root, `refs/remotes/origin/${branch}`) ? `origin/${branch}` : branch;
}

/**
 * Ahead/behind of `branch` relative to `defaultBranch`. Computed against remote-tracking refs when an
 * `origin` exists (so no checkout is needed), falling back to the local default-branch tip for a
 * host-less project with no `origin` (SPEC-024). `null`/degraded when neither ref resolves.
 */
export function gitAheadBehind(
  root: string,
  defaultBranch: string,
  branch: string,
): Ok<{ ahead: number; behind: number }> {
  if (!gitAvailable()) return { ok: false, reason: "git not found on PATH" };
  const base = resolveRef(root, defaultBranch);
  const head = resolveRef(root, branch);
  if (!refExists(root, base)) return { ok: false, reason: `default ref '${base}' not found` };
  if (!refExists(root, head)) return { ok: false, reason: `branch ref '${head}' not found (no upstream?)` };
  try {
    const res = spawnSync("git", ["rev-list", "--left-right", "--count", `${base}...${head}`], gitOpts(root));
    if (res.status !== 0) return { ok: false, reason: (res.stderr || "git rev-list failed").trim() };
    // `--left-right --count A...B` prints "<left>\t<right>": left = commits in A not B (behind),
    // right = commits in B not A (ahead).
    const [behindStr, aheadStr] = (res.stdout ?? "").trim().split(/\s+/);
    const behind = Number(behindStr);
    const ahead = Number(aheadStr);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { ok: false, reason: "unparseable rev-list output" };
    return { ok: true, ahead, behind };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Added/removed lines and changed-file count for `branch` relative to `defaultBranch`, via
 * `git diff --numstat`. Same remote-tracking-vs-local ref resolution as {@link gitAheadBehind}.
 * Binary files (numstat reports "-\t-") count toward `files` but not the line totals.
 */
export function gitDiffStat(
  root: string,
  defaultBranch: string,
  branch: string,
): Ok<{ added: number; removed: number; files: number }> {
  if (!gitAvailable()) return { ok: false, reason: "git not found on PATH" };
  const base = resolveRef(root, defaultBranch);
  const head = resolveRef(root, branch);
  if (!refExists(root, base)) return { ok: false, reason: `default ref '${base}' not found` };
  if (!refExists(root, head)) return { ok: false, reason: `branch ref '${head}' not found (no upstream?)` };
  try {
    const res = spawnSync("git", ["diff", "--numstat", base, head], gitOpts(root));
    if (res.status !== 0) return { ok: false, reason: (res.stderr || "git diff failed").trim() };
    let added = 0;
    let removed = 0;
    let files = 0;
    for (const line of (res.stdout ?? "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      files += 1;
      const [a, r] = trimmed.split(/\s+/);
      if (a !== "-") added += Number(a) || 0;
      if (r !== "-") removed += Number(r) || 0;
    }
    return { ok: true, added, removed, files };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The count of files with uncommitted changes in `root`'s working tree, via `git status --porcelain`.
 * This is only meaningful for whichever branch is currently checked out — the caller compares against
 * `gitHeadBranch(root)` (queried fresh) and renders `null` ("—") for any other branch (SPEC-025 Dec #4).
 */
export function gitDirtyCount(root: string): Ok<{ dirty: number }> {
  if (!gitAvailable()) return { ok: false, reason: "git not found on PATH" };
  try {
    const res = spawnSync("git", ["status", "--porcelain"], gitOpts(root));
    if (res.status !== 0) return { ok: false, reason: (res.stderr || "git status failed").trim() };
    const dirty = (res.stdout ?? "").split("\n").filter((l) => l.trim().length > 0).length;
    return { ok: true, dirty };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The open/draft PR state (and number) for `branch` via `gh pr view`. Read-only. The caller MUST gate
 * this behind the project's GitHub integration being configured — an unconfigured/host-less project
 * should never shell `gh` on a timer (SPEC-025 Dec #6). `pr === null` means "no open PR is linked"; a
 * failure returns `{ ok: false }` so the field renders "unknown", not "none".
 */
export function githubPrStatus(root: string, branch: string): Ok<{ pr: { number: number; status: "open" | "draft" } | null }> {
  try {
    const res = spawnSync(
      "gh",
      ["pr", "view", branch, "--json", "number,state,isDraft"],
      { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: { ...process.env } },
    );
    // `gh pr view` exits non-zero when there is no PR for the branch — that is a VERIFIED "none",
    // not an error, so long as gh itself ran. Distinguish "gh missing/errored" from "no PR".
    if (res.error) return { ok: false, reason: res.error.message };
    if (res.status !== 0) {
      const stderr = (res.stderr ?? "").toLowerCase();
      if (stderr.includes("no pull requests found") || stderr.includes("no open pull requests")) {
        return { ok: true, pr: null };
      }
      return { ok: false, reason: (res.stderr || "gh pr view failed").trim().slice(0, 200) };
    }
    const parsed = JSON.parse(res.stdout ?? "{}") as { number?: number; state?: string; isDraft?: boolean };
    if (parsed.state !== "OPEN" || typeof parsed.number !== "number") return { ok: true, pr: null };
    return { ok: true, pr: { number: parsed.number, status: parsed.isDraft ? "draft" : "open" } };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Repository identity for the panel header: name, remote URL, default branch, and HEAD short SHA. */
export function gitRepoIdentity(root: string): RepoIdentityView {
  const remote = (() => {
    try {
      const res = spawnSync("git", ["remote", "get-url", "origin"], gitOpts(root));
      return res.status === 0 ? (res.stdout ?? "").trim() : "";
    } catch {
      return "";
    }
  })();
  const head = (() => {
    try {
      const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], gitOpts(root));
      return res.status === 0 ? (res.stdout ?? "").trim() : "";
    } catch {
      return "";
    }
  })();
  // Prefer "owner/repo" from the remote url when present; else the folder name.
  const name = (() => {
    const m = remote.match(/([^/:]+\/[^/]+?)(?:\.git)?$/);
    return m && m[1] ? m[1] : basename(root);
  })();
  return { name, remote, default: gitDefaultBranch(root) ?? "", head };
}

/**
 * Compute the full {@link RepoStatusView} for one specification branch, assembling the per-field results
 * above and recording a `degraded[]` entry for each field that could not be computed. `dirty` is only
 * populated when `branch` is the branch currently checked out in `root` (queried fresh, not cached).
 * `prNumberFallback` (SPEC-008's webhook-tracked number) is used only when `gh` itself can't be queried.
 */
export function computeRepoStatus(opts: {
  root: string;
  specId: string;
  branch: string;
  defaultBranch: string;
  ghEnabled: boolean;
  prNumberFallback?: number;
}): RepoStatusView {
  const { root, specId, branch, defaultBranch, ghEnabled, prNumberFallback } = opts;
  const degraded: NonNullable<RepoStatusView["degraded"]> = [];

  const ab = gitAheadBehind(root, defaultBranch, branch);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (ab.ok) {
    ahead = ab.ahead;
    behind = ab.behind;
  } else {
    degraded.push({ field: "ahead", reason: ab.reason });
    degraded.push({ field: "behind", reason: ab.reason });
  }

  const ds = gitDiffStat(root, defaultBranch, branch);
  let added: number | null = null;
  let removed: number | null = null;
  let files: number | null = null;
  if (ds.ok) {
    added = ds.added;
    removed = ds.removed;
    files = ds.files;
  } else {
    degraded.push({ field: "diff", reason: ds.reason });
  }

  // Dirty is only defined for the checked-out branch (SPEC-025 Dec #4). Query HEAD fresh.
  let dirty: number | null = null;
  if (gitHeadBranch(root) === branch) {
    const dc = gitDirtyCount(root);
    if (dc.ok) dirty = dc.dirty;
    else degraded.push({ field: "dirty", reason: dc.reason });
  }

  // PR status: gated behind an integration being configured. When disabled, mark unknown (degraded)
  // and surface the webhook-tracked number as a display fallback if we have one.
  let pr: RepoStatusView["pr"] = null;
  if (!ghEnabled) {
    pr = prNumberFallback !== undefined ? { number: prNumberFallback, status: null } : null;
    degraded.push({ field: "pr", reason: "GitHub integration not configured" });
  } else {
    const ph = githubPrStatus(root, branch);
    if (ph.ok) {
      pr = ph.pr;
    } else {
      pr = prNumberFallback !== undefined ? { number: prNumberFallback, status: null } : null;
      degraded.push({ field: "pr", reason: ph.reason });
    }
  }

  return {
    specId,
    branch,
    ahead,
    behind,
    dirty,
    added,
    removed,
    files,
    pr,
    ...(degraded.length ? { degraded } : {}),
  };
}
