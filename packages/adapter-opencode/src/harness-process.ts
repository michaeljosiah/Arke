import { spawn, type ChildProcess } from "node:child_process";

/**
 * A supervised harness child process (SPEC-016, managed mode).
 *
 * Spawns `opencode serve` (or any harness command), scoped to the project root with host-only
 * credentials in the child's environment, waits for it to become healthy, and stops it cleanly.
 * Arke owns only what it starts: in attach mode this is never constructed, and `stop` is a no-op
 * for a server it did not spawn.
 */
export interface HarnessProcessOptions {
  /** argv, e.g. ["opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096"]. */
  command: string[];
  /** Working directory — the canonical project root. */
  cwd: string;
  /** Extra environment for the child (host-only credentials live here, never in the client). */
  env?: NodeJS.ProcessEnv;
  /** Injected readiness probe (the adapter polls the server's health endpoint). */
  healthCheck: () => Promise<boolean>;
  /** How long to wait for health before failing the start. */
  healthTimeoutMs?: number;
  /** Resolve the command through a shell (needed on Windows for `.cmd` shims). */
  shell?: boolean;
  /** Called when the child exits (expected or not). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 3_000;

export class HarnessProcess {
  private readonly opts: HarnessProcessOptions;
  private child?: ChildProcess;
  private exited = false;
  /** True when we attached to a pre-existing healthy server instead of spawning our own. */
  private adopted = false;

  constructor(opts: HarnessProcessOptions) {
    this.opts = opts;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.adopted || (this.child !== undefined && !this.exited);
  }

  /** True when {@link start} adopted an already-running server rather than spawning one. */
  get wasAdopted(): boolean {
    return this.adopted;
  }

  /** Spawn the process and resolve once it is healthy; reject if it dies or never gets healthy. */
  async start(): Promise<void> {
    const [cmd, ...args] = this.opts.command;
    if (!cmd) throw new Error("harness command is empty");
    this.exited = false;
    this.adopted = false;
    // Self-healing (SPEC-016): if a healthy server is ALREADY listening on the target endpoint —
    // e.g. a managed harness orphaned by a coordinator that crashed or was killed without a clean
    // stop (on Windows a child does not die with its parent) — ADOPT it rather than spawning a second
    // server on the same port, which would fail to bind, exit, and wedge readiness. Adopting behaves
    // like attach mode for this lifecycle: `stop` leaves the adopted server running.
    if (await this.opts.healthCheck().catch(() => false)) {
      this.adopted = true;
      return;
    }
    this.child = spawn(cmd, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: "ignore",
      shell: this.opts.shell ?? false,
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.opts.onExit?.(code, signal);
    });

    const deadline = Date.now() + (this.opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (this.exited) throw new Error("harness process exited before becoming healthy");
      if (await this.opts.healthCheck().catch(() => false)) return;
      await delay(300);
    }
    await this.stop();
    throw new Error("harness did not become healthy within the timeout");
  }

  /** Terminate the child we started (SIGTERM, then SIGKILL after a grace period). */
  async stop(): Promise<void> {
    if (this.adopted) {
      // We attached to a server we did not spawn — leave it running (like attach mode).
      this.adopted = false;
      this.exited = true;
      return;
    }
    const child = this.child;
    if (!child || this.exited) {
      this.exited = true;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(force);
        resolve();
      };
      child.once("exit", done);
      const force = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        done();
      }, STOP_GRACE_MS);
      if (typeof force.unref === "function") force.unref();
      try {
        child.kill("SIGTERM");
      } catch {
        done();
      }
    });
    this.exited = true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}
