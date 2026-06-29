import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolves a `credentialsRef` to a secret on the coordinator host (SPEC-005, NFR-1). The secret is
 * read here and used only inside the coordinator process — it is never returned to the client, and
 * the ref string itself is excluded from every client-facing payload. Three backends:
 *
 * - `env:NAME`        — a host environment variable.
 * - `file:path`       — a file under a configured safe root; the path is canonicalised and any
 *                       attempt to traverse outside the safe root is rejected before the read.
 * - `keychain:key`    — the OS keychain, via an injected reader (none configured → a clear error).
 *
 * A bare ref with no scheme (e.g. `opencode/gateway`) defaults to the `env:` backend, mapping the
 * ref to an env var name by upper-casing and replacing non-alphanumerics with `_`
 * (`opencode/gateway` → `OPENCODE_GATEWAY`).
 */

/** A `file:` credentialsRef whose path would resolve outside the configured safe root (NFR-1). */
export class CredentialPathError extends Error {
  constructor(
    readonly candidate: string,
    readonly safeRoot: string,
  ) {
    super(`credential path '${candidate}' resolves outside the safe root '${safeRoot}'`);
    this.name = "CredentialPathError";
  }
}

/** A credentialsRef that names a backend the resolver cannot serve. */
export class CredentialBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialBackendError";
  }
}

export interface CredentialResolverOptions {
  /** The only directory a `file:` ref may read from; paths are canonicalised and confined to it. */
  safeRoot: string;
  /** Environment for the `env:` backend (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Optional OS-keychain reader for the `keychain:` backend. */
  keychain?: (key: string) => Promise<string | undefined>;
}

export class CredentialResolver {
  private readonly safeRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly keychain?: (key: string) => Promise<string | undefined>;

  constructor(opts: CredentialResolverOptions) {
    this.safeRoot = canonicalise(opts.safeRoot);
    this.env = opts.env ?? process.env;
    if (opts.keychain) this.keychain = opts.keychain;
  }

  /** Resolve a ref to its secret value, or `undefined` when the source has no value configured. */
  async resolve(ref: string): Promise<string | undefined> {
    const colon = ref.indexOf(":");
    if (colon > 0) {
      // A scheme is present: it must name a backend we support. An unknown scheme (`vault:…`) or a
      // typo (`envr:…`) is a configuration error, not a bare env ref — fail clearly rather than
      // silently reading the wrong variable.
      const scheme = ref.slice(0, colon);
      const rest = ref.slice(colon + 1);
      switch (scheme) {
        case "env":
          return this.env[rest];
        case "file":
          return this.readFile(rest);
        case "keychain":
          return this.readKeychain(rest);
        default:
          throw new CredentialBackendError(
            `unsupported credential backend '${scheme}:' — use env:, file:, or keychain:`,
          );
      }
    }
    // No scheme → env backend with a normalised key.
    return this.env[toEnvKey(ref)];
  }

  /** Read a file confined to the safe root; reject traversal before opening it. NFR-1. */
  private readFile(path: string): string {
    const resolved = isAbsolute(path) ? resolve(path) : resolve(this.safeRoot, path);
    // Lexical check first (covers a not-yet-existing path), then re-check the canonical real path so
    // a symlink inside the root pointing out is also refused.
    if (!isWithin(this.safeRoot, resolved)) throw new CredentialPathError(path, this.safeRoot);
    let real = resolved;
    try {
      real = realpathSync.native(resolved);
    } catch {
      // not on disk — the lexical check above is the best we can do; let the read surface ENOENT
    }
    if (!isWithin(this.safeRoot, real)) throw new CredentialPathError(path, this.safeRoot);
    return readFileSync(resolved, "utf8").replace(/\r?\n$/, "");
  }

  private async readKeychain(key: string): Promise<string | undefined> {
    if (!this.keychain) {
      throw new CredentialBackendError(
        "keychain credential backend is not configured on this host",
      );
    }
    return this.keychain(key);
  }
}

/** Upper-case + non-alphanumerics→`_` for the bare-ref env mapping (`a/b-c` → `A_B_C`). */
function toEnvKey(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

function canonicalise(root: string): string {
  const abs = resolve(root);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** True when `candidate` (absolute) is the root itself or strictly inside it. */
function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
