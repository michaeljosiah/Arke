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
    // Byte-for-byte the SPEC-031 wording buildDeliveryPrompt emitted before the seam. `--base <branch>` only
    // when a base is given (the caller vets it for shell-safety and passes undefined otherwise).
    const baseFlag = baseBranch ? ` --base ${baseBranch}` : "";
    const target = baseBranch ? `the ${baseBranch} branch` : "the repository's default branch";
    const command = `gh pr create${baseFlag} --fill`;
    return {
      command,
      lines: [
        "When every task is checked off, open a pull request for your changes so this delivery can be reviewed",
        `and merged: make sure both your current branch and ${target} are pushed to the remote (push whichever`,
        `is missing), then run \`${command}\` (it opens a PR from your current branch into`,
        `${target}). This project is configured to open the PR automatically on delivery — the engineer has`,
        "pre-authorised it, so do not stop to ask for a separate diff approval first.",
      ],
    };
  }
}
