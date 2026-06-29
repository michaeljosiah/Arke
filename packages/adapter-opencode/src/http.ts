import type { OpenCodeConfig } from "./config.js";
import { resolveDirectory } from "./config.js";

/**
 * The OpenCode HTTP surface (SPEC-002). One place builds URLs, attaches the validated
 * `directory`, and constructs the `Authorization: Basic` header from host-only credentials.
 *
 * Credential boundary: the password is held here and used only to build the request header.
 * It is never returned from any method and never placed in a value that reaches the client.
 */

export class OpenCodeError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`OpenCode ${method} ${path} → ${status} ${statusText}`);
    this.name = "OpenCodeError";
  }
}

export class OpenCodeHttp {
  private readonly config: OpenCodeConfig;
  /** Pre-validated canonical project directory applied to every request. */
  readonly directory: string;

  constructor(config: OpenCodeConfig) {
    this.config = config;
    // Canonical root validated once; never re-derived from caller input (NFR-1).
    this.directory = resolveDirectory(config.projectRoot);
  }

  /** Build an absolute URL, always scoping to the validated project directory. */
  url(path: string): string {
    const u = new URL(path, this.config.baseUrl);
    u.searchParams.set("directory", this.directory);
    return u.toString();
  }

  /** Request headers, including Basic auth when a password is configured. */
  headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
    if (this.config.password) {
      const user = this.config.username ?? "opencode";
      const token = Buffer.from(`${user}:${this.config.password}`).toString("base64");
      h.Authorization = `Basic ${token}`;
    }
    return h;
  }

  /** JSON request; throws {@link OpenCodeError} on a non-2xx status. */
  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new OpenCodeError(method, path, res.status, res.statusText);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Open the per-project SSE stream; the caller parses the body. We use `/event` (the
   * project-scoped bus, events un-wrapped as `{ id, type, properties }`) — NOT `/global/event`,
   * which is the multi-project firehose that wraps each event as `{ directory, project, payload }`
   * (the nested `payload.type` is invisible to the normalizer → every frame dead-letters). The
   * adapter already runs one OpenCode instance per project, so the project-scoped stream is correct.
   */
  async openEventStream(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(this.url("/event"), {
      headers: this.headers({ Accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new OpenCodeError("GET", "/event", res.status, res.statusText);
    }
    return res.body;
  }
}
