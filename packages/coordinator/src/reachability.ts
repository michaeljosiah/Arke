/**
 * Probes configured harness endpoints on launch and on a client `harness.probe` request
 * (SPEC-004). A clean failure (connection refused, timeout) is reported distinctly from a
 * partial response (the health endpoint answers but capabilities cannot be confirmed) and from
 * an HTTP error status (e.g. 503). Every result carries a human-readable `reason` — never a
 * credential value — so the guidance surface can explain *why* rather than a generic "unreachable".
 */

export interface ReachabilityResult {
  endpoint: string;
  reachable: boolean;
  /** Health responded but the capability surface could not be confirmed (distinct from a clean fail). */
  partial?: boolean;
  reason?: string;
}

/** The default per-probe window (SPEC-004 scenario: a 3-second launch probe). */
export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export class HarnessReachabilityProbe {
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts?: { timeoutMs?: number; fetchImpl?: FetchLike }) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    // Default to global fetch; tests inject a fake to exercise timeout/error/partial paths.
    this.fetchImpl = opts?.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** Probe every endpoint concurrently, returning a per-endpoint result. */
  async probe(endpoints: string[]): Promise<ReachabilityResult[]> {
    return Promise.all(endpoints.map((e) => this.probeOne(e)));
  }

  /** True if at least one endpoint is fully reachable. */
  async anyReachable(endpoints: string[]): Promise<{ reachable: boolean; results: ReachabilityResult[] }> {
    const results = await this.probe(endpoints);
    return { reachable: results.some((r) => r.reachable), results };
  }

  private async probeOne(endpoint: string): Promise<ReachabilityResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const healthUrl = this.healthUrl(endpoint);
    try {
      const res = await this.fetchImpl(healthUrl, { signal: controller.signal });
      if (!res.ok) {
        return { endpoint, reachable: false, reason: `HTTP ${res.status}` };
      }
      // Health is up; confirm the body is a parseable capability surface. If not, that is a
      // *partial* response — reported distinctly from a clean failure (SPEC-004).
      try {
        await res.json();
      } catch {
        return {
          endpoint,
          reachable: false,
          partial: true,
          reason: "health responded but capabilities could not be confirmed",
        };
      }
      return { endpoint, reachable: true };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        endpoint,
        reachable: false,
        reason: aborted ? "timeout" : err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** OpenCode (and the other drivers) expose readiness at `/health`; normalise the base URL. */
  private healthUrl(endpoint: string): string {
    const trimmed = endpoint.replace(/\/+$/, "");
    return `${trimmed}/health`;
  }
}
