import type { OmnigentConfig } from "./config.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./config.js";

/**
 * The Omnigent v1 HTTP surface (ADR-0002 spike). One place builds URLs and attaches the
 * `Authorization: Bearer` header from the host-only token. The token is never returned.
 */
export class OmnigentError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`Omnigent ${method} ${path} → ${status} ${statusText}`);
    this.name = "OmnigentError";
  }
}

export class OmnigentHttp {
  constructor(private readonly config: OmnigentConfig) {}

  url(path: string): string {
    return new URL(path, this.config.baseUrl).toString();
  }

  headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
    if (this.config.token) h.Authorization = `Bearer ${this.config.token}`;
    return h;
  }

  /** JSON request; throws {@link OmnigentError} on a non-2xx status. */
  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.url(path), {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new OmnigentError(method, path, res.status, res.statusText);
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(t);
    }
  }

  /** Open a per-session SSE stream; the caller parses the body (no replay — live-tail only). */
  async openStream(path: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(this.url(path), {
      headers: this.headers({ Accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new OmnigentError("GET", path, res.status, res.statusText);
    }
    return res.body;
  }
}
