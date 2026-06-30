import { createHash } from "node:crypto";

/**
 * Deterministic projection + integrations registry helpers (SPEC-014). Pure and side-effect-free:
 * the stable idempotency key for a system-of-record write, the env-based integration probe, and the
 * `tool.execute.before` policy decisions (block downstream edits to the spec; block direct calls to
 * integration domains). The actual SoR writes live in the harness plugin; credentials never appear here.
 */

export type IntegrationId = "github" | "jira" | "azure-devops";
export type IntegrationStatus = "connected" | "not-configured" | "error";

export interface IntegrationRecord {
  id: IntegrationId;
  status: IntegrationStatus;
  enables: string[];
  lastCheckedAt: number;
  errorReason?: string;
}

/** Stable dedup key for a SoR write — identical content always yields the same key (crash-recovery
 *  and identical re-generation safe). `SHA-256(specId : artifactId : SHA-256(content))`. */
export function idempotencyKey(specId: string, artifactId: string, content: string): string {
  const contentDigest = createHash("sha256").update(content, "utf8").digest("hex");
  return createHash("sha256").update(`${specId}:${artifactId}:${contentDigest}`, "utf8").digest("hex");
}

/** Which env vars must be present for each integration, and what it enables. */
const INTEGRATION_ENV: Record<IntegrationId, { vars: string[]; enables: string[] }> = {
  github: { vars: ["GITHUB_TOKEN"], enables: ["issue projection"] },
  jira: { vars: ["JIRA_API_TOKEN", "JIRA_BASE_URL"], enables: ["ticket projection"] },
  "azure-devops": { vars: ["AZURE_DEVOPS_PAT", "AZURE_DEVOPS_ORG"], enables: ["work-item projection"] },
};

/**
 * Probe integration status from the environment at a given time. `connected` when all required vars
 * are present, else `not-configured`. (Liveness/401 → `error` is applied by the coordinator when a
 * real API probe runs; this pure function only reports configured-ness.) Never returns any credential.
 */
export function probeIntegrations(env: Record<string, string | undefined>, now: number): IntegrationRecord[] {
  return (Object.keys(INTEGRATION_ENV) as IntegrationId[]).map((id) => {
    const { vars, enables } = INTEGRATION_ENV[id];
    const configured = vars.every((v) => !!env[v]);
    return { id, status: configured ? "connected" : "not-configured", enables, lastCheckedAt: now };
  });
}

/** Default integration domains the policy hook blocks agents from calling directly (SPEC-014). */
export const DEFAULT_BLOCKED_DOMAINS = ["api.github.com", "*.atlassian.net", "dev.azure.com", "app.vssps.visualstudio.com"];

/** True when a host (or URL) matches a block-list entry (supports a leading `*.` wildcard). */
export function matchesBlockedDomain(target: string, blocked: string[] = DEFAULT_BLOCKED_DOMAINS): boolean {
  let host = target.trim().toLowerCase();
  try {
    if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    /* not a URL — match against the raw string */
  }
  return blocked.some((pat) => {
    const p = pat.toLowerCase();
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".atlassian.net"
      return host === p.slice(2) || host.endsWith(suffix);
    }
    return host === p;
  });
}

/** SPEC_SPEC path guard: a write to docs/specifications/** from a non-authoring session is blocked. */
export function isSpecPath(path: string): boolean {
  return /(^|\/)docs\/specifications\//.test(path.replace(/\\/g, "/"));
}

/**
 * The `tool.execute.before` decision (SPEC-014): block a spec-path write from any session that is not
 * a trusted authoring session (kind !== "spec"), including a session whose kind is unknown (fail
 * closed); block any tool call whose target matches an integration domain. Returns the block reason
 * or null to allow.
 */
export function policyDecision(input: {
  sessionKind: string | undefined;
  path?: string;
  domainTarget?: string;
  blockedDomains?: string[];
}): string | null {
  if (input.domainTarget && matchesBlockedDomain(input.domainTarget, input.blockedDomains)) {
    return `blocked: direct call to integration domain '${input.domainTarget}'`;
  }
  if (input.path && isSpecPath(input.path)) {
    if (input.sessionKind !== "spec") {
      return input.sessionKind ? `blocked: ${input.sessionKind} session may not write the spec` : "blocked: session kind unknown — spec write refused";
    }
  }
  return null;
}
