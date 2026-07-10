import type { LifecycleTransition } from "../spec-lifecycle.js";

/**
 * The neutral VCS/PR-host seam (SPEC-038) — the forge analogue of `HarnessAdapter`. GitHub and Azure Repos
 * are two leaves behind this interface, so the lifecycle/board/delivery code never names a specific host.
 * The forge is selected on TWO paths: at webhook ingress by the URL route (`forgeForWebhookPath`), and for
 * board/delivery by the project's git remote (`resolveForge`). Plain git ops + branch routing stay shared.
 */
export interface NormalizedRemote {
  /** The forge host, e.g. `github.com`, `dev.azure.com`, `myorg.visualstudio.com`. */
  host: string;
  /** The owner/org, e.g. `acme`. */
  owner: string;
  /** The repository name. */
  repo: string;
  /** Azure Repos only: the project between the org and the repo (`dev.azure.com/{owner}/{project}/_git/{repo}`). */
  project?: string;
}

/** A read result mirroring the coordinator's `Ok<T>` shape for PR status. */
export type PrStatusResult =
  | { ok: true; pr: { number: number; status: "open" | "draft" } | null }
  | { ok: false; reason?: string };

/** The delivery auto-PR instruction (SPEC-031), authored per forge (the CLI + flags differ). */
export interface AutoOpenPrInstruction {
  /** The command the implementer runs, e.g. `gh pr create --fill` or `az repos pr create …`. */
  command: string;
  /** Human wording for the delivery prompt describing push + open (forge-specific). */
  lines: string[];
}

export interface ForgeAdapter {
  readonly id: "github" | "azure-repos";

  /**
   * Verify an inbound webhook request against the configured secret, the forge's own way (GitHub: HMAC over
   * `X-Hub-Signature-256`; Azure: HTTP Basic auth). The server owns the "no secret configured" policy; this
   * only performs the cryptographic/credential check when a secret is present.
   */
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    secret: string,
  ): boolean;

  /** Map a host-specific webhook (event name + payload) to a neutral {@link LifecycleTransition}. */
  mapWebhookEvent(eventName: string, payload: unknown): LifecycleTransition;

  /** The open/draft PR (+ number) for a branch, normalised to the neutral shape (or `null` = no PR). */
  pullRequestStatus(root: string, branch: string): PrStatusResult;

  /** Parse a git remote URL into `{ host, owner, repo, project? }` (null when unrecognised). */
  normalizeRemote(url: string | undefined): NormalizedRemote | null;

  /** The auto-PR delivery instruction for this forge (SPEC-031), given the base branch. */
  autoOpenPrInstruction(baseBranch: string | undefined): AutoOpenPrInstruction;
}

export type { LifecycleTransition };
