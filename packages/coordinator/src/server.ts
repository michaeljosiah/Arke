import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { DomainEvent, HarnessAdapter, ModelTier } from "@arke/contracts";
import {
  OpenCodeAdapter,
  loadOpenCodeConfig,
  type DeadLetter,
  type DeadLetterSink,
  type OpenCodeConfig,
  type ResolvedModel,
} from "@arke/adapter-opencode";
import { Trace } from "./trace.js";
import { MockAdapter } from "./mock-adapter.js";
import { NullAdapter } from "./null-adapter.js";
import { ClientConnection } from "./client-connection.js";
import { CoordinatorSessionStore } from "./session-store.js";
import { GrantStore } from "./grant-store.js";
import { ValidationError } from "./input-validator.js";
import { HarnessReachabilityProbe } from "./reachability.js";
import type { ScaffoldTiers } from "./scaffold.js";
import { ProjectRegistry, projectIdForRoot } from "./project-registry.js";
import { ProjectContext, buildDecision, type ProjectContextInit } from "./project-context.js";

/**
 * Coordinator = the single control plane (PRD §8.5; SPEC-003/018). It owns ONE WebSocket server
 * and supervises a `Map<projectId, ProjectContext>` — each context is a fully isolated project
 * (its own harness, read model, trace, stores). It does NOT spawn a coordinator per project.
 *
 * Every client connection has one **active project**; the connection's snapshot and the events it
 * receives are scoped to that project. `project.open` ensures/activates a context (reusing it if
 * already open); switching re-snapshots without stopping the prior project's runner. Idle contexts
 * are evicted under a concurrency bound; the default project is never auto-evicted.
 */
const REPO_ROOT = process.env.ARKE_PROJECT_ROOT ?? process.cwd();
const CONFIG_PATH = process.env.ARKE_CONFIG_PATH ?? resolve(REPO_ROOT, ".arke/config.json");
const PORT = Number(process.env.ARKE_COORDINATOR_PORT ?? 4319);
const TRACE_PATH = process.env.ARKE_TRACE_PATH ?? resolve(REPO_ROOT, ".arke/trace.ndjson");
const SESSION_STORE_PATH =
  process.env.ARKE_SESSION_STORE_PATH ?? resolve(REPO_ROOT, ".arke/sessions.ndjson");
const GRANT_STORE_PATH =
  process.env.ARKE_GRANT_STORE_PATH ?? resolve(REPO_ROOT, ".arke/grants.ndjson");
const MAX_PROJECTS = Number(process.env.ARKE_MAX_PROJECTS ?? 8);
const IDLE_TTL_MS = Number(process.env.ARKE_PROJECT_IDLE_MS ?? 30 * 60_000);

/** The per-project dependencies a context needs (built per root; the default comes from bootstrap). */
export interface ContextDeps {
  adapter: HarnessAdapter;
  trace: Trace;
  grants: GrantStore;
  endpoints: string[];
  tierDefaults: ScaffoldTiers;
}

/** Builds the dependencies for a project rooted at `root` (used to open projects at runtime). */
export type ContextFactory = (root: string) => Promise<ContextDeps>;

export class Coordinator {
  private clientIdSeq = 0;
  private wss?: WebSocketServer;
  private readonly abort = new AbortController();

  private readonly contexts = new Map<string, ProjectContext>();
  /** Each connection's active project id. */
  private readonly activeByConn = new Map<ClientConnection, string>();
  private defaultProjectId = "";
  private idleTimer?: ReturnType<typeof setInterval>;

  private readonly registry: ProjectRegistry;
  private readonly probe: HarnessReachabilityProbe;
  private readonly supervisorTrace: Trace; // coordinator-level log (context create/open/evict)
  private readonly defaultRoot: string;
  private readonly defaultDeps: ContextDeps;
  private readonly contextFactory: ContextFactory;
  private readonly maxProjects: number;
  private readonly idleTtlMs: number;

  constructor(
    adapter: HarnessAdapter,
    trace: Trace,
    grants: GrantStore,
    port: number = PORT,
    opts: {
      projectRoot?: string;
      endpoints?: string[];
      probe?: HarnessReachabilityProbe;
      tierDefaults?: ScaffoldTiers;
      registry?: ProjectRegistry;
      contextFactory?: ContextFactory;
      maxProjects?: number;
      idleTtlMs?: number;
    } = {},
  ) {
    this.port = port;
    this.defaultRoot = resolve(opts.projectRoot ?? REPO_ROOT);
    this.defaultDeps = {
      adapter,
      trace,
      grants,
      endpoints: opts.endpoints ?? [],
      tierDefaults: opts.tierDefaults ?? {},
    };
    this.supervisorTrace = trace;
    this.registry = opts.registry ?? new ProjectRegistry({ persist: false });
    this.probe = opts.probe ?? new HarnessReachabilityProbe();
    // Default factory builds a context from the root's own .arke/config.json; injectable for tests.
    this.contextFactory = opts.contextFactory ?? buildContextDeps;
    this.maxProjects = opts.maxProjects ?? MAX_PROJECTS;
    this.idleTtlMs = opts.idleTtlMs ?? IDLE_TTL_MS;
  }

  private readonly port: number;

  /** Start the WS server + the default project context; resolves with the actual bound port. */
  async start(): Promise<number> {
    const wss = new WebSocketServer({ port: this.port });
    this.wss = wss;
    wss.on("connection", (ws) => void this.onConnection(ws));
    await new Promise<void>((res) => wss.once("listening", () => res()));
    const addr = wss.address();
    const actual = typeof addr === "object" && addr ? addr.port : this.port;
    console.log(`[coordinator] WebSocket listening on ws://127.0.0.1:${actual}`);

    const ctx = this.addContext(this.defaultRoot, this.defaultDeps);
    this.defaultProjectId = ctx.projectId;
    console.log(
      `[coordinator] default project '${ctx.name}' adapter=${ctx.adapter.id} caps=${[...ctx.adapter.capabilities()].join(",") || "(none)"}`,
    );
    await ctx.start();

    if (this.idleTtlMs > 0) {
      this.idleTimer = setInterval(() => void this.idleSweep(), Math.min(this.idleTtlMs, 60_000));
      this.idleTimer.unref?.();
    }
    return actual;
  }

  /** Stop the listener, all contexts (and any harness each started), and close clients. */
  async stop(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.abort.abort();
    // Force-terminate any still-open client sockets so close() can never hang on a lingering client.
    for (const client of this.wss?.clients ?? []) {
      try {
        client.terminate();
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((res) => {
      if (!this.wss) return res();
      this.wss.close(() => res());
    });
    for (const ctx of this.contexts.values()) await ctx.stop();
    this.contexts.clear();
  }

  // ---- context lifecycle ---------------------------------------------------

  private addContext(root: string, deps: ContextDeps): ProjectContext {
    const projectId = projectIdForRoot(root);
    const init: ProjectContextInit = {
      projectId,
      root,
      adapter: deps.adapter,
      trace: deps.trace,
      grants: deps.grants,
      endpoints: deps.endpoints,
      tierDefaults: deps.tierDefaults,
      registry: this.registry,
      probe: this.probe,
      publish: (event) => this.fanOut(projectId, event),
    };
    const ctx = new ProjectContext(init);
    this.contexts.set(projectId, ctx);
    return ctx;
  }

  /** Ensure a context for the target (by id or path) exists and is started; reuse if already open. */
  private async ensureContext(target: { projectId?: unknown; path?: unknown }): Promise<ProjectContext> {
    let root: string;
    if (typeof target.path === "string" && target.path.trim()) {
      root = resolve(target.path);
    } else if (target.projectId) {
      const entry = this.registry.get(String(target.projectId));
      if (!entry) throw new Error(`unknown project '${String(target.projectId)}'`);
      root = entry.root;
    } else {
      throw new Error("project.open requires a projectId or path");
    }
    // Refuse a path that doesn't exist: otherwise context startup would create `.arke/` (and a
    // trace) under a typo'd root, registering a phantom empty project on disk. Opening only ever
    // attaches to an existing folder; new projects are created via clone/scaffold, not project.open.
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`project path does not exist or is not a directory: ${root}`);
    }
    const projectId = projectIdForRoot(root);
    const existing = this.contexts.get(projectId);
    if (existing) return existing; // reuse — one context per project

    if (this.contexts.size >= this.maxProjects && !(await this.evictLruIdle())) {
      throw new Error(`maximum of ${this.maxProjects} concurrent projects reached; close one first`);
    }
    const deps = await this.contextFactory(root);
    const ctx = this.addContext(root, deps);
    await this.supervisorTrace.write({ kind: "supervisor.project", action: "create", projectId, root });
    await ctx.start();
    return ctx;
  }

  /**
   * After a scaffold writes the first `.arke/config.json` into a project that opened greenfield (its
   * context holds a not-ready adapter), rebuild that context so it picks up the real harness. Without
   * this the project still holds the NullAdapter and can't create sessions or run grounding until the
   * coordinator restarts (PR #10 review). Re-snapshots the affected connections so the gate flips.
   */
  private async reloadContextIfHarnessAppeared(ctx: ProjectContext, rawPath: unknown): Promise<void> {
    // Only the in-place case: a scaffold targeting the context's OWN root. A clone scaffolds a
    // subdirectory that becomes its own context on project.open (which already builds fresh deps).
    const target = resolve(ctx.root, typeof rawPath === "string" && rawPath.trim() ? rawPath : ".");
    if (target !== ctx.root) return;
    if (ctx.adapter.readiness?.().ready !== false) return; // harness already live → nothing to do
    if (!existsSync(resolve(ctx.root, ".arke", "config.json"))) return; // no config was produced
    const projectId = ctx.projectId;
    const deps = await this.contextFactory(ctx.root);
    await ctx.stop();
    this.contexts.delete(projectId);
    const fresh = this.addContext(ctx.root, deps);
    await this.supervisorTrace.write({ kind: "supervisor.project", action: "reload", projectId, root: ctx.root });
    await fresh.start();
    // Push the fresh snapshot to every connection whose active project is this one (the harness gate
    // now reflects the newly-loaded config instead of the greenfield NullAdapter).
    for (const [c, pid] of this.activeByConn) {
      if (pid === projectId) c.sendSnapshot(JSON.stringify(fresh.snapshotPayload()));
    }
  }

  private activeCount(projectId: string): number {
    let n = 0;
    for (const pid of this.activeByConn.values()) if (pid === projectId) n += 1;
    return n;
  }

  /** Evict the least-recently-active idle, non-default, non-streaming context. Returns true if one went. */
  private async evictLruIdle(): Promise<boolean> {
    let victim: ProjectContext | undefined;
    for (const [pid, ctx] of this.contexts) {
      if (pid === this.defaultProjectId) continue;
      if (this.activeCount(pid) > 0 || ctx.streamingCount > 0) continue;
      if (!victim || ctx.lastActiveAt < victim.lastActiveAt) victim = ctx;
    }
    if (!victim) return false;
    await this.evict(victim.projectId, "lru");
    return true;
  }

  private async idleSweep(): Promise<void> {
    const now = Date.now();
    for (const [pid, ctx] of [...this.contexts]) {
      if (pid === this.defaultProjectId) continue;
      if (this.activeCount(pid) > 0 || ctx.streamingCount > 0) continue;
      if (now - ctx.lastActiveAt < this.idleTtlMs) continue;
      await this.evict(pid, "idle-timeout");
    }
  }

  private async evict(projectId: string, reason: string): Promise<void> {
    const ctx = this.contexts.get(projectId);
    if (!ctx) return;
    this.contexts.delete(projectId);
    await ctx.stop(); // stops only a harness this context started (never an attached one)
    await this.supervisorTrace.write({ kind: "supervisor.project", action: "evict", projectId, reason });
  }

  // ---- connections + routing ----------------------------------------------

  private async onConnection(ws: WebSocket): Promise<void> {
    const conn = new ClientConnection(ws, {
      id: `client-${++this.clientIdSeq}`,
      onDrop: (clientId, dropped) =>
        void this.supervisorTrace.write({ kind: "client.drop", clientId, dropped, at: Date.now() }),
    });
    // New connections default to the sole/default project (back-compat with SPEC-003/004).
    this.activeByConn.set(conn, this.defaultProjectId);
    ws.on("close", () => {
      const pid = this.activeByConn.get(conn);
      this.activeByConn.delete(conn);
      const ctx = pid ? this.contexts.get(pid) : undefined;
      if (ctx) ctx.lastActiveAt = Date.now(); // becomes idle now → eligible for later eviction
    });
    ws.on("message", (raw) => void this.onClientMessage(conn, ws, raw.toString()));
    const ctx = this.contexts.get(this.defaultProjectId);
    if (ctx) {
      await this.supervisorTrace.write({ kind: "snapshot", cardCount: ctx.cardCount(), projectId: ctx.projectId });
      conn.sendSnapshot(JSON.stringify(ctx.snapshotPayload()));
    }
  }

  /** The connection's active project context (touching its activity clock). */
  private activeCtx(conn: ClientConnection): ProjectContext {
    const pid = this.activeByConn.get(conn);
    const ctx = pid ? this.contexts.get(pid) : undefined;
    if (!ctx) throw new Error("no active project");
    ctx.lastActiveAt = Date.now();
    return ctx;
  }

  private async onClientMessage(conn: ClientConnection, ws: WebSocket, raw: string): Promise<void> {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    await this.supervisorTrace.write({ kind: "client.request", request: redactRequest(msg) });

    if (msg.type === "request") {
      await this.handleRequest(conn, ws, msg);
      return;
    }
    if (msg.type === "harness.probe") {
      try {
        await this.activeCtx(conn).refreshReachability();
      } catch {
        /* no active project — ignore */
      }
      return;
    }
    if (msg.type === "folder.inspect") {
      try {
        const r = this.activeCtx(conn).inspectFolder(msg.path);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "folder.inspected", ...r }));
      } catch (err) {
        this.sendValidationError(ws, err);
      }
      return;
    }
    if (msg.type === "repo.clone") {
      try {
        const r = await this.activeCtx(conn).cloneRepo(msg.url, msg.targetPath);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "folder.inspected", ...r }));
      } catch (err) {
        this.sendValidationError(ws, err);
      }
      return;
    }
    if (msg.type === "scaffold.run") {
      try {
        const ctx = this.activeCtx(conn);
        await ctx.runScaffold(msg.path, msg.tiers, msg.resumeFrom);
        await this.reloadContextIfHarnessAppeared(ctx, msg.path);
      } catch (err) {
        this.sendValidationError(ws, err);
      }
      return;
    }
    if (msg.type === "respondToPermission") {
      const decision = buildDecision(msg);
      try {
        const ack = await this.activeCtx(conn).decidePermission(decision);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "permission.ack", ack }));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "permission.error", permissionId: decision.permissionId, reason }));
        }
      }
    } else if (msg.type === "revokeGrant") {
      try {
        await this.activeCtx(conn).revokeGrant(String(msg.grantId ?? ""));
      } catch {
        /* no active project — ignore */
      }
    }
  }

  private async handleRequest(conn: ClientConnection, ws: WebSocket, msg: { [k: string]: unknown }): Promise<void> {
    const id = msg.id;
    const op = String(msg.op ?? "");
    try {
      const result = op.startsWith("project.")
        ? await this.handleProjectOp(conn, ws, op, msg.args)
        : await this.activeCtx(conn).dispatch(op, msg.args);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "response", id, ok: true, result }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "response", id, ok: false, error }));
    }
  }

  /** The SPEC-018 project surface (supervisor-level, not per-context). */
  private async handleProjectOp(conn: ClientConnection, ws: WebSocket, op: string, rawArgs: unknown): Promise<unknown> {
    const a = (rawArgs ?? {}) as Record<string, unknown>;
    switch (op) {
      case "project.list":
        return this.registry.list();
      case "project.open": {
        const ctx = await this.ensureContext({ projectId: a.projectId, path: a.path });
        this.activeByConn.set(conn, ctx.projectId);
        ctx.lastActiveAt = Date.now();
        if (ws.readyState === ws.OPEN) conn.sendSnapshot(JSON.stringify(ctx.snapshotPayload()));
        await this.supervisorTrace.write({ kind: "supervisor.project", action: "open", projectId: ctx.projectId });
        return { projectId: ctx.projectId, name: ctx.name, root: ctx.root, state: ctx.snapshotPayload().projectState };
      }
      case "project.close": {
        const pid = String(a.projectId ?? "");
        if (pid === this.defaultProjectId) throw new Error("cannot close the default project");
        if (!this.contexts.has(pid)) throw new Error(`project '${pid}' is not open`);
        if (this.activeCount(pid) > 0) throw new Error("project has active clients; switch them away first");
        await this.evict(pid, "closed");
        return { closed: pid };
      }
      case "project.forget": {
        const pid = String(a.projectId ?? "");
        if (this.contexts.has(pid)) throw new Error("close the project before forgetting it");
        const forgotten = this.registry.forget(pid);
        await this.supervisorTrace.write({ kind: "supervisor.project", action: "forget", projectId: pid, forgotten });
        return { forgotten: forgotten ? pid : null };
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  private sendValidationError(ws: WebSocket, err: unknown): void {
    if (ws.readyState !== ws.OPEN) return;
    if (err instanceof ValidationError) {
      ws.send(JSON.stringify({ type: "validation-error", field: err.field, reason: err.message }));
    } else {
      ws.send(JSON.stringify({ type: "error", reason: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Push a stamped event to every connection whose active project is `projectId`. */
  private fanOut(projectId: string, event: DomainEvent): void {
    for (const [conn, pid] of this.activeByConn) if (pid === projectId) conn.pushEvent(event);
  }
}

// ---- helpers ---------------------------------------------------------------

/** Strip `user:pass@` userinfo from a `scheme://…` URL so credentials never reach the trace. */
function redactUrlCreds(s: string): string {
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
}

/** Deep-copy a client request, redacting URL credentials from every string value. */
function redactRequest(msg: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(msg), (_k, v) => (typeof v === "string" ? redactUrlCreds(v) : v));
  } catch {
    return msg;
  }
}

/** True only when mock data is explicitly opted into (ARKE_MOCK=1|true|yes). Off by default. */
function mockEnabled(): boolean {
  const v = (process.env.ARKE_MOCK ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Logical-tier defaults used when a project has no `.arke/config.json` yet (SPEC-018). These are
 * the gateway placeholders — never vendor model ids — so a greenfield project is NEVER blocked from
 * scaffolding (the `config` scaffold step then writes a real `.arke/config.json` the user edits).
 */
const GATEWAY_TIER_DEFAULTS: ScaffoldTiers = { capable: "capable-tier", mid: "mid-tier", fast: "fast-tier" };

/**
 * Tier defaults resolved from a loaded config, as full model references (incl. fast). We keep the
 * provider so a config seeded from these values round-trips: a registry model like
 * `anthropic/claude-sonnet` is preserved verbatim, not flattened to its bare name (which the loader
 * would later re-read as `gateway/claude-sonnet`). Gateway placeholders stay bare.
 */
function modelRef(m: ResolvedModel | undefined): string | undefined {
  if (!m) return undefined;
  return m.provider === "gateway" ? m.name : `${m.provider}/${m.name}`;
}
function tierDefaultsFrom(config: { resolveModel?: (t: ModelTier) => ResolvedModel }): ScaffoldTiers {
  return {
    capable: modelRef(config.resolveModel?.("capable")),
    mid: modelRef(config.resolveModel?.("mid")),
    fast: modelRef(config.resolveModel?.("fast")),
  };
}

/** Build context dependencies for an arbitrary project root (used to open projects at runtime). */
async function buildContextDeps(root: string): Promise<ContextDeps> {
  const arke = resolve(root, ".arke");
  const trace = new Trace(resolve(arke, "trace.ndjson"));
  const grants = new GrantStore(resolve(arke, "grants.ndjson"));
  grants.load();
  if (mockEnabled()) {
    return { adapter: new MockAdapter(), trace, grants, endpoints: [], tierDefaults: GATEWAY_TIER_DEFAULTS };
  }
  const configPath = resolve(arke, "config.json");
  const config = loadOpenCodeConfig({ configPath, baseDir: root });
  if (!config) {
    // Absent config → genuine greenfield (the scaffold `config` step writes the real one). A config
    // that EXISTS but is unparseable / has no OpenCode instance is a different situation: the config
    // step would skip it as user-modified, so seeding gateway defaults and proceeding would let the
    // project be classified ready while the registry is still unreadable. Surface it via the gate.
    const reason = existsSync(configPath)
      ? ".arke/config.json is present but invalid or has no OpenCode instance — fix or remove it to re-scaffold"
      : undefined;
    return { adapter: new NullAdapter(reason), trace, grants, endpoints: [], tierDefaults: GATEWAY_TIER_DEFAULTS };
  }
  const deadLetterSink: DeadLetterSink = { write: (dl: DeadLetter) => trace.write({ ...dl }) };
  const adapter = new OpenCodeAdapter(config, {
    sessionStore: new CoordinatorSessionStore(resolve(arke, "sessions.ndjson"), "OpenCode"),
    deadLetterSink,
    onLifecycleEvent: (record) => void trace.write(record),
  });
  try {
    await adapter.init();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The config parsed fine; only the harness server failed — its tier mapping is still known.
    return { adapter: new NullAdapter(`harness init failed: ${reason}`), trace, grants, endpoints: [], tierDefaults: tierDefaultsFrom(config) };
  }
  return { adapter, trace, grants, endpoints: [config.baseUrl], tierDefaults: tierDefaultsFrom(config) };
}

/** Build the DEFAULT project's adapter (uses the env-overridable paths for back-compat). */
async function buildDefaultDeps(trace: Trace, grants: GrantStore): Promise<ContextDeps> {
  if (mockEnabled()) {
    console.warn("[coordinator] ARKE_MOCK set — using MockAdapter (FABRICATED demo data, not real)");
    return { adapter: new MockAdapter(), trace, grants, endpoints: [], tierDefaults: GATEWAY_TIER_DEFAULTS };
  }
  const config = loadOpenCodeConfig({ configPath: CONFIG_PATH, baseDir: REPO_ROOT });
  if (!config) {
    const present = existsSync(CONFIG_PATH);
    console.log(
      present
        ? "[coordinator] .arke/config.json is present but invalid or has no OpenCode instance — " +
            "real mode, no harness (the client shows the reachability gate; fix or remove it to re-scaffold)"
        : "[coordinator] no harness configured in .arke/config.json — real mode, no harness " +
            "(the client shows the reachability gate; set ARKE_MOCK=1 for demo data)",
    );
    // Absent → greenfield: gateway defaults so it can scaffold (which writes the real config).
    // Present-but-invalid → surface the reason rather than silently presenting as scaffold-ready.
    const reason = present
      ? ".arke/config.json is present but invalid or has no OpenCode instance — fix or remove it to re-scaffold"
      : undefined;
    return { adapter: new NullAdapter(reason), trace, grants, endpoints: [], tierDefaults: GATEWAY_TIER_DEFAULTS };
  }
  const deadLetterSink: DeadLetterSink = { write: (dl: DeadLetter) => trace.write({ ...dl }) };
  const adapter = new OpenCodeAdapter(config, {
    sessionStore: new CoordinatorSessionStore(SESSION_STORE_PATH, "OpenCode"),
    deadLetterSink,
    onLifecycleEvent: (record) => void trace.write(record),
  });
  console.log(
    `[coordinator] ${config.manageHarness ? "starting & probing" : "probing"} OpenCode at ${config.baseUrl} …`,
  );
  try {
    await adapter.init();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The config parsed fine; only the harness server failed — keep the config-derived tier mapping
    // (mirrors buildContextDeps) so the init screen and any child project seed the user's models.
    console.error(`[coordinator] harness init failed (${reason}); serving real empty state (set ARKE_MOCK=1 for demo data)`);
    return {
      adapter: new NullAdapter(`harness init failed: ${reason}`),
      trace,
      grants,
      endpoints: [config.baseUrl],
      tierDefaults: tierDefaultsFrom(config),
    };
  }
  return { adapter, trace, grants, endpoints: [config.baseUrl], tierDefaults: tierDefaultsFrom(config) };
}

async function bootstrap(): Promise<void> {
  const trace = new Trace(TRACE_PATH);
  const grants = new GrantStore(GRANT_STORE_PATH);
  grants.load();
  let deps: ContextDeps;
  try {
    deps = await buildDefaultDeps(trace, grants);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[coordinator] harness init failed (${reason}); serving real empty state (set ARKE_MOCK=1 for demo data)`);
    deps = { adapter: new NullAdapter(`harness init failed: ${reason}`), trace, grants, endpoints: [], tierDefaults: GATEWAY_TIER_DEFAULTS };
  }
  await new Coordinator(deps.adapter, deps.trace, deps.grants, PORT, {
    endpoints: deps.endpoints,
    tierDefaults: deps.tierDefaults,
    registry: new ProjectRegistry(), // the real global recents (SPEC-018)
  }).start();
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void bootstrap();
}
