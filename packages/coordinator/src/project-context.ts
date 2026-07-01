import { existsSync, readdirSync, realpathSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  DomainEvent,
  appendChangeHistory,
  parseFrontmatter,
  parseSpecDoc,
  setFrontmatterStatus,
  type AgentImage,
  type HarnessAdapter,
  type ModelInfo,
  type ModelTier,
  type PermissionAck,
  type PermissionDecision,
  type ScaffoldStep,
  type SpecStatus,
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
import {
  maxConcurrentTasks,
  parseTasks,
  planFanOut,
  type FanOutRecord,
  type FanOutTask,
  type TaskCommand,
} from "./fanout.js";
import { FanOutStore } from "./fanout-store.js";
import {
  RegistryResolver,
  type RegistryConfig,
  type RegistryInstanceStatus,
  type RegistrySnapshot,
  type RegistryWarning,
  type RegistryWarningReason,
} from "./registry.js";
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
import { loadAgentImage } from "@arke/agent-image";
import { ReadModel } from "./read-model.js";
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
  tierDefaults: ScaffoldTiers;
  registry: ProjectRegistry;
  /** The harness/model registry parsed from this project's `.arke/config.json` (SPEC-005). */
  registryConfig?: RegistryConfig;
  /** The configured instance the live adapter serves (first `opencode` driver), if any. */
  connectedInstanceId?: string;
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
  instanceId: string;
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
  private readonly tierDefaults: ScaffoldTiers;
  private readonly registry: ProjectRegistry;
  private readonly probe: HarnessReachabilityProbe;
  private readonly publish: (event: DomainEvent) => void;
  private readonly registryResolver?: RegistryResolver;
  private readonly connectedInstanceId?: string;
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
  /** Durable fan-out records for restart idempotency (SPEC-009). */
  private fanoutStore?: FanOutStore;
  /** Per-spec queue of task commands held back by the concurrency cap (SPEC-009). */
  private readonly fanoutQueues = new Map<string, TaskCommand[]>();
  /** Specs whose fan-out is halted because the spec was demoted away from approved (SPEC-009). */
  private readonly fanoutHalted = new Set<string>();
  /** task sessionId → its spec + task key, so a completed task can drain the spec's queue (SPEC-009). */
  private readonly taskSessions = new Map<string, { specId: string; taskKey: string }>();
  /** Canonical spec ids with at least one completed review panel — the finalisation gate (SPEC-007). */
  private readonly completedReviews = new Set<string>();

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
    if (init.connectedInstanceId) this.connectedInstanceId = init.connectedInstanceId;
    if (init.registryConfig && init.registryConfig.instances.length > 0) {
      try {
        this.registryResolver = new RegistryResolver(init.registryConfig);
      } catch (err) {
        // A structurally invalid registry (e.g. duplicate instance ids) leaves the projection empty;
        // record why rather than crashing context startup. The screen then shows no harnesses.
        void this.trace.write({
          kind: "registry.config-error",
          projectId: this.projectId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Classify the folder, register it as a recent, probe reachability, and start the pump if ready. */
  async start(): Promise<void> {
    this.classify();
    await this.reconstructReviewGate(); // SPEC-007: rebuild completed-review set from the durable trace
    this.fanoutStore = new FanOutStore(resolve(this.root, ".arke", "fanout.ndjson")); // SPEC-009
    this.fanoutStore.load();
    this.fanoutStore.reconcileInterrupted(); // restart: free slots held by tasks whose sessions died
    this.registry.upsert({ root: this.root, name: this.name, state: this.projectState });
    await this.refreshReachability();
    // Build the registry projection even when the harness isn't ready: a configured-but-unreachable
    // instance is a real, useful state for the harnesses screen (SPEC-005).
    await this.refreshRegistry();
    const readiness = this.adapter.readiness?.();
    if (readiness && !readiness.ready) return; // serve snapshot only; no stream
    void this.pump();
  }

  /** Stop this context's pump and any harness it started (never an attached one — SPEC-016). */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.trace.drain(); // SPEC-015: flush enqueued trace appends before exit (no dropped records)
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
      ...(this.registrySnapshot ? { registry: this.registrySnapshot } : {}),
      // SPEC-019: whether ANY harness is configured (globally or per-project). When false, the launch
      // screen shows first-run quick setup instead of the configured-but-down re-probe state.
      harnessSetup: { configured: this.registryResolver !== undefined },
      specs: this.specLibrary(), // SPEC-008: the spec library for this project
    };
  }

  cardCount(): number {
    return this.read.snapshot().length;
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
    const resolver = this.registryResolver;
    if (!resolver) {
      this.registrySnapshot = null;
      return;
    }
    // On an explicit Re-probe, re-run the adapter's startup probe so readiness/caps/catalog reflect
    // the server's CURRENT state — OpenCodeAdapter caches them at init(), so without this the
    // Re-probe button could never recover a server that was down at startup. init() is idempotent;
    // guard it so a still-down server yields reachable:false rather than throwing here.
    if (reprobe && this.adapter.init) {
      try {
        await this.adapter.init();
      } catch {
        /* readiness()/capabilities() now reflect the failed probe */
      }
    }
    const catalogs = new Map<string, ModelInfo[] | null>();
    const instances: RegistryInstanceStatus[] = [];
    for (const inst of resolver.listInstances()) {
      const connected = inst.id === this.connectedInstanceId;
      let reachable = false;
      let caps: string[] = [];
      let catalogUnavailable = true;
      let endpoint = inst.host;
      if (connected) {
        const r = this.adapter.readiness?.() ?? { ready: true };
        reachable = r.ready;
        caps = [...this.adapter.capabilities()];
        endpoint = this.endpoints[0] ?? this.adapter.id;
        if (caps.includes("models") && this.adapter.listModels) {
          try {
            catalogs.set(inst.id, await this.adapter.listModels());
            catalogUnavailable = false;
          } catch {
            catalogs.set(inst.id, null);
          }
        } else {
          catalogs.set(inst.id, null);
        }
      } else {
        catalogs.set(inst.id, null); // no adapter wired for non-connected instances yet
      }
      instances.push({
        id: inst.id,
        driver: inst.driver,
        endpoint,
        reachable,
        caps,
        serves: inst.serves,
        ...(catalogUnavailable ? { catalogUnavailable: true } : {}),
      });
    }

    // Validate configured serves against the live catalog(s) and collect config problems as warnings
    // (labels only — no vendor model string leaks into the detail). Warnings are stored ON the
    // snapshot so a client opening a project with a bad registry sees them immediately, even though
    // the emitted `registry.warning` events fire before it has subscribed (PR #15 review).
    const warnings: RegistryWarning[] = [];
    const validation = resolver.validateServesAgainstCatalog(catalogs);
    for (const p of validation.problems) {
      warnings.push({
        reason: "model-not-in-catalog",
        detail: `instance '${p.instanceId}' has a model absent from its live catalog for tier '${p.tier}' (${p.label})`,
      });
    }
    try {
      resolver.assertReviewersDistinct();
    } catch (err) {
      warnings.push({
        reason: "reviewer-models-identical",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    this.registrySnapshot = {
      instances,
      tierResolution: resolver.tierResolution(),
      roster: resolver.rosterResolution(),
      warnings,
    };
    // Emit the warning events too, for clients already subscribed to a live context.
    for (const w of warnings) await this.emitRegistryWarning(w.reason, w.detail ?? "");
    await this.emit({
      seq: 0,
      ts: 0,
      harness: this.adapter.id,
      type: "registry.updated",
      instances: instances.map((s) => ({
        id: s.id,
        driver: s.driver,
        endpoint: s.endpoint,
        reachable: s.reachable,
        caps: s.caps,
        serves: s.serves,
        ...(s.catalogUnavailable ? { catalogUnavailable: true } : {}),
      })),
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
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
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
      entries = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "specification.template.md");
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

    // Advance status in the read model AND persist it to the file frontmatter, so the library's
    // divergence check (read-model vs. frontmatter) only fires on genuine drift, not after every
    // transition (the spec calls for the frontmatter status to follow PR state).
    const setStatus = async (status: SpecStatus, reason: string, extra?: Partial<SpecRecordState>) => {
      this.specRecords.set(specId, { ...(this.specRecords.get(specId) ?? {}), status, ...(("prNumber" in t) ? { prNumber: (t as any).prNumber } : {}), ...extra });
      try {
        const cur = this.findSpecFile(specId);
        if (cur && (cur.frontmatter.status ?? "draft") !== status) writeFileSync(cur.absPath, setFrontmatterStatus(cur.text, status), "utf8");
      } catch {
        /* best-effort: the read model is authoritative for the gate; a write failure surfaces as divergence */
      }
      await this.trace.write({ kind: "spec.lifecycle", projectId: this.projectId, specId, status, reason });
      // SPEC-009 demotion guard: leaving `approved` while tasks are still queued halts the queue —
      // queued tasks for a no-longer-approved spec must not be dispatched.
      if (status !== "approved" && (this.fanoutQueues.get(specId)?.length ?? 0) > 0) {
        this.fanoutHalted.add(specId);
        await this.trace.write({ kind: "fanout.halted", projectId: this.projectId, specId, reason: "spec-demoted" });
      }
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.status", specId, status, reason } as DomainEvent);
    };

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
        // Second-human gate, fail CLOSED: an approval from the owner, OR a spec with no `owner` to check
        // against, must NOT advance to approved (the governance invariant can't be verified).
        if (!owner || isSelfApproval(t.approver, owner)) {
          await this.trace.write({ kind: "governance.self-approval-rejected", projectId: this.projectId, specId, approver: t.approver, prNumber: t.prNumber, reason: owner ? "self-approval" : "no-owner-to-verify" });
          return { applied: owner ? "self-approval-rejected" : "approval-rejected-no-owner", specId };
        }
        // Record the normative baseline so a later material change can be detected.
        await setStatus("approved", "pr-approved", { normativeHash: normativeHash(found.text) });
        this.fanoutHalted.delete(specId);
        void this.fanOut(specId); // SPEC-009: fan the task list out concurrently (non-blocking)
        void this.generate(specId); // SPEC-013: propose downstream artefacts from the approved spec
        return { applied: "approved", specId };
      }
      case "merged":
        await this.flattenAndMerge(specId, t.branch);
        await setStatus("merged", "pr-merged");
        return { applied: "merged", specId };
      case "force-push": {
        if (found.frontmatter.branch && found.frontmatter.branch !== t.branch) {
          await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.branch-mismatch", specId, frontmatterBranch: found.frontmatter.branch, pushedBranch: t.branch } as DomainEvent);
        }
        return { applied: "force-push-revalidated", specId };
      }
    }
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
   * `spec.promote` (SPEC-010) — a human board correction that advances a DRAFT spec to in-review
   * without going through a PR. The column is still a read-only projection: this writes the underlying
   * frontmatter status and emits `spec.status`, so the card moves as a result of the event, never a
   * direct column write. Traced before the change. Refuses a non-draft spec.
   */
  private async promoteSpec(specId: string): Promise<{ ok: boolean; specId?: string; status?: string; error?: string }> {
    const found = this.findSpecFile(specId);
    if (!found) return { ok: false, error: `no spec '${specId}'` };
    const cid = found.canonicalId;
    const current = found.frontmatter.status ?? "draft";
    if (current !== "draft") return { ok: false, specId: cid, error: `cannot promote: '${cid}' is '${current}', expected 'draft'` };
    await this.trace.write({ kind: "spec.promote", projectId: this.projectId, specId: cid, from: "draft", to: "in-review" });
    try {
      writeFileSync(found.absPath, setFrontmatterStatus(found.text, "in-review"), "utf8");
    } catch {
      return { ok: false, specId: cid, error: "could not write spec frontmatter" };
    }
    this.specRecords.set(cid, { ...(this.specRecords.get(cid) ?? {}), status: "in-review" });
    await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "spec.status", specId: cid, status: "in-review", reason: "promoted" } as DomainEvent);
    return { ok: true, specId: cid, status: "in-review" };
  }

  // ---- session detail: rescue / steering / diff-gate (SPEC-011) -----------

  /** True when a session exists in the read model (the ownership guard — not specId truthiness). */
  private sessionExists(sessionId: string): boolean {
    return this.read.snapshot().some((c) => c.id === sessionId);
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
      this.adapter.dispatchAsync({ sessionId: ref.sessionId, agent: "spec-author", tier: "capable", parts: [{ type: "text", text: buildGenerationPrompt(found.text) }] }),
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

  // ---- parallel task fan-out (SPEC-009) -----------------------------------

  /**
   * Fan an approved spec's task list out into concurrent child task sessions (SPEC-009). Each task
   * runs in its own git worktree off the feature branch. Idempotent across restart (FanOutStore),
   * non-blocking (commands dispatch concurrently), and capped at `ARKE_MAX_CONCURRENT_TASKS` with the
   * excess queued and drained as task sessions complete.
   */
  async fanOut(specId: string): Promise<{ dispatched: number; queued: number; error?: string }> {
    const found = this.findSpecFile(specId);
    if (!found) return { dispatched: 0, queued: 0, error: "spec not found" };
    const cid = found.canonicalId;
    const featureBranch = found.frontmatter.branch ?? "";
    const tasks = parseTasks(found.text);
    if (tasks.filter((t) => !t.done).length === 0) {
      // Graceful failure: no actionable tasks (SPEC-009). Error on the spec session + warn trace.
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "session.status", sessionId: cid, specId: cid, kind: "spec", status: "error" } as DomainEvent);
      await this.trace.write({ kind: "warn", projectId: this.projectId, specId: cid, reason: "no-tasks" });
      return { dispatched: 0, queued: 0, error: "no-tasks" };
    }
    const store = this.fanoutStore;
    const already = store?.dispatchedKeys(cid) ?? new Set<string>();
    const record: FanOutRecord = store?.get(cid) ?? { specId: cid, specSessionId: cid, featureBranch, tasks: [], startedAt: Date.now() };
    const runningCount = record.tasks.filter((t) => t.status === "running" || t.status === "dispatching").length;
    const plan = planFanOut({ specId: cid, specSessionId: cid, featureBranch, tasks, alreadyDispatched: already, runningCount, limit: maxConcurrentTasks() });

    // Replace the live queue from the freshly-computed plan — fanOut re-plans from the durable record
    // each call, so repeated calls (and re-approval after a restart) are idempotent: dispatchedKeys
    // excludes running/dispatching/done, so only genuinely-pending tasks are (re)queued here.
    this.fanoutQueues.set(cid, plan.queued);
    for (const cmd of plan.queued) {
      const existing = record.tasks.find((t) => t.taskKey === cmd.taskKey);
      if (!existing) record.tasks.push({ taskIndex: cmd.taskIndex, taskKey: cmd.taskKey, taskText: cmd.taskText, status: "queued", worktreeBranch: cmd.worktreeBranch });
      else if (existing.status === "failed") existing.status = "queued"; // retry a previously-failed task
    }
    store?.put(record);

    // Dispatch the immediate set concurrently — never await one before starting the next. Each task is
    // isolated: a per-task failure (collision/worktree/dispatch) does not abort the others.
    const results = await Promise.allSettled(plan.dispatch.map((cmd) => this.dispatchTask(cmd)));
    const dispatched = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
    return { dispatched, queued: plan.queued.length };
  }

  /** Execute one task command: collision check → worktree → session → dispatchAsync, fully isolated.
   *  Returns true only when the task was actually dispatched (false on any per-task failure). */
  private async dispatchTask(cmd: TaskCommand): Promise<boolean> {
    const store = this.fanoutStore;
    const record = store?.get(cmd.specId) ?? { specId: cmd.specId, specSessionId: cmd.specSessionId, featureBranch: cmd.featureBranch, tasks: [], startedAt: Date.now() };
    const upsert = (patch: Partial<FanOutTask>) => {
      const existing = record.tasks.find((t) => t.taskKey === cmd.taskKey);
      if (existing) Object.assign(existing, patch);
      else record.tasks.push({ taskIndex: cmd.taskIndex, taskKey: cmd.taskKey, taskText: cmd.taskText, status: "dispatching", ...patch });
      store?.put(record);
    };
    const fail = async (reason: string) => {
      upsert({ status: "failed", error: reason });
      await this.trace.write({ kind: "dispatch.failed", projectId: this.projectId, specId: cmd.specId, taskIndex: cmd.taskIndex, taskKey: cmd.taskKey, worktreeBranch: cmd.worktreeBranch, reason });
      // The task card moves to needs-human (the read model maps an errored task session to that column).
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "session.status", sessionId: `${cmd.specId}#task-${cmd.taskKey}`, specId: cmd.specId, kind: "task", status: "error" } as DomainEvent);
    };

    upsert({ status: "dispatching", worktreeBranch: cmd.worktreeBranch });
    await this.trace.write({ kind: "dispatch.started", projectId: this.projectId, specId: cmd.specId, taskIndex: cmd.taskIndex, taskKey: cmd.taskKey, worktreeBranch: cmd.worktreeBranch });

    // Branch-collision guard: an existing branch means an orphaned worktree from a prior run.
    const exists = spawnSync("git", ["branch", "--list", cmd.worktreeBranch], gitOpts(this.root));
    if ((exists.stdout ?? "").trim().length > 0) {
      await this.trace.write({ kind: "warn", projectId: this.projectId, specId: cmd.specId, taskKey: cmd.taskKey, reason: "branch-collision", branch: cmd.worktreeBranch });
      await fail(`worktree branch '${cmd.worktreeBranch}' already exists`);
      return false;
    }
    // Worktree path keyed by a hash of the full branch name, so distinct branches never collapse to
    // the same on-disk path (a lossy char-replace could map `feat/foo` and `feat-foo` together).
    const wtPath = resolve(this.root, ".arke", "worktrees", createHash("sha1").update(cmd.worktreeBranch).digest("hex").slice(0, 16));
    const add = spawnSync("git", ["worktree", "add", "-b", cmd.worktreeBranch, wtPath, cmd.featureBranch], gitOpts(this.root));
    if (add.status !== 0) {
      await fail(`git worktree add failed: ${(add.stderr || add.stdout || "").toString().trim().slice(0, 200)}`);
      return false;
    }

    try {
      const ref = await this.adapter.createSession({ specId: cmd.specId, parent: cmd.specSessionId });
      this.taskSessions.set(ref.sessionId, { specId: cmd.specId, taskKey: cmd.taskKey });
      upsert({ status: "running", sessionId: ref.sessionId });
      await this.adapter.dispatchAsync({ sessionId: ref.sessionId, agent: "implementer", tier: "mid", parts: [{ type: "text", text: cmd.taskText }] });
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "session.status", sessionId: ref.sessionId, specId: cmd.specId, kind: "task", status: "running" } as DomainEvent);
      await this.trace.write({ kind: "dispatch.complete", projectId: this.projectId, specId: cmd.specId, taskIndex: cmd.taskIndex, taskKey: cmd.taskKey, sessionId: ref.sessionId });
      return true;
    } catch (err) {
      // The worktree was created but the session never started: remove it so a retry is clean rather
      // than tripping the collision guard on the orphaned branch.
      spawnSync("git", ["worktree", "remove", "--force", wtPath], gitOpts(this.root));
      spawnSync("git", ["branch", "-D", cmd.worktreeBranch], gitOpts(this.root));
      await fail(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Drain one queued task for a spec when a running task completes (respecting the demotion halt). */
  private async drainFanOut(specId: string): Promise<void> {
    if (this.fanoutHalted.has(specId)) return; // spec demoted → hold queued tasks
    const queue = this.fanoutQueues.get(specId);
    if (!queue || queue.length === 0) return;
    const next = queue.shift()!;
    await this.dispatchTask(next);
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
    if (this.read.snapshot().some((c) => c.specId === cid && c.id !== cid && c.kind === "spec" && c.status === "running")) {
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
    if (head !== fmBranch) return fail(`branch guard: HEAD is '${head}' but the spec's branch is '${fmBranch}'`);

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

    // Validate reviewers against the registry (SPEC-007). Without a registry we can't guarantee
    // distinct models, so refuse rather than run a panel with unverifiable independence.
    if (!this.registryResolver) {
      const reason = "no registry configured — cannot resolve distinct reviewer models";
      await this.emit({ seq: 0, ts: 0, harness: this.adapter.id, type: "panel.config-error", specId: cid, reason } as DomainEvent);
      throw new Error(reason);
    }
    const reviewers = reviewersArg && reviewersArg.length > 0 ? reviewersArg : [{ role: "reviewer-a" }, { role: "reviewer-b" }];
    const validation = validateReviewers(this.registryResolver, reviewers);
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
      panel.reviewers.push({ role: r.role, sessionId: ref.sessionId, instanceId: r.instanceId, model: r.model, label: r.label, status: "running" });
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
      reviewers: panel.reviewers.map((r) => ({ role: r.role, instanceId: r.instanceId, model: r.model })), // host-side audit may include the model
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
      await this.adapter.dispatchAsync({ sessionId: r.sessionId, agent: r.role, tier: "capable", parts: [{ type: "text", text: prompt }] });
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

  /** A short grounding summary for reviewers: the AGENTS.md head, if present (host-side, SPEC-007). */
  private groundingSummary(): string {
    try {
      const agents = readFileSync(resolve(this.root, "AGENTS.md"), "utf8");
      return agents.slice(0, 2000);
    } catch {
      return "";
    }
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
        tier: "capable",
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
        const sessionId = String(a.sessionId ?? "");
        // Stale-session guard (SPEC-006): a queued message that targets a session no longer idle or
        // running (e.g. it went waiting/done/error while the client was offline) is rejected with its
        // current status rather than silently executed.
        const known = this.read.snapshot().find((c) => c.id === sessionId);
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
        }
        const input = {
          sessionId,
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
      case "registry.get":
        return this.registrySnapshot; // current projection, no re-probe (read-only)
      case "registry.probe":
        await this.refreshRegistry(true); // explicit user action → re-probe the live adapter
        return this.registrySnapshot;
      case "spec.file":
        return this.readSpecFile(String(a.specId ?? ""));
      case "spec.library":
        return this.specLibrary(); // SPEC-008: every spec in the active project with status
      case "spec.fanout":
        return this.fanOut(String(a.specId ?? "")); // SPEC-009: fan an approved spec's tasks out
      case "spec.promote":
        return this.promoteSpec(String(a.specId ?? "")); // SPEC-010: human board correction draft→in-review
      case "revert": // SPEC-011 rescue
        return this.rescue("revert", String(a.sessionId ?? ""), a.messageId ? String(a.messageId) : undefined);
      case "unrevert":
        return this.rescue("unrevert", String(a.sessionId ?? ""));
      case "pr.approve": // SPEC-011 diff-review gate (idempotent)
        return this.approvePr(String(a.sessionId ?? ""));
      case "diff.refresh":
        return this.refreshDiff(String(a.sessionId ?? ""));
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
    const supplied = (rawTiers ?? {}) as Record<string, unknown>;
    const tiers: ScaffoldTiers = {
      capable: typeof supplied.capable === "string" ? supplied.capable : this.tierDefaults.capable,
      mid: typeof supplied.mid === "string" ? supplied.mid : this.tierDefaults.mid,
      fast: typeof supplied.fast === "string" ? supplied.fast : this.tierDefaults.fast,
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
      await this.observeReviewerEvent(event);
      await this.observeTaskCompletion(event); // SPEC-009: drain the fan-out queue on task completion
      await this.observeGeneration(event); // SPEC-013: ingest the generation agent's proposal

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

  /**
   * Route harness events that belong to a review-panel reviewer session into its panel (SPEC-007):
   * a completed turn → parse issues; an errored session → mark the reviewer errored; a write/diff
   * from a read-only reviewer → log a `policy.violation`. No-op for non-reviewer sessions.
   */
  private async observeReviewerEvent(event: DomainEvent): Promise<void> {
    if (!("sessionId" in event)) return;
    const sessionId = (event as { sessionId: string }).sessionId;
    if (!this.reviewerSessions.has(sessionId)) return;
    if (event.type === "message.updated" && !event.isStreaming) {
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

  /**
   * Drain the fan-out queue when a task session reaches a TERMINAL state (SPEC-009). `done` is
   * terminal; `idle` is only the end of one turn (the agent may still be working) so it must NOT
   * count as completion. `error` is terminal too — it frees the slot, so it also drains.
   */
  private async observeTaskCompletion(event: DomainEvent): Promise<void> {
    if (event.type !== "session.status") return;
    if (event.status !== "done" && event.status !== "error") return;
    const link = this.taskSessions.get(event.sessionId);
    if (!link) return;
    const store = this.fanoutStore;
    const record = store?.get(link.specId);
    if (record) {
      const task = record.tasks.find((t) => t.taskKey === link.taskKey);
      if (task && task.status === "running") {
        task.status = event.status === "done" ? "done" : "failed";
        if (event.status === "error") task.error = "task session reported error";
        store?.put(record);
      }
    }
    this.taskSessions.delete(event.sessionId);
    await this.drainFanOut(link.specId);
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

/** Bound git invocations so a hanging hook / credential or GPG prompt can't wedge the event loop. */
const GIT_TIMEOUT_MS = Number(process.env.ARKE_GIT_TIMEOUT_MS ?? 20_000);
/** Non-interactive git: never block on a terminal credential prompt (PR #18 review round 6). */
function gitOpts(cwd: string) {
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
