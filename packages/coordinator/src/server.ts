import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyGithubSignature } from "./spec-lifecycle.js";
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
import { loadRegistryConfig } from "./registry-config.js";
import {
  globalConfigPath,
  loadGlobalConfig,
  restoreGlobalConfigRaw,
  snapshotGlobalConfigRaw,
  upsertGlobalInstance,
} from "./global-config.js";
import { assertSubstrateExclusivity, resolveEffectiveConfig, resolveProcessSettings } from "./config-resolve.js";
import { DEFAULT_PROBE_TIMEOUT_MS } from "./reachability.js";
import type { InstanceConfig, RegistryConfig } from "./registry.js";

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
  /** Full harness/model registry from the project's `.arke/config.json` (SPEC-005). */
  registryConfig?: RegistryConfig;
  /** The instance the live adapter serves (first `opencode` driver), if any (SPEC-005). */
  connectedInstanceId?: string;
}

/** Builds the dependencies for a project rooted at `root` (used to open projects at runtime). */
export type ContextFactory = (root: string) => Promise<ContextDeps>;

export class Coordinator {
  private clientIdSeq = 0;
  private wss?: WebSocketServer;
  private httpServer?: HttpServer;
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
      registryConfig?: RegistryConfig;
      connectedInstanceId?: string;
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
      ...(opts.registryConfig ? { registryConfig: opts.registryConfig } : {}),
      ...(opts.connectedInstanceId ? { connectedInstanceId: opts.connectedInstanceId } : {}),
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
    // One HTTP server carries both the WS upgrade (client transport, ADR-0003) and the SPEC-008
    // GitHub webhook endpoint (POST /webhooks/github) on the same port.
    const server = createServer((req, res) => void this.handleHttp(req, res));
    this.httpServer = server;
    const wss = new WebSocketServer({ server });
    this.wss = wss;
    wss.on("connection", (ws) => void this.onConnection(ws));
    await new Promise<void>((res) => server.listen(this.port, () => res()));
    const addr = server.address();
    const actual = typeof addr === "object" && addr ? addr.port : this.port;
    console.log(`[coordinator] listening on ws://127.0.0.1:${actual} (webhooks: POST /webhooks/github)`);

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
    await new Promise<void>((res) => {
      if (!this.httpServer) return res();
      this.httpServer.close(() => res());
    });
    for (const ctx of this.contexts.values()) await ctx.stop();
    this.contexts.clear();
  }

  // ---- HTTP (SPEC-008 webhooks) --------------------------------------------

  /**
   * Handle plain-HTTP requests on the shared port: the GitHub webhook endpoint and a health probe.
   * The webhook is validated (HMAC) when `ARKE_WEBHOOK_SECRET` is set, then fanned to every open
   * project context — the one with a spec on the event's branch applies it; the rest are a no-op.
   */
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, projects: this.contexts.size }));
      return;
    }
    if (req.method === "POST" && req.url === "/webhooks/github") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const secret = process.env.ARKE_WEBHOOK_SECRET;
      const allowUnsigned = process.env.ARKE_WEBHOOK_ALLOW_UNSIGNED === "1" || process.env.ARKE_WEBHOOK_ALLOW_UNSIGNED === "true";
      const sig = req.headers["x-hub-signature-256"];
      if (secret) {
        if (!verifyGithubSignature(secret, body, Array.isArray(sig) ? sig[0] : sig)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid signature" }));
          return;
        }
      } else if (!allowUnsigned) {
        // Fail CLOSED: an unconfigured webhook secret must not let unauthenticated POSTs drive lifecycle
        // mutations (status transitions, merge-time file writes). Set ARKE_WEBHOOK_SECRET in production,
        // or ARKE_WEBHOOK_ALLOW_UNSIGNED=1 to explicitly opt in for local/dev.
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "webhook secret not configured (set ARKE_WEBHOOK_SECRET, or ARKE_WEBHOOK_ALLOW_UNSIGNED=1 for local/dev)" }));
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid json" }));
        return;
      }
      const eventName = (req.headers["x-github-event"] as string) ?? "";
      const results: Array<{ projectId: string; applied: string; specId?: string }> = [];
      for (const [projectId, ctx] of this.contexts) {
        try {
          const r = await ctx.handleWebhook(eventName, payload);
          if (!r.applied.startsWith("no spec") && !r.applied.startsWith("ignored")) results.push({ projectId, ...r });
        } catch {
          /* one context's failure must not fail the whole delivery */
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, routed: results }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
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
      ...(deps.registryConfig ? { registryConfig: deps.registryConfig } : {}),
      ...(deps.connectedInstanceId ? { connectedInstanceId: deps.connectedInstanceId } : {}),
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
    await this.reloadContext(ctx.projectId);
  }

  /**
   * Rebuild an open context from freshly-loaded deps and re-snapshot its connections (SPEC-018/019).
   * Used when the config underneath a context changes — a scaffold that wrote `.arke/config.json`, or
   * a SPEC-019 quick-setup connect that wrote a harness to the global config. `projectId` is derived
   * from the (unchanged) root, so it is stable across the rebuild.
   */
  private async reloadContext(projectId: string): Promise<void> {
    const ctx = this.contexts.get(projectId);
    if (!ctx) return;
    const root = ctx.root;
    const deps = await this.contextFactory(root);
    await ctx.stop();
    this.contexts.delete(projectId);
    const fresh = this.addContext(root, deps);
    await this.supervisorTrace.write({ kind: "supervisor.project", action: "reload", projectId, root });
    await fresh.start();
    // Push the fresh snapshot to every connection whose active project is this one, so the harness
    // gate reflects the newly-loaded config instead of the prior NullAdapter.
    for (const [c, pid] of this.activeByConn) {
      if (pid === projectId) c.sendSnapshot(JSON.stringify(fresh.snapshotPayload()));
    }
  }

  /** Reload every open context (SPEC-019): a global-config change affects all of them equally. */
  private async reloadAllContexts(): Promise<void> {
    for (const projectId of [...this.contexts.keys()]) await this.reloadContext(projectId);
  }

  /**
   * SPEC-019 quick-setup connect. Only a driver Arke can actually **activate** is persisted: OpenCode
   * is validated, written to the GLOBAL config, and the contexts reloaded; if the harness does not
   * come live (a server that answers `/global/health` but lacks the full capability surface, say), the
   * write is **rolled back** so the launch screen never shows a configured-but-dead state. Other
   * drivers (Claude Code / Codex / an Omnigent substrate) have no runnable adapter in this build, so
   * their endpoint is validated (to give feedback) but nothing is persisted — a fake success that
   * hides quick setup is worse than an honest "not yet". Userinfo is stripped before any write (NFR-1).
   */
  private async connectHarness(rawDriver: unknown, rawEndpoint: unknown): Promise<{ ok: boolean; reason?: string; driver?: string }> {
    const endpoint = String(rawEndpoint ?? "").trim();
    if (!endpoint) return { ok: false, reason: "no endpoint provided" };
    const driver = resolveDriver(rawDriver, endpoint);
    const base = httpBaseFromEndpoint(endpoint);

    if (driver !== "opencode") {
      // Validate for feedback, but do not persist a driver we cannot bring live.
      const v = await this.validateEndpoint(base);
      const label = driver === "omnigent" ? "Omnigent substrate" : driver;
      const state = v.ok ? "reachable, but" : `unreachable (${v.reason}); and`;
      return { ok: false, driver, reason: `${label} is ${state} not runnable in this build yet — only OpenCode can be connected. The install/start commands above are for reference.` };
    }

    // OpenCode: /global/health must answer with a parseable capability surface (SPEC-002 probe target).
    const health = await this.probe.anyReachable([base]);
    if (!health.reachable) return { ok: false, driver, reason: health.results[0]?.reason ?? "unreachable" };

    // Persist, reload, and VERIFY the harness came live — rolling the write back if it did not, so a
    // health-only or capability-incomplete server never leaves a dead instance in the global config.
    const rollback = snapshotGlobalConfigRaw();
    upsertGlobalInstance(descriptorFor(driver, endpoint));
    await this.supervisorTrace.write({ kind: "harness.connect", driver, endpoint: redactUrlCreds(endpoint) });
    await this.reloadAllContexts();
    const readiness = this.contexts.get(this.defaultProjectId)?.adapter.readiness?.() ?? { ready: true };
    if (!readiness.ready) {
      restoreGlobalConfigRaw(rollback);
      await this.reloadAllContexts();
      await this.supervisorTrace.write({ kind: "harness.connect", driver, endpoint: redactUrlCreds(endpoint), rolledBack: true });
      return { ok: false, driver, reason: readiness.reason ?? "the harness did not become ready after connecting" };
    }
    return { ok: true, driver };
  }

  /** Permissive reachability check (any HTTP response means a server is listening) for feedback only. */
  private async validateEndpoint(base: string): Promise<{ ok: boolean; reason?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
    try {
      await fetch(base, { signal: controller.signal });
      return { ok: true };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return { ok: false, reason: aborted ? "timeout" : err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
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
    if (msg.type === "registry.probe") {
      try {
        await this.activeCtx(conn).refreshRegistry(true);
      } catch {
        /* no active project — ignore */
      }
      return;
    }
    if (msg.type === "harness.connect") {
      // SPEC-019 first-run quick setup: validate the endpoint, persist the harness to the GLOBAL
      // config, then reload every open context so the newly-configured harness goes live.
      let result: { ok: boolean; reason?: string; driver?: string };
      try {
        result = await this.connectHarness(msg.driver, msg.endpoint);
      } catch (err) {
        result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "harness.connected", ...result }));
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

// ---- SPEC-019 quick-setup endpoint parsing ---------------------------------

/** Map a harness scheme to its driver name (the client may also send `driver` explicitly). */
const SCHEME_DRIVER: Record<string, string> = {
  opencode: "opencode",
  acp: "claude-code",
  codex: "codex",
  omnigent: "omnigent",
};

/**
 * Split `scheme://[userinfo@]host[/path]` into its parts; a bare `host:port` has no scheme. The
 * `userinfo` (a `user:pass@` prefix) is separated out so a caller never persists it — the harness,
 * not Arke, owns credentials (SPEC-019 / NFR-1).
 */
export function parseEndpoint(endpoint: string): { scheme?: string; host: string; userinfo?: string } {
  const trimmed = endpoint.trim();
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(trimmed);
  let scheme: string | undefined;
  let rest: string;
  if (m) {
    scheme = m[1]!.toLowerCase();
    rest = m[2]!;
  } else {
    rest = trimmed;
  }
  rest = rest.replace(/\/+$/, "");
  const at = rest.lastIndexOf("@");
  const userinfo = at >= 0 ? rest.slice(0, at) : undefined;
  const host = at >= 0 ? rest.slice(at + 1) : rest;
  return { ...(scheme ? { scheme } : {}), host, ...(userinfo ? { userinfo } : {}) };
}

/** The HTTP(S) base URL to probe for reachability (harness schemes normalise to http; userinfo dropped). */
function httpBaseFromEndpoint(endpoint: string): string {
  const { scheme, host } = parseEndpoint(endpoint);
  const proto = scheme === "http" || scheme === "https" ? scheme : "http";
  return `${proto}://${host}`;
}

/** Resolve the driver: an explicit client value wins, else the endpoint scheme, else opencode. */
function resolveDriver(rawDriver: unknown, endpoint: string): string {
  const d = String(rawDriver ?? "").trim().toLowerCase();
  if (d) return d;
  const { scheme } = parseEndpoint(endpoint);
  return (scheme && SCHEME_DRIVER[scheme]) || "opencode";
}

/**
 * Build the instance descriptor persisted to the global config on connect (SPEC-019). Any `user:pass@`
 * userinfo is STRIPPED — it is never written to disk (NFR-1). A `baseUrl` is stored so the endpoint's
 * scheme (notably `https`) survives the round-trip rather than defaulting back to `http`. `serves` is
 * left empty for the engineer to fill; the `credentialsRef` is a pointer only, never a secret.
 */
export function descriptorFor(driver: string, endpoint: string): InstanceConfig {
  const { scheme, host } = parseEndpoint(endpoint);
  const proto = scheme === "https" ? "https" : "http";
  return {
    id: `${driver}-local`,
    driver,
    host,
    cwd: ".",
    credentialsRef: `${driver}/gateway`,
    serves: [],
    baseUrl: `${proto}://${host}`,
  };
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

/**
 * Resolve the EFFECTIVE harness/model registry for a project (SPEC-019): the global (machine-level)
 * config deep-merged under this project's `.arke/config.json` (project wins on conflicting ids). A
 * globally-configured harness is thereby inherited by a project with no local registry. Returns the
 * merged `registryConfig` + the connected instance (first `opencode` driver in merged order), or an
 * empty object when nothing is configured anywhere (launch then shows quick setup). A merged config
 * that mixes a substrate with leaf instances is rejected (served as unconfigured) — ADR-0004.
 */
function resolveRegistryDeps(configPath: string): { registryConfig?: RegistryConfig; connectedInstanceId?: string } {
  const global = loadGlobalConfig();
  const project = loadRegistryConfig(configPath);
  if (!global && !project) return {};
  const effective = resolveEffectiveConfig(global, project?.config ?? null);
  if (effective.instances.length === 0) return {};
  try {
    assertSubstrateExclusivity(effective);
  } catch (err) {
    console.error(`[coordinator] ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
  const connectedInstanceId = effective.instances.find((i) => i.driver === "opencode")?.id;
  return {
    registryConfig: { instances: effective.instances, roster: effective.roster },
    ...(connectedInstanceId ? { connectedInstanceId } : {}),
  };
}

/** Build context dependencies for an arbitrary project root (used to open projects at runtime). */
async function buildContextDeps(root: string): Promise<ContextDeps> {
  const arke = resolve(root, ".arke");
  const trace = new Trace(resolve(arke, "trace.ndjson"));
  const grants = new GrantStore(resolve(arke, "grants.ndjson"));
  grants.load();
  const configPath = resolve(arke, "config.json");
  const registryDeps = resolveRegistryDeps(configPath);
  if (mockEnabled()) {
    return { adapter: new MockAdapter(), trace, grants, endpoints: [], tierDefaults: GATEWAY_TIER_DEFAULTS, ...registryDeps };
  }
  const config = loadOpenCodeConfig({ configPath, baseDir: root, globalConfigPath: globalConfigPath() });
  if (!config) {
    // Absent config → genuine greenfield (the scaffold `config` step writes the real one). A config
    // that EXISTS but is unparseable / has no OpenCode instance is a different situation: the config
    // step would skip it as user-modified, so seeding gateway defaults and proceeding would let the
    // project be classified ready while the registry is still unreadable. Surface it via the gate.
    const reason = existsSync(configPath)
      ? ".arke/config.json is present but invalid or has no OpenCode instance — fix or remove it to re-scaffold"
      : undefined;
    return { adapter: new NullAdapter(reason), trace, grants, endpoints: [], tierDefaults: GATEWAY_TIER_DEFAULTS, ...registryDeps };
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
    return { adapter: new NullAdapter(`harness init failed: ${reason}`), trace, grants, endpoints: [], tierDefaults: tierDefaultsFrom(config), ...registryDeps };
  }
  return { adapter, trace, grants, endpoints: [config.baseUrl], tierDefaults: tierDefaultsFrom(config), ...registryDeps };
}

/** Build the DEFAULT project's adapter (uses the env-overridable paths for back-compat). */
async function buildDefaultDeps(trace: Trace, grants: GrantStore): Promise<ContextDeps> {
  const registryDeps = resolveRegistryDeps(CONFIG_PATH);
  if (mockEnabled()) {
    console.warn("[coordinator] ARKE_MOCK set — using MockAdapter (FABRICATED demo data, not real)");
    return { adapter: new MockAdapter(), trace, grants, endpoints: [], tierDefaults: GATEWAY_TIER_DEFAULTS, ...registryDeps };
  }
  const config = loadOpenCodeConfig({ configPath: CONFIG_PATH, baseDir: REPO_ROOT, globalConfigPath: globalConfigPath() });
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
    return { adapter: new NullAdapter(reason), trace, grants, endpoints: [], tierDefaults: GATEWAY_TIER_DEFAULTS, ...registryDeps };
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
      ...registryDeps,
    };
  }
  return { adapter, trace, grants, endpoints: [config.baseUrl], tierDefaults: tierDefaultsFrom(config), ...registryDeps };
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
  // Process-wide settings (SPEC-019 R3): the global config `settings` block, with `ARKE_*` env
  // winning. A project `.arke/config.json` can never set these — they are not threaded here. No-op
  // (keeps the env-derived defaults) when no global config is present.
  const settings = resolveProcessSettings(loadGlobalConfig()?.settings, process.env);
  // The query limits and OTLP endpoint are read from `process.env` deep inside each ProjectContext;
  // publish the resolved global values there (env still wins — only fill an UNSET var) so a global
  // `settings` block is honored without also exporting the matching env var by hand.
  if (settings?.projectionQueryLimit !== undefined) process.env.ARKE_PROJECTION_QUERY_LIMIT ??= String(settings.projectionQueryLimit);
  if (settings?.auditQueryLimit !== undefined) process.env.ARKE_AUDIT_QUERY_LIMIT ??= String(settings.auditQueryLimit);
  if (settings?.otlpEndpoint) process.env.ARKE_OTLP_ENDPOINT ??= settings.otlpEndpoint;
  await new Coordinator(deps.adapter, deps.trace, deps.grants, settings?.coordinatorPort ?? PORT, {
    endpoints: deps.endpoints,
    tierDefaults: deps.tierDefaults,
    ...(deps.registryConfig ? { registryConfig: deps.registryConfig } : {}),
    ...(deps.connectedInstanceId ? { connectedInstanceId: deps.connectedInstanceId } : {}),
    ...(settings?.maxProjects !== undefined ? { maxProjects: settings.maxProjects } : {}),
    ...(settings?.idleTtlMs !== undefined ? { idleTtlMs: settings.idleTtlMs } : {}),
    registry: new ProjectRegistry(), // the real global recents (SPEC-018)
  }).start();
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void bootstrap();
}
