import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { FolderState } from "./folder-inspector.js";

/**
 * Durable registry of known/recent projects (SPEC-018). Lives in a GLOBAL Arke state location —
 * NOT inside any one project's `.arke/` — so recents span projects and survive a project being
 * deleted or forgotten. It holds only display-safe metadata (name, canonical path, folder state,
 * timestamps); never credentials, config, or file contents.
 */

export interface ProjectEntry {
  /** Stable id = short hash of the canonical root, so the same folder always maps to the same id. */
  projectId: string;
  name: string;
  root: string;
  lastOpenedAt: number;
  lastState: FolderState | null;
}

/** Stable project id from a canonical absolute root. */
export function projectIdForRoot(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
}

/**
 * Resolve the global Arke state directory: `ARKE_HOME` if set, else the OS-conventional location.
 * The project registry (`projects.json`) lives here, separate from per-project `.arke/` state.
 */
export function arkeHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ARKE_HOME && env.ARKE_HOME.trim()) return resolve(env.ARKE_HOME);
  if (process.platform === "win32") {
    return resolve(env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "arke");
  }
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "arke");
  }
  return resolve(env.XDG_STATE_HOME ?? resolve(homedir(), ".local", "state"), "arke");
}

interface RegistryFile {
  version: 1;
  projects: ProjectEntry[];
}

export class ProjectRegistry {
  private readonly path: string;
  private readonly persist: boolean;
  private projects = new Map<string, ProjectEntry>();
  private readonly clock: () => number;

  constructor(opts?: { path?: string; persist?: boolean; clock?: () => number }) {
    // `persist: false` gives a pure in-memory registry (no disk reads/writes) — used when no
    // global registry is injected (e.g. tests), so the coordinator never writes to the user's
    // real projects.json or into the repo working tree.
    this.persist = opts?.persist ?? true;
    this.path = opts?.path ?? resolve(arkeHome(), "projects.json");
    this.clock = opts?.clock ?? Date.now;
    this.load();
  }

  /** Restore from disk (best-effort; a corrupt/absent file yields an empty registry). */
  load(): void {
    this.projects.clear();
    if (!this.persist || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RegistryFile>;
      for (const p of parsed.projects ?? []) {
        if (p && typeof p.projectId === "string") this.projects.set(p.projectId, p as ProjectEntry);
      }
    } catch {
      // corrupt registry → treat as empty; the next upsert rewrites it cleanly
    }
  }

  /** All known projects, most-recently-opened first. */
  list(): ProjectEntry[] {
    return [...this.projects.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  get(projectId: string): ProjectEntry | undefined {
    return this.projects.get(projectId);
  }

  /**
   * Record (or refresh) a project on open/clone/scaffold. `root` MUST already be canonical/absolute.
   * Returns the stored entry. Bumps `lastOpenedAt` so it floats to the top of `list()`.
   */
  upsert(input: { root: string; name: string; state: FolderState | null }): ProjectEntry {
    const projectId = projectIdForRoot(input.root);
    const entry: ProjectEntry = {
      projectId,
      name: input.name,
      root: input.root,
      lastOpenedAt: this.clock(),
      lastState: input.state,
    };
    this.projects.set(projectId, entry);
    this.save();
    return entry;
  }

  /** Remove a project from the registry. NEVER deletes any files on disk. */
  forget(projectId: string): boolean {
    const had = this.projects.delete(projectId);
    if (had) this.save();
    return had;
  }

  private save(): void {
    if (!this.persist) return;
    const file: RegistryFile = { version: 1, projects: [...this.projects.values()] };
    const tmp = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
    renameSync(tmp, this.path); // atomic replace
  }
}
