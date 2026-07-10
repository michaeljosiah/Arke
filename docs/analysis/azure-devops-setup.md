# Azure DevOps (Azure Repos) setup

*Implements SPEC-038 — Azure Repos as a lifecycle host behind the neutral `ForgeAdapter` seam.*

Arke drives a specification's lifecycle (`draft → in-review → approved → delivered`) from **pull-request /
branch state**. For a project whose code lives in **Azure Repos**, that signal arrives as Azure DevOps
**Service Hooks** (verified via HTTP Basic auth) instead of GitHub webhooks, and PRs are opened/read via the
`az` CLI instead of `gh`. Everything else — plain git, branch-based routing, the state machine, the board — is
identical to a GitHub project. **v1 is the lifecycle host only**; Azure Boards work-item projection and Azure
Pipelines CI-gate status are separate follow-ups.

The forge is chosen automatically: a project whose `origin` remote is `dev.azure.com/{org}/{project}/_git/{repo}`
(or the legacy `{org}.visualstudio.com/{project}/_git/{repo}`) resolves the **Azure Repos forge**; a
`github.com` / unrecognised / absent remote stays on GitHub. No config is required for detection, though an
`.arke/config.json` `forge` block can force it.

## 1. Point the project at its Azure remote

```bash
git remote -v          # confirm origin is https://dev.azure.com/<org>/<project>/_git/<repo>
```

SSH (`git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`) is recognised too.

## 2. Give the coordinator a host-side PAT (never persisted)

The `az` CLI reads a **Personal Access Token** from its environment. Arke keeps host credentials host-side and
**never** writes them to disk, the wire, or logs (NFR-1). Reconciled with the existing work-item integration,
Arke reads the PAT from **`AZURE_DEVOPS_PAT`** and seeds the CLI's own `AZURE_DEVOPS_EXT_PAT` from it at
call-time — set just the one variable in the environment that launches the coordinator/CLI:

```bash
export AZURE_DEVOPS_PAT='<pat-with-Code(Read&Write)+PullRequest scopes>'
```

Scopes needed: **Code (Read & Write)** to open PRs, and read access to list PR status.

> The `az` shell-out to `dev.azure.com` is **not** blocked by Arke's own tool-guard. That guard
> (`DEFAULT_BLOCKED_DOMAINS`, which includes `dev.azure.com`) inspects **fetch/HTTP tool calls** (`input.url`),
> not shell commands — so an agent cannot hit the Azure REST API directly, but the trusted `az`/`gh` CLIs run
> unhindered, exactly as `gh`'s `api.github.com` traffic does.

## 3. Configure the Service Hook subscriptions (Basic auth)

Azure DevOps Service Hooks are configured **one subscription per event type**. In
**Project Settings → Service Hooks → + (Create subscription) → Web Hooks**, create three subscriptions, each
POSTing to your coordinator's `/webhooks/azure` endpoint:

| Trigger (event type)         | Drives                                            |
|------------------------------|---------------------------------------------------|
| **Pull request created**     | `opened` → `in-review`                            |
| **Pull request updated**     | approval (reviewer vote 10) → `approved`; completed → `delivered`; abandoned → `draft`; reactivated → `in-review` |
| **Code pushed**              | (reserved) force-push revalidation of an approved branch |

For each subscription, set:

- **URL**: `https://<your-coordinator-host>/webhooks/azure`
- **Resource details / messages to send**: *All* (the default detailed payload).
- **HTTP headers / Basic authentication**: set a **username and password** (Azure sends them as an
  `Authorization: Basic …` header). This is the credential Arke verifies — Azure does **not** HMAC-sign the
  body the way GitHub does, so verification is Basic-auth, not a signature.

Set the **same** credential on the coordinator as **`ARKE_WEBHOOK_SECRET`**, in the form `user:pass`:

```bash
export ARKE_WEBHOOK_SECRET='arke:<the-basic-auth-password-you-configured>'
```

The coordinator compares the decoded Basic-auth credential constant-time and **fails closed**: a missing or
wrong credential is rejected `401`. (For local/dev only, `ARKE_WEBHOOK_ALLOW_UNSIGNED=1` skips the check — never
in production.) For v1 this is a single coordinator-level credential shared by all projects on the host; a
per-project forge secret is a deferred follow-up (it also feeds the second-human approval gate).

## 4. (Optional) auto-open the PR on delivery

If the project enables auto-PR (SPEC-031), the delivery agent is instructed to run **`az repos pr create
--target-branch <base>`** (the Azure flags differ from `gh`'s `--base`), and the board reads PR status via
`az repos pr list`. Nothing else changes: the PR merges the delivery branch into the feature branch, the
`Pull request updated → completed` hook lands the spec as `delivered`, and the board shows the PR — end to end,
behind the same neutral seam a GitHub project uses.

## What is NOT covered in v1 (named follow-ups)

- **Azure Boards** work-item projection (the `projection.ts` `azure-devops` integration already scaffolds it on
  `AZURE_DEVOPS_PAT`/`AZURE_DEVOPS_ORG`).
- **Azure Pipelines** CI-gate status on the board.
- **Cross-repo** Azure linkage (SPEC-030's `normalizeRepoSlug` is still host-blind).
- **Per-project** forge secrets.
- Reliable **force-push** detection: Azure's `git.push` payload carries no forced flag (unlike GitHub's
  `forced: true`), so a plain push is ignored — detecting a rewrite needs a history/ancestry comparison.
