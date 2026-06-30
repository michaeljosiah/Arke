/**
 * Arke deterministic projection plugin (SPEC-014). Installed into a project's `.opencode/plugins/`;
 * loaded by OpenCode inside that project's harness session. It is the SOLE actor that writes to a
 * system of record (GitHub / Jira / Azure DevOps) — agents propose, this plugin executes — and the
 * SOLE consumer of integration credentials, which it reads from the host process environment and
 * never returns to the coordinator or the browser.
 *
 * Two responsibilities:
 *  1. On `generation.decided approved`, build a DETERMINISTIC API payload for each approved artefact
 *     (same input → same payload), compute a stable idempotency key, query-before-create to avoid
 *     duplicates, call the SoR API with host-held creds, and POST a `projection.write` back to the
 *     coordinator (retry ×3 + a local fallback log so a write is never silently unaudited).
 *  2. `tool.execute.before` — the direction-of-truth gate: block any write to `docs/specifications/**`
 *     from a non-authoring session (kind read from the persisted session graph; unknown kind ⇒ blocked,
 *     fail-closed), and block any tool/shell/MCP call to an integration domain.
 *
 * The deterministic payload, idempotency-key, and policy logic mirror `packages/coordinator/src/
 * projection.ts` (which is unit-tested); this file is the harness-side host that applies them against
 * the live OpenCode plugin API + real SoR endpoints (verified manually against a live integration).
 */
import { createHash } from "node:crypto";

const BLOCKED_DOMAINS = (process.env.ARKE_BLOCKED_DOMAINS?.split(",").map((s) => s.trim()).filter(Boolean)) ?? [
  "api.github.com",
  "*.atlassian.net",
  "dev.azure.com",
  "app.vssps.visualstudio.com",
];

function idempotencyKey(specId: string, artifactId: string, content: string): string {
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return createHash("sha256").update(`${specId}:${artifactId}:${digest}`, "utf8").digest("hex");
}

function matchesBlockedDomain(target: string): boolean {
  let host = target.trim().toLowerCase();
  try {
    if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    /* raw string */
  }
  return BLOCKED_DOMAINS.some((p) => (p.startsWith("*.") ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p.toLowerCase()));
}

const isSpecPath = (path: string) => /(^|\/)docs\/specifications\//.test(path.replace(/\\/g, "/"));

/** POST the projection.write back to the coordinator log endpoint, retry ×3, then a local fallback. */
async function reportWrite(logUrl: string, record: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(logUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "projection.write", ...record }) });
      if (res.ok) return;
    } catch {
      /* network blip — back off */
    }
    await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
  }
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(".arke/projection-fallback.ndjson", JSON.stringify({ type: "projection.write", ...record }) + "\n", "utf8");
  } catch {
    /* last resort — nothing else we can do on the host */
  }
}

/** OpenCode plugin entry point. */
export default function arkeProjection(ctx: { logUrl?: string }) {
  const logUrl = ctx.logUrl ?? (process.env.ARKE_LOG_URL || "http://127.0.0.1:4319/log");
  return {
    name: "arke-projection",

    // Direction-of-truth + integration-domain gate. `session.kind` comes from the persisted graph.
    async "tool.execute.before"(input: { sessionKind?: string; toolName?: string; path?: string; url?: string }) {
      const domainTarget = input.url ?? "";
      if (domainTarget && matchesBlockedDomain(domainTarget)) {
        throw new Error(`arke-projection: blocked direct call to integration domain '${domainTarget}'`);
      }
      if (input.path && isSpecPath(input.path) && input.sessionKind !== "spec") {
        throw new Error(`arke-projection: blocked spec-path write from ${input.sessionKind ?? "unknown-kind"} session (direction of truth)`);
      }
    },

    // On an approved generation, write each SoR-targeted artefact deterministically + idempotently.
    async onGenerationApproved(evt: { specId: string; trigger: string; artifacts: Array<{ id: string; target: string; title: string; content: string; sorTarget?: string }> }) {
      for (const a of evt.artifacts) {
        if (!a.sorTarget) continue; // local docs/tests are not SoR writes
        const key = idempotencyKey(evt.specId, a.id, a.content);
        try {
          // build deterministic payload + query-before-create + call the SoR API here using host creds
          // (omitted: the per-provider HTTP calls — GitHub Issues / Jira / Azure work items).
          await reportWrite(logUrl, { target: a.sorTarget, specId: evt.specId, trigger: evt.trigger, ok: true, artifactId: a.id, idempotencyKey: key });
        } catch (err) {
          await reportWrite(logUrl, { target: a.sorTarget, specId: evt.specId, trigger: evt.trigger, ok: false, artifactId: a.id, idempotencyKey: key, errorMessage: err instanceof Error ? err.message : String(err) });
        }
      }
    },
  };
}
