import type { Capability, Readiness } from "@arke/contracts";

/**
 * Startup capability probe (SPEC-002). Rather than hard-coding what the adapter supports,
 * it asks the live server: health must pass, and each capability is advertised only when
 * the endpoint it depends on is present in the server's auto-generated OpenAPI (`GET /doc`).
 * A missing optional endpoint degrades the board to the server's real surface; a missing
 * *required* endpoint (the event stream) fails readiness with a clear reason — it never
 * silently assumes support.
 */

/** The minimal HTTP surface the probe needs (satisfied by {@link OpenCodeHttp}). */
export interface ProbeClient {
  req<T>(method: string, path: string): Promise<T>;
}

interface OpenApiDoc {
  paths?: Record<string, unknown>;
}

/** Each capability and the endpoint pattern that must exist for it to be advertised. */
const CAPABILITY_ENDPOINTS: ReadonlyArray<{ cap: Capability; match: RegExp }> = [
  { cap: "events", match: /^\/(global\/event|event)$/ },
  { cap: "todos", match: /^\/session\/\*\/todo$/ },
  { cap: "diff", match: /^\/session\/\*\/diff$/ },
  { cap: "permissions", match: /^\/permission\/\*\/reply$/ },
  { cap: "commands", match: /^\/session\/\*\/command$/ },
];

/** Capabilities without which the adapter cannot serve its purpose. */
const REQUIRED: ReadonlySet<Capability> = new Set<Capability>(["events"]);

/** Collapse OpenAPI path templates (`/session/{id}/todo`) to a comparable form. */
function normalizePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, "*");
}

export interface ProbeResult {
  capabilities: Set<Capability>;
  readiness: Readiness;
}

export async function probeCapabilities(client: ProbeClient): Promise<ProbeResult> {
  // 1. Health: the server must be reachable at all.
  try {
    await client.req("GET", "/global/health");
  } catch (err) {
    return {
      capabilities: new Set(),
      readiness: { ready: false, reason: `health check failed: ${reason(err)}` },
    };
  }

  // 2. Enumerate endpoints from the OpenAPI document.
  let paths: string[];
  try {
    const doc = await client.req<OpenApiDoc>("GET", "/doc");
    paths = Object.keys(doc?.paths ?? {}).map(normalizePath);
  } catch (err) {
    return {
      capabilities: new Set(),
      readiness: { ready: false, reason: `cannot probe capabilities: /doc unavailable (${reason(err)})` },
    };
  }

  const capabilities = new Set<Capability>();
  for (const { cap, match } of CAPABILITY_ENDPOINTS) {
    if (paths.some((p) => match.test(p))) capabilities.add(cap);
  }

  // 3. A required capability whose endpoint is absent fails readiness honestly.
  const missingRequired = [...REQUIRED].filter((c) => !capabilities.has(c));
  if (missingRequired.length > 0) {
    return {
      capabilities,
      readiness: {
        ready: false,
        reason: `missing required capability: ${missingRequired.join(", ")} (no matching endpoint at /doc)`,
      },
    };
  }

  return { capabilities, readiness: { ready: true } };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
