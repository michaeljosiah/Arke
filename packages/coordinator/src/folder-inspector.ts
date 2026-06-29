import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Classifies an opened folder so the initialisation screen knows exactly what to offer
 * (SPEC-004). Deliberately a fast, deterministic sentinel check — not a full tree walk:
 *
 * - `method-ready`     — all sentinels present → open straight into the spec library
 * - `partial-scaffold` — some (but not all) sentinels present → explain precisely what is missing
 * - `has-code`         — source files but no sentinels → offer a full scaffold, warn about code
 * - `empty`            — no source files, no sentinels → fresh start
 *
 * It never reads, modifies, or deletes any file — only `existsSync`/`statSync` probes.
 */
export type FolderState = "method-ready" | "partial-scaffold" | "has-code" | "empty";

export interface FolderClassification {
  state: FolderState;
  /** The method-ready sentinels that are absent (empty when method-ready). */
  missingSentinels: string[];
}

/**
 * The sentinels that together mark a repository as method-ready. `.arke/config.json` is included
 * because the harness/model registry is required for a usable project (a scaffold that crashed after
 * the first `config` step, or an older repo with the agent/spec sentinels but no registry, must
 * classify as partial — so init prompts to finish — not method-ready).
 */
export const METHOD_READY_SENTINELS = [
  ".arke/config.json",
  ".opencode/agents",
  "docs/specifications",
  "AGENTS.md",
] as const;

/** File extensions that count as "source" when deciding has-code vs empty. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".scala", ".clj", ".ex", ".exs",
]);

/** Directories that never count as source code when scanning for has-code vs empty. */
const IGNORED_DIRS = new Set([".git", "node_modules", ".arke", ".repos", ".opencode", "dist", "build"]);

export const FolderInspector = {
  classify(folder: string): FolderClassification {
    const root = resolve(folder);
    const present = METHOD_READY_SENTINELS.filter((s) => existsSync(resolve(root, s)));
    const missingSentinels = METHOD_READY_SENTINELS.filter((s) => !present.includes(s));

    if (present.length === METHOD_READY_SENTINELS.length) {
      return { state: "method-ready", missingSentinels: [] };
    }
    if (present.length > 0) {
      return { state: "partial-scaffold", missingSentinels };
    }
    // No sentinels: distinguish a folder with real source from a pristine/empty one.
    return {
      state: hasSourceFiles(root) ? "has-code" : "empty",
      missingSentinels,
    };
  },
};

/** Shallow-ish scan for any source file, skipping VCS/build/scaffold dirs. Bounded by design. */
function hasSourceFiles(root: string, depth = 0): boolean {
  if (depth > 3) return false;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  const subdirs: string[] = [];
  for (const name of entries) {
    const full = resolve(root, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (!IGNORED_DIRS.has(name) && !name.startsWith(".")) subdirs.push(full);
      continue;
    }
    const dot = name.lastIndexOf(".");
    if (dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot))) return true;
  }
  return subdirs.some((d) => hasSourceFiles(d, depth + 1));
}
