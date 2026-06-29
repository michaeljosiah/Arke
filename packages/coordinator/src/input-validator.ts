import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Validates and canonicalises every client-supplied path and clone URL before any filesystem
 * or git operation (SPEC-004, NFR-1). The browser is untrusted: a path may try to escape the
 * safe root via `..`, an absolute override, or a symlink; a clone URL may be a `file://` read
 * primitive or a shell-injection string. The canonical value is what subsequent operations use;
 * the raw client value is discarded after validation.
 */

/** Raised when a client value fails validation. Surfaced to the client as a `validation-error`. */
export class ValidationError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(reason);
    this.name = "ValidationError";
  }
}

/** True when `candidate` (absolute) is the root itself or strictly inside it. */
function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve symlinks on the longest existing ancestor of `p`, re-appending the not-yet-existing
 * tail literally. A plain `realpathSync` throws when the target is absent, which would let a
 * symlinked *parent* (e.g. `safeRoot/out -> /tmp/outside`) escape the root on a later write; this
 * resolves that parent so the escape is caught.
 */
function realpathWithAncestors(p: string): string {
  const suffix: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return suffix.length ? resolve(real, ...suffix) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p; // reached the filesystem root with nothing resolvable
      suffix.unshift(basename(cur));
      cur = parent;
    }
  }
}

// A clone URL must be a well-formed git remote over https or ssh. Anything else — file://,
// a bare path, or a string carrying shell metacharacters — is rejected before git is invoked.
const SHELL_SPECIAL = /[;&|`$(){}<>\n\r\t\\"']/;

export const InputValidator = {
  /**
   * Resolve `raw` against `safeRoot`, refusing any value that escapes it (via `..`, an absolute
   * path, or a symlink that points outside). Returns the canonical absolute path. With no safe
   * root configured, the resolved absolute path is returned but traversal above the filesystem
   * mount is impossible by construction, so only obviously-malformed values are rejected.
   */
  canonicalisePath(raw: string, safeRoot: string): string {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new ValidationError("path", "path is required");
    }
    if (raw.includes("\0")) {
      throw new ValidationError("path", "path contains a null byte");
    }
    const root = resolve(safeRoot);
    const resolved = resolve(root, raw);
    // Validate the lexical resolution first (catches `..` even when the target is absent).
    if (!isWithinRoot(root, resolved)) {
      throw new ValidationError("path", `path '${raw}' resolves outside the safe root`);
    }
    // Then follow symlinks — including on existing *ancestors* of an absent target — to catch a
    // link that escapes the root before a later git clone / scaffold write follows it.
    const real = realpathWithAncestors(resolved);
    if (!isWithinRoot(root, real)) {
      throw new ValidationError("path", `path '${raw}' resolves (via symlink) outside the safe root`);
    }
    return resolved;
  },

  /**
   * Validate a git clone URL: allow only well-formed `https://` and `ssh://` remotes. Reject
   * `file://`, bare path strings, and anything with shell-special characters. Returns the
   * normalised URL string for git.
   */
  validateCloneUrl(raw: string): string {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new ValidationError("url", "clone url is required");
    }
    const url = raw.trim();
    if (SHELL_SPECIAL.test(url)) {
      throw new ValidationError("url", "clone url contains shell-special characters");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ValidationError("url", `'${url}' is not a well-formed url (bare paths are rejected)`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
      throw new ValidationError(
        "url",
        `clone url scheme '${parsed.protocol.replace(":", "")}' is not allowed; use https:// or ssh://`,
      );
    }
    if (!parsed.hostname) {
      throw new ValidationError("url", "clone url is missing a host");
    }
    // Refuse embedded credentials: they would otherwise become durable in the trace and cross the
    // credential boundary to the client (NFR-1). A password is always a secret; an https username
    // is the PAT/token pattern (`https://token@github.com/…`). SSH's `git@host` is the normal login
    // user (key-based auth), so a bare ssh username is allowed — but an ssh password is not.
    if (parsed.password || (parsed.username && parsed.protocol === "https:")) {
      throw new ValidationError("url", "clone url must not embed credentials; use SSH or a host credential helper");
    }
    return url;
  },
};
