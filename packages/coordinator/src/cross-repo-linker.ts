import { gitRepoIdentity } from "./git-status.js";
import type { ProjectContext } from "./project-context.js";

/**
 * Normalise a repo reference — a git remote URL (`git@github.com:acme/widgets.git`,
 * `https://github.com/acme/widgets`) or an `org/repo` slug — to a portable, lowercased `org/repo`
 * (SPEC-030). The last two path segments are the match key, so a spec's `repo: acme/widgets` resolves
 * against a project whose `origin` remote is any URL form ending in `acme/widgets(.git)`.
 */
export function normalizeRepoSlug(ref: string): string {
  const m = ref.trim().replace(/\.git$/i, "").match(/([^/:]+\/[^/]+?)$/);
  return (m?.[1] ?? ref.trim()).toLowerCase();
}

/** The narrow, whitelisted surface the linker invokes on a TARGET project context — each executed by that
 *  context on its OWN files/trace (SPEC-018 isolation; a context never reaches into a peer's filesystem). */
export interface RippleTarget {
  readonly projectId: string;
  /** (Re)generate the read-only pointer stub for a canonical spec into this project; idempotent + traced. */
  writePointerStub(ref: CanonicalRef): { ok: boolean; path?: string; changed?: boolean; reason?: string };
  /** Mark this project's ripples of `ref` stale (a canonical change happened); returns how many were marked. */
  markRipplesStaleFor(ref: CanonicalRef, trigger: string): Promise<number>;
}

/** A reference to a canonical spec, carried across contexts by value (never a live object). */
export interface CanonicalRef {
  repo: string; // the canonical project's org/repo slug
  specId: string;
  title: string;
  status: string;
  capabilities: string[];
  /** Normative hash of the canonical at the time of the reference (staleness anchor). */
  normativeHash: string;
}

/** The local id a pointer stub carries as its `spec_id` (and the key its staleness is tracked under). */
export function pointerStubId(canonicalSpecId: string): string {
  return `ripple-${canonicalSpecId}`.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** The deterministic filename for a canonical's generated pointer stub in a target repo's docs/specifications/. */
export function pointerStubFilename(canonicalSpecId: string): string {
  return `${pointerStubId(canonicalSpecId)}.md`;
}

/**
 * Render a canonical spec's read-only pointer stub (SPEC-030) — a deterministic projection of its
 * frontmatter + summary, carrying `canonical:` back-reference frontmatter (so the target repo's own
 * `parseLinkage` recognises it as a ripple) and a "generated — do not hand-edit" marker (the SPEC-026
 * posture). It NEVER copies requirement bodies — a stub is a pointer, not a mirror. Byte-deterministic for
 * a given ref, so regeneration is idempotent.
 */
export function renderPointerStub(ref: CanonicalRef): string {
  const caps = ref.capabilities.length ? ref.capabilities.join(", ") : "—";
  return `---
spec_id: ${pointerStubId(ref.specId)}
title: ${ref.title} (cross-repo pointer)
status: ${ref.status}
type: pointer
generated: true
canonical:
  repo: ${ref.repo}
  spec: ${ref.specId}
---

<!-- GENERATED POINTER — do not hand-edit. This repository is affected by a specification whose canonical
     copy lives in ${ref.repo}. Regenerated deterministically by the Arke coordinator (SPEC-030). Edit the
     canonical specification, not this stub. -->

# ${ref.title} — cross-repo pointer

This repository is affected by **${ref.specId}** (\`${ref.title}\`), whose **canonical** specification lives
in **${ref.repo}**.

- **Canonical status:** ${ref.status}
- **Capabilities:** ${caps}

There is no local contract change in this repository for this specification — this file is a pointer, not a
copy. See the canonical specification in \`${ref.repo}\` for the full requirements and history.
`;
}

/**
 * Supervisor-mediated cross-repo linkage (SPEC-030) — the first cross-context service in Arke. Resolves a
 * ripple's `org/repo` slug to a registered {@link ProjectContext} (via each context's git remote) and
 * brokers cross-context work to that TARGET context's own narrow methods. The linker itself performs no
 * file IO and holds no linkage state: the specification frontmatter is the source of truth, and each
 * context owns its own files/trace (SPEC-018 / NFR-1). It reads the live context map lazily, so peers that
 * open after construction resolve correctly.
 */
export class CrossRepoLinker {
  constructor(private readonly contexts: () => Iterable<ProjectContext>) {}

  /** The registered context whose `origin` remote resolves to `repo`, or null (unresolved → inert). */
  resolve(repo: string): ProjectContext | null {
    const want = normalizeRepoSlug(repo);
    for (const ctx of this.contexts()) {
      try {
        if (normalizeRepoSlug(gitRepoIdentity(ctx.root).name) === want) return ctx;
      } catch {
        /* a context whose git identity can't be read is skipped, not fatal */
      }
    }
    return null;
  }

  /** The registered `projectId` for `repo`, or null when unresolved. */
  resolveId(repo: string): string | null {
    return this.resolve(repo)?.projectId ?? null;
  }
}
