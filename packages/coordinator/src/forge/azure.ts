import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { parseRemote } from "./remote.js";
import type { AutoOpenPrInstruction, ForgeAdapter, LifecycleTransition, NormalizedRemote, PrStatusResult } from "./types.js";

const AZ_TIMEOUT_MS = 15_000;

/** Strip a `refs/heads/` prefix from an Azure ref name → the bare branch. */
function stripRefsHeads(ref: unknown): string {
  return String(ref ?? "").replace(/^refs\/heads\//, "");
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The first **human** reviewer who approved (`vote === 10`, `isContainer !== true`). Azure has no dedicated
 * review event — the whole reviewers array rides every `git.pullrequest.updated` — and a container/team
 * reviewer's vote must NOT misattribute the approver (the self-approval gate compares a real identity).
 */
function firstHumanApprover(reviewers: unknown): string | null {
  if (!Array.isArray(reviewers)) return null;
  for (const r of reviewers) {
    const rev = r as { vote?: unknown; isContainer?: unknown; uniqueName?: unknown; displayName?: unknown };
    if (Number(rev?.vote) === 10 && rev?.isContainer !== true) {
      const id = String(rev?.uniqueName ?? rev?.displayName ?? "").trim();
      if (id) return id;
    }
  }
  return null;
}

/**
 * Parse the JSON output of `az repos pr list` into the neutral `{ number, status } | null` board shape.
 * Pure + separately tested — the `gh` stderr sniff (githubPrStatus) does NOT transfer: `az` reports "no PR"
 * as an empty JSON array `[]`, not a non-zero exit. An unparseable body is a real failure (`ok: false`).
 */
export function parseAzReposPrList(stdout: string): PrStatusResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout && stdout.trim() ? stdout : "[]");
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const list = Array.isArray(parsed) ? parsed : [];
  // Only PRs still open ("active") count; drafts are flagged by isDraft. Azure filters by branch itself.
  const open = list.find((p) => String((p as { status?: unknown })?.status ?? "active").toLowerCase() === "active");
  if (!open) return { ok: true, pr: null };
  const item = open as { pullRequestId?: unknown; isDraft?: unknown };
  const number = Number(item?.pullRequestId);
  if (!Number.isFinite(number)) return { ok: true, pr: null };
  return { ok: true, pr: { number, status: item?.isDraft === true ? "draft" : "open" } };
}

/**
 * The Azure Repos forge leaf (SPEC-038). Maps Azure DevOps **Service Hook** events to the SAME neutral
 * `LifecycleTransition`s the GitHub forge produces, verifies via Azure's **HTTP Basic auth** model (NOT an
 * HMAC — Azure Service Hooks do not sign the payload), and reads/opens PRs via the `az` CLI.
 */
export class AzureReposForge implements ForgeAdapter {
  readonly id = "azure-repos" as const;

  /**
   * Azure Service Hooks authenticate with **HTTP Basic auth** (the subscription's configured credential),
   * NOT GitHub's `X-Hub-Signature-256` HMAC (SPEC-038 Decision #3). `rawBody` is intentionally unused — there
   * is no body signature to check. Fail-closed: no/blank secret, missing/malformed header, or mismatch → false.
   * The configured `secret` is the expected `user:pass` credential, compared constant-time.
   */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, _rawBody: string, secret: string): boolean {
    if (!secret) return false;
    const auth = headerValue(headers["authorization"]);
    if (!auth) return false;
    const m = /^Basic\s+(.+)$/i.exec(auth.trim());
    if (!m) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(m[1]!, "base64").toString("utf8");
    } catch {
      return false;
    }
    const a = Buffer.from(decoded);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Map an Azure Service Hook to a neutral {@link LifecycleTransition}. The event type lives in the payload
   * (`eventType`), not a header, so we read it there (falling back to the passed `eventName`). Because Azure
   * has no dedicated review event, `git.pullrequest.updated` carries the whole PR resource and must be
   * disambiguated: completed → merged, abandoned → closed-unmerged, a human vote===10 → approved, else
   * active → reopened (a candidate — the coordinator applies it ONLY when the last-known status was closed,
   * making it idempotent since the same update re-fires on every edit). `git.pullrequest.created` → opened.
   */
  mapWebhookEvent(eventName: string, payload: unknown): LifecycleTransition {
    const p = (payload ?? {}) as { eventType?: unknown; resource?: unknown };
    const type = String(p?.eventType ?? eventName ?? "");
    const resource = (p?.resource ?? {}) as {
      pullRequestId?: unknown;
      status?: unknown;
      sourceRefName?: unknown;
      reviewers?: unknown;
      refUpdates?: unknown;
      isForcePush?: unknown;
    };
    const branch = stripRefsHeads(resource?.sourceRefName);
    const prNumber = Number(resource?.pullRequestId ?? 0);

    if (type === "git.pullrequest.created") {
      return { kind: "opened", branch, prNumber };
    }

    if (type === "git.pullrequest.updated") {
      const status = String(resource?.status ?? "").toLowerCase();
      if (status === "completed") return { kind: "merged", branch, prNumber };
      if (status === "abandoned") return { kind: "closed-unmerged", branch, prNumber };
      // Approval takes precedence within an active update: a fresh human vote===10 gates promotion, whereas a
      // plain active edit is a reopen candidate the coordinator no-ops unless the spec was previously closed.
      const approver = firstHumanApprover(resource?.reviewers);
      if (approver) return { kind: "approved", branch, prNumber, approver };
      if (status === "active") return { kind: "reopened", branch, prNumber };
      return { kind: "ignored", reason: `git.pullrequest.updated status '${status}'` };
    }

    if (type === "git.push") {
      // Azure's base "code pushed" payload does NOT carry a forced flag (unlike GitHub's `forced: true`);
      // reliably detecting a force-push needs a history/ancestry comparison, which is out of a pure mapper's
      // reach (a named follow-up). We honour an explicit marker if a setup provides one, else ignore.
      const forced = resource?.isForcePush === true || (p as { isForcePush?: unknown })?.isForcePush === true;
      if (forced) {
        const updates = Array.isArray(resource?.refUpdates) ? (resource!.refUpdates as unknown[]) : [];
        const first = (updates[0] ?? {}) as { name?: unknown };
        return { kind: "force-push", branch: stripRefsHeads(first?.name) };
      }
      return { kind: "ignored", reason: "git.push (Azure payload carries no force-push flag)" };
    }

    return { kind: "ignored", reason: `event '${type}'` };
  }

  /**
   * The open/draft PR for `branch` via `az repos pr list`. The Azure PAT stays host-side: the `az` CLI reads
   * `AZURE_DEVOPS_EXT_PAT`, which we seed from the reconciled `AZURE_DEVOPS_PAT` (SPEC-038; never persisted).
   * The caller MUST gate this behind the project's forge being configured (as with `gh`), so it never shells
   * `az` on a timer for an unconfigured project.
   */
  pullRequestStatus(root: string, branch: string): PrStatusResult {
    const remote = this.remoteForRoot(root);
    if (!remote) return { ok: false, reason: "no Azure remote for project" };
    try {
      const args = [
        "repos",
        "pr",
        "list",
        "--source-branch",
        `refs/heads/${branch}`,
        "--status",
        "active",
        "--organization",
        `https://${remote.host}/${remote.owner}`,
        "--project",
        remote.project ?? "",
        "--repository",
        remote.repo,
        "--output",
        "json",
      ];
      const pat = process.env.AZURE_DEVOPS_PAT ?? process.env.AZURE_DEVOPS_EXT_PAT;
      const env = { ...process.env, ...(pat ? { AZURE_DEVOPS_EXT_PAT: pat } : {}) };
      const res = spawnSync("az", args, { cwd: root, encoding: "utf8", timeout: AZ_TIMEOUT_MS, env });
      if (res.error) return { ok: false, reason: res.error.message };
      if (res.status !== 0) return { ok: false, reason: (res.stderr || "az repos pr list failed").trim().slice(0, 200) };
      return parseAzReposPrList(res.stdout ?? "");
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  normalizeRemote(url: string | undefined): NormalizedRemote | null {
    return parseRemote(url);
  }

  /**
   * The Azure auto-PR delivery instruction (SPEC-031/038). `az repos pr create` uses the current branch as
   * `--source-branch` by default and `--target-branch` for the base — its flags differ from `gh`'s `--base`,
   * so the instruction is forge-authored, not a token swap. The PAT stays host-side in `AZURE_DEVOPS_EXT_PAT`.
   */
  autoOpenPrInstruction(baseBranch: string | undefined): AutoOpenPrInstruction {
    const targetFlag = baseBranch ? ` --target-branch ${baseBranch}` : "";
    const target = baseBranch ? `the ${baseBranch} branch` : "the repository's default branch";
    const command = `az repos pr create${targetFlag}`;
    return {
      command,
      lines: [
        "When every task is checked off, open a pull request for your changes so this delivery can be reviewed",
        `and merged: make sure both your current branch and ${target} are pushed to the Azure Repos remote (push`,
        `whichever is missing), then run \`${command}\` (it opens a PR from your current branch into`,
        `${target}; add a --title if prompted). This project is configured to open the PR automatically on`,
        "delivery — the engineer has pre-authorised it, so do not stop to ask for a separate diff approval first.",
      ],
    };
  }

  /** The Azure remote (org/project/repo) for a project root, read from `origin`. */
  private remoteForRoot(root: string): NormalizedRemote | null {
    try {
      const res = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", timeout: AZ_TIMEOUT_MS });
      if (res.status !== 0) return null;
      return parseRemote((res.stdout ?? "").trim());
    } catch {
      return null;
    }
  }
}
