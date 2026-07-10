import { githubPrStatus } from "../git-status.js";
import { mapWebhookEvent, verifyGithubSignature } from "../spec-lifecycle.js";
import { parseRemote } from "./remote.js";
import type { AutoOpenPrInstruction, ForgeAdapter, LifecycleTransition, NormalizedRemote, PrStatusResult } from "./types.js";

/**
 * The GitHub forge leaf (SPEC-038). Behaviour-preserving: it DELEGATES to the existing, tested coordinator
 * functions (`verifyGithubSignature`, `mapWebhookEvent`, `githubPrStatus`) so the GitHub path is byte-for-byte
 * unchanged. Only the surface moves behind the neutral `ForgeAdapter`; the logic is the same code.
 */
export class GitHubForge implements ForgeAdapter {
  readonly id = "github" as const;

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, secret: string): boolean {
    const sig = headers["x-hub-signature-256"];
    return verifyGithubSignature(secret, rawBody, Array.isArray(sig) ? sig[0] : sig);
  }

  mapWebhookEvent(eventName: string, payload: unknown): LifecycleTransition {
    return mapWebhookEvent(eventName, payload);
  }

  pullRequestStatus(root: string, branch: string): PrStatusResult {
    return githubPrStatus(root, branch);
  }

  normalizeRemote(url: string | undefined): NormalizedRemote | null {
    return parseRemote(url);
  }

  autoOpenPrInstruction(baseBranch: string | undefined): AutoOpenPrInstruction {
    // Preserves the SPEC-031 wording; `--base <branch>` only when the base is shell-safe (the caller vets it).
    const baseFlag = baseBranch ? ` --base ${baseBranch}` : "";
    const command = `gh pr create${baseFlag} --fill`;
    return {
      command,
      lines: [
        "When every task is checked off, open a pull request for your changes so this delivery can be reviewed",
        `and merged: make sure both your current branch and ${baseBranch ?? "the base branch"} are pushed to the`,
        `remote (push whichever is missing), then run \`${command}\` (it opens a PR from your current branch`,
        `into ${baseBranch ?? "the base branch"}). This project is configured to open the PR automatically.`,
      ],
    };
  }
}
