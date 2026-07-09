import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  DomainEvent,
  SpecStatus,
  appendChangeHistory,
  parseFrontmatter,
  parseSpecDoc,
  setFrontmatterStatus,
  validateWellFormed,
  bundleEntryFromFile,
  isBundleDoc,
  isSpecFile,
  renderBundleIndex,
  renderSpecIndex,
  specEntryFromFile,
  groundingDocFromFile,
  renderGroundingDigest,
  GROUNDING_TYPES,
  type GroundingDigest,
  type GroundingDoc,
  type GroundingSpecEntry,
  type AgentImage,
  type AgentModel,
  type CapabilityMaterialisation,
  type GovernanceLevel,
  type HarnessAdapter,
  type PermissionAck,
  type PermissionDecision,
  type ScaffoldStep,
} from "@arke/contracts";
import { isWithinRoot, resolveDirectory } from "@arke/adapter-opencode";
import {
  flattenDeltaTags,
  isMaterialChange,
  isSelfApproval,
  mapWebhookEvent,
  normativeHash,
  parseCapabilities,
} from "./spec-lifecycle.js";
import { buildDeliveryPrompt, deliveryWorktreeBranch, parseTasks } from "./delivery.js";
import { loadAutoOpenPr, setAutoOpenPr } from "./delivery-config.js";
import {
  type HarnessStatus,
  type RegistrySnapshot,
  type RegistryWarning,
  type RegistryWarningReason,
} from "./registry.js";
import { AgentRegistry, loadAgentRegistry } from "./agent-registry.js";
import {
  ISSUE_EXTRACTION_PROMPT_VERSION,
  buildReviewerPrompt,
  detectAgreement,
  parseReviewerIssues,
  sectionHashOf,
  validateReviewers,
  type ReviewerConfig,
} from "./review-panel.js";
import {
  DEFAULT_GENERATION_TIMEOUT_MS,
  buildGenerationPrompt,
  parseArtifacts,
  resolveApproval,
  specContentHash,
  type ArtifactEdit,
  type ArtifactProposal,
} from "./generation.js";
import { idempotencyKey, probeIntegrations, type IntegrationRecord } from "./projection.js";
import { loadAgentImage, setAgentModel, setAgentMode, setAgentPermission, writeNewAgent, type NewAgentSpec } from "@arke/agent-image";
import { ReadModel } from "./read-model.js";
import { computeRepoStatus, gitRepoIdentity } from "./git-status.js";
import { sanitizeSpanAttributes } from "./trace.js";
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
  /** The project's agents (each declaring model + provider) and provider/auth profiles (SPEC-016 revised). */
  agents?: AgentRegistry;
  registry: ProjectRegistry;
  /** Fan a stamped event out to this context's active client connections (supervisor-supplied). */
  publish: (event: DomainEvent) => void;
  probe?: HarnessReachabilityProbe;
}

/** In-memory state for one review panel (SPEC-007); adjudications are also written to the trace. */
interface PanelIssueState {
  issueId: string;
  reviewerRole: string;
  section: string;
  sectionHash: string;
  text: string;
  severity: string;
  adjudication?: "accepted" | "dismissed" | "sent-back";
}
interface PanelReviewerState {
  role: string;
  sessionId: string;
  model: string;
  label: string;
  status: "running" | "done" | "error";
}
interface ReviewPanel {
  panelId: string;
  specId: string; // canonical
  branch?: string;
  startedAt: number;
  requirementsSectionHash: string;
  /** Normalised section identifier (anatomy key + title, lowercased) → hash of that section's CONTENT
   *  at panel start. Used to anchor issues by section content rather than the reviewer's label string. */
  sectionHashes: Map<string, string>;
  reviewers: PanelReviewerState[];
  issues: PanelIssueState[];
  agreedHashes: Set<string>;
  status: "running" | "complete" | "failed";
}

/** A spec library entry projected from a file's frontmatter + coordinator lifecycle state (SPEC-008). */
export interface SpecLibraryRecord {
  specId: string;
  title: string;
  status: SpecStatus;
  branch: string;
  capabilities: string[];
  updatedAt: string;
  prNumber?: number;
  hasDivergence?: boolean;
}

/** Coordinator-side lifecycle state for a spec, driven by PR webhooks (SPEC-008). */
interface SpecRecordState {
  status: SpecStatus;
  prNumber?: number;
  normativeHash?: string;
}

export class ProjectContext {
  readonly projectId: string;
  readonly root: string;
  readonly name: string;
  readonly adapter: HarnessAdapter;
  private readonly trace: Trace;
  private readonly grants: GrantStore;
  private readonly endpoints: string[];
  private readonly registry: ProjectRegistry;
  private readonly probe: HarnessReachabilityProbe;
  private readonly publish: (event: DomainEvent) => void;
  /** The project's agents (declared model + provider) and provider/auth profiles (SPEC-016 revised).
   *  Reassigned when an agent's model is edited (`agent.configure`) so the roster stays live. */
  private agents: AgentRegistry;
  private registrySnapshot: RegistrySnapshot | null = null;
  /** Serialises approveDraft per project so two concurrent approvals can't race the commit/rollback. */
  private approvalInFlight = false;
  /** Live review panels by id (SPEC-007); in-memory, durable adjudication via the trace. */
  private readonly panels = new Map<string, ReviewPanel>();
  /** Reviewer session id → its panel + role, so the pump routes reviewer output to the panel. */
  private readonly reviewerSessions = new Map<string, { panelId: string; role: string }>();
  /** Spec lifecycle state by canonical specId, driven by PR webhooks (SPEC-008). */
  private readonly specRecords = new Map<string, SpecRecordState>();
  /** Sessions whose diff a human has approved for PR (SPEC-011 diff-gate; idempotency guard). */
  private readonly prApproved = new Set<string>();
  /** Generation proposals by specId (SPEC-013); the buffered, pre-write proposal awaiting a decision. */
  private readonly generationProposals = new Map<string, { sessionId: string; artifacts: ArtifactProposal[]; specContentHash: string; status: "generating" | "pending-review" }>();
  /** generation sessionId → specId, so the agent's completed turn is routed back to its proposal. */
  private readonly generationSessions = new Map<string, string>();
  /** specId → its live delivery (single-session implementation) sessionId — the claim that closes the
   *  TOCTOU race between deliver()'s guard and the async createSession call (SPEC-009 revised). */
  private readonly deliverySessions = new Map<string, string>();
  /** delivery sessionId → specId, so a settled turn is routed back to its completion check. */
  private readonly deliverySessionOwner = new Map<string, string>();
  /** specId → the delivery's worktree path + branch, so a harness-reported error (observeDeliveryProgress)
   *  can remove the worktree/branch the same way a pre-dispatch failure does — otherwise the deterministic
   *  branch name lingers and every retry trips the branch-collision guard. */
  private readonly deliveryWorktrees = new Map<string, { wtPath: string; branch: string }>();
  /** Canonical spec ids with at least one completed review panel — the finalisation gate (SPEC-007). */
  private readonly completedReviews = new Set<string>();
  /** Specs currently being auto-renamed after titling, so the per-turn trigger is not re-entrant (SPEC-020). */
  private readonly renamingSpecs = new Set<string>();
  /** SPEC-025: last emitted repo.identity signature (remote|default|head) — re-emit only on change. */
  private lastRepoIdentitySig = "";
  /** SPEC-025: per-spec debounce timers, coalescing rapid triggers into one recompute per branch. */
  private readonly repoDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  /** SPEC-025: the periodic background repo-status refresh (≤1/60s), cleared on stop(). */
  private repoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** SPEC-026: the `docs/**` watcher driving bundle-index regeneration, closed on stop(). */
  private docsWatcher: FSWatcher | null = null;
  /** SPEC-026: per-bundle debounce timers, coalescing rapid `docs/` edits into one regeneration. */
  private readonly indexDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  /** SPEC-027: the assembled grounding digest, cached until a `docs/` change or grounding upload. */
  private groundingDigestCache: GroundingDigest | null = null;

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
    this.registry = init.registry;
    this.publish = init.publish;
    this.probe = init.probe ?? new HarnessReachabilityProbe();
    // Agents declare their own model+provider (SPEC-016 revised). Load them from the project's own
    // `agents/<name>/config.yaml` when the supervisor did not inject a registry (e.g. tests).
    this.agents = init.agents ?? loadAgentRegistry(this.root);
  }

  /** Classify the folder, register it as a recent, probe reachability, and start the pump if ready. */
  async start(): Promise<void> {
    this.classify();
    await this.reconstructReviewGate(); // SPEC-007: rebuild completed-review set from the durable trace
    this.registry.upsert({ root: this.root, name: this.name, state: this.projectState });
    await this.refreshReachability();
    // Build the registry projection even when the harness isn't ready: a configured-but-unreachable
    // instance is a real, useful state for the harnesses screen (SPEC-005).
    await this.refreshRegistry();
    this.startRepoRefresh(); // SPEC-025: seed the Overview's repository panel + keep it fresh
    this.sweepAllBundles(); // SPEC-026: regenerate every docs/ bundle index from disk (out-of-band repair)
    this.startDocsWatcher(); // SPEC-026: keep bundle indexes current on any docs/ change
    const readiness = this.adapter.readiness?.();
    if (readiness && !readiness.ready) return; // serve snapshot only; no stream
    void this.pump();
  }

  /** Stop this context's pump and any harness it started (never an attached one — SPEC-016). */
  async stop(): Promise<void> {
    this.abort.abort();
    if (this.repoRefreshTimer) clearInterval(this.repoRefreshTimer); // SPEC-025: stop the background refresh
    this.repoRefreshTimer = null;
    for (const t of this.repoDebounce.values()) clearTimeout(t);
    this.repoDebounce.clear();
    this.stopDocsWatcher(); // SPEC-026: close the docs/ watcher + clear its debounce timers
    await this.trace.drain(); // SPEC-015: flush enqueued trace appends before exit (no dropped records)
    await this.adapter.stopServer?.();
  }

  // ---- OKF bundle indexes (SPEC-026) --------------------------------------

  /** Regenerate the `docs/specifications/` index synchronously — the spec lifecycle fast-path, so a
   *  governed status write reflects immediately rather than on the watcher's debounce latency. */
  private regenerateSpecIndex(): void {
    this.regenerateBundleIndex(resolve(this.root, "docs", "specifications"));
  }

  /**
   * Regenerate one `docs/` bundle's `index.md` from its documents' frontmatter (SPEC-026). Best-effort:
   * a failure is traced and swallowed, never thrown into the caller. `docs/specifications/` renders the
   * rich spec table; every other bundle renders the generic OKF index. Idempotent — it writes only when
   * the rendered text differs, so a no-op regeneration touches nothing (and cannot loop the watcher).
   */
  private regenerateBundleIndex(dir: string): void {
    // Any docs/ document change (add/edit/delete, a governed status write) flows through here, so this is
    // the single choke-point to invalidate the grounding digest cache (SPEC-027) — cheap: it only nulls.
    this.groundingDigestCache = null;
    const bundle = relative(this.root, dir).replaceAll("\\", "/") || ".";
    try {
      if (!existsSync(dir)) return;
      const isSpecs = resolve(dir) === resolve(this.root, "docs", "specifications");
      const names = readdirSync(dir).filter((f) => {
        try {
          return statSync(resolve(dir, f)).isFile();
        } catch {
          return false;
        }
      });
      let md: string;
      let count: number;
      if (isSpecs) {
        const entries = names.filter(isSpecFile).map((f) => specEntryFromFile(f, readFileSync(resolve(dir, f), "utf8")));
        md = renderSpecIndex(entries);
        count = entries.length;
      } else {
        const files = names.filter(isBundleDoc);
        if (files.length === 0) return; // not an OKF bundle (no documents) → no index
        const entries = files.map((f) => bundleEntryFromFile(f, readFileSync(resolve(dir, f), "utf8")));
        md = renderBundleIndex(basename(dir), entries);
        count = entries.length;
      }
      const indexPath = resolve(dir, "index.md");
      const changed = !existsSync(indexPath) || readFileSync(indexPath, "utf8") !== md;
      if (changed) writeFileSync(indexPath, md, "utf8");
      void this.trace.write({ kind: "index.generated", projectId: this.projectId, bundle, docCount: count, changed });
    } catch (err) {
      void this.trace.write({ kind: "index.generated", projectId: this.projectId, bundle, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Regenerate every `docs/` bundle index from disk (the project-open sweep, SPEC-026): the `docs/` root
   *  itself (if it holds top-level documents) plus each subfolder that is an OKF bundle. */
  private sweepAllBundles(): void {
    const docsRoot = resolve(this.root, "docs");
    if (!existsSync(docsRoot)) return;
    try {
      this.regenerateBundleIndex(docsRoot);
      for (const name of readdirSync(docsRoot)) {
        const sub = resolve(docsRoot, name);
        try {
          if (statSync(sub).isDirectory()) this.regenerateBundleIndex(sub);
        } catch {
          /* skip an unreadable entry */
        }
      }
    } catch {
      /* docs/ unreadable — the watcher (if it starts) still covers live edits */
    }
  }

  /** Watch `docs/**` and regenerate the changed bundle's index, debounced (SPEC-026). The generator's own
   *  `index.md` writes are excluded so regeneration cannot self-trigger. Degrades to sweep-only when
   *  filesystem watching is unavailable (headless/CI). */
  private startDocsWatcher(): void {
    const docsRoot = resolve(this.root, "docs");
    if (this.docsWatcher || !existsSync(docsRoot)) return;
    try {
      this.docsWatcher = watch(docsRoot, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const rel = filename.toString().replaceAll("\\", "/");
        if (!rel.endsWith(".md") || rel.endsWith("index.md")) return; // .md documents only; never our own writes
        const slash = rel.indexOf("/");
        const bundleDir = slash === -1 ? docsRoot : resolve(docsRoot, rel.slice(0, slash));
        const prev = this.indexDebounce.get(bundleDir);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
          this.indexDebounce.delete(bundleDir);
          this.regenerateBundleIndex(bundleDir);
        }, 250);
        if (typeof t.unref === "function") t.unref();
        this.indexDebounce.set(bundleDir, t);
      });
      this.docsWatcher.on("error", () => {
        /* watcher died — the project-open sweep remains the backstop */
      });
    } catch {
      /* fs.watch unavailable — sweep-only fallback */
    }
  }

  private stopDocsWatcher(): void {
    if (this.docsWatcher) {
      try {
        this.docsWatcher.close();
      } catch {
        /* already gone */
      }
      this.docsWatcher = null;
    }
    for (const t of this.indexDebounce.values()) clearTimeout(t);
    this.indexDebounce.clear();
  }

  // ---- typed grounding digest (SPEC-027) ----------------------------------

  /**
   * Assemble the three-part typed grounding digest (SPEC-027) injected at BOTH sites — authoring and
   * review. (a) business grounding = the grounding-typed OKF documents anywhere under `docs/`, selected
   * by `type` (not folder); (b) the existing spec corpus from `docs/specifications/` (SPEC-026); (c) the
   * `.arke/grounding/` local uploads, referenced by explicit path. Cached per project-context and
   * invalidated whenever a `docs/` bundle regenerates (any doc add/edit/status change flows through
   * {@link regenerateBundleIndex}) or a grounding file is uploaded — so the walk is not repeated per turn.
   */
  private buildGroundingDigest(): GroundingDigest {
    if (this.groundingDigestCache) return this.groundingDigestCache;
    const digest: GroundingDigest = {
      businessGrounding: this.collectGroundingDocs(),
      specIndex: this.collectSpecIndexDigest(),
      sessionUploads: this.groundingList().map((g) => ({ path: `.arke/grounding/${g.name}` })),
    };
    this.groundingDigestCache = digest;
    return digest;
  }

  /** Walk `docs/` recursively and collect every grounding-typed document (SPEC-027, part a). */
  private collectGroundingDocs(): GroundingDoc[] {
    const docsRoot = resolve(this.root, "docs");
    if (!existsSync(docsRoot)) return [];
    const summaryBudget = Number(process.env.ARKE_GROUNDING_SUMMARY_BUDGET) || undefined;
    const out: GroundingDoc[] = [];
    const walk = (dir: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const abs = resolve(dir, name);
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (name === "assets" || name === "examples") continue; // not OKF document folders
          walk(abs);
          continue;
        }
        if (!name.endsWith(".md") || name === "index.md") continue; // generated index is `type: index`, never grounding
        const relPath = relative(this.root, abs).replaceAll("\\", "/");
        try {
          const doc = groundingDocFromFile(relPath, readFileSync(abs, "utf8"), summaryBudget ? { summaryBudget } : {});
          if (doc) out.push(doc);
        } catch {
          /* an unreadable/odd file is skipped — grounding is best-effort context */
        }
      }
    };
    walk(docsRoot);
    // Deterministic order: by the grounding vocabulary (product-overview first), then path.
    out.sort((a, b) => rankGroundingType(a.type) - rankGroundingType(b.type) || a.path.localeCompare(b.path));
    return out;
  }

  /** Project `docs/specifications/` into the compact spec-index digest (SPEC-027, part b), ordered by NNN. */
  private collectSpecIndexDigest(): GroundingSpecEntry[] {
    const dir = resolve(this.root, "docs", "specifications");
    if (!existsSync(dir)) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const entries: GroundingSpecEntry[] = [];
    for (const f of names.filter(isSpecFile)) {
      try {
        const e = specEntryFromFile(f, readFileSync(resolve(dir, f), "utf8"));
        if (e.parseState === "ok") {
          entries.push({ number: e.number, title: e.title, status: e.status, capabilities: e.capabilities, path: `docs/specifications/${e.path}` });
        }
      } catch {
        /* an unparseable spec is skipped from grounding (it still surfaces, flagged, in the index) */
      }
    }
    entries.sort((a, b) => a.number.localeCompare(b.number) || a.path.localeCompare(b.path));
    return entries;
  }

  /** Whether the pump is (or could be) streaming — used by idle eviction to avoid killing live work. */
  get streamingCount(): number {
    return this.streaming.size;
  }

  /**
   * Whether this project has work in flight (SPEC-022): a session that is running or blocked on a human
   * (a permission OR an elicitation), or a queued fan-out task. Derived from the READ MODEL's card
   * states — `status: running|waiting` and the sticky `needsHuman` gate — so it also catches a task
   * that is running before its first `message.part` and an elicitation-gated session (which a
   * `streaming`/`pendingPerms` check alone would miss — review D2). Computed host-side (authoritative),
   * never trusted from a renderer signal that can go stale across a reconnect. The desktop shell
   * aggregates this across contexts to gate quit-confirm and auto-update.
   */
  workInFlight(): boolean {
    for (const card of this.read.snapshot()) {
      // Sessions fold into their spec's card (SPEC-023): work is in flight if any folded session is
      // running/waiting, or a human gate is open. `card.status` is now the spec's frontmatter status.
      if (card.needsHuman) return true;
      if (card.sessions.some((s) => s.status === "running" || s.status === "waiting")) return true;
    }
    return false;
  }

  /**
   * The dispatch `model` fragment for an agent (SPEC-016 revised): the concrete model+provider the
   * agent declares in its image `executor`, spread into a {@link SendMessageInput}. An agent that
   * pins no model (or is unknown) yields `{}` — the adapter then omits `model` and the harness uses
   * the agent's own materialised/default model.
   */
  private modelArg(agent: string): { model?: AgentModel } {
    const m = this.agents.modelFor(agent);
    return m ? { model: m } : {};
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
      ...(this.registrySnapshot ? { registry: this.registrySnapshot } : {}),
      // SPEC-019: whether ANY harness is configured (a provider profile or a live endpoint). When
      // false, the launch screen shows first-run quick setup instead of the configured-but-down state.
      harnessSetup: { configured: this.endpoints.length > 0 || Object.keys(this.agents.providers).length > 0 },
      specs: this.specLibrary(), // SPEC-008: the spec library for this project
      // SPEC-030: the per-project auto-PR preference, so the Settings toggle renders its true state on
      // connect without an extra round-trip.
      delivery: { autoOpenPr: loadAutoOpenPr(this.deliveryConfigPath()) },
      ...this.read.repoSnapshot(), // SPEC-025: repoIdentity + gitBranches, so a fresh client isn't blank
    };
  }

  cardCount(): number {
    return this.read.snapshot().length;
  }

  // ---- repository status (SPEC-025) ---------------------------------------

  /**
   * Recompute git + GitHub PR status for one specification branch (or all when `specId` is omitted) and
   * emit `repo.status` per branch plus `repo.identity` once (re-emitted only when HEAD/remote changed).
   * All queries are read-only and each failure degrades one field, never crashes the context. Emitted
   * events fold into the read model (so the snapshot seeds them) and publish to clients.
   */
  async refreshRepoStatus(specId?: string): Promise<void> {
    if (!gitAvailable()) return; // no git → nothing to compute; the panel shows its empty state
    let records: SpecLibraryRecord[];
    try {
      records = this.specLibrary().filter((r) => r.branch && (specId ? r.specId === specId : true));
    } catch {
      return;
    }
    const id = gitRepoIdentity(this.root);
    const sig = `${id.remote}|${id.default}|${id.head}`;
    if (sig !== this.lastRepoIdentitySig) {
      this.lastRepoIdentitySig = sig;
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "repo.identity", ...id });
    }
    const ghEnabled = this.hostConfigured();
    const defaultBranch = id.default || "main";
    for (const rec of records) {
      const status = computeRepoStatus({
        root: this.root,
        specId: rec.specId,
        branch: rec.branch,
        defaultBranch,
        ghEnabled,
        ...(rec.prNumber !== undefined ? { prNumberFallback: rec.prNumber } : {}),
      });
      // Trace a fully-degraded row's reason once (NFR-7) so a missing binary/integration is visible.
      if (status.degraded && status.degraded.length) {
        await this.trace
          .write({ kind: "repo.status-degraded", projectId: this.projectId, specId: rec.specId, branch: rec.branch, degraded: status.degraded })
          .catch(() => undefined);
      }
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "repo.status", ...status });
    }
  }

  /**
   * SPEC-025 trigger (3): after a `diff.finalized` or a TERMINAL `session.status`, schedule a debounced
   * per-branch recompute. Called from `emit()`; it never reacts to `repo.*` events (so no recursion) and
   * coalesces the frequent `session.status` transitions of a fan-out into one recompute per branch.
   */
  private scheduleRepoRecompute(event: DomainEvent): void {
    let specId: string | undefined;
    if (event.type === "diff.finalized") {
      specId = this.read.specForSession(event.sessionId);
    } else if (event.type === "session.status" && (event.status === "done" || event.status === "error" || event.status === "interrupted")) {
      specId = event.specId;
    }
    if (!specId) return;
    const existing = this.repoDebounce.get(specId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.repoDebounce.delete(specId!);
      void this.refreshRepoStatus(specId).catch(() => undefined);
    }, 400);
    timer.unref?.();
    this.repoDebounce.set(specId, timer);
  }

  /** Start the bounded (≤1/60s) background repo-status refresh. Idempotent; cleared by {@link stop}. */
  private startRepoRefresh(): void {
    if (this.repoRefreshTimer) return;
    void this.refreshRepoStatus().catch(() => undefined); // trigger (1): on open
    const timer = setInterval(() => void this.refreshRepoStatus().catch(() => undefined), 60_000); // trigger (2)
    timer.unref?.();
    this.repoRefreshTimer = timer;
  }

  // ---- registry projection (SPEC-005) -------------------------------------

  /**
   * Recompute the client-safe registry projection from this project's config + the live adapter, and
   * emit `registry.updated` (and any `registry.warning`). The connected instance is enriched with its
   * real reachability, capabilities, and model catalog; other configured instances are surfaced as
   * configured-but-not-connected (multi-instance adapters are a follow-up). Never includes a model
   * string or a credentialsRef — tier labels only.
   */
  async refreshRegistry(reprobe = false): Promise<void> {
    const providers = this.agents.providers;
    const agentRoster = this.agents.list();
    // Nothing configured at all (no provider profile, no agent image) → no projection to show.
    if (Object.keys(providers).length === 0 && agentRoster.length === 0) {
      this.registrySnapshot = null;
      return;
    }
    // On an explicit Re-probe, re-run the adapter's startup probe so readiness/caps reflect the
    // server's CURRENT state — OpenCodeAdapter caches them at init(), so without this the Re-probe
    // button could never recover a server that was down at startup. init() is idempotent; guard it
    // so a still-down server yields reachable:false rather than throwing here.
    if (reprobe && this.adapter.init) {
      try {
        await this.adapter.init();
      } catch {
        /* readiness()/capabilities() now reflect the failed probe */
      }
    }
    const r = this.adapter.readiness?.() ?? { ready: true };
    const caps = [...this.adapter.capabilities()];
    const liveEndpoint = this.endpoints[0] ?? this.adapter.id;
    // Each provider/auth profile is a harness endpoint. The OpenCode profile the adapter serves gets
    // its live reachability + capabilities; any other profile is surfaced configured-but-not-wired.
    const harnesses: HarnessStatus[] = [];
    const entries = Object.entries(providers);
    if (entries.length === 0) {
      // No explicit provider profiles but the adapter is live — surface it as the single harness.
      harnesses.push({ id: this.adapter.id, harness: this.adapter.id, endpoint: liveEndpoint, reachable: r.ready, caps });
    } else {
      // Only ONE OpenCode profile is actually wired — `loadOpenCodeConfig` picks the first — so only
      // that one carries the live endpoint/reachability/caps. Any other profile (a second OpenCode
      // provider, or a non-OpenCode harness) is surfaced configured-but-not-wired.
      let wiredOpenCode = false;
      for (const [id, prof] of entries) {
        const kind = prof.harness ?? "opencode";
        const isWired = kind.startsWith("opencode") && !wiredOpenCode;
        if (isWired) wiredOpenCode = true;
        const endpoint = isWired
          ? liveEndpoint
          : prof.baseUrl ?? [prof.host, prof.port].filter(Boolean).join(":") ?? id;
        harnesses.push({ id, harness: kind, endpoint, reachable: isWired ? r.ready : false, caps: isWired ? caps : [] });
      }
    }

    // Reviewer independence (SPEC-007): surface a warning when the two reviewers resolve to the same
    // model. Stored ON the snapshot so a client opening a project with a bad roster sees it at once.
    const warnings: RegistryWarning[] = [];
    if (this.agents.has("reviewer-a") && this.agents.has("reviewer-b")) {
      const v = validateReviewers(this.agents, [{ role: "reviewer-a" }, { role: "reviewer-b" }]);
      if (!v.ok) warnings.push({ reason: "reviewer-models-identical", detail: v.reason });
    }

    this.registrySnapshot = { harnesses, agents: agentRoster, warnings };
    // Emit the warning events too, for clients already subscribed to a live context.
    for (const w of warnings) await this.emitRegistryWarning(w.reason, w.detail ?? "");
    await this.emit({
      seq: 0,
      ts: 0,
      harness: this.adapter.id,
      type: "registry.updated",
      // The live event carries the harness endpoints (as instances); the agent roster rides the
      // snapshot (`registry.get`). `serves` is retained by the schema but empty — tiers are gone.
      instances: harnesses.map((h) => ({ id: h.id, driver: h.harness, endpoint: h.endpoint, reachable: h.reachable, caps: h.caps, serves: [] })),
    } as DomainEvent);
  }

  private emitRegistryWarning(reason: RegistryWarningReason, detail: string): Promise<void> {
    return this.emit({
      seq: 0,
      ts: 0,
      harness: this.adapter.id,
      type: "registry.warning",
      reason,
      detail,
    } as DomainEvent);
  }

  /**
   * Rewrite an agent's declared model, permission grid, and/or interaction mode in its image
   * (SPEC-016 revised + SPEC-021) — the write half of the model + capability editor. Edits
   * `agents/<name>/config.yaml` (`executor.config.model` + optional `options.reasoningEffort`, the
   * `interaction.mode`, and the top-level `permission:` block), re-materialises the harness agent so
   * a permission/mode edit actually reaches OpenCode, reloads the {@link AgentRegistry}, and refreshes
   * the projection so the roster updates live. The write is confined to this project's root; the model
   * id, mode, and permission verbs are public (only credentials are host-side).
   *
   * Each field is independent: an empty `model` leaves the model untouched (so a default-model agent
   * can still have its permissions saved); `permission` undefined leaves the block, whereas an explicit
   * empty map CLEARS it; an invalid permission verb (only `allow|ask|deny`) is rejected before any write.
   */
  async configureAgent(rawName: unknown, rawProvider: unknown, rawModel: unknown, rawEffort: unknown, rawPermission?: unknown, rawMode?: unknown): Promise<{ name: string; model?: string; reasoningEffort?: string; permission?: Record<string, string>; mode?: string }> {
    const name = String(rawName ?? "");
    // Guard the path segment: agent names index a directory, so only a safe slug is addressable.
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`invalid agent name '${name}'`);
    if (!this.agents.has(name)) throw new Error(`unknown agent '${name}'`);
    const provider = String(rawProvider ?? "").trim();
    const model = String(rawModel ?? "").trim();
    const effort = rawEffort ? String(rawEffort).trim() : undefined;
    // A concrete provider prefixes the model; the `gateway` sentinel (harness default) stays bare. An
    // empty model means "leave the model untouched" (a permission-only save on a default-model agent),
    // NOT an error — so a gateway/default agent's permissions can still be edited.
    const hasModel = model !== "";
    const full = hasModel && provider && provider !== "gateway" ? `${provider}/${model}` : model;
    const permission = sanitizePermission(rawPermission); // undefined = leave; {} = clear; {…} = set (verbs validated)
    const mode = rawMode ? String(rawMode).trim() : undefined;
    if (mode && mode !== "primary" && mode !== "subagent" && mode !== "all") throw new Error(`invalid mode '${mode}' (expected primary | subagent | all)`);
    if (!hasModel && permission === undefined && !mode) throw new Error("nothing to update — provide a model, permission, or mode");

    const agentDir = resolve(this.root, "agents", name);
    if (!isWithinRoot(this.root, agentDir)) throw new Error("agent image path escapes the project root");
    if (!existsSync(resolve(agentDir, "config.yaml"))) throw new Error(`agent '${name}' has no config.yaml image`);

    if (hasModel) setAgentModel(agentDir, full, effort);
    if (mode) setAgentMode(agentDir, mode);
    if (permission !== undefined) setAgentPermission(agentDir, permission);
    // Reload the roster from disk (keeping the same provider profiles) so modelFor()/list() are fresh.
    this.agents = loadAgentRegistry(this.root, this.agents.providers);
    // Re-materialise the harness agent: OpenCode reads permissions + mode from `.opencode/agents/<name>.md`,
    // so without this a permission/mode edit would never take effect. The adapter preserves the existing
    // instruction body when the image carries none, so this only rewrites the frontmatter and never
    // clobbers the prompt (the reason an earlier version skipped it). A model edit also rides the
    // per-message dispatch override, but rewriting it here keeps the materialised file consistent.
    const img = this.agents.image(name);
    if (img) await this.adapter.materializeAgent?.(img);
    await this.trace.write({ kind: "agent.configured", projectId: this.projectId, name, ...(hasModel ? { model: full } : {}), ...(effort ? { reasoningEffort: effort } : {}), ...(mode ? { mode } : {}), ...(permission !== undefined ? { permission } : {}) });
    await this.refreshRegistry(); // emit registry.updated + refresh the snapshot roster
    return { name, ...(hasModel ? { model: full } : {}), ...(effort ? { reasoningEffort: effort } : {}), ...(mode ? { mode } : {}), ...(permission !== undefined ? { permission } : {}) };
  }

  /**
   * Create a NEW agent image (`agents/<name>/config.yaml`) from the editor's structured spec
   * (SPEC-021). The name is slug-guarded and the write is confined to this project's `agents/` dir;
   * the underlying writer round-trips the image through the loader (rejecting an inline secret — NFR-1,
   * or an overwrite of an existing agent) so a bad create never lands on disk. On success the registry
   * reloads and the projection refreshes so the new agent appears on the roster at once.
   */
  async createAgent(raw: unknown): Promise<{ name: string }> {
    const spec = raw as Partial<NewAgentSpec> | undefined;
    const name = String(spec?.name ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`invalid agent name '${name}'`);
    if (!spec?.harness) throw new Error("a harness is required");
    const agentsRoot = resolve(this.root, "agents");
    const agentDir = resolve(agentsRoot, name);
    if (!isWithinRoot(this.root, agentDir)) throw new Error("agent image path escapes the project root");

    const permission = sanitizePermission(spec.permission);
    writeNewAgent(agentsRoot, {
      name,
      ...(spec.description ? { description: String(spec.description) } : {}),
      harness: String(spec.harness),
      ...(spec.model ? { model: String(spec.model) } : {}),
      ...(spec.reasoningEffort ? { reasoningEffort: String(spec.reasoningEffort) } : {}),
      ...(spec.authProfile ? { authProfile: String(spec.authProfile) } : {}),
      ...(spec.mode ? { mode: String(spec.mode) } : {}),
      ...(typeof spec.conversational === "boolean" ? { conversational: spec.conversational } : {}),
      ...(spec.instructions ? { instructions: String(spec.instructions) } : {}),
      ...(permission && Object.keys(permission).length ? { permission } : {}),
      ...(spec.tools ? { tools: spec.tools } : {}),
    });
    this.agents = loadAgentRegistry(this.root, this.agents.providers);
    // Materialise the new agent into the harness immediately (like `agents.materialize`): OpenCode
    // reads the agent from `.opencode/agents/<name>.md` and its MCP servers from `opencode.json`, so
    // without this a just-created agent (especially one with MCP tools) shows on the roster but is not
    // yet usable until a separate materialise. Best-effort per capability; the trace records the result.
    const img = this.agents.image(name);
    if (img) {
      await this.adapter.materializeAgent?.(img);
      const cap = this.adapter.materializeCapabilities ? await this.adapter.materializeCapabilities(img) : undefined;
      await this.trace.write({ kind: "agent.created", projectId: this.projectId, name, harness: String(spec.harness), ...(spec.model ? { model: String(spec.model) } : {}), ...(cap ? { registered: cap.registered, unsupported: cap.unsupported } : {}) });
    } else {
      await this.trace.write({ kind: "agent.created", projectId: this.projectId, name, harness: String(spec.harness), ...(spec.model ? { model: String(spec.model) } : {}) });
    }
    await this.refreshRegistry();
    return { name };
  }

  // ---- authoring cockpit (SPEC-006) ---------------------------------------

  /**
   * Locate a working specification file under this project's `docs/specifications/` by spec id
   * (matched against the frontmatter `spec_id`/`slug`/`title` or the filename stem). Host-side read,
   * confined to the project root. Returns the file's text + parsed frontmatter, or null if absent.
   */
  private findSpecFile(specId: string): { relPath: string; absPath: string; text: string; frontmatter: Record<string, string>; canonicalId: string } | null {
    if (!specId) return null;
    const dir = resolve(this.root, "docs", "specifications");
    if (!existsSync(dir)) return null;
    // Canonicalise both the project root and the specifications dir, then require the specs dir to
    // resolve INSIDE the canonical root — otherwise a `docs/specifications -> /outside` symlink would
    // make realDir an external directory and authorise every file under it (PR #18 review round 3).
    let realRoot: string;
    let realDir: string;
    try {
      realRoot = realpathSync.native(this.root);
      realDir = realpathSync.native(dir);
    } catch {
      return null;
    }
    // The specs dir must resolve to EXACTLY <root>/docs/specifications. isWithinRoot alone passed when
    // realDir === realRoot (a `docs/specifications -> .` symlink), which then authorised every top-level
    // .md in the repo via the per-file `isWithinRoot(realDir, …)` check below. Pinning the canonical
    // location rejects a specs dir relocated by a symlink (PR #18 final review).
    const expectedDir = resolve(realRoot, "docs", "specifications");
    if (realDir !== expectedDir || !isWithinRoot(realRoot, realDir)) return null;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md"); // exclude the generated index (SPEC-026)
    } catch {
      return null;
    }
    for (const f of entries) {
      const absPath = resolve(dir, f);
      // Confine reads to `docs/specifications/` itself (not merely the repo root): resolve symlinks
      // first, so a planted entry like `secret.md -> /etc/passwd` OR `leak.md -> ../../in-repo-file`
      // is skipped — only files that actually live under the specifications dir are served/written
      // (PR #18 review, rounds 1–2).
      let real: string;
      try {
        real = realpathSync.native(absPath);
      } catch {
        continue;
      }
      if (!isWithinRoot(realDir, real)) continue;
      let text: string;
      try {
        text = readFileSync(real, "utf8");
      } catch {
        continue;
      }
      const { data } = parseFrontmatter(text);
      const stem = f.replace(/\.md$/, "");
      // Match either frontmatter convention: `spec_id` (the spec files' YAML) or `specId` (the
      // SpecFrontmatter contract shape), plus slug / title / filename stem.
      if (data.spec_id === specId || data.specId === specId || data.slug === specId || data.title === specId || stem === specId) {
        // Derive the git pathspec from the CANONICAL root, so a project opened via a symlinked dir
        // still yields `docs/specifications/foo.md` (not `../real-repo/…`, which `git add` rejects).
        // `canonicalId` is the frontmatter spec id, so results/events use it even when the caller
        // passed a slug/title/filename alias (PR #18 review round 7).
        const canonicalId = data.spec_id ?? data.specId ?? specId;
        // SPEC-024: coerce legacy on-disk `status: merged` to the renamed terminal `delivered` on read,
        // so a spec authored before the rename still resolves to a valid status (spec.ts note).
        if (data.status === "merged") data.status = "delivered";
        return { relPath: relative(realRoot, real).replaceAll("\\", "/"), absPath: real, text, frontmatter: data, canonicalId };
      }
    }
    return null;
  }

  /** `spec.file` — the working specification text + metadata for the cockpit preview (SPEC-006). */
  private readSpecFile(specId: string): {
    specId: string;
    exists: boolean;
    path?: string;
    text?: string;
    branch?: string;
    status?: string;
  } {
    const found = this.findSpecFile(specId);
    if (!found) return { specId, exists: false };
    return {
      specId: found.canonicalId, // canonical id even when the caller passed an alias (round 7)
      exists: true,
      path: found.relPath,
      text: found.text,
      ...(found.frontmatter.branch ? { branch: found.frontmatter.branch } : {}),
      ...(found.frontmatter.status ? { status: found.frontmatter.status } : {}),
    };
  }

  // ---- spec library + lifecycle (SPEC-008) --------------------------------

  /**
   * Build the spec library for this project (SPEC-008): one record per file under
   * `docs/specifications/` (template + examples excluded), parsed from frontmatter. The file in git is
   * the source of truth; `hasDivergence` flags a record whose frontmatter status differs from the
   * status the read model believes (e.g. after a missed webhook).
   */
  specLibrary(): SpecLibraryRecord[] {
    const records: SpecLibraryRecord[] = [];
    const expectedDir = (() => {
      try {
        return resolve(realpathSync.native(this.root), "docs", "specifications");
      } catch {
        return resolve(this.root, "docs", "specifications");
      }
    })();
    const dir = resolve(this.root, "docs", "specifications");
    if (!existsSync(dir)) return records;
    let realDir: string;
    try {
      realDir = realpathSync.native(dir);
    } catch {
      return records;
    }
    if (realDir !== expectedDir) return records; // same symlink guard as findSpecFile
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "specification.template.md" && f !== "index.md");
    } catch {
      return records;
    }
    for (const f of entries) {
      let real: string;
      try {
        real = realpathSync.native(resolve(dir, f));
      } catch {
        continue;
      }
      if (!isWithinRoot(realDir, real)) continue;
      let text: string;
      try {
        text = readFileSync(real, "utf8");
      } catch {
        continue;
      }
      const { data } = parseFrontmatter(text);
      const specId = data.spec_id ?? data.specId ?? f.replace(/\.md$/, "");
      const frontStatus = (data.status ?? "draft") as SpecStatus;
      const known = this.specRecords.get(specId);
      records.push({
        specId,
        title: data.title ?? specId,
        status: known?.status ?? frontStatus,
        branch: data.branch ?? "",
        capabilities: parseCapabilities(data),
        updatedAt: data.updated ?? "",
        ...(known?.prNumber !== undefined ? { prNumber: known.prNumber } : {}),
        hasDivergence: known ? known.status !== frontStatus : false,
      });
    }
    return records;
  }

  /**
   * Apply a GitHub webhook event to this project's spec lifecycle (SPEC-008). Maps the event to a
   * transition, enforces the second-human (anti-self-approval) gate at the coordinator, runs the
   * merge-time delta flatten, and emits `spec.status` / governance trace. Returns a short outcome.
   */
  async handleWebhook(eventName: string, payload: unknown): Promise<{ applied: string; specId?: string }> {
    const t = mapWebhookEvent(eventName, payload);
    if (t.kind === "ignored") return { applied: `ignored: ${t.reason}` };
    if (!t.branch) return { applied: "ignored: empty branch" }; // a malformed payload must not route by ""
    const found = this.findSpecByBranch(t.branch);
    if (!found) return { applied: `no spec on branch '${t.branch}'` };
    const specId = found.canonicalId;
    const owner = found.frontmatter.owner;

    // Advance status via the shared `commitStatus` executor (SPEC-024) — the same write+persist+trace+
    // emit mechanics the human manual-move path uses, so a webhook and a person leave identical state.
    const setStatus = (status: SpecStatus, reason: string, extra?: Partial<SpecRecordState>) =>
      this.commitStatus(specId, status, reason, { prNumber: "prNumber" in t ? (t as any).prNumber : undefined, extra });

    switch (t.kind) {
      case "opened":
        await setStatus("in-review", "pr-opened");
        return { applied: "in-review", specId };
      case "reopened":
        await setStatus("in-review", "pr-reopened");
        return { applied: "in-review", specId };
      case "closed-unmerged":
        await setStatus("draft", "pr-closed");
        return { applied: "draft", specId };
      case "synchronized": {
        // A new push to an open PR. Only an APPROVED spec is affected, and only when the push changed
        // the normative sections — the material-change gate (SPEC-008). Trivial pushes keep approval.
        const rec = this.specRecords.get(specId);
        if (rec?.status === "approved" && isMaterialChange(rec.normativeHash, found.text)) {
          await setStatus("in-review", "material-change");
          return { applied: "material-change", specId };
        }
        return { applied: "no-op", specId };
      }
      case "approved": {
        // Second-human gate, fail CLOSED (SPEC-024: shared `approveGate` with the manual path). An
        // approval from the owner, OR a spec with no `owner` to verify against, must NOT advance to
        // approved via a webhook — the governance invariant can't be verified.
        const gate = this.approveGate(owner, t.approver, "webhook");
        if (!gate.ok) {
          await this.trace.write({ kind: "governance.self-approval-rejected", projectId: this.projectId, specId, approver: t.approver, prNumber: t.prNumber, reason: gate.code === "no-owner" ? "no-owner-to-verify" : "self-approval" });
          return { applied: gate.code === "no-owner" ? "approval-rejected-no-owner" : "self-approval-rejected", specId };
        }
        // Record the normative baseline so a later material change can be detected.
        await setStatus("approved", "pr-approved", { normativeHash: normativeHash(found.text) });
        // SPEC-024: approval is DECOUPLED from delivery. Reaching `approved` no longer fans out or
        // generates — it is a resting backlog state. Delivery (single-session implementation +
        // downstream-artefact generation) is started explicitly by the `spec.deliver` op, which may run
        // later, on any branch.
        return { applied: "approved", specId };
      }
      case "merged": // git-side transition kind (WebhookTransition.kind) — the PR merged
        await this.flattenAndMerge(specId, t.branch);
        await setStatus("delivered", "pr-merged"); // SPEC-024: the governed terminal status is `delivered`
        return { applied: "delivered", specId };
      case "force-push": {
        if (found.frontmatter.branch && found.frontmatter.branch !== t.branch) {
          await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.branch-mismatch", specId, frontmatterBranch: found.frontmatter.branch, pushedBranch: t.branch } as DomainEvent);
        }
        return { applied: "force-push-revalidated", specId };
      }
    }
  }

  /**
   * `commitStatus` (SPEC-024) — the ONE place a governed status is written: read-model record →
   * frontmatter persistence → audit trace → SPEC-009 demotion guard → `spec.status` emit. Shared by the
   * webhook lifecycle and the human manual-move path so both triggers leave identical state. `actor` is
   * carried for a human move (audited + emitted); absent for a webhook.
   */
  private async commitStatus(
    specId: string,
    status: SpecStatus,
    reason: string,
    opts?: { prNumber?: number; actor?: string; extra?: Partial<SpecRecordState> },
  ): Promise<void> {
    this.specRecords.set(specId, {
      ...(this.specRecords.get(specId) ?? {}),
      status,
      ...(opts?.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
      ...(opts?.extra ?? {}),
    });
    try {
      const cur = this.findSpecFile(specId);
      if (cur && (cur.frontmatter.status ?? "draft") !== status) writeFileSync(cur.absPath, setFrontmatterStatus(cur.text, status), "utf8");
    } catch {
      /* best-effort: the read model is authoritative for the gate; a write failure surfaces as divergence */
    }
    await this.trace.write({ kind: "spec.lifecycle", projectId: this.projectId, specId, status, reason, ...(opts?.actor ? { actor: opts.actor } : {}) });
    await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.status", specId, status, reason, ...(opts?.actor ? { actor: opts.actor } : {}) } as DomainEvent);
    this.regenerateSpecIndex(); // SPEC-026: keep the index status column true through the lifecycle
  }

  /** Legal governed status edges (SPEC-024). The client offers only adjacent moves as an affordance; the
   *  server enforces this table for EVERY caller, so an illegal/non-adjacent transition is refused
   *  regardless of trigger (board, CLI, or a direct op). */
  private static readonly LEGAL_TRANSITIONS: Record<string, SpecStatus[]> = {
    draft: ["in-review"],
    "in-review": ["approved", "draft"],
    approved: ["in-review", "delivered", "draft"],
    delivered: ["in-review"],
  };

  /** Is a git host configured (webhooks can drive transitions)? The webhook secret is the signal that
   *  PR review + branch protection govern this project — otherwise governance is host-less. */
  private hostConfigured(): boolean {
    return !!process.env.ARKE_WEBHOOK_SECRET;
  }

  /** The governance assurance level surfaced to the board (SPEC-024, host-optional). */
  governanceStatus(): { level: GovernanceLevel; hostConfigured: boolean } {
    const hostConfigured = this.hostConfigured();
    return { level: hostConfigured ? "host-enforced" : "solo", hostConfigured };
  }

  /**
   * The second-human approval gate (SPEC-024), shared by the webhook `approved` path and the human
   * manual-approve op — one gate, two triggers. A distinct approver (≠ owner) always passes. When the
   * approver is the owner or unknown: a webhook fails CLOSED; a host-enforced human is refused; only a
   * host-LESS human is allowed, in solo mode, and that self-approval is flagged for audit.
   */
  private approveGate(
    owner: string | undefined,
    approver: string | undefined,
    trigger: "webhook" | "human",
  ): { ok: true; solo?: boolean } | { ok: false; code: "self-approval" | "no-owner"; reason: string } {
    if (approver && owner && !isSelfApproval(approver, owner)) return { ok: true };
    if (trigger === "webhook") {
      return owner
        ? { ok: false, code: "self-approval", reason: "self-approval rejected" }
        : { ok: false, code: "no-owner", reason: "no owner to verify the approver against" };
    }
    // Human trigger with no distinct approver:
    if (this.hostConfigured()) return { ok: false, code: "self-approval", reason: "host-enforced governance requires an approver distinct from the owner" };
    return { ok: true, solo: true }; // host-less solo self-approval — permitted but flagged
  }

  /**
   * `applyTransition` (SPEC-024) — the ONE gated executor for a governed status change, shared by the
   * human manual-move op and (for the symmetric edges) the webhook lifecycle. The trigger differs (a
   * git-host webhook vs a person); the gate does not. Enforces legal adjacency, the per-edge gate
   * (second-human approval; the gated draft→in-review door; host-less local merge), the reopen
   * side-effect (interrupt in-flight delivery), and audits every move with `reason`/`actor`. Refuses any
   * illegal or non-adjacent transition for EVERY caller.
   */
  private async applyTransition(
    specId: string,
    to: SpecStatus,
    trigger: { kind: "webhook"; approver?: string } | { kind: "human"; actor?: string },
  ): Promise<{ applied: string; specId?: string; error?: string }> {
    const found = this.findSpecFile(specId);
    if (!found) return { applied: "no-spec", error: `no spec '${specId}'` };
    const cid = found.canonicalId;
    const from = (this.specRecords.get(cid)?.status ?? found.frontmatter.status ?? "draft") as SpecStatus;
    if (from === to) return { applied: "no-op", specId: cid };
    const legal = ProjectContext.LEGAL_TRANSITIONS[from] ?? [];
    if (!legal.includes(to)) {
      const reason = `illegal transition '${from}' → '${to}'`;
      await this.trace.write({ kind: "spec.transition-rejected", projectId: this.projectId, specId: cid, from, to, reason, trigger: trigger.kind });
      return { applied: "illegal-transition", specId: cid, error: reason };
    }
    const owner = found.frontmatter.owner;
    const actor = trigger.kind === "human" ? trigger.actor : undefined;

    // draft → in-review is the single gated door: delegate to `approveDraft` so a manual promote runs the
    // identical well-formedness / review-panel / branch gate as the cockpit approve.
    if (from === "draft" && to === "in-review") {
      try {
        const r = await this.approveDraft(cid);
        return { applied: r.status, specId: cid };
      } catch (err) {
        return { applied: "gate-failed", specId: cid, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // in-review → approved: the second-human gate (shared with the webhook path).
    if (to === "approved") {
      const gate = this.approveGate(owner, actor, "human");
      if (!gate.ok) {
        await this.trace.write({ kind: "governance.self-approval-rejected", projectId: this.projectId, specId: cid, approver: actor, reason: gate.code });
        return { applied: "self-approval-rejected", specId: cid, error: gate.reason };
      }
      if (gate.solo) await this.trace.write({ kind: "governance.self-approval-allowed-solo", projectId: this.projectId, specId: cid, actor });
      await this.commitStatus(cid, "approved", gate.solo ? "manual-solo" : "manual", { actor, extra: { normativeHash: normativeHash(found.text) } });
      return { applied: "approved", specId: cid };
    }

    // approved → delivered: the merge (git → frontmatter handshake). Host-enforced delivery lands via the
    // `merged` webhook; a host-LESS human reaches delivered by a local branch merge with conflict handling.
    if (to === "delivered") {
      const specBranch = found.frontmatter.branch;
      if (!specBranch) return { applied: "no-branch", specId: cid, error: `spec '${cid}' has no frontmatter branch to merge` };
      const merge = await this.localMerge(cid, specBranch);
      if (!merge.ok) return { applied: "merge-failed", specId: cid, error: merge.error };
      // Post-merge, HEAD is on the mainline. Flatten the delta tags, set `delivered`, and COMMIT that on
      // the mainline so git truly reflects the delivered outcome (no working-tree-vs-HEAD divergence).
      await this.flattenAndMerge(cid, specBranch);
      await this.commitStatus(cid, "delivered", "manual-merge", { actor });
      gitCommit(this.root, found.relPath, `spec(${cid}): delivered (local merge)`);
      return { applied: "delivered", specId: cid };
    }

    // reopen / regression → in-review, or a manual reject → draft. Reopening a delivered (or
    // approved-and-delivering) spec interrupts any in-flight delivery so work does not continue against a
    // superseded contract (SPEC-024, in-place reopen).
    if (from === "delivered" || from === "approved") await this.interruptInFlightDelivery(cid);
    await this.commitStatus(cid, to, "manual", { actor });
    return { applied: to, specId: cid };
  }

  /** Interrupt any in-flight delivery for a reopened spec (SPEC-024): mark its live task session
   *  `interrupted` (the card surfaces needs-human) and release the delivery claim so a fresh
   *  `spec.deliver` after re-approval isn't blocked by this superseded one. The contract changed —
   *  delivery must not silently continue. */
  private async interruptInFlightDelivery(specId: string): Promise<void> {
    const card = this.read.snapshot().find((c) => c.specId === specId);
    const live = (card?.sessions ?? []).filter((s) => s.kind === "task" && (s.status === "running" || s.status === "waiting" || s.status === "idle"));
    for (const s of live) {
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "session.status", sessionId: s.sessionId, specId, kind: "task", status: "interrupted" } as DomainEvent);
      this.deliverySessionOwner.delete(s.sessionId);
    }
    this.deliverySessions.delete(specId);
    if (live.length > 0) await this.trace.write({ kind: "delivery.interrupted", projectId: this.projectId, specId, count: live.length, reason: "reopen" });
  }

  /** Host-less local merge of a spec branch into the mainline to reach `delivered` (SPEC-024). A conflict
   *  is aborted cleanly and returned as a named error — never a half-merged tree. */
  private async localMerge(specId: string, specBranch: string): Promise<{ ok: true; sha?: string } | { ok: false; error: string }> {
    if (!gitAvailable()) return { ok: false, error: "git not found on PATH; cannot perform a local merge" };
    const mainline = gitDefaultBranch(this.root);
    if (!mainline) return { ok: false, error: "no mainline branch (main/master) found to merge into" };
    if (mainline === specBranch) return { ok: false, error: `the spec branch '${specBranch}' is the mainline; nothing to merge` };
    await this.trace.write({ kind: "local-merge.started", projectId: this.projectId, specId, from: specBranch, into: mainline });
    const res = gitMerge(this.root, mainline, specBranch, `spec(${specId}): deliver → ${mainline} (local merge)`);
    await this.trace.write({ kind: "local-merge.complete", projectId: this.projectId, specId, ok: res.ok, ...(res.ok ? {} : { conflict: !!res.conflict }) });
    if (!res.ok) return { ok: false, error: res.conflict ? `local merge conflicted (aborted, no partial state): ${res.error}` : res.error };
    return { ok: true, sha: res.sha };
  }

  /** Flatten delta tags on the working file at merge (idempotent), bracketed by trace markers. */
  private async flattenAndMerge(specId: string, branch: string): Promise<void> {
    const found = this.findSpecFile(specId);
    if (!found) return;
    await this.trace.write({ kind: "flatten.started", projectId: this.projectId, specId, branch });
    const date = new Date().toISOString().slice(0, 10);
    const { text, changed } = flattenDeltaTags(found.text, branch, date);
    if (changed) {
      try {
        writeFileSync(found.absPath, text, "utf8");
      } catch {
        /* best-effort; the trace records the attempt */
      }
    }
    await this.trace.write({ kind: "flatten.complete", projectId: this.projectId, specId, branch, changed });
  }

  /** Find the spec file whose frontmatter `branch` matches (for webhook routing by branch). */
  private findSpecByBranch(branch: string): { canonicalId: string; text: string; frontmatter: Record<string, string>; absPath: string } | null {
    for (const rec of this.specLibrary()) {
      if (rec.branch === branch) {
        const found = this.findSpecFile(rec.specId);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * `spec.deliver` (SPEC-024) — the explicit start of delivery, decoupled from approval. Approval parks
   * a spec in the `approved` backlog; delivery dispatches ONE implementer session with the full task
   * list (SPEC-009 revised — the agent decides how to sequence/tackle the tasks itself, no forced
   * concurrent fan-out) and proposes downstream artefacts (SPEC-013) on a recorded delivery branch, and
   * may run later, on any branch. Refuses a spec that is not `approved`, or one already delivering (no
   * double-dispatch).
   */
  private async deliver(specId: string, branch?: string): Promise<{ ok: boolean; specId?: string; branch?: string; error?: string }> {
    const found = this.findSpecFile(specId);
    if (!found) return { ok: false, error: `no spec '${specId}'` };
    const cid = found.canonicalId;
    const status = this.specRecords.get(cid)?.status ?? found.frontmatter.status ?? "draft";
    if (status !== "approved") return { ok: false, specId: cid, error: `cannot deliver: '${cid}' is '${status}', expected 'approved'` };
    // Re-delivery guard: an in-memory claim already in flight (closes the TOCTOU race around the async
    // dispatch below) or a live task session in the read model must not be re-dispatched.
    const card = this.read.snapshot().find((c) => c.specId === cid);
    const alreadyDelivering =
      this.deliverySessions.has(cid) || !!card?.sessions.some((s) => s.kind === "task" && (s.status === "running" || s.status === "idle"));
    if (alreadyDelivering) return { ok: false, specId: cid, error: `'${cid}' is already delivering` };
    const deliveryBranch = branch ?? found.frontmatter.branch ?? gitHeadBranch(this.root) ?? "";
    await this.trace.write({ kind: "spec.deliver", projectId: this.projectId, specId: cid, branch: deliveryBranch });
    void this.deliverImplementation(cid, deliveryBranch); // SPEC-009 revised: one session, full task list
    void this.generate(cid); // SPEC-013: propose downstream artefacts
    return { ok: true, specId: cid, branch: deliveryBranch };
  }

  /** The canonical project config file (`.arke/config.json`) — home of the SPEC-030 auto-PR preference. */
  private deliveryConfigPath(): string {
    return resolve(this.root, ".arke", "config.json");
  }

  /**
   * Dispatch the single implementer session for a delivery (SPEC-009 revised): the full unchecked task
   * list is the prompt, and the agent decides how to sequence/parallelise its own work — the
   * coordinator no longer forces tasks into concurrent child sessions. Runs in ONE dedicated git
   * worktree on a deterministic sibling branch (`deliveryWorktreeBranch`), not the feature branch
   * itself, so the worktree can always be created even if the human's own working directory (`this.root`)
   * is currently checked out on that feature branch (a common case — approving a spec requires being on
   * it). Idempotent: a duplicate trigger while a delivery session is live is a no-op.
   */
  private async deliverImplementation(specId: string, featureBranch: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    const found = this.findSpecFile(specId);
    if (!found) return { ok: false, error: "spec not found" };
    const cid = found.canonicalId;
    if (this.deliverySessions.has(cid)) return { ok: true, sessionId: this.deliverySessions.get(cid) }; // duplicate → no-op
    const tasks = parseTasks(found.text);
    if (tasks.filter((t) => !t.done).length === 0) {
      // Graceful failure: no actionable tasks (SPEC-009). Error on the spec session + warn trace.
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "session.status", sessionId: cid, specId: cid, kind: "spec", status: "error" } as DomainEvent);
      await this.trace.write({ kind: "warn", projectId: this.projectId, specId: cid, reason: "no-tasks" });
      return { ok: false, error: "no-tasks" };
    }
    // Claim the slot SYNCHRONOUSLY (before any await) so a concurrent deliver() for the same spec sees
    // it already claimed and no-ops — closing the TOCTOU race (single live delivery session invariant).
    this.deliverySessions.set(cid, "");
    const deliveryBranch = deliveryWorktreeBranch(featureBranch);
    const fail = async (reason: string) => {
      this.deliverySessions.delete(cid);
      await this.trace.write({ kind: "dispatch.failed", projectId: this.projectId, specId: cid, branch: deliveryBranch, reason });
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "session.status", sessionId: `${cid}#delivery`, specId: cid, kind: "task", status: "error" } as DomainEvent);
    };
    // Branch-collision guard: an existing branch means an orphaned worktree from a prior run.
    const exists = spawnSync("git", ["branch", "--list", deliveryBranch], gitOpts(this.root));
    if ((exists.stdout ?? "").trim().length > 0) {
      await this.trace.write({ kind: "warn", projectId: this.projectId, specId: cid, reason: "branch-collision", branch: deliveryBranch });
      await fail(`delivery branch '${deliveryBranch}' already exists`);
      return { ok: false, error: "branch-collision" };
    }
    const wtPath = resolve(this.root, ".arke", "worktrees", createHash("sha1").update(deliveryBranch).digest("hex").slice(0, 16));
    const add = spawnSync("git", ["worktree", "add", "-b", deliveryBranch, wtPath, featureBranch], gitOpts(this.root));
    if (add.status !== 0) {
      await fail(`git worktree add failed: ${(add.stderr || add.stdout || "").toString().trim().slice(0, 200)}`);
      return { ok: false, error: "worktree-failed" };
    }
    // Recorded so a LATER harness-reported error (observeDeliveryProgress, once the session is live) can
    // remove this same worktree/branch — otherwise the deterministic branch name lingers and every retry
    // trips the branch-collision guard above.
    this.deliveryWorktrees.set(cid, { wtPath, branch: deliveryBranch });
    // SPEC-030: when the project has opted into auto-PR, the delivery prompt tells the implementer to open
    // the PR itself once every task is done — otherwise the prompt says nothing about PRs and delivery
    // stops at the human diff-review gate (SPEC-011). The agent runs on `<featureBranch>--delivery` (the
    // worktree, below), so the PR targets the FEATURE branch (SPEC-031): delivery → feature, which then
    // merges to mainline = delivered (SPEC-024). `buildDeliveryPrompt` only interpolates the base branch
    // when it is metacharacter-free (else it falls back to gh's default base).
    const autoOpenPr = loadAutoOpenPr(this.deliveryConfigPath());
    await this.trace.write({ kind: "dispatch.started", projectId: this.projectId, specId: cid, branch: deliveryBranch, autoOpenPr });
    try {
      // SPEC-028: the delivery session runs IN the worktree (`cwd`), so the implementer's edits, git ops,
      // and diff all happen on the `--delivery` branch in isolation, never in the human's own checkout.
      const ref = await this.adapter.createSession({ specId: cid, parent: cid, cwd: wtPath });
      this.deliverySessions.set(cid, ref.sessionId);
      this.deliverySessionOwner.set(ref.sessionId, cid);
      await this.adapter.dispatchAsync({ sessionId: ref.sessionId, agent: "implementer", ...this.modelArg("implementer"), parts: [{ type: "text", text: buildDeliveryPrompt(found.relPath, tasks, autoOpenPr ? { autoOpenPr: true, ...(featureBranch ? { baseBranch: featureBranch } : {}) } : {}) }] });
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "session.status", sessionId: ref.sessionId, specId: cid, kind: "task", status: "running" } as DomainEvent);
      await this.trace.write({ kind: "dispatch.complete", projectId: this.projectId, specId: cid, branch: deliveryBranch, sessionId: ref.sessionId });
      return { ok: true, sessionId: ref.sessionId };
    } catch (err) {
      // The worktree was created but the session never started: remove it so a retry is clean rather
      // than tripping the collision guard on the orphaned branch.
      this.removeDeliveryWorktree(cid);
      await fail(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: "dispatch-failed" };
    }
  }

  /** The delivery spec's on-disk `## Tasks` source, read from its WORKTREE when one is recorded (SPEC-028
   *  — the implementer edits the checklist there, not in the primary checkout), else the primary content.
   *  Best-effort: an unreadable worktree file (e.g. removed) falls back to the primary checkout's text, as
   *  does the post-restart case where the worktree mapping was lost (in-memory only). */
  private deliverySpecText(specId: string, found: { relPath: string; text: string }): string {
    const wt = this.deliveryWorktrees.get(specId);
    if (!wt) return found.text;
    try {
      return readFileSync(resolve(wt.wtPath, found.relPath), "utf8");
    } catch {
      return found.text;
    }
  }

  /** Best-effort removal of a delivery's worktree + branch (a failed/errored delivery must not leave the
   *  deterministic `<featureBranch>--delivery` branch behind — it would trip the collision guard on every
   *  subsequent retry). Safe to call when there is nothing recorded (e.g. failure occurred before the
   *  worktree was created) — it is then a no-op. */
  private removeDeliveryWorktree(specId: string): void {
    const wt = this.deliveryWorktrees.get(specId);
    if (!wt) return;
    spawnSync("git", ["worktree", "remove", "--force", wt.wtPath], gitOpts(this.root));
    spawnSync("git", ["branch", "-D", wt.branch], gitOpts(this.root));
    this.deliveryWorktrees.delete(specId);
  }

  /**
   * Resolve which spec owns a delivery session, rehydrating `deliverySessionOwner` from the read model
   * when the in-memory claim is missing (SPEC-028 restart recovery). `deliverySessions`/
   * `deliverySessionOwner` are process-lifetime-only maps; a coordinator restart empties them even
   * though a delivery session may still be running in the harness. The read model's own
   * `specForSession` index recovers independently once the harness's live event stream resumes for
   * that still-running session (adapter-side identity resolution survives restart via the harness's own
   * durable session titles — `rebuildSessionGraph()`) — so lazily re-adopt ownership from there rather
   * than losing the checklist completion oracle for the rest of that delivery's lifetime. Only re-adopts
   * a `task`-kind session that is still live (`running`/`waiting`/`idle`); a session already `done`,
   * `error`, or `interrupted` is not a delivery to resume tracking.
   */
  private resolveDeliveryOwner(sessionId: string): string | undefined {
    const known = this.deliverySessionOwner.get(sessionId);
    if (known) return known;
    const specId = this.read.specForSession(sessionId);
    if (!specId) return undefined;
    const card = this.read.snapshot().find((c) => c.specId === specId);
    const sess = card?.sessions.find((s) => s.sessionId === sessionId);
    if (!sess || sess.kind !== "task" || !(sess.status === "running" || sess.status === "waiting" || sess.status === "idle")) return undefined;
    this.deliverySessionOwner.set(sessionId, specId);
    this.deliverySessions.set(specId, sessionId);
    return specId;
  }

  /**
   * Track a delivery session to completion (SPEC-009 revised): there is no artificial "one dispatch,
   * one turn, idle means done" signal anymore — the agent may take several turns, possibly steered by
   * a human via the board's task composer — so on each settled assistant turn, check whether every task
   * in the spec's `## Tasks` list is now checked off; that checklist is the completion oracle. Marks the
   * session `done` (surfacing the board's diff-review column) only once every task is checked. A
   * harness-reported error releases the claim — AND removes the delivery's worktree/branch, the same
   * cleanup a pre-dispatch failure gets — so a fresh `spec.deliver` can retry cleanly.
   */
  private async observeDeliveryProgress(event: DomainEvent): Promise<void> {
    if (event.type === "session.status" && event.status === "error") {
      const specId = this.resolveDeliveryOwner(event.sessionId);
      if (!specId) return;
      this.removeDeliveryWorktree(specId);
      this.deliverySessions.delete(specId);
      this.deliverySessionOwner.delete(event.sessionId);
      return;
    }
    if (event.type !== "message.updated" || event.isStreaming || event.role !== "assistant") return;
    const specId = this.resolveDeliveryOwner(event.sessionId);
    if (!specId) return;
    const found = this.findSpecFile(specId);
    if (!found) return;
    // SPEC-028: the implementer checks tasks off in ITS WORKTREE's copy of the spec (it runs there now),
    // not the human's primary checkout — so the completion oracle must read the worktree's file.
    const tasks = parseTasks(this.deliverySpecText(specId, found));
    if (tasks.length === 0 || !tasks.every((t) => t.done)) return;
    await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "session.status", sessionId: event.sessionId, specId, kind: "task", status: "done" } as DomainEvent);
    await this.trace.write({ kind: "delivery.complete", projectId: this.projectId, specId, sessionId: event.sessionId });
    this.deliverySessions.delete(specId);
    this.deliverySessionOwner.delete(event.sessionId);
  }

  // ---- session detail: rescue / steering / diff-gate (SPEC-011) -----------

  /** True when a session exists in the read model (the ownership guard — not specId truthiness). */
  private sessionExists(sessionId: string): boolean {
    return this.read.snapshot().some((c) => c.sessions.some((s) => s.sessionId === sessionId));
  }

  /** `revert` / `unrevert` (SPEC-011) — git-checkpoint rescue, routed to the adapter, ownership-checked. */
  private async rescue(verb: "revert" | "unrevert", sessionId: string, messageId?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.sessionExists(sessionId)) return { ok: false, error: `unknown session '${sessionId}'` };
    if (verb === "revert" && !messageId) return { ok: false, error: "revert requires a target messageId (checkpoint)" };
    if (!this.adapter.capabilities().has("revert") || !this.adapter[verb]) {
      return { ok: false, error: `harness does not support ${verb}` };
    }
    await this.trace.write({ kind: "client.request", projectId: this.projectId, verb, sessionId, ...(messageId ? { messageId } : {}) });
    try {
      if (verb === "revert") await this.adapter.revert!({ sessionId }, messageId!);
      else await this.adapter.unrevert!({ sessionId });
      return { ok: true };
    } catch (err) {
      // A transient rescue failure must NOT corrupt the card's real status — surface it in the
      // response only; the harness will report the true status via the event stream.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** `pr.approve` (SPEC-011) — the diff-review gate. Idempotent per session: a second approve is a no-op. */
  private async approvePr(sessionId: string): Promise<{ ok: boolean; opened: boolean; error?: string }> {
    if (!this.sessionExists(sessionId)) return { ok: false, opened: false, error: `unknown session '${sessionId}'` };
    if (this.prApproved.has(sessionId)) return { ok: true, opened: false }; // already approved → no double PR
    this.prApproved.add(sessionId);
    await this.trace.write({ kind: "client.request", projectId: this.projectId, verb: "pr.approve", sessionId });
    return { ok: true, opened: true };
  }

  /** `diff.refresh` (SPEC-011) — re-fetch the diff via the adapter and re-emit `diff.finalized`. */
  private async refreshDiff(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.sessionExists(sessionId)) return { ok: false, error: `unknown session '${sessionId}'` };
    if (!this.adapter.getDiff) return { ok: false, error: "harness does not support diff" };
    try {
      const d = await this.adapter.getDiff({ sessionId });
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "diff.finalized", sessionId, added: d.added, removed: d.removed, files: d.files } as DomainEvent);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- generation workspace: propose → decide → execute (SPEC-013) --------

  /**
   * Dispatch the generation agent for an approved spec (SPEC-013). Idempotent: a duplicate trigger
   * while a generation session is live is a no-op. The agent is given ONLY the canonical spec markdown
   * (the sole generation input). A timeout surfaces a `generation.error` so the workspace never hangs.
   */
  async generate(specId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    const found = this.findSpecFile(specId);
    if (!found) return { ok: false, error: "spec not found" };
    const cid = found.canonicalId;
    const existing = this.generationProposals.get(cid);
    if (existing?.status === "generating") return { ok: true, sessionId: existing.sessionId }; // duplicate → no-op
    // Claim the slot SYNCHRONOUSLY (before the createSession await) so a concurrent generate() for the
    // same spec sees `generating` and no-ops — closing the TOCTOU race (single live session invariant).
    this.generationProposals.set(cid, { sessionId: "", artifacts: [], specContentHash: specContentHash(found.text), status: "generating" });
    // Superseding a prior pending-review proposal: release its leaked session→spec mapping.
    if (existing) for (const [sid, owner] of this.generationSessions) if (owner === cid) this.generationSessions.delete(sid);
    const ref = await this.adapter.createSession({ specId: cid });
    this.generationSessions.set(ref.sessionId, cid);
    this.generationProposals.set(cid, { sessionId: ref.sessionId, artifacts: [], specContentHash: specContentHash(found.text), status: "generating" });
    await this.trace.write({ kind: "generation.started", projectId: this.projectId, specId: cid, sessionId: ref.sessionId });
    // SPEC-015: span the adapter boundary (attributes carry ids only — never the spec markdown prompt).
    await this.withSpan("dispatchAsync", { "arke.specId": cid, "arke.sessionId": ref.sessionId, "arke.harness": this.adapter.id }, () =>
      this.adapter.dispatchAsync({ sessionId: ref.sessionId, agent: "spec-author", ...this.modelArg("spec-author"), parts: [{ type: "text", text: buildGenerationPrompt(found.text) }] }),
    );
    const timeoutMs = Number(process.env.ARKE_GENERATION_TIMEOUT_MS) || DEFAULT_GENERATION_TIMEOUT_MS;
    const timer = setTimeout(() => void this.failGeneration(cid, ref.sessionId, "generation timed out"), timeoutMs);
    timer.unref?.();
    return { ok: true, sessionId: ref.sessionId };
  }

  /** The generation agent's completed turn: parse artefacts → buffer + emit proposed (or error). */
  private async ingestGeneration(sessionId: string, text: string): Promise<void> {
    const cid = this.generationSessions.get(sessionId);
    if (!cid) return;
    const proposal = this.generationProposals.get(cid);
    if (!proposal || proposal.sessionId !== sessionId || proposal.status !== "generating") return;
    const artifacts = parseArtifacts(text);
    if (artifacts.length === 0) {
      await this.failGeneration(cid, sessionId, "could not parse agent output");
      return;
    }
    proposal.artifacts = artifacts;
    proposal.status = "pending-review";
    await this.trace.write({ kind: "generation.proposed", projectId: this.projectId, specId: cid, sessionId, count: artifacts.length });
    await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "generation.proposed", specId: cid, sessionId, artifacts } as DomainEvent);
  }

  /** Surface a generation failure (parse/timeout) and clear the in-flight proposal. */
  private async failGeneration(cid: string, sessionId: string, reason: string): Promise<void> {
    const p = this.generationProposals.get(cid);
    if (!p || p.sessionId !== sessionId || p.status !== "generating") return; // already resolved
    this.generationProposals.delete(cid);
    this.generationSessions.delete(sessionId);
    await this.trace.write({ kind: "generation.error", projectId: this.projectId, specId: cid, sessionId, reason });
    await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "generation.error", specId: cid, reason } as DomainEvent);
  }

  /**
   * Decide on a generation proposal (SPEC-013). The `proposalId` MUST match the current pending
   * proposal's sessionId (stale/mismatched decisions are refused). Approve resolves the final
   * artefacts (partial selection + human edits), records the full decision in the trace BEFORE any
   * write, then fans out. Nothing is written before this approval.
   */
  async decideGeneration(
    specId: string,
    proposalId: string,
    decision: "approved" | "rejected",
    approvedArtifactIds?: string[],
    edits?: ArtifactEdit[],
  ): Promise<{ ok: boolean; written?: number; error?: string }> {
    // Resolve the proposal by the specId the client sent (the canonical id carried on generation.proposed)
    // first, so a decision still lands even if the spec file was moved/deleted mid-flight; fall back to
    // the file's canonical id only if the direct key misses.
    const found = this.findSpecFile(specId);
    const cid = this.generationProposals.has(specId) ? specId : found?.canonicalId ?? specId;
    const proposal = this.generationProposals.get(cid);
    if (!proposal || proposal.status !== "pending-review") return { ok: false, error: "no pending proposal" };
    if (proposal.sessionId !== proposalId) return { ok: false, error: "stale proposalId — proposal was superseded" };

    if (decision === "rejected") {
      this.generationProposals.delete(cid);
      this.generationSessions.delete(proposal.sessionId);
      await this.trace.write({ kind: "generation.decision", projectId: this.projectId, specId: cid, sessionId: proposalId, decision: "rejected" });
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "generation.decided", specId: cid, sessionId: proposalId, decision: "rejected" } as DomainEvent);
      return { ok: true, written: 0 };
    }

    const { artifacts, error } = resolveApproval(proposal.artifacts, approvedArtifactIds, edits);
    if (error) return { ok: false, error };
    // Trace-BEFORE-write (SPEC-013): the durable proof of intent + recovery anchor. Records the final,
    // human-reviewed content for each approved artefact. writeOrThrow → if it can't persist, no write.
    await this.trace.writeOrThrow({
      kind: "generation.decision",
      projectId: this.projectId,
      specId: cid,
      sessionId: proposalId,
      decision: "approved",
      approvedArtifactIds: artifacts.map((a) => a.id),
      finalContent: artifacts.map((a) => ({ id: a.id, target: a.target, title: a.title, content: a.content, ...(a.sorTarget ? { sorTarget: a.sorTarget } : {}) })),
    });
    this.generationProposals.delete(cid);
    this.generationSessions.delete(proposal.sessionId);
    await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "generation.decided", specId: cid, sessionId: proposalId, decision: "approved", approvedArtifactIds: artifacts.map((a) => a.id) } as DomainEvent);
    // Fan-out (SPEC-014): each artefact becomes a projection.write with a stable idempotency key. A
    // SoR-targeted artefact (sorTarget) is the deterministic-plugin hand-off; local docs/tests record
    // the same way. The harness plugin performs the real API call; the coordinator records the intent.
    for (const a of artifacts) {
      const target = a.sorTarget ?? a.target;
      await this.emit({
        seq: 0, ts: 0, harness: this.adapter.id, type: "projection.write",
        target, specId: cid, trigger: proposalId, ok: true, artifactId: a.id,
        idempotencyKey: idempotencyKey(cid, a.id, a.content),
      } as DomainEvent);
    }
    return { ok: true, written: artifacts.length };
  }

  // ---- deterministic projection + integrations registry (SPEC-014) --------

  /** Probe this project's integrations from the environment (credentials never returned). */
  integrationStatus(): IntegrationRecord[] {
    return probeIntegrations(process.env, Date.now());
  }

  /**
   * Re-attempt a failed/blocked SoR write using the ORIGINAL approval as authorisation — no new human
   * gesture (SPEC-014). The original `generation.decision approved` trace record for the spec must
   * exist and have included this artefactId; otherwise the retry is refused.
   */
  async retryProjection(specId: string, artifactId: string, target: string): Promise<{ ok: boolean; error?: string }> {
    const records = await this.trace.readAll();
    // Newest-first: re-generation reassigns the same artifactId with NEW content, so the retry must
    // mirror the LATEST approval's content (not the oldest) — else the idempotency key drifts from the
    // current SoR write and the plugin's dedup is defeated.
    const approval = [...records].reverse().find(
      (r) => r.kind === "generation.decision" && r.decision === "approved" && r.specId === specId && Array.isArray(r.approvedArtifactIds) && (r.approvedArtifactIds as string[]).includes(artifactId),
    );
    if (!approval) return { ok: false, error: "cannot retry — original approval not found" };
    const final = (approval.finalContent as Array<{ id: string; content: string }> | undefined)?.find((a) => a.id === artifactId);
    if (!final) return { ok: false, error: "cannot retry — approved content not found in the trace record" };
    await this.emit({
      seq: 0, ts: 0, harness: this.adapter.id, type: "projection.write",
      target, specId, trigger: String(approval.sessionId ?? "retry"), ok: true, artifactId,
      idempotencyKey: idempotencyKey(specId, artifactId, final.content),
    } as DomainEvent);
    return { ok: true };
  }

  /** The projections-status surface data: projection.write records, newest first, capped (SPEC-014). */
  async projectionsQuery(specId?: string): Promise<{ rows: unknown[]; total: number; capped: boolean }> {
    const limit = Number(process.env.ARKE_PROJECTION_QUERY_LIMIT) || 200;
    const records = await this.trace.readAll();
    const all = records.filter((r) => r.kind === "event" && (r.event as { type?: string } | undefined)?.type === "projection.write" && (!specId || (r.event as { specId?: string }).specId === specId)).map((r) => r.event);
    const newestFirst = all.reverse();
    return { rows: newestFirst.slice(0, limit), total: all.length, capped: all.length > limit };
  }

  // ---- audit / observability (SPEC-015) -----------------------------------

  /**
   * Run `fn` bracketed by a persisted span record (SPEC-015). Attributes pass through the allowlist
   * (no spec content / secrets), `error.message` is truncated; the span write is best-effort and never
   * blocks or fails the operation. A lightweight, OTLP-exportable local span — the durable audit path.
   */
  async withSpan<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const startTime = Date.now();
    try {
      const result = await fn();
      void this.trace.write({ kind: "span", name, startTime, endTime: Date.now(), status: "ok", attributes: sanitizeSpanAttributes({ "arke.operation": name, ...attrs }) });
      return result;
    } catch (err) {
      void this.trace.write({ kind: "span", name, startTime, endTime: Date.now(), status: "error", attributes: sanitizeSpanAttributes({ "arke.operation": name, ...attrs, "error.message": err instanceof Error ? err.message : String(err) }) });
      throw err;
    }
  }

  /** `get-audit-records` (SPEC-015): this project's trace for a spec, capped, with the total + projectId. */
  async auditRecords(specId: string, since?: number): Promise<{ projectId: string; specId: string; records: unknown[]; total: number }> {
    const limit = Number(process.env.ARKE_AUDIT_QUERY_LIMIT) || 500;
    const { records, total } = await this.trace.query(specId, since ?? 0, limit);
    return { projectId: this.projectId, specId, records, total };
  }

  /**
   * `approveDraft` — atomically advance a draft to `in-review` (SPEC-006). Verifies the git HEAD
   * branch equals the frontmatter `branch`, writes the updated status + a Change history line,
   * commits the file on the branch, and emits `spec.status`. Any failure emits `spec.approval-failed`,
   * leaves the on-disk status unchanged (rolling back a written-but-uncommitted file), and throws so
   * the client sees an error and can retry. A single transaction — no partial success.
   */
  private async approveDraft(specId: string, clientBranch?: string): Promise<{ ok: true; specId: string; status: string; branch: string }> {
    // Serialise approvals: a concurrent second approval could otherwise capture the same draft text
    // and, on a git no-op/failure, roll its stale copy back over the just-committed file (PR #18
    // review round 3). One at a time per project.
    if (this.approvalInFlight) {
      // Route the concurrency rejection through the same governed-failure path (event + trace) as any
      // other approval failure, so the cockpit and audit log stay complete (PR #18 review round 4).
      const reason = `an approval is already in progress for '${specId}'`;
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.approval-failed", specId, reason } as DomainEvent);
      await this.trace.write({ kind: "spec.approve", projectId: this.projectId, specId, ok: false, reason });
      throw new Error(reason);
    }
    this.approvalInFlight = true;
    try {
      return await this.approveDraftLocked(specId, clientBranch);
    } finally {
      this.approvalInFlight = false;
    }
  }

  private async approveDraftLocked(specId: string, clientBranch?: string): Promise<{ ok: true; specId: string; status: string; branch: string }> {
    // Failures emit/trace under the canonical id once it's known; before resolution (file-not-found)
    // only the caller's alias is available, which is the right thing to record there (PR #18 final review).
    let auditId = specId;
    const fail = async (reason: string): Promise<never> => {
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.approval-failed", specId: auditId, reason } as DomainEvent);
      await this.trace.write({ kind: "spec.approve", projectId: this.projectId, specId: auditId, ok: false, reason });
      throw new Error(reason);
    };

    const found = this.findSpecFile(specId);
    if (!found) return fail(`no specification file found for '${specId}' under docs/specifications`);
    // Use the frontmatter's canonical spec id for all events/results/trace, even if the caller passed
    // a slug/title/filename alias — so the right board card advances (PR #18 review round 7).
    const cid = found.canonicalId;
    auditId = cid;
    // Only a draft may be approved into review — never regress an already-approved/merged spec back
    // to in-review (PR #18 review). A spec with no status is treated as a draft.
    const current = found.frontmatter.status;
    if (current && current !== "draft") {
      return fail(`cannot approve: specification '${cid}' is '${current}', expected 'draft'`);
    }
    // Well-formedness gate (SPEC-024) — the FIRST precondition. A draft may not advance out of `draft`
    // unless it is structurally complete: a Requirements section, at least one SHALL/MUST statement, and
    // at least one WHEN/THEN scenario. This runs ahead of the review-panel gate so an author is told the
    // document is malformed before convening reviewers. Enforced server-side for every caller (board,
    // CLI, direct op) — the UI's "looks done" is not the gate.
    const wf = validateWellFormed(found.text);
    if (!wf.ok) {
      const reason = `specification is not well-formed — missing: ${wf.missing.join(", ")}`;
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.malformed", specId: cid, missing: wf.missing } as DomainEvent);
      await this.trace.write({ kind: "spec.approve", projectId: this.projectId, specId: cid, ok: false, reason: "spec.malformed" });
      throw new Error(reason);
    }
    // Finalisation gate (SPEC-007): a draft cannot be approved until at least one review panel has
    // completed for it. Enforced server-side so a direct approveDraft (CLI/op) can't bypass the UI.
    if (!this.completedReviews.has(cid)) {
      const reason = "no completed review panel — convene and complete a review before approving";
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "review.gate-failed", specId: cid, reason } as DomainEvent);
      await this.trace.write({ kind: "spec.approve", projectId: this.projectId, specId: cid, ok: false, reason: "review.gate-failed" });
      throw new Error(reason);
    }
    // Server-side in-flight guard (the UI guard alone can't protect the exposed CLI/op): never commit
    // while a spec-author/architect AUTHORING session for this spec is running — an unrelated
    // implementation task for the same spec must NOT block approval (PR #18 review rounds 5 & 7).
    const cidCard = this.read.snapshot().find((c) => c.specId === cid);
    if (cidCard?.sessions.some((s) => s.kind === "spec" && s.status === "running")) {
      return fail(`an authoring session for '${cid}' is still running — wait for it to finish before approving`);
    }
    const fmBranch = found.frontmatter.branch;
    if (!fmBranch) return fail(`specification '${specId}' has no 'branch' in its frontmatter`);
    if (clientBranch && clientBranch !== fmBranch) {
      return fail(`branch mismatch: client sent '${clientBranch}' but frontmatter is '${fmBranch}'`);
    }
    if (!gitAvailable()) return fail("git not found on PATH; cannot commit the approval");
    const head = gitHeadBranch(this.root);
    if (head === null) return fail("could not determine the git HEAD branch (not a git repository?)");
    if (head !== fmBranch) {
      // SPEC-024: surface a TYPED branch-mismatch so a board/CLI caller that promoted from the wrong
      // HEAD gets actionable guidance (check out the spec's branch), not just an opaque failure string.
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.branch-mismatch", specId: cid, frontmatterBranch: fmBranch, pushedBranch: head } as DomainEvent);
      return fail(`branch guard: HEAD is '${head}' but the spec's branch is '${fmBranch}' — check out '${fmBranch}' before promoting`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const updated = appendChangeHistory(
      setFrontmatterStatus(found.text, "in-review"),
      `${date} · ${fmBranch} · in-review — approved via the authoring cockpit`,
    );
    try {
      writeFileSync(found.absPath, updated, "utf8");
    } catch (err) {
      return fail(`could not write the specification file: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Preflight the audit trace BEFORE committing: a governed action must be recorded, so if the
    // append-only trace is unwritable we refuse (and roll back the file) rather than commit something
    // we can't audit (PR #18 review round 6, per AGENTS.md/SPEC-006).
    try {
      await this.trace.writeOrThrow({ kind: "spec.approve.preflight", projectId: this.projectId, specId: cid, branch: fmBranch });
    } catch (err) {
      try {
        writeFileSync(found.absPath, found.text, "utf8");
      } catch {
        /* best-effort rollback */
      }
      return fail(`audit trace is unwritable — refusing to approve (${err instanceof Error ? err.message : String(err)})`);
    }
    const committed = gitCommit(this.root, found.relPath, `spec(${cid}): approve → in-review`);
    if (!committed.ok) {
      // Roll back the write so the on-disk status is unchanged (the approval did not happen).
      try {
        writeFileSync(found.absPath, found.text, "utf8");
      } catch {
        /* best-effort rollback */
      }
      return fail(`git commit failed: ${committed.error}`);
    }

    // The commit is permanent — the approval succeeded. Publish the status FIRST (emit() publishes
    // even if its own trace write fails), then record the final audit best-effort: a post-commit
    // trace failure must not report an already-committed approval as failed (PR #18 review rounds 4–7).
    await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.status", specId: cid, status: "in-review" } as DomainEvent);
    try {
      await this.trace.write({ kind: "spec.approve", projectId: this.projectId, specId: cid, ok: true, branch: fmBranch, commit: committed.sha });
    } catch {
      /* committed + published already — the preflight recorded the governed action; this is bonus */
    }
    this.regenerateSpecIndex(); // SPEC-026: draft→in-review is written here (bypasses commitStatus) — refresh the index
    return { ok: true, specId: cid, status: "in-review", branch: fmBranch };
  }

  /**
   * `convenePanel` — start a multi-model review of the working draft (SPEC-007). Validates the
   * reviewer configuration against the registry (pairwise-distinct models, enough distinct capable
   * models), dispatches each reviewer as a parallel read-only session, and emits `panel.started`.
   * Passes a reference (`specId`/`branch`), never file content; the coordinator reads the file.
   */
  private async convenePanel(
    specId: string,
    branch?: string,
    reviewersArg?: ReviewerConfig[],
  ): Promise<{ panelId: string; specId: string; branch?: string; convened: boolean; reviewers: Array<{ role: string; model: string }> }> {
    const found = this.findSpecFile(specId);
    if (!found) throw new Error(`no specification file found for '${specId}' under docs/specifications`);
    const doc = parseSpecDoc(found.text);
    if (doc.requirements.length === 0) {
      throw new Error(`specification '${specId}' has no requirements yet — nothing to review`);
    }
    const fmBranch = found.frontmatter.branch;
    if (branch && fmBranch && branch !== fmBranch) {
      throw new Error(`branch mismatch: client sent '${branch}' but spec '${specId}' is on '${fmBranch}'`);
    }
    const cid = found.canonicalId;
    const resolvedBranch = fmBranch ?? branch;

    // Validate reviewers against the agent registry (SPEC-007): at least two reviewers, each with a
    // declared model, and every pair distinct. Refuse rather than run a panel with unverifiable
    // independence — validateReviewers surfaces the precise reason (missing agent, no model, or dup).
    const reviewers = reviewersArg && reviewersArg.length > 0 ? reviewersArg : [{ role: "reviewer-a" }, { role: "reviewer-b" }];
    const validation = validateReviewers(this.agents, reviewers);
    if (!validation.ok) {
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "panel.config-error", specId: cid, reason: validation.reason ?? "invalid reviewer configuration" } as DomainEvent);
      throw new Error(validation.reason ?? "invalid reviewer configuration");
    }

    const panelId = `panel-${randomUUID()}`;
    // Hash each section's CONTENT (not its label) so agreement anchors to the reviewed text. Key by
    // both the anatomy key and the lowercased title, since a reviewer may cite either.
    const sectionHashes = new Map<string, string>();
    for (const s of doc.sections) {
      const h = sectionHashOf(s.markdown);
      sectionHashes.set(s.key.toLowerCase(), h);
      sectionHashes.set(s.title.toLowerCase(), h);
    }
    const requirementsSectionHash = sectionHashes.get("requirements") ?? sectionHashOf("");
    const grounding = this.groundingSummary();
    const prompt = buildReviewerPrompt(found.text, grounding);
    const panel: ReviewPanel = {
      panelId,
      specId: cid,
      ...(resolvedBranch ? { branch: resolvedBranch } : {}),
      startedAt: Date.now(),
      requirementsSectionHash,
      sectionHashes,
      reviewers: [],
      issues: [],
      agreedHashes: new Set(),
      status: "running",
    };

    // Create every reviewer session and register the FULLY-POPULATED panel before dispatching anything.
    // dispatchAsync yields, so an early reviewer message must find a panel that already knows all its
    // reviewers — otherwise its issues are dropped, or maybeCompletePanel completes a half-built panel.
    for (const r of validation.reviewers) {
      const ref = await this.adapter.createSession({ specId: cid });
      this.reviewerSessions.set(ref.sessionId, { panelId, role: r.role });
      panel.reviewers.push({ role: r.role, sessionId: ref.sessionId, model: r.model, label: r.label, status: "running" });
    }
    this.panels.set(panelId, panel);

    // Announce the panel BEFORE dispatching, so panel.started reaches the client ahead of any panel.issue.
    await this.trace.write({
      kind: "panel.started",
      projectId: this.projectId,
      panelId,
      specId: cid,
      branch: resolvedBranch ?? null,
      promptVersion: ISSUE_EXTRACTION_PROMPT_VERSION,
      reviewers: panel.reviewers.map((r) => ({ role: r.role, model: r.model })), // host-side audit may include the model
    });
    await this.emit({
      seq: 0,
      ts: 0,
      harness: this.adapter.id,
      type: "panel.started",
      panelId,
      specId: cid,
      reviewers: panel.reviewers.map((r) => ({ role: r.role, model: r.label })), // client sees the tier LABEL, never the vendor model id
    } as DomainEvent);

    // Now dispatch each reviewer as a parallel, read-only turn (HarnessAdapter.dispatchAsync).
    for (const r of panel.reviewers) {
      await this.adapter.dispatchAsync({ sessionId: r.sessionId, agent: r.role, ...this.modelArg(r.role), parts: [{ type: "text", text: prompt }] });
    }

    return {
      panelId,
      specId: cid,
      ...(resolvedBranch ? { branch: resolvedBranch } : {}),
      convened: true,
      reviewers: panel.reviewers.map((r) => ({ role: r.role, model: r.label })),
    };
  }

  /**
   * Rebuild the finalisation-gate state from the durable trace on startup (SPEC-007): the live panel
   * view is in-memory and lost on restart, but every completed panel wrote a `review.complete` record,
   * so the gate (which specs have a completed review) survives a coordinator restart.
   */
  private async reconstructReviewGate(): Promise<void> {
    // Read through the Trace abstraction (the single owner of the path/format) rather than
    // re-deriving the trace location here. One pass rebuilds both the review gate (SPEC-007) and the
    // pr.approve idempotency set (SPEC-011) so a restart can't re-open a second PR for a session.
    for (const rec of await this.trace.readAll()) {
      if (rec.kind === "review.complete" && typeof rec.specId === "string") this.completedReviews.add(rec.specId);
      if (rec.kind === "client.request" && rec.verb === "pr.approve" && typeof rec.sessionId === "string") this.prApproved.add(rec.sessionId);
    }
  }

  /**
   * Grounding for reviewers (SPEC-007, upgraded by SPEC-027): the AGENTS.md house-rules head plus the
   * typed grounding digest — foundational business grounding, the existing spec corpus, and the
   * `.arke/grounding/` session uploads (by explicit path). `buildReviewerPrompt` wraps this under a
   * `## Project grounding` heading, so the digest's own `###` subsections nest cleanly beneath it.
   */
  private groundingSummary(): string {
    const parts: string[] = [];
    try {
      const agents = readFileSync(resolve(this.root, "AGENTS.md"), "utf8").slice(0, 2000).trim();
      if (agents) parts.push(`### House rules (AGENTS.md, head)\n\n${agents}`);
    } catch {
      /* no AGENTS.md — the digest below still grounds the reviewer */
    }
    const digest = renderGroundingDigest(this.buildGroundingDigest());
    if (digest) parts.push(digest);
    return parts.join("\n\n");
  }

  /**
   * Route a reviewer session's completed turn into its panel (SPEC-007): parse issues, emit
   * `panel.issue` + any new `panel.agreed`, and complete the panel when every reviewer is done.
   * Called from the pump for reviewer sessions only.
   */
  private async ingestReviewerMessage(sessionId: string, text: string): Promise<void> {
    const link = this.reviewerSessions.get(sessionId);
    if (!link) return;
    const panel = this.panels.get(link.panelId);
    if (!panel) return;
    const reviewer = panel.reviewers.find((r) => r.sessionId === sessionId);
    if (!reviewer || reviewer.status !== "running") return;

    for (const parsed of parseReviewerIssues(text)) {
      const issueId = `issue-${randomUUID()}`;
      // Anchor by the section's CONTENT hash when the label resolves to a known section; fall back to
      // hashing the label so unknown/free-form sections still group consistently across reviewers.
      const sectionHash = panel.sectionHashes.get(parsed.section.trim().toLowerCase()) ?? sectionHashOf(parsed.section);
      panel.issues.push({ issueId, reviewerRole: link.role, section: parsed.section, sectionHash, text: parsed.text, severity: parsed.severity });
      await this.emit({
        seq: 0, ts: 0, harness: this.adapter.id, type: "panel.issue",
        panelId: panel.panelId, issueId, reviewerRole: link.role, section: parsed.section, sectionHash, text: parsed.text, severity: parsed.severity,
      } as DomainEvent);
    }
    // Emit agreement for any newly-agreed section (deduped by section hash).
    for (const group of detectAgreement(panel.issues)) {
      if (panel.agreedHashes.has(group.sectionHash)) continue;
      panel.agreedHashes.add(group.sectionHash);
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "panel.agreed", panelId: panel.panelId, issueIds: group.issueIds, section: group.section } as DomainEvent);
    }
    reviewer.status = "done";
    await this.maybeCompletePanel(panel);
  }

  /** Mark a reviewer errored and continue the panel; complete (failed) if all reviewers errored. */
  private async failReviewer(sessionId: string, reason: string): Promise<void> {
    const link = this.reviewerSessions.get(sessionId);
    if (!link) return;
    const panel = this.panels.get(link.panelId);
    const reviewer = panel?.reviewers.find((r) => r.sessionId === sessionId);
    if (!panel || !reviewer || reviewer.status !== "running") return;
    reviewer.status = "error";
    await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "panel.reviewer-error", panelId: panel.panelId, reviewerRole: link.role, reason } as DomainEvent);
    await this.maybeCompletePanel(panel);
  }

  /** Complete a panel once no reviewer is still running; satisfy the review gate unless all errored. */
  private async maybeCompletePanel(panel: ReviewPanel): Promise<void> {
    if (panel.reviewers.some((r) => r.status === "running")) return;
    const anySucceeded = panel.reviewers.some((r) => r.status === "done");
    panel.status = anySucceeded ? "complete" : "failed";
    for (const r of panel.reviewers) this.reviewerSessions.delete(r.sessionId);
    if (panel.status === "complete") {
      this.completedReviews.add(panel.specId); // satisfies the finalisation gate
      await this.trace.write({ kind: "review.complete", projectId: this.projectId, specId: panel.specId, panelId: panel.panelId });
    }
    await this.emit({
      seq: 0, ts: 0, harness: this.adapter.id, type: "panel.complete",
      panelId: panel.panelId, specId: panel.specId, status: panel.status, issueCount: panel.issues.length,
      adjudicatedCount: panel.issues.filter((i) => i.adjudication).length,
    } as DomainEvent);
  }

  /**
   * `adjudicateIssue` — accept / dismiss / send-back one panel issue (SPEC-007). Accept routes the
   * critique to the `spec-author` agent (after a stale-file check); all three are written to the
   * trace. Returns `{ staleWarning: true }` when accept is blocked pending confirmation.
   */
  private async adjudicateIssue(
    panelId: string,
    issueId: string,
    action: "accepted" | "dismissed" | "sent-back",
    rationale?: string,
    confirm?: boolean,
  ): Promise<{ ok: boolean; staleWarning?: boolean }> {
    const panel = this.panels.get(panelId);
    if (!panel) throw new Error(`unknown panel '${panelId}'`);
    const issue = panel.issues.find((i) => i.issueId === issueId);
    if (!issue) throw new Error(`unknown issue '${issueId}' in panel '${panelId}'`);

    if (action === "accepted") {
      // Stale-file guard: if the Requirements section changed since panel start, warn + require
      // confirmation before routing the critique to the authoring agent (SPEC-007).
      const found = this.findSpecFile(panel.specId);
      const currentHash = found ? sectionHashOf(parseSpecDoc(found.text).sections.find((s) => s.key === "requirements")?.markdown ?? "") : panel.requirementsSectionHash;
      if (currentHash !== panel.requirementsSectionHash && !confirm) {
        await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "panel.stale-file-warning", panelId, issueId, specId: panel.specId } as DomainEvent);
        return { ok: false, staleWarning: true };
      }
      // Route the accepted critique to the authoring agent — the singular write path (reviewers never
      // write). Best-effort dispatch; the agent revises the section on the working file.
      const session = await this.adapter.createSession({ specId: panel.specId });
      await this.adapter.dispatchAsync({
        sessionId: session.sessionId,
        agent: "spec-author",
        ...this.modelArg("spec-author"),
        parts: [{ type: "text", text: `Apply this reviewer critique to the specification section "${issue.section}":\n\n${issue.text}` }],
      });
    }

    issue.adjudication = action;
    await this.trace.write({
      kind: "review.adjudicate",
      projectId: this.projectId,
      panelId,
      issueId,
      specId: panel.specId,
      section: issue.section,
      sectionHash: issue.sectionHash,
      reviewerRole: issue.reviewerRole,
      action,
      ...(rationale ? { rationale } : {}),
    });
    return { ok: true };
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

  // ---- blank-slate authoring + grounding (SPEC-020) -----------------------

  /**
   * Create a new specification as a blank slate (SPEC-020): allocate the next number + a slug from the
   * title, create/checkout a `spec/<slug>` feature branch when git allows (else stay on the current
   * branch so approval's guard still holds), and write `docs/specifications/<nnn>.<slug>.md` from the
   * template with seeded frontmatter and empty sections. The cockpit then opens on it and it grows in
   * the live preview as the conversation develops. Nothing is authored here.
   */
  async createSpec(rawTitle: unknown): Promise<{ specId: string; branch: string; path: string; number: number }> {
    const specsDir = resolve(this.root, "docs", "specifications");
    mkdirSync(specsDir, { recursive: true });
    const number = nextSpecNumber(specsDir);
    const nnn = String(number).padStart(3, "0");
    // The title is OPTIONAL (SPEC-020): the spec-author derives the real title from the conversation
    // once it understands the goal (it rewrites the frontmatter `title:` + H1). An untitled slate gets
    // a number-unique slug so filenames and branches never collide across untitled specs; the NNN
    // prefix keeps the library in chronological order either way.
    const given = String(rawTitle ?? "").trim();
    const title = given || "Untitled specification";
    const slug = given ? slugify(given) : `untitled-${nnn}`;
    const date = new Date().toISOString().slice(0, 10);
    const specId = `SPEC-${date}-${slug}`;

    // Author on a fresh feature branch (SPEC-020 R1). Fall back to the current HEAD if the branch can't
    // be created (git absent, dirty tree, name taken) so approveDraft's HEAD==branch guard still holds.
    let branch = `spec/${slug}`;
    if (gitAvailable()) {
      const co = spawnSync("git", ["checkout", "-b", branch], gitOpts(this.root));
      if (co.status !== 0) branch = gitHeadBranch(this.root) ?? branch;
    } else {
      branch = gitHeadBranch(this.root) ?? branch;
    }

    const filename = `${nnn}.${slug}.md`;
    const absPath = resolve(specsDir, filename);
    if (existsSync(absPath)) throw new Error(`a specification file '${filename}' already exists`);
    writeFileSync(absPath, renderBlankSpec({ specId, title, branch, date }), "utf8");
    await this.trace.write({ kind: "spec.create", projectId: this.projectId, specId, branch, path: `docs/specifications/${filename}` });
    this.regenerateSpecIndex(); // SPEC-026: the new spec appears in the index immediately
    return { specId, branch, path: `docs/specifications/${filename}`, number };
  }

  /**
   * Rename a blank-slate spec once the spec-author has derived its real title (SPEC-020). A spec born
   * as `untitled-NNN` (filename, spec_id, branch) is renamed to a concise title-derived slug: the file
   * is renamed, the frontmatter `spec_id`/`branch` rewritten, the git branch renamed, in-memory
   * lifecycle/review state migrated, and `spec.renamed` emitted so the read model re-keys its card and
   * the client rebinds its active spec. Idempotent and safe to call after every authoring turn: a no-op
   * unless the spec is still `untitled-NNN`, now carries a real title, and the derived slug differs.
   */
  async renameSpec(oldSpecId: string): Promise<{ renamed: boolean; specId: string; path?: string; branch?: string }> {
    // Acquire the per-spec lock FIRST so the whole read→write→rename is atomic: a concurrent call
    // (e.g. the per-turn auto-trigger racing an explicit spec.rename op) sees the lock and no-ops
    // rather than double-applying frontmatter edits and corrupting the file.
    if (this.renamingSpecs.has(oldSpecId)) return { renamed: false, specId: oldSpecId };
    this.renamingSpecs.add(oldSpecId);
    try {
      const found = this.findSpecFile(oldSpecId);
      if (!found) return { renamed: false, specId: oldSpecId };
      const stem = basename(found.absPath, ".md"); // e.g. "002.untitled-002"
      const m = /^(\d{3})\.(.+)$/.exec(stem);
      if (!m) return { renamed: false, specId: oldSpecId };
      const [nnn, currentSlug] = [m[1]!, m[2]!];
      if (!/^untitled-\d+$/.test(currentSlug)) return { renamed: false, specId: oldSpecId }; // already titled
      const title = (found.frontmatter.title ?? "").trim();
      if (!title || title.toLowerCase() === "untitled specification") return { renamed: false, specId: oldSpecId };
      const newSlug = conciseSlugFromTitle(title, currentSlug);
      if (newSlug === currentSlug) return { renamed: false, specId: oldSpecId };
      const date = /^SPEC-(\d{4}-\d{2}-\d{2})-/.exec(found.canonicalId)?.[1] ?? new Date().toISOString().slice(0, 10);
      const newSpecId = `SPEC-${date}-${newSlug}`;
      const newBranch = `spec/${newSlug}`;
      const oldBranch = found.frontmatter.branch ?? `spec/${currentSlug}`;
      const newFilename = `${nnn}.${newSlug}.md`;
      const newAbs = resolve(this.root, "docs", "specifications", newFilename);
      if (existsSync(newAbs)) return { renamed: false, specId: oldSpecId }; // target name taken — leave as-is

      let text = setFrontmatterField(found.text, "spec_id", newSpecId);
      text = setFrontmatterField(text, "branch", newBranch);
      text = appendChangeHistory(text, `${date} · ${newBranch} · draft — renamed from ${currentSlug} to ${newSlug} (title finalised)`);
      writeFileSync(found.absPath, text, "utf8");
      renameSync(found.absPath, newAbs);

      // Rename the git branch ONLY when it is the `spec/untitled-NNN` branch `spec.create` made and
      // we are still on it (best-effort; frontmatter branch is the approval guard). If spec.create
      // fell back to the engineer's existing branch (e.g. `main`/a feature branch, recorded verbatim
      // in frontmatter), renaming it would hijack their working branch — so skip that case entirely.
      if (gitAvailable() && oldBranch !== newBranch && oldBranch.startsWith("spec/untitled-") && gitHeadBranch(this.root) === oldBranch) {
        spawnSync("git", ["branch", "-m", newBranch], gitOpts(this.root));
      }

      // Migrate in-memory state keyed by spec id so lifecycle/review gates follow the rename.
      const rec = this.specRecords.get(oldSpecId);
      if (rec) {
        this.specRecords.delete(oldSpecId);
        this.specRecords.set(newSpecId, rec);
      }
      if (this.completedReviews.delete(oldSpecId)) this.completedReviews.add(newSpecId);

      const relPath = `docs/specifications/${newFilename}`;
      await this.trace.write({ kind: "spec.rename", projectId: this.projectId, oldSpecId, specId: newSpecId, path: relPath, branch: newBranch });
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.renamed", oldSpecId, specId: newSpecId, path: relPath, branch: newBranch, title } as DomainEvent);
      this.regenerateSpecIndex(); // SPEC-026: the index reflects the new id/slug/link
      return { renamed: true, specId: newSpecId, path: relPath, branch: newBranch };
    } finally {
      this.renamingSpecs.delete(oldSpecId);
    }
  }

  /**
   * Store an uploaded grounding file on the host under this project's `.arke/grounding/` (SPEC-020).
   * The name is confined to that root (traversal rejected) and the content is size-bounded. Grounding
   * is context for the authoring discussion — read by the agent, never written into the spec.
   */
  async groundingUpload(rawName: unknown, rawContent: unknown): Promise<{ name: string; path: string; size: number }> {
    const root = resolve(this.root, ".arke", "grounding");
    const abs = InputValidator.canonicalisePath(String(rawName ?? ""), root);
    const content = String(rawContent ?? "");
    const size = Buffer.byteLength(content, "utf8");
    const max = Number(process.env.ARKE_GROUNDING_MAX_BYTES) || 5 * 1024 * 1024;
    if (size > max) throw new ValidationError("content", `grounding file exceeds the ${max}-byte limit`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    this.groundingDigestCache = null; // SPEC-027: a new upload changes part (c) of the digest
    // Report the path relative to the grounding root (posix) so a nested upload is named the way the
    // recursive listing surfaces it (SPEC-027) — `grounding.list` and the injected path then agree.
    const name = relative(root, abs).replaceAll("\\", "/");
    await this.trace.write({ kind: "grounding.upload", projectId: this.projectId, name, size });
    return { name, path: relative(this.root, abs).replaceAll("\\", "/"), size };
  }

  /**
   * List the grounding files under this project's `.arke/grounding/` (SPEC-020, widened to recurse for
   * SPEC-027). Recursion matters because `groundingUpload` accepts nested paths, and the injected digest
   * references each upload by EXPLICIT path (the agent's `glob`/`grep` skip the git-ignored dot-dir) —
   * so a nested upload must be surfaced or it is silently unreachable. `name` is the POSIX path relative
   * to the grounding root, so the caller renders `.arke/grounding/${name}` correctly for nested files.
   */
  groundingList(): Array<{ name: string; size: number }> {
    const root = resolve(this.root, ".arke", "grounding");
    const out: Array<{ name: string; size: number }> = [];
    const walk = (dir: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const f of names) {
        const abs = resolve(dir, f);
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(abs);
        else if (st.isFile()) out.push({ name: relative(root, abs).replaceAll("\\", "/"), size: st.size });
      }
    };
    walk(root);
    return out.sort((a, b) => a.name.localeCompare(b.name));
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
        // The dispatch model is the AGENT's declared model+provider (SPEC-016 revised) — no per-turn
        // tier. An agent that pins no model (or an unknown agent) sends without one and the harness
        // uses the agent's own materialised/default model.
        const sessionId = String(a.sessionId ?? "");
        // Stale-session guard (SPEC-006): a queued message that targets a session no longer idle or
        // running (e.g. it went waiting/done/error while the client was offline) is rejected with its
        // current status rather than silently executed.
        const knownCard = this.read.snapshot().find((c) => c.sessions.some((s) => s.sessionId === sessionId));
        const known = knownCard?.sessions.find((s) => s.sessionId === sessionId);
        if (known) {
          if (known.status !== "idle" && known.status !== "running") {
            throw new Error(`session '${sessionId}' is '${known.status}', not idle/running — message rejected`);
          }
        } else if (a.replay === true) {
          // A REPLAYED (offline-queued) prompt whose session is absent from the read model can't be
          // confirmed live — e.g. after a coordinator restart the read model may not list the old
          // session yet. Reject rather than execute blindly; only a brand-new session's first online
          // prompt (unknown AND not a replay) is allowed through (PR #18 final review).
          throw new Error(`session '${sessionId}' is not active — replayed message rejected`);
        } else if (a.specId && !this.findSpecFile(String(a.specId))) {
          // Cross-project guard: an unknown session whose claimed spec does not exist in THIS
          // project means the client is bound to the wrong active project (e.g. a silent reconnect
          // reset it to the default). Executing would dispatch the prompt to the wrong harness.
          throw new Error(
            `spec '${String(a.specId)}' is not in project '${this.name}' — the client's active project looks stale; reopen the project and retry`,
          );
        }
        // Anchor the turn to the session's working specification (SPEC-020): without an explicit
        // file reference the agent globs `docs/specifications/` and can guess the WRONG spec when
        // several exist. Resolve the session's spec (read model, else the durable session graph) and
        // prepend the file path as context. Best-effort — a session with no spec file sends as-is.
        let specContext = "";
        try {
          const sid = (a.specId ? String(a.specId) : undefined) ?? knownCard?.specId;
          const found = sid ? this.findSpecFile(sid) : null;
          if (found) {
            specContext = `Working specification: ${found.relPath} (spec_id: ${found.canonicalId}). Read and edit THIS file for this conversation; do not pick a different specification unless explicitly asked.\n`;
          }
          // Typed grounding digest (SPEC-027): foundational business grounding + the existing spec corpus
          // + the `.arke/grounding/` session uploads (referenced by explicit path — the agent's glob/grep
          // skip the git-ignored dot-dir, so it cannot discover them by search). Each part is distinctly
          // framed and the whole is size-bounded, so it stays bounded as the corpus grows.
          const digest = renderGroundingDigest(this.buildGroundingDigest());
          if (digest) specContext += `${specContext ? "\n" : ""}## Project grounding\n${digest}\n`;
          if (specContext) specContext += "\n";
        } catch {
          /* context is a nicety — never block the send on it */
        }
        const agent = String(a.agent ?? "");
        const input = {
          sessionId,
          agent,
          ...this.modelArg(agent),
          parts: [{ type: "text" as const, text: specContext + String(a.message ?? "") }],
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
          harness: img.executor.config.harness,
          ...(img.executor.config.model ? { model: img.executor.config.model } : {}),
          ...(img.executor.config.options?.reasoningEffort ? { reasoningEffort: img.executor.config.options.reasoningEffort } : {}),
          description: img.description,
          mode: img.interaction.mode,
        }));
      case "agents.materialize": {
        if (!this.adapter.materializeAgent) throw new Error("harness does not support agent materialisation");
        const images = this.loadAgentImages(a.dir);
        // SPEC-021: materialise each image's agent frontmatter AND its declared tools/MCP/skills into
        // the harness's native config. An adapter with no capability support skips the latter; whatever
        // it can't register (e.g. a function tool on a harness without them) is surfaced, not silently
        // dropped, so the caller/editor can warn.
        const capabilities: Record<string, CapabilityMaterialisation> = {};
        for (const img of images) {
          await this.adapter.materializeAgent(img);
          if (this.adapter.materializeCapabilities) {
            const cap = await this.adapter.materializeCapabilities(img);
            capabilities[img.name] = cap;
            await this.trace.write({ kind: "agent.capabilities-materialized", projectId: this.projectId, name: img.name, registered: cap.registered, unsupported: cap.unsupported });
          }
        }
        return { materialized: images.map((i) => i.name), capabilities };
      }
      case "harness.capabilities":
        // SPEC-021: what this harness natively supports (MCP forms, skills locations, function tools,
        // tool gating, built-in tools) — the manifest the capability-aware agent editor validates
        // against. Absent → the adapter declares no manifest (treated as supporting nothing).
        return this.adapter.capabilitiesManifest?.() ?? null;
      case "harness.probe":
        await this.refreshReachability();
        return this.reachableSummary();
      case "models.list":
        // SPEC-016 revised: the harness's live model catalog (provider/model), for the agent-model
        // editor. Capability-gated — empty when the harness exposes no catalog or is unreachable.
        return this.adapter.capabilities().has("models") && this.adapter.listModels
          ? await this.adapter.listModels().catch(() => [])
          : [];
      case "agent.configure": // SPEC-016 revised + SPEC-021: rewrite an agent's model+effort (+ permission + mode)
        return this.configureAgent(a.name, a.provider, a.model, a.reasoningEffort, a.permission, a.mode);
      case "agent.create": // SPEC-021: create a new agent image from the editor's structured spec
        return this.createAgent(a.spec ?? a);
      case "registry.get":
        return this.registrySnapshot; // current projection, no re-probe (read-only)
      case "registry.probe":
        await this.refreshRegistry(true); // explicit user action → re-probe the live adapter
        return this.registrySnapshot;
      case "delivery.settings": // SPEC-030: read the per-project auto-PR preference
        return { autoOpenPr: loadAutoOpenPr(this.deliveryConfigPath()) };
      case "delivery.configure": {
        // SPEC-030: persist the auto-PR preference into `.arke/config.json` (preserving other keys).
        // Governed write: record the STANDING authorisation fail-safe BEFORE applying it (writeOrThrow),
        // so the config can't flip — enabling PRs-without-per-diff-approval — with no durable audit
        // record if the trace is unwritable. Mirrors approveDraft's trace-before-write preflight.
        const autoOpenPr = a.autoOpenPr === true;
        await this.trace.writeOrThrow({ kind: "delivery.configure", projectId: this.projectId, autoOpenPr });
        setAutoOpenPr(this.deliveryConfigPath(), autoOpenPr);
        return { ok: true, autoOpenPr };
      }
      case "spec.file":
        return this.readSpecFile(String(a.specId ?? ""));
      case "spec.create": // SPEC-020: new blank-slate specification from the template
        return this.createSpec(a.title);
      case "spec.rename": // SPEC-020: finalise a blank-slate spec's name from its derived title
        return this.renameSpec(String(a.specId ?? ""));
      case "grounding.upload": // SPEC-020: store an uploaded grounding file on the host
        return this.groundingUpload(a.name, a.content);
      case "grounding.list":
        return this.groundingList();
      case "spec.library":
        return this.specLibrary(); // SPEC-008: every spec in the active project with status
      case "spec.deliver": // SPEC-024: explicit delivery (decoupled from approval) — single-session implementation + generate
        return this.deliver(String(a.specId ?? ""), a.branch ? String(a.branch) : undefined);
      case "spec.transition": { // SPEC-024: a human manual board move — one op, two triggers, one gate
        const parsed = SpecStatus.safeParse(a.to);
        if (!parsed.success) return { applied: "invalid-target", error: `invalid target status '${String(a.to)}'` };
        return this.applyTransition(String(a.specId ?? ""), parsed.data, { kind: "human", actor: a.actor ? String(a.actor) : undefined });
      }
      case "governance.status": // SPEC-024: host-optional governance assurance level for the board badge
        return this.governanceStatus();
      // SPEC-024: the ungated `spec.promote` door is DELETED. Draft → in-review now has exactly one door —
      // the gated `approveDraft` (well-formedness → review panel → no-running-session → branch → git).
      // Board and CLI callers route through it; there is no path to `in-review` that skips the gate.
      case "revert": // SPEC-011 rescue
        return this.rescue("revert", String(a.sessionId ?? ""), a.messageId ? String(a.messageId) : undefined);
      case "unrevert":
        return this.rescue("unrevert", String(a.sessionId ?? ""));
      case "pr.approve": // SPEC-011 diff-review gate (idempotent)
        return this.approvePr(String(a.sessionId ?? ""));
      case "diff.refresh":
        return this.refreshDiff(String(a.sessionId ?? ""));
      case "repo.status.refresh": // SPEC-025: client-requested recompute (optionally one spec)
        await this.refreshRepoStatus(a.specId ? String(a.specId) : undefined);
        return { ok: true };
      case "elicitation.reply": // SPEC-012
        return this.decideElicitation("reply", String(a.sessionId ?? ""), String(a.questionId ?? ""), a.answer != null ? String(a.answer) : undefined);
      case "elicitation.reject":
        return this.decideElicitation("reject", String(a.sessionId ?? ""), String(a.questionId ?? ""));
      case "spec.generate": // SPEC-013: trigger/regenerate downstream artefacts
        return this.generate(String(a.specId ?? ""));
      case "generation.approve":
        return this.decideGeneration(String(a.specId ?? ""), String(a.proposalId ?? ""), "approved", Array.isArray(a.approvedArtifactIds) ? (a.approvedArtifactIds as string[]) : undefined, Array.isArray(a.edits) ? (a.edits as ArtifactEdit[]) : undefined);
      case "generation.reject":
        return this.decideGeneration(String(a.specId ?? ""), String(a.proposalId ?? ""), "rejected");
      case "integration.status": // SPEC-014
        return this.integrationStatus();
      case "retry-projection":
        return this.retryProjection(String(a.specId ?? ""), String(a.artifactId ?? ""), String(a.target ?? ""));
      case "projections.query":
        return this.projectionsQuery(a.specId ? String(a.specId) : undefined);
      case "get-audit-records": // SPEC-015
        return this.auditRecords(String(a.specId ?? ""), a.since != null ? Number(a.since) : undefined);
      case "spec.webhook":
        // Test/automation entry to the webhook lifecycle (the HTTP endpoint also routes here).
        return this.handleWebhook(String(a.eventName ?? ""), a.payload);
      case "approveDraft":
        return this.approveDraft(String(a.specId ?? ""), a.branch ? String(a.branch) : undefined);
      case "convenePanel":
        return this.convenePanel(
          String(a.specId ?? ""),
          a.branch ? String(a.branch) : undefined,
          Array.isArray(a.reviewers) ? (a.reviewers as ReviewerConfig[]) : undefined,
        );
      case "adjudicateIssue": {
        const action = String(a.action ?? "");
        if (action !== "accepted" && action !== "dismissed" && action !== "sent-back") {
          throw new Error(`invalid adjudication action '${action}': must be accepted | dismissed | sent-back`);
        }
        return this.adjudicateIssue(
          String(a.panelId ?? ""),
          String(a.issueId ?? ""),
          action,
          a.rationale ? String(a.rationale) : undefined,
          a.confirm === true,
        );
      }
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

  async decidePermission(decision: PermissionDecision, identity = "anonymous"): Promise<PermissionAck> {
    if (!this.adapter.respondToPermission) throw new Error("harness does not support permissions");
    // Validate the decision against an OPEN permission (SPEC-012): reject an unknown id with a warn
    // trace and NO adapter call — preventing a relay for a permission that isn't pending.
    const pending = this.pendingPerms.get(decision.permissionId);
    if (!pending) {
      await this.trace.write({ kind: "permission.warn", projectId: this.projectId, reason: "unknown-permission", permissionId: decision.permissionId });
      throw new Error(`unknown permissionId '${decision.permissionId}'`);
    }
    // Trace-BEFORE-relay, fail-safe (SPEC-012): the audit record must exist before the adapter acts.
    // writeOrThrow is intentionally NOT best-effort — if it rejects, the relay below never runs.
    await this.trace.writeOrThrow({
      kind: "permission.decision",
      at: Date.now(),
      projectId: this.projectId,
      permissionId: decision.permissionId,
      sessionId: pending.sessionId,
      granted: decision.decision !== "reject",
      decision: decision.decision,
      identity,
      harness: this.adapter.id,
    });
    if (decision.decision === "always") {
      const grant = this.grants.remember({ sessionId: pending.sessionId, actionClass: pending.actionClass, createdBy: "human" });
      await this.trace.write({ kind: "grant.remembered", grant, projectId: this.projectId });
    }
    const ack = await this.adapter.respondToPermission(decision);
    await this.trace.write({ kind: "permission.ack", ack, projectId: this.projectId });
    return ack;
  }

  /**
   * `elicitation.reply` / `elicitation.reject` (SPEC-012) — relay an agent-question decision to the
   * adapter, trace-before-relay (fail-safe) with identity. Ownership-checked; capability-gated.
   */
  async decideElicitation(verb: "reply" | "reject", sessionId: string, questionId: string, answer?: string, identity = "anonymous"): Promise<{ ok: boolean; error?: string }> {
    if (!this.sessionExists(sessionId)) return { ok: false, error: `unknown session '${sessionId}'` };
    const a = this.adapter as HarnessAdapter & {
      respondToElicitation?: (q: string, ans: string) => Promise<void>;
      rejectElicitation?: (q: string) => Promise<void>;
    };
    if (verb === "reply" ? !a.respondToElicitation : !a.rejectElicitation) {
      return { ok: false, error: "harness does not support elicitation" };
    }
    await this.trace.writeOrThrow({ // trace-before-relay fail-safe (SPEC-012), same as permissions
      kind: "elicitation.decision",
      at: Date.now(),
      projectId: this.projectId,
      questionId,
      sessionId,
      replied: verb === "reply",
      ...(answer !== undefined ? { answer } : {}), // record an explicit empty-string answer, not just truthy ones
      identity,
    });
    try {
      if (verb === "reply") await a.respondToElicitation!(questionId, answer ?? "");
      else await a.rejectElicitation!(questionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
    // The scaffold still writes a gateway-placeholder `.arke/config.json` for a greenfield project;
    // any tier value the client supplies is honoured, else the scaffold's own gateway default fills
    // it. Agents declare their real model per-image (SPEC-016 revised), edited after scaffolding.
    const supplied = (rawTiers ?? {}) as Record<string, unknown>;
    const tiers: ScaffoldTiers = {
      ...(typeof supplied.capable === "string" ? { capable: supplied.capable } : {}),
      ...(typeof supplied.mid === "string" ? { mid: supplied.mid } : {}),
      ...(typeof supplied.fast === "string" ? { fast: supplied.fast } : {}),
    } as ScaffoldTiers;
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
        ...this.modelArg("researcher"),
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
      await this.observeReviewerEvent(event);
      await this.observeGeneration(event); // SPEC-013: ingest the generation agent's proposal
      await this.observeDeliveryProgress(event); // SPEC-009 revised: has every task been checked off (or errored)?

      if (event.type === "message.part") {
        this.streaming.add(event.sessionId);
      } else if (event.type === "message.updated" && !event.isStreaming) {
        if (this.streaming.delete(event.sessionId)) {
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
        // SPEC-020: once an ASSISTANT authoring turn settles, finalise a blank-slate spec's name if
        // the spec-author has now written a real title (no-op otherwise). Decoupled from the
        // streaming gate above, which requires message.part frames that a short turn may not emit.
        if (event.role === "assistant") await this.maybeRenameTitledSpec(event.sessionId);
      }
    }
  }

  /** After an authoring turn settles, rename an `untitled-NNN` spec whose title is now set (SPEC-020). */
  private async maybeRenameTitledSpec(sessionId: string): Promise<void> {
    // Only the AUTHORING session drives the rename. Reviewer / generation / delivery sessions are also
    // created parentless (so they surface as spec-kind cards), but a reviewer, generation, or delivery
    // turn on a still-untitled spec must NOT trigger the rename — otherwise it races the author.
    if (this.reviewerSessions.has(sessionId) || this.generationSessions.has(sessionId) || this.deliverySessionOwner.has(sessionId)) return;
    // The authoring session folds into its spec's card as a `spec`-kind session (SPEC-023); find that
    // card and rename the spec it belongs to.
    const card = this.read.snapshot().find((c) => c.sessions.some((s) => s.sessionId === sessionId && s.kind === "spec"));
    if (!card) return;
    await this.renameSpec(card.specId).catch(() => undefined);
  }

  /**
   * Route harness events that belong to a review-panel reviewer session into its panel (SPEC-007):
   * a completed turn → parse issues; an errored session → mark the reviewer errored; a write/diff
   * from a read-only reviewer → log a `policy.violation`. No-op for non-reviewer sessions.
   */
  private async observeReviewerEvent(event: DomainEvent): Promise<void> {
    if (!("sessionId" in event)) return;
    const sessionId = (event as { sessionId: string }).sessionId;
    if (!this.reviewerSessions.has(sessionId)) return;
    // Ingest ONLY the reviewer's completed ASSISTANT turn. The `role` gate is load-bearing: the
    // user prompt itself arrives as a `message.updated` with `isStreaming:false` (role "user"), and
    // that prompt now embeds an example issues array (see buildReviewerPrompt) — without this gate the
    // parser extracted the *example* from the prompt and marked the reviewer done before its real
    // answer ever arrived. Intermediate assistant messages stream (`isStreaming:true`); only the final
    // answer is finalised non-streaming by `session.idle`.
    if (event.type === "message.updated" && !event.isStreaming && event.role === "assistant") {
      await this.ingestReviewerMessage(sessionId, event.text);
    } else if (event.type === "session.status" && event.status === "error") {
      await this.failReviewer(sessionId, "reviewer session reported error");
    } else if (event.type === "diff.finalized") {
      // Reviewers are read-only (edit/bash deny). A diff from a reviewer means the permission profile
      // was bypassed — record it as a governed-policy violation (SPEC-007).
      const link = this.reviewerSessions.get(sessionId);
      await this.trace.write({ kind: "policy.violation", projectId: this.projectId, panelId: link?.panelId, reviewerRole: link?.role, action: "diff.finalized", sessionId });
    }
  }

  /** Route a generation session's completed turn (or error) into its proposal (SPEC-013). */
  private async observeGeneration(event: DomainEvent): Promise<void> {
    if (!("sessionId" in event)) return;
    const sid = (event as { sessionId: string }).sessionId;
    const cid = this.generationSessions.get(sid);
    if (!cid) return;
    if (event.type === "message.updated" && !event.isStreaming) await this.ingestGeneration(sid, event.text);
    else if (event.type === "session.status" && event.status === "error") await this.failGeneration(cid, sid, "generation session reported error");
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
    // The audit trace is best-effort: an unwritable `.arke/trace.ndjson` must NOT stop the live event
    // from reaching clients (e.g. an approval's spec.status after the commit already landed) — the
    // read model + publish are the live path; the trace is durable audit (PR #18 review round 5).
    try {
      await this.trace.write({ kind: "event", projectId: this.projectId, event: stamped });
    } catch {
      /* trace unavailable — still publish the live event */
    }
    this.publish(stamped);
    // SPEC-025: after a diff/terminal-session event, schedule a debounced repo-status recompute for the
    // affected branch. This lives in emit() (not the pump) because diff.finalized/session.status are
    // emitted internally too; it never reacts to repo.* events, so there is no recursion.
    this.scheduleRepoRecompute(stamped);
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

// ---- SPEC-020 blank-slate helpers -------------------------------------------

/** Kebab-case a title into a filesystem/branch-safe slug. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "spec"
  );
}

/**
 * A concise, human-readable slug from a derived title (SPEC-020 rename). Strips parentheticals, takes
 * the headline before an em-dash/en-dash/colon, and caps it to a few words so a long title like
 * "Evolution research report — agent skills & tooling (…)" yields "evolution-research-report" rather
 * than a 60-char run-on. Falls back to the given placeholder when nothing usable remains.
 */
export function conciseSlugFromTitle(title: string, fallback: string): string {
  const stripped = title.replace(/\([^)]*\)/g, " ").trim();
  const headline = (stripped.split(/\s*[—–:]\s*/)[0] ?? stripped).trim();
  const base = headline.split(/\s+/).filter(Boolean).length >= 2 ? headline : stripped;
  const capped = base.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  const s = slugify(capped);
  return s && s !== "spec" ? s : fallback;
}

/**
 * Replace (or insert) a single scalar frontmatter field, leaving the rest of the document intact.
 * Mirrors {@link setFrontmatterStatus}: `parseFrontmatter().raw` ALREADY includes the `---` fences,
 * so the result is `newRaw + body` — re-wrapping `raw` in a second pair of fences (an earlier bug)
 * produced a doc the next call could not re-parse, corrupting the frontmatter.
 */
export function setFrontmatterField(md: string, key: string, value: string): string {
  const { raw, body } = parseFrontmatter(md);
  if (!raw) return `---\n${key}: ${value}\n---\n\n${md}`;
  let replaced = false;
  const re = new RegExp(`^${key}:\\s*`);
  const newRaw = raw
    .split("\n")
    .map((line) => (re.test(line) ? ((replaced = true), `${key}: ${value}`) : line))
    .join("\n");
  const withField = replaced ? newRaw : newRaw.replace(/\n---(\r?\n?)$/, `\n${key}: ${value}\n---$1`);
  return withField + body;
}

/** The next `NNN` spec number: one above the highest `NNN.` file already in the specifications dir. */
export function nextSpecNumber(specsDir: string): number {
  let max = 0;
  try {
    for (const f of readdirSync(specsDir)) {
      const m = /^(\d{3})\./.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {
    /* no dir yet → start at 1 */
  }
  return max + 1;
}

/**
 * Render a blank specification: the real template's frontmatter (seeded) and section skeleton with
 * empty bodies, so the SPEC-006 preview shows the headings as placeholders that fill in through the
 * conversation (SPEC-020). Requirements / Design / Tasks match SPEC_ANATOMY so the preview renders them.
 */
export function renderBlankSpec(seed: { specId: string; title: string; branch: string; date: string }): string {
  const { specId, title, branch, date } = seed;
  return `---
spec_id: ${specId}
title: ${title}
status: draft
branch: ${branch}
owner: core-maintainers
capabilities: []
type: specification
created: ${date}
updated: ${date}
---

# ${title}

## Why

## What changes

## Requirements

## Design

### Architectural decision

### Target architecture

### Data model

### Interfaces and contracts

### Cross-cutting

## Tasks

### Testing

### Definition of done

## Decision log
| # | Decision | Rationale |
|---|----------|-----------|

## Open questions

## Change history
- ${date} · ${branch} · draft — created (blank slate)
`;
}

export function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** The current git HEAD branch name in `cwd`, or null when it can't be determined (SPEC-006). */
export function gitHeadBranch(cwd: string): string | null {
  try {
    const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], gitOpts(cwd));
    if (res.status !== 0) return null;
    const branch = (res.stdout ?? "").trim();
    return branch.length > 0 && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/** The permission verbs an agent image accepts — the harness gate (OpenCode: allow/ask/deny). */
const PERMISSION_VERBS = new Set(["allow", "ask", "deny"]);

/**
 * Coerce a client-supplied `permission` payload into a clean `Record<string,string>` (SPEC-021):
 * - `undefined`/non-object → `undefined` ("not provided" — the caller leaves the block untouched).
 * - an object → the sanitised map, which MAY be empty (an explicit "clear all permissions").
 *
 * Verbs are validated against `allow|ask|deny` and a bad verb THROWS before any write — otherwise a
 * typo like `edit: always` would be written to `config.yaml` and then fail the image's schema on the
 * next registry reload, silently dropping the agent from the roster.
 */
function sanitizePermission(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.trim() === "" || typeof v !== "string" || v.trim() === "") continue;
    if (!PERMISSION_VERBS.has(v)) throw new Error(`invalid permission verb '${v}' for '${k}' (expected allow | ask | deny)`);
    out[k] = v;
  }
  return out; // may be {} → an explicit clear
}

/** Bound git invocations so a hanging hook / credential or GPG prompt can't wedge the event loop. */
export const GIT_TIMEOUT_MS = Number(process.env.ARKE_GIT_TIMEOUT_MS ?? 20_000);
/** Non-interactive git: never block on a terminal credential prompt (PR #18 review round 6). */
export function gitOpts(cwd: string) {
  return { cwd, encoding: "utf8" as const, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
}

/** Stage and commit a single file in `cwd` (SPEC-006). Returns the new sha or the failure reason. */
export function gitCommit(cwd: string, relPath: string, message: string): { ok: true; sha: string } | { ok: false; error: string } {
  try {
    const add = spawnSync("git", ["add", "--", relPath], gitOpts(cwd));
    if (add.status !== 0) return { ok: false, error: (add.stderr || "git add failed").trim() };
    const commit = spawnSync("git", ["commit", "-m", message, "--", relPath], gitOpts(cwd));
    if (commit.status !== 0) {
      // Unstage what `git add` staged so a commit failure leaves the index clean too — otherwise the
      // approval change sits staged and a later commit could include it (PR #18 review). The caller
      // restores the working-tree file; this restores the index. (A timeout yields status null →
      // treated as failure, and the bounded wait means a hung hook can't block forever.)
      spawnSync("git", ["reset", "-q", "--", relPath], gitOpts(cwd));
      return { ok: false, error: (commit.error?.message || commit.stderr || commit.stdout || "git commit failed").trim() };
    }
    const sha = spawnSync("git", ["rev-parse", "HEAD"], gitOpts(cwd));
    return { ok: true, sha: (sha.stdout ?? "").trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The repo's mainline branch (SPEC-024 host-less delivery): the first of `main`/`master` that exists,
 *  or null. Used as the merge target when there is no git host to define the default branch. */
export function gitDefaultBranch(cwd: string): string | null {
  for (const b of ["main", "master"]) {
    if (spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${b}`], gitOpts(cwd)).status === 0) return b;
  }
  return null;
}

/**
 * Merge `fromBranch` into `intoBranch` in `cwd` for host-less delivery (SPEC-024). Checks out the
 * mainline, merges `--no-ff`, and — critically — aborts cleanly on conflict so no half-merged tree is
 * ever left behind. Returns the new sha or a named failure (with `conflict` set when git reported one).
 */
export function gitMerge(
  cwd: string,
  intoBranch: string,
  fromBranch: string,
  message: string,
): { ok: true; sha: string } | { ok: false; error: string; conflict?: boolean } {
  try {
    const co = spawnSync("git", ["checkout", intoBranch], gitOpts(cwd));
    if (co.status !== 0) return { ok: false, error: (co.stderr || `could not checkout '${intoBranch}'`).trim() };
    const merge = spawnSync("git", ["merge", "--no-ff", "-m", message, fromBranch], gitOpts(cwd));
    if (merge.status !== 0) {
      // Abort so the working tree/index is restored — never leave a conflicted, half-merged state.
      spawnSync("git", ["merge", "--abort"], gitOpts(cwd));
      const out = (merge.stderr || merge.stdout || "git merge failed").trim();
      return { ok: false, error: out, conflict: /conflict/i.test(out) };
    }
    const sha = spawnSync("git", ["rev-parse", "HEAD"], gitOpts(cwd));
    return { ok: true, sha: (sha.stdout ?? "").trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const CLONE_TIMEOUT_MS = Number(process.env.ARKE_CLONE_TIMEOUT_MS ?? 120_000);

export function gitCloneAsync(url: string, target: string, timeoutMs: number): Promise<void> {
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

/** Rank a grounding `type` by the vocabulary order (product-overview first) for a deterministic digest. */
function rankGroundingType(type: string): number {
  const i = (GROUNDING_TYPES as readonly string[]).indexOf(type);
  return i === -1 ? GROUNDING_TYPES.length : i;
}
