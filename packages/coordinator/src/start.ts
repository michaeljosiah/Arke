import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Coordinator } from "./server.js";
import { NullAdapter } from "./null-adapter.js";
import { Trace } from "./trace.js";
import { GrantStore } from "./grant-store.js";
import { ProjectRegistry } from "./project-registry.js";

/**
 * Options for {@link startCoordinator} (SPEC-022). Everything is passed EXPLICITLY — none of the
 * module-level `ARKE_*` env constants in `server.ts` (read at import time, relative to `process.cwd()`)
 * are relied on, because in a packaged Electron app `cwd` is the read-only resources dir.
 */
export interface StartCoordinatorOptions {
  /**
   * The neutral default-context root — e.g. the Electron `userData` dir. The coordinator's default
   * context binds here with a {@link NullAdapter} (NO managed harness, no `opencode` spawn), so nothing
   * is written under the app bundle before the user opens a real project.
   */
  root: string;
  /** Bind port; `0` (the default) asks the OS for an ephemeral port, returned in {@link RunningCoordinator.url}. */
  port?: number;
  /**
   * Force managed-harness mode for REAL projects opened at runtime (SPEC-016). The per-project factory
   * reads `ARKE_MANAGE_HARNESS` when it builds a project's context, so this sets that env var; the
   * neutral default context is unaffected (it uses the NullAdapter above).
   */
  manageHarness?: boolean;
  /** Override the trace / grant-store paths (default: under `<root>/.arke/`). */
  paths?: { trace?: string; grants?: string };
}

/** A coordinator started in-process, with the bound URL + the SPEC-022 lifecycle handles. */
export interface RunningCoordinator {
  /** The bound `ws://127.0.0.1:<port>` URL, handed to the renderer via the preload `coordinator.url` bridge. */
  url: string;
  /** Whether any open project has work in flight (gates quit-confirm + deferred auto-update). */
  workInFlight(): boolean;
  /** Graceful stop: transitively drains each context's trace (SPEC-015) and stops managed harnesses. */
  stop(): Promise<void>;
}

/**
 * Start a coordinator programmatically for **embedding** (SPEC-022) — the desktop shell (or any host)
 * that wants the coordinator in-process rather than via `arke up`. Constructs a {@link Coordinator}
 * directly with an explicit `root` + paths, rooting its default context at a NEUTRAL directory with a
 * {@link NullAdapter} so no harness is spawned and no `.arke/` is written under the app bundle until a
 * real project is opened. Real projects opened at runtime get their managed harness via the
 * coordinator's per-project factory (`manageHarness` forces that on). Resolves once the server is
 * listening, returning the bound URL, a `workInFlight()` query, and a graceful `stop()`.
 */
export async function startCoordinator(opts: StartCoordinatorOptions): Promise<RunningCoordinator> {
  const root = resolve(opts.root);
  const arkeDir = resolve(root, ".arke");
  try {
    mkdirSync(arkeDir, { recursive: true });
  } catch {
    /* best-effort; Trace/GrantStore surface a real write failure */
  }
  const tracePath = opts.paths?.trace ?? resolve(arkeDir, "trace.ndjson");
  const grantsPath = opts.paths?.grants ?? resolve(arkeDir, "grants.ndjson");

  // Real projects opened at runtime read `ARKE_MANAGE_HARNESS` via the per-project context factory, so
  // force it on here for the desktop; the neutral default context never spawns a harness (NullAdapter).
  if (opts.manageHarness) process.env.ARKE_MANAGE_HARNESS = "1";

  const trace = new Trace(tracePath);
  const grants = new GrantStore(grantsPath);
  grants.load();

  const coord = new Coordinator(new NullAdapter("no project open"), trace, grants, opts.port ?? 0, {
    projectRoot: root,
    registry: new ProjectRegistry(), // persist recents so the app menu can list recent projects
  });
  const port = await coord.start();

  return {
    url: `ws://127.0.0.1:${port}`,
    workInFlight: () => coord.workInFlight(),
    stop: () => coord.stop(),
  };
}
