import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { FolderInspector, type FolderState } from "./folder-inspector.js";
import { InputValidator, ValidationError } from "./input-validator.js";
import { loadGlobalConfig } from "./global-config.js";
import { CLONE_TIMEOUT_MS, gitAvailable, gitCloneAsync } from "./project-context.js";

/**
 * The **workspace root** and the supervisor-level folder operations that let the browser open, clone,
 * or create a project *anywhere the user is allowed to* — without ever touching the filesystem itself
 * (SPEC-018). A browser can't browse or name a host path, so the coordinator does it: it lists
 * directories, clones, and creates folders, all **bounded to the workspace root** so a client can
 * never enumerate or write outside it. After a browse/clone/create the client calls `project.open`
 * with the returned path.
 */

/**
 * Resolve the workspace root that bounds all folder operations. Precedence: `ARKE_WORKSPACE_ROOT`
 * env → the global config `settings.workspaceRoot` → the directory that CONTAINS the current project
 * (so sibling projects are visible out of the box, rather than the whole home dir).
 */
export function resolveWorkspaceRoot(env: NodeJS.ProcessEnv = process.env, projectRoot?: string): string {
  const explicit = env.ARKE_WORKSPACE_ROOT?.trim() || loadGlobalConfig()?.settings?.workspaceRoot;
  if (explicit) return resolve(explicit);
  return dirname(resolve(projectRoot ?? env.ARKE_PROJECT_ROOT ?? process.cwd()));
}

/** True when `candidate` (absolute) is the root itself or strictly inside it. */
function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface BrowseEntry {
  name: string;
  path: string;
  /** True when the directory is already an Arke project (has an `.arke/`). */
  isProject: boolean;
}
export interface BrowseResult {
  root: string;
  path: string;
  /** The parent directory to navigate up to, or null when at (or above) the workspace root. */
  parent: string | null;
  entries: BrowseEntry[];
}

/** List the immediate subdirectories of `rawPath` (default = the workspace root), bounded to the root. */
export function browseDirectory(workspaceRoot: string, rawPath?: unknown): BrowseResult {
  const root = resolve(workspaceRoot);
  const path =
    typeof rawPath === "string" && rawPath.trim() ? InputValidator.canonicalisePath(rawPath, root) : root;
  let names: string[] = [];
  try {
    names = readdirSync(path);
  } catch {
    /* unreadable directory → empty listing rather than an error */
  }
  const entries: BrowseEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // hide dot dirs (.git, .arke, …) from the browser
    const full = resolve(path, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push({ name, path: full, isProject: existsSync(resolve(full, ".arke")) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parentDir = dirname(path);
  const parent = path !== root && isWithin(root, parentDir) ? parentDir : null;
  return { root, path, parent, entries };
}

export interface CloneResult {
  path: string;
  name: string;
  state: FolderState;
}

/** Clone `url` into `<dest ?? workspaceRoot>/<name>` (bounded), returning the classified target. */
export async function cloneIntoWorkspace(
  workspaceRoot: string,
  rawUrl: unknown,
  rawDest?: unknown,
  rawName?: unknown,
): Promise<CloneResult> {
  const root = resolve(workspaceRoot);
  const url = InputValidator.validateCloneUrl(String(rawUrl ?? ""));
  const dest = destDir(root, rawDest);
  const name = cleanName(typeof rawName === "string" && rawName.trim() ? rawName : deriveNameFromUrl(url));
  const target = InputValidator.canonicalisePath(name, dest); // a single segment within dest ⊆ root
  if (existsSync(target)) throw new ValidationError("name", `'${name}' already exists in the destination`);
  if (!gitAvailable()) throw new Error("git not found on PATH; cannot clone");
  await gitCloneAsync(url, target, CLONE_TIMEOUT_MS);
  return { path: target, name, state: FolderInspector.classify(target).state };
}

export interface CreateResult {
  path: string;
  name: string;
}

/** Create an empty `<dest ?? workspaceRoot>/<name>` (bounded) for a greenfield project to scaffold into. */
export function createProject(workspaceRoot: string, rawDest?: unknown, rawName?: unknown): CreateResult {
  const root = resolve(workspaceRoot);
  const dest = destDir(root, rawDest);
  const name = cleanName(String(rawName ?? ""));
  const target = InputValidator.canonicalisePath(name, dest);
  if (existsSync(target)) throw new ValidationError("name", `'${name}' already exists in the destination`);
  mkdirSync(target, { recursive: true });
  return { path: target, name };
}

/** Resolve the destination directory within the workspace root (default = the root itself). */
function destDir(root: string, rawDest: unknown): string {
  return typeof rawDest === "string" && rawDest.trim() ? InputValidator.canonicalisePath(rawDest, root) : root;
}

/** A project folder name must be a single, filesystem-safe path segment (no separators, no `..`). */
function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new ValidationError("name", "a project name is required");
  if (/[\\/]/.test(name) || name === "." || name === ".." || name.includes("\0")) {
    throw new ValidationError("name", `'${raw}' is not a valid folder name`);
  }
  return name;
}

/** Derive a folder name from a clone URL's last path segment, stripping a trailing `.git`. */
function deriveNameFromUrl(url: string): string {
  const last = url.split(/[/:]/).filter(Boolean).pop() ?? "repo";
  return last.replace(/\.git$/i, "") || "repo";
}
