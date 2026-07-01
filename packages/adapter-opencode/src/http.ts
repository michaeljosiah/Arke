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
    /** Bounded, human-readable detail extracted from the error response body (never credentials). */
    readonly detail?: string,
  ) {
    super(`OpenCode ${method} ${path} → ${status} ${statusText}${detail ? ` — ${detail}` : ""}`);
    this.name = "OpenCodeError";
  }
}

/**
 * Extract a bounded, human-readable reason from an OpenCode error body. OpenCode returns
 * `{ name, data: { message, ref? } }`; fall back to a raw-text excerpt for anything else. Without
 * this the engineer sees a bare "500 Internal Server Error" with no way to diagnose it.
 */
export function errorDetailFrom(bodyText: string): string | undefined {
  const text = bodyText.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { name?: string; data?: { message?: string; ref?: string } };
    const parts = [parsed.name, parsed.data?.message, parsed.data?.ref ? `(ref ${parsed.data.ref})` : undefined]
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    if (parts.length > 0) return parts.join(": ").replace(/: \(ref/, " (ref").slice(0, 300);
  } catch {
    /* not JSON — use the raw excerpt */
  }
  return text.slice(0, 200);
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

  /** JSON request; throws {@link OpenCodeError} (with body detail) on a non-2xx status. */
  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // Surface WHY: OpenCode's error body names the failure (e.g. UnknownError + a ref) — a bare
      // status code left the engineer staring at "500 Internal Server Error" with nothing to act on.
      const errText = await res.text().catch(() => "");
      throw new OpenCodeError(method, path, res.status, res.statusText, errorDetailFrom(errText));
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Open the SSE stream; the caller parses the body. */
  async openEventStream(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(this.url("/global/event"), {
      headers: this.headers({ Accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new OpenCodeError("GET", "/global/event", res.status, res.statusText);
    }
    return res.body;
  }
}
