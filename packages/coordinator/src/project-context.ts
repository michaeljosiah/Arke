import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  DomainEvent,
  type AgentImage,
  type HarnessAdapter,
  type ModelTier,
  type PermissionAck,
  type PermissionDecision,
  type ScaffoldStep,
} from "@arke/contracts";
import { resolveDirectory } from "@arke/adapter-opencode";
import { loadAgentImage } from "@arke/agent-image";
import { ReadModel } from "./read-model.js";
import type { Trace } from "./trace.js";
import type { GrantStore } from "./grant-store.js";
import { InputValidator, ValidationError } from "./input-validator.js";
import { FolderInspector, type FolderState } from "./folder-inspector.js";
import { HarnessReachabilityProbe } from "./reachability.js";
import { ScaffoldRunner, type ScaffoldTiers } from "./scaffold.js";
import type { ProjectRegistry } from "./project-registry.js";

/**
 * One project, fully isolated (SPEC-018). Owns everything the coordinator used to hold as a
 * singleton — the harness adapter, read model, trace, grant store, onboarding/reachability state,
 * the event pump, and the op surface — all keyed to a single canonical `root` (its own safe root).
 * The supervisor ({@link Coordinator}) holds a `Map<projectId, ProjectContext>` and fans events out
 * to whichever clients have this context as their active project via the injected `publish`.
 */
export interface ProjectContextInit {
  projectId: string;
  root: string; // canonical absolute root; the safe root for all path validation
  adapter: HarnessAdapter;
  trace: Trace;
  grants: GrantStore;
  endpoints: string[];
  tierDefaults: ScaffoldTiers;
  registry: ProjectRegistry;
  /** Fan a stamped event out to this context's active client connections (supervisor-supplied). */
  publish: (event: DomainEvent) => void;
  probe?: HarnessReachabilityProbe;
}

export class ProjectContext {
  readonly projectId: string;
  readonly root: string;
  readonly name: string;
  readonly adapter: HarnessAdapter;
  private readonly trace: Trace;
  private readonly grants: GrantStore;
  private readonly endpoints: string[];
  private readonly tierDefaults: ScaffoldTiers;
  private readonly registry: ProjectRegistry;
  private readonly probe: HarnessReachabilityProbe;
  private readonly publish: (event: DomainEvent) => void;

  private readonly read = new ReadModel();
  private readonly abort = new AbortController();
  private ingestSeq = 0;
  private readonly streaming = new Set<string>();
  private readonly pendingPerms = new Map<string, { sessionId: string; actionClass: string }>();

  private harnessReachable = true;
  private harnessReachabilityReason?: string;
  private harnessPartial = false;
  private projectState: FolderState | null = null;
  private missingSentinels: string[] = [];

  /** Tracks recent activity for idle eviction (set by the supervisor on each client request). */
  lastActiveAt = 0;

  constructor(init: ProjectContextInit) {
    this.projectId = init.projectId;
    this.root = init.root;
    this.name = basename(init.root);
    this.adapter = init.adapter;
    this.trace = init.trace;
    this.grants = init.grants;
    this.endpoints = init.endpoints;
    this.tierDefaults = init.tierDefaults;
    this.registry = init.registry;
    this.publish = init.publish;
    this.probe = init.probe ?? new HarnessReachabilityProbe();
  }

  /** Classify the folder, register it as a recent, probe reachability, and start the pump if ready. */
  async start(): Promise<void> {
    this.classify();
    this.registry.upsert({ root: this.root, name: this.name, state: this.projectState });
    await this.refreshReachability();
    const readiness = this.adapter.readiness?.();
    if (readiness && !readiness.ready) return; // serve snapshot only; no stream
    void this.pump();
  }

  /** Stop this context's pump and any harness it started (never an attached one — SPEC-016). */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.adapter.stopServer?.();
  }

  /** Whether the pump is (or could be) streaming — used by idle eviction to avoid killing live work. */
  get streamingCount(): number {
    return this.streaming.size;
  }

  // ---- snapshot ------------------------------------------------------------

  /** The snapshot payload for this project (cards + onboarding state), scoped by `projectId`. */
  snapshotPayload(): Record<string, unknown> {
    return {
      type: "snapshot",
      cards: this.read.snapshot(),
      projectId: this.projectId,
      projectName: this.name,
      projectPath: this.root,
      harness: this.adapter.id,
      ...(this.endpoints[0] ? { harnessEndpoint: this.endpoints[0] } : {}),
      harnessReachable: this.harnessReachable,
      ...(this.harnessReachabilityReason ? { harnessReachabilityReason: this.harnessReachabilityReason } : {}),
      ...(this.harnessPartial ? { harnessReachabilityPartial: true } : {}),
      projectState: this.projectState,
      missingSentinels: this.missingSentinels,
      tierDefaults: this.tierDefaults,
    };
  }

  cardCount(): number {
    return this.read.snapshot().length;
  }

  // ---- classification + reachability --------------------------------------

  private classify(target: string = this.root): void {
    try {
      const cls = FolderInspector.classify(target);
      this.projectState = cls.state;
      this.missingSentinels = cls.missingSentinels;
    } catch {
      this.projectState = null;
      this.missingSentinels = [];
    }
  }

  async refreshReachability(): Promise<void> {
    // Adapter readiness is authoritative for the gate (it confirms the events capability); the raw
    // HTTP probe only enriches a failure reason and can never flip reachable to true (SPEC-004).
    const r = this.adapter.readiness?.() ?? { ready: true };
    this.harnessReachable = r.ready;
    this.harnessReachabilityReason = r.ready ? undefined : (r.reason ?? "harness not ready");
    this.harnessPartial = false;
    if (!r.ready && this.endpoints.length > 0) {
      const { results } = await this.probe.anyReachable(this.endpoints);
      const failed = results.find((res) => !res.reachable);
      if (failed?.reason) this.harnessReachabilityReason = failed.reason;
      this.harnessPartial = failed?.partial ?? false;
    }
    await this.emit({
      seq: 0,
      ts: 0,
      harness: this.adapter.id,
      type: "harness.reachability",
      endpoint: this.endpoints[0] ?? this.adapter.id,
      reachable: this.harnessReachable,
      ...(this.harnessPartial ? { partial: true } : {}),
      ...(this.harnessReachabilityReason ? { reason: this.harnessReachabilityReason } : {}),
    });
  }

  reachableSummary(): { reachable: boolean; reason?: string } {
    return { reachable: this.harnessReachable, ...(this.harnessReachabilityReason ? { reason: this.harnessReachabilityReason } : {}) };
  }

  // ---- op surface (per project) -------------------------------------------

  /** Map a CLI/client op to this project's adapter/coordinator capability (SPEC-017). */
  async dispatch(op: string, rawArgs: unknown): Promise<unknown> {
    const a = (rawArgs ?? {}) as Record<string, unknown>;
    switch (op) {
      case "session.create": {
        const specId = String(a.specId ?? "");
        const parent = a.parent ? String(a.parent) : undefined;
        const ref = await this.adapter.createSession({ specId, ...(parent ? { parent } : {}) });
        await this.emit({
          seq: 0,
          ts: 0,
          harness: this.adapter.id,
          type: "session.status",
          sessionId: ref.sessionId,
          specId,
          kind: parent ? "task" : "spec",
          status: "idle",
        });
        return ref;
      }
      case "session.list":
        return this.read.snapshot();
      case "prompt.send":
      case "prompt.dispatch": {
        // Pass through any known tier (capable | mid | fast); an unknown/absent tier falls back to
        // mid rather than silently downgrading an explicit fast/capable request.
        const requested = String(a.tier ?? "");
        const tier: ModelTier =
          requested === "capable" || requested === "mid" || requested === "fast"
            ? (requested as ModelTier)
            : "mid";
        const input = {
          sessionId: String(a.sessionId ?? ""),
          agent: String(a.agent ?? ""),
          tier,
          parts: [{ type: "text" as const, text: String(a.message ?? "") }],
          ...(a.correlationId ? { correlationId: String(a.correlationId) } : {}),
        };
        return op === "prompt.send" ? this.adapter.sendMessage(input) : this.adapter.dispatchAsync(input);
      }
      case "todos.get":
        if (!this.adapter.getTodos) throw new Error("harness does not support todos");
        return this.adapter.getTodos({ sessionId: String(a.sessionId ?? "") });
      case "diff.get":
        if (!this.adapter.getDiff) throw new Error("harness does not support diff");
        return this.adapter.getDiff({ sessionId: String(a.sessionId ?? "") });
      case "permission.list":
        return [...this.pendingPerms.entries()].map(([permissionId, p]) => ({
          permissionId,
          sessionId: p.sessionId,
          actionClass: p.actionClass,
        }));
      case "permission.decide":
        return this.decidePermission(buildDecision(a));
      case "grant.list":
        return this.grants.all();
      case "grant.revoke": {
        const grantId = String(a.grantId ?? "");
        this.grants.revoke(grantId);
        await this.trace.write({ kind: "grant.revoked", grantId, projectId: this.projectId });
        return { revoked: grantId };
      }
      case "agents.list":
        return this.loadAgentImages(a.dir).map((img) => ({
          name: img.name,
          tier: img.tier,
          description: img.description,
          mode: img.interaction.mode,
        }));
      case "agents.materialize": {
        if (!this.adapter.materializeAgent) throw new Error("harness does not support agent materialisation");
        const images = this.loadAgentImages(a.dir);
        for (const img of images) await this.adapter.materializeAgent(img);
        return { materialized: images.map((i) => i.name) };
      }
      case "harness.probe":
        await this.refreshReachability();
        return this.reachableSummary();
      case "folder.inspect":
        return this.inspectFolder(a.path);
      case "repo.clone":
        return this.cloneRepo(a.url, a.targetPath);
      case "scaffold.run": {
        const result = await this.runScaffold(a.path, a.tiers, a.resumeFrom);
        return { ok: result.ok, stepsRun: result.stepsRun, steps: result.steps };
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  // ---- permissions ---------------------------------------------------------

  async decidePermission(decision: PermissionDecision): Promise<PermissionAck> {
    if (!this.adapter.respondToPermission) throw new Error("harness does not support permissions");
    if (decision.decision === "always") {
      const pending = this.pendingPerms.get(decision.permissionId);
      if (pending) {
        const grant = this.grants.remember({
          sessionId: pending.sessionId,
          actionClass: pending.actionClass,
          createdBy: "human",
        });
        await this.trace.write({ kind: "grant.remembered", grant, projectId: this.projectId });
      }
    }
    const ack = await this.adapter.respondToPermission(decision);
    await this.trace.write({ kind: "permission.ack", ack, projectId: this.projectId });
    return ack;
  }

  revokeGrant(grantId: string): Promise<void> {
    this.grants.revoke(grantId);
    return this.trace.write({ kind: "grant.revoked", grantId, projectId: this.projectId });
  }

  // ---- onboarding core (validated against THIS project's root) -------------

  inspectFolder(rawPath: unknown): { state: FolderState; missingSentinels: string[]; projectPath: string } {
    const path = InputValidator.canonicalisePath(String(rawPath ?? ""), this.root);
    const cls = FolderInspector.classify(path);
    this.projectState = cls.state;
    this.missingSentinels = cls.missingSentinels;
    return { state: cls.state, missingSentinels: cls.missingSentinels, projectPath: path };
  }

  async cloneRepo(
    rawUrl: unknown,
    rawTarget: unknown,
  ): Promise<{ state: FolderState; missingSentinels: string[]; projectPath: string }> {
    const url = InputValidator.validateCloneUrl(String(rawUrl ?? ""));
    const target = InputValidator.canonicalisePath(String(rawTarget ?? ""), this.root);
    if (!gitAvailable()) throw new Error("git not found on PATH; cannot clone");
    await gitCloneAsync(url, target, CLONE_TIMEOUT_MS);
    const cls = FolderInspector.classify(target);
    return { state: cls.state, missingSentinels: cls.missingSentinels, projectPath: target };
  }

  async runScaffold(rawPath: unknown, rawTiers: unknown, rawResumeFrom: unknown) {
    const path = InputValidator.canonicalisePath(String(rawPath ?? ""), this.root);
    const supplied = (rawTiers ?? {}) as Record<string, unknown>;
    const tiers: ScaffoldTiers = {
      capable: typeof supplied.capable === "string" ? supplied.capable : this.tierDefaults.capable,
      mid: typeof supplied.mid === "string" ? supplied.mid : this.tierDefaults.mid,
    };
    const resumeFrom = typeof rawResumeFrom === "string" ? (rawResumeFrom as ScaffoldStep) : undefined;
    const runner = new ScaffoldRunner({
      root: path,
      harness: this.adapter.id,
      emit: (e) => this.emit(e),
      trace: this.trace,
    });
    const result = await runner.run({ tiers, ...(resumeFrom ? { resumeFrom } : {}) });
    // Register the project that was ACTUALLY scaffolded — which may be a cloned subdirectory
    // (entryPath), a distinct project from this context's root. Only adopt the classification as
    // this context's own state when the scaffold target IS this context's root; otherwise we would
    // overwrite the parent's state and leave the scaffolded repo absent from project.list.
    const cls = FolderInspector.classify(path);
    if (path === this.root) {
      this.projectState = cls.state;
      this.missingSentinels = cls.missingSentinels;
    }
    this.registry.upsert({ root: path, name: basename(path), state: cls.state });
    if (result.ok) void this.runGrounding(path);
    return result;
  }

  private async runGrounding(projectPath: string): Promise<void> {
    try {
      const agentsMdPath = resolve(projectPath, "AGENTS.md");
      const previousSha = fileSha(agentsMdPath);
      const session = await this.adapter.createSession({ specId: "grounding" });
      await this.adapter.sendMessage({
        sessionId: session.sessionId,
        agent: "researcher",
        tier: "mid",
        parts: [
          {
            type: "text",
            text: "Analyse this repository and rewrite AGENTS.md with module structure, key entry points, and conventions.",
          },
        ],
      });
      const newSha = fileSha(agentsMdPath);
      await this.trace.write({
        kind: "grounding.session",
        projectId: this.projectId,
        sessionId: session.sessionId,
        role: "researcher",
        completedAt: new Date().toISOString(),
        agentsMdSha: newSha,
        ...(previousSha && previousSha !== newSha ? { previousAgentsMdSha: previousSha } : {}),
      });
    } catch (err) {
      await this.trace.write({
        kind: "grounding.session",
        projectId: this.projectId,
        role: "researcher",
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private loadAgentImages(dir: unknown): AgentImage[] {
    const base = resolveDirectory(this.root, typeof dir === "string" && dir ? dir : "agents");
    if (!existsSync(base)) return [];
    const out: AgentImage[] = [];
    for (const name of readdirSync(base)) {
      const d = resolve(base, name);
      let isImage = false;
      try {
        isImage = statSync(d).isDirectory() && existsSync(resolve(d, "config.yaml"));
      } catch {
        isImage = false;
      }
      if (isImage) out.push(loadAgentImage(d));
    }
    return out;
  }

  // ---- pump + emit ---------------------------------------------------------

  private async maybeAutoGrant(event: Extract<DomainEvent, { type: "permission.asked" }>): Promise<boolean> {
    const match = this.grants.findMatch(event.sessionId, event.title);
    if (!match) return false;
    await this.trace.write({
      kind: "permission.auto-grant",
      projectId: this.projectId,
      permissionId: event.permissionId,
      sessionId: event.sessionId,
      actionClass: event.title,
      ruleId: match.id,
      at: Date.now(),
    });
    void this.adapter.respondToPermission?.({ permissionId: event.permissionId, decision: "once" }).catch(() => undefined);
    return true;
  }

  private async pump(): Promise<void> {
    for await (const incoming of this.adapter.streamEvents(this.abort.signal)) {
      const parsed = DomainEvent.safeParse(incoming);
      if (!parsed.success) {
        await this.trace.write({
          kind: "dead-letter",
          projectId: this.projectId,
          rawType: (incoming as { type?: unknown })?.type,
          reason: parsed.error.message,
          at: Date.now(),
        });
        continue;
      }
      const event = parsed.data;
      if (event.type === "permission.asked") {
        this.pendingPerms.set(event.permissionId, { sessionId: event.sessionId, actionClass: event.title });
        if (await this.maybeAutoGrant(event)) continue;
      } else if (event.type === "permission.replied") {
        this.pendingPerms.delete(event.permissionId);
      }

      await this.emit(event);

      if (event.type === "message.part") {
        this.streaming.add(event.sessionId);
      } else if (event.type === "message.updated" && !event.isStreaming && this.streaming.delete(event.sessionId)) {
        await this.emit({
          seq: 0,
          ts: 0,
          harness: event.harness,
          ...(event.correlationId ? { correlationId: event.correlationId } : {}),
          type: "turn.quiescent",
          sessionId: event.sessionId,
          turnId: event.messageId,
        });
      }
    }
  }

  /** Stamp ingest seq + ts + projectId, fold into the read model, trace (before push), publish. */
  private async emit(event: DomainEvent): Promise<void> {
    // Stamp `projectId` on the pushed event so a client can discard stale frames: on a slow
    // connection, events queued for project A can arrive after a `project.open` snapshot for B —
    // without the id the client could fold A's events into B's board (SPEC-018).
    const stamped = { ...event, seq: ++this.ingestSeq, ts: Date.now(), projectId: this.projectId } as DomainEvent & {
      projectId: string;
    };
    this.read.apply(stamped);
    await this.trace.write({ kind: "event", projectId: this.projectId, event: stamped });
    this.publish(stamped);
  }
}

// ---- shared helpers (module scope) -----------------------------------------

/** Fail-closed permission verb parse: an invalid verb errors rather than coercing to allow-once. */
export function buildDecision(msg: { [k: string]: unknown }): PermissionDecision {
  const verb = msg.decision;
  if (verb !== "once" && verb !== "always" && verb !== "reject") {
    throw new Error(`invalid permission decision '${String(verb)}': must be once | always | reject`);
  }
  return {
    permissionId: String(msg.permissionId ?? ""),
    decision: verb,
    ...(typeof msg.message === "string" ? { message: msg.message } : {}),
  };
}

export { ValidationError };

export function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const CLONE_TIMEOUT_MS = Number(process.env.ARKE_CLONE_TIMEOUT_MS ?? 120_000);

function gitCloneAsync(url: string, target: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", ["clone", url, target], {
      stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git clone timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`git clone failed (exit ${code ?? "signal"})`));
    });
  });
}

function fileSha(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}
