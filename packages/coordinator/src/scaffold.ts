import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { DomainEvent, ScaffoldStep } from "@arke/contracts";
import type { Trace } from "./trace.js";

/**
 * Scaffolds a repository into a method-ready state in one confirmed action (SPEC-004).
 *
 * Runs on the coordinator (host), never the client, so file I/O stays inside the trust
 * boundary (NFR-1). Each step is idempotent and non-destructive: an artefact is created when
 * absent, overwritten only when stale or absent, skipped when it already matches the manifest,
 * and left untouched (skipped `user-modified`) when its checksum diverges from what a previous
 * scaffold produced. The `.arke/scaffold-manifest.json` is the authoritative record of what the
 * scaffold produced and is written atomically after each successful step, so a crash mid-scaffold
 * can resume from the last incomplete step.
 */

export const SCAFFOLD_STEP_ORDER: ScaffoldStep[] = ["config", "agents", "specs", "grounding", "plugins", "repos"];

/** Per-artefact outcome within a step. */
export type ArtefactOutcome = "created" | "overwritten" | "skipped-uptodate" | "skipped-user-modified";

export interface ScaffoldArtefact {
  path: string; // repo-relative
  outcome: ArtefactOutcome;
}

export interface ScaffoldStepResult {
  step: ScaffoldStep;
  status: "done" | "skipped" | "error";
  detail?: string;
  artefacts: ScaffoldArtefact[];
}

export interface ScaffoldResult {
  stepsRun: ScaffoldStep[];
  steps: ScaffoldStepResult[];
  /** True if every attempted step completed without error. */
  ok: boolean;
}

interface ManifestEntry {
  scaffoldChecksum: string;
  createdAt: string;
}

interface ScaffoldManifest {
  version: 1;
  lastCompletedStep?: ScaffoldStep;
  artefacts: Record<string, ManifestEntry>;
  /** Repo-relative paths explicitly marked stale → overwritten on the next run. */
  stale: string[];
}

/**
 * Vestigial (SPEC-016 revised): agents declare their own model per-image, so the scaffold no longer
 * takes logical-tier model bindings. Retained (optional, unused) so older callers/tests still type.
 */
export interface ScaffoldTiers {
  capable?: string;
  mid?: string;
  fast?: string;
}

export interface ScaffoldRunOptions {
  tiers?: ScaffoldTiers;
  /** When set, steps before this one in {@link SCAFFOLD_STEP_ORDER} are skipped (manifest-aware). */
  resumeFrom?: ScaffoldStep;
}

/** Injectable probe for git presence, so tests can exercise the no-git `repos` skip path. */
export type GitProbe = () => boolean;

const MANIFEST_REL = ".arke/scaffold-manifest.json";

export class ScaffoldRunner {
  private readonly root: string;
  private readonly emit: (event: DomainEvent) => Promise<void>;
  private readonly trace?: Trace;
  private readonly harness: string;
  private readonly gitAvailable: GitProbe;
  private readonly clock: () => number;

  constructor(opts: {
    root: string;
    harness: string;
    emit: (event: DomainEvent) => Promise<void>;
    trace?: Trace;
    gitProbe?: GitProbe;
    clock?: () => number;
  }) {
    this.root = resolve(opts.root);
    this.harness = opts.harness;
    this.emit = opts.emit;
    this.trace = opts.trace;
    this.gitAvailable = opts.gitProbe ?? defaultGitProbe;
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Run the scaffold steps in order. A failing step stops execution at that step (its remaining
   * steps are not attempted), records `lastCompletedStep` up to the prior success, and surfaces a
   * `scaffold.step` `error` event so the client can offer "Retry from step".
   */
  async run(opts: ScaffoldRunOptions = {}): Promise<ScaffoldResult> {
    // Greenfield is NOT blocked (revises SPEC-004 D9): the `config` step writes `.arke/config.json`
    // with a gateway provider/auth profile, and the agent roster (`agents/<name>/config.yaml` +
    // materialised `.opencode/agents/*.md`) declares gateway-placeholder models — never a real vendor
    // id — so nothing unusable is written; the engineer edits the models/provider host-side later.
    const manifest = this.readManifest();
    const startIndex = opts.resumeFrom ? SCAFFOLD_STEP_ORDER.indexOf(opts.resumeFrom) : 0;
    const results: ScaffoldStepResult[] = [];
    const stepsRun: ScaffoldStep[] = [];

    for (let i = Math.max(0, startIndex); i < SCAFFOLD_STEP_ORDER.length; i++) {
      const step = SCAFFOLD_STEP_ORDER[i]!;
      stepsRun.push(step);
      await this.emitStep(step, "running");
      try {
        const result = await this.runStep(step, manifest);
        results.push(result);
        manifest.lastCompletedStep = step;
        this.writeManifest(manifest); // atomic, after each successful step
        await this.emitStep(step, result.status, result.detail);
        await this.trace?.write({ kind: "scaffold.step", step, status: result.status, detail: result.detail });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        results.push({ step, status: "error", detail, artefacts: [] });
        await this.emitStep(step, "error", detail);
        await this.trace?.write({ kind: "scaffold.step", step, status: "error", detail });
        // Stop at the failed step; remaining steps are not attempted (SPEC-004 resilience).
        return { stepsRun, steps: results, ok: false };
      }
    }

    await this.emit({
      seq: 0,
      ts: 0,
      harness: this.harness,
      type: "scaffold.done",
      projectPath: this.root, // canonicalised root only — never a raw client value
      stepsRun,
    });
    await this.trace?.write({ kind: "scaffold.done", projectPath: this.root, stepsRun });
    return { stepsRun, steps: results, ok: true };
  }

  // ---- steps ---------------------------------------------------------------

  private async runStep(
    step: ScaffoldStep,
    manifest: ScaffoldManifest,
  ): Promise<ScaffoldStepResult> {
    if (step === "repos" && !this.gitAvailable()) {
      // Advisory step: surface the skip with a reason rather than silently omitting it (D10).
      return { step, status: "skipped", detail: "git not found on PATH", artefacts: [] };
    }

    const files = this.filesFor(step);
    const artefacts = files.map((f) => this.writeArtefact(f.relPath, f.content, manifest));
    const changed = artefacts.filter((a) => a.outcome === "created" || a.outcome === "overwritten");
    const userModified = artefacts.filter((a) => a.outcome === "skipped-user-modified");

    if (changed.length > 0) {
      return { step, status: "done", detail: summarise(artefacts), artefacts };
    }
    return {
      step,
      status: "skipped",
      detail: userModified.length > 0 ? `${userModified.length} user-modified, left untouched` : "all up to date",
      artefacts,
    };
  }

  /** Decide create / overwrite / skip for one artefact against the manifest, then act. */
  private writeArtefact(relPath: string, content: string, manifest: ScaffoldManifest): ScaffoldArtefact {
    const abs = resolve(this.root, relPath);
    const desired = checksum(content);
    const recorded = manifest.artefacts[relPath]?.scaffoldChecksum;
    const isStale = manifest.stale.includes(relPath);

    if (!existsSync(abs)) {
      this.put(abs, content);
      manifest.artefacts[relPath] = { scaffoldChecksum: desired, createdAt: new Date(this.clock()).toISOString() };
      this.clearStale(manifest, relPath);
      return { path: relPath, outcome: "created" };
    }

    const current = checksum(readFileSync(abs, "utf8"));
    if (isStale) {
      this.put(abs, content);
      manifest.artefacts[relPath] = { scaffoldChecksum: desired, createdAt: new Date(this.clock()).toISOString() };
      this.clearStale(manifest, relPath);
      return { path: relPath, outcome: "overwritten" };
    }
    if (current === recorded || current === desired) {
      // Already exactly what a scaffold produces — record it so future runs stay clean, then skip.
      manifest.artefacts[relPath] ??= { scaffoldChecksum: desired, createdAt: new Date(this.clock()).toISOString() };
      return { path: relPath, outcome: "skipped-uptodate" };
    }
    // Checksum diverges from the recorded scaffold-time checksum → user-customised; never touch it.
    return { path: relPath, outcome: "skipped-user-modified" };
  }

  private put(abs: string, content: string): void {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  private clearStale(manifest: ScaffoldManifest, relPath: string): void {
    const i = manifest.stale.indexOf(relPath);
    if (i >= 0) manifest.stale.splice(i, 1);
  }

  // ---- manifest (atomic) ---------------------------------------------------

  readManifest(): ScaffoldManifest {
    const abs = resolve(this.root, MANIFEST_REL);
    if (existsSync(abs)) {
      try {
        const parsed = JSON.parse(readFileSync(abs, "utf8")) as Partial<ScaffoldManifest>;
        return {
          version: 1,
          lastCompletedStep: parsed.lastCompletedStep,
          artefacts: parsed.artefacts ?? {},
          stale: parsed.stale ?? [],
        };
      } catch {
        // A corrupt manifest is treated as absent; the idempotency check then falls back to
        // user-modified for any existing artefact, which is the safe (non-destructive) default.
      }
    }
    return { version: 1, artefacts: {}, stale: [] };
  }

  private writeManifest(manifest: ScaffoldManifest): void {
    const abs = resolve(this.root, MANIFEST_REL);
    const tmp = `${abs}.tmp`;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
    try {
      renameSync(tmp, abs); // atomic replace on the same filesystem
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
  }

  // ---- emit ----------------------------------------------------------------

  private emitStep(
    step: ScaffoldStep,
    status: "running" | "done" | "skipped" | "error",
    detail?: string,
  ): Promise<void> {
    return this.emit({
      seq: 0,
      ts: 0,
      harness: this.harness,
      type: "scaffold.step",
      step,
      status,
      ...(detail ? { detail } : {}),
    });
  }

  // ---- artefact content ----------------------------------------------------

  private filesFor(step: ScaffoldStep): Array<{ relPath: string; content: string }> {
    switch (step) {
      case "config":
        return [{ relPath: ".arke/config.json", content: configFile() }];
      case "agents":
        // Each role ships BOTH its Omnigent source image (`agents/<name>/config.yaml`, the coordinator's
        // AgentRegistry reads this) and the materialised OpenCode agent (`.opencode/agents/<name>.md`,
        // what the harness reads) — self-describing (declares its own model), no logical-tier indirection.
        return ROSTER.flatMap((r) => [
          { relPath: `agents/${r.name}/config.yaml`, content: agentConfigYaml(r) },
          { relPath: `.opencode/agents/${r.name}.md`, content: agentFile(r) },
        ]);
      case "specs":
        return [
          { relPath: "docs/specifications/specification.template.md", content: SPEC_TEMPLATE },
          { relPath: "docs/specifications/README.md", content: SPECS_README },
        ];
      case "grounding":
        return [{ relPath: "AGENTS.md", content: AGENTS_STUB }];
      case "plugins":
        // These are ARKE-coordinator policy/projection stubs, not OpenCode plugins — they must NOT
        // live under `.opencode/plugins/`, where OpenCode loads (and chokes on) them: a non-plugin
        // module there crashes OpenCode's provider pipeline for the whole project (Provider.list →
        // 500 on every message) whenever the project is a harness's primary directory.
        return [
          { relPath: ".arke/plugins/policy.ts", content: POLICY_STUB },
          { relPath: ".arke/plugins/projection.ts", content: PROJECTION_STUB },
        ];
      case "repos":
        return [{ relPath: ".repos/README.md", content: REPOS_README }];
    }
  }
}

// ---- helpers ---------------------------------------------------------------

function checksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function summarise(artefacts: ScaffoldArtefact[]): string {
  const counts = artefacts.reduce<Record<string, number>>((acc, a) => {
    acc[a.outcome] = (acc[a.outcome] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

function defaultGitProbe(): boolean {
  try {
    const res = spawnSync("git", ["--version"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

// ---- canonical scaffold templates ------------------------------------------

interface RosterRole {
  name: string;
  role: string;
  /** The concrete `provider/model` the agent declares. Greenfield uses a `gateway/…` placeholder. */
  model: string;
  /** Optional reasoning effort for a reasoning-capable model (e.g. gpt-5.5 → "xhigh"). */
  reasoningEffort?: string;
  mode: "primary" | "subagent" | "all";
  writes: string;
  description: string;
  /** Per-capability permission posture written to the agent image (SPEC-007 read-only reviewers). */
  permission?: Record<string, "allow" | "deny" | "ask">;
}

/**
 * The six canonical roles. Each DECLARES its own model (SPEC-016 revised). Greenfield uses distinct
 * `gateway/…` placeholders — never a real vendor id — the engineer edits host-side; the reviewers'
 * placeholders are distinct so the panel-independence check (SPEC-007) is satisfiable out of the box.
 */
const ROSTER: RosterRole[] = [
  { name: "spec-author", role: "Specification Author", model: "gateway/spec-author", mode: "primary", writes: "Requirements", description: "Co-authors the requirements section of a specification with the engineer." },
  { name: "architect", role: "Technical Architect", model: "gateway/architect", mode: "primary", writes: "Design", description: "Designs the target architecture, data model, and contracts for a specification." },
  // Reviewers are READ-ONLY (SPEC-007): they critique into the panel only and never write/commit.
  { name: "reviewer-a", role: "Reviewer (panel A)", model: "gateway/reviewer-a", mode: "subagent", writes: "Critique", description: "Independent review-panel member; critiques a specification or generated change.", permission: { edit: "deny", bash: "deny" } },
  { name: "reviewer-b", role: "Reviewer (panel B)", model: "gateway/reviewer-b", mode: "subagent", writes: "Critique", description: "Second independent review-panel member; surfaces divergent findings.", permission: { edit: "deny", bash: "deny" } },
  { name: "implementer", role: "Implementer", model: "gateway/implementer", mode: "subagent", writes: "Code", description: "Implements an approved task: edits source, runs checks, opens a pull request (gated)." },
  { name: "researcher", role: "Researcher", model: "gateway/researcher", mode: "subagent", writes: "Grounding", description: "Analyses the repository to produce or refresh the AGENTS.md grounding baseline." },
];

/** The Omnigent source image (`agents/<name>/config.yaml`) — the agent DECLARES its harness + model. */
function agentConfigYaml(r: RosterRole): string {
  const options = r.reasoningEffort ? `    options:\n      reasoningEffort: ${r.reasoningEffort}\n` : "";
  const permission = r.permission
    ? `permission:\n${Object.entries(r.permission).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`
    : "";
  return `spec_version: 1
name: ${r.name}
description: "${r.description}"
executor:
  type: omnigent
  config:
    harness: opencode-native
    model: ${r.model}
${options}    auth:
      profile: opencode-local
instructions: AGENTS.md
interaction:
  conversational: true
  mode: ${r.mode}
${permission}`;
}

function agentFile(r: RosterRole): string {
  // OpenCode-native agent markdown (materialised): YAML frontmatter (description, mode, model,
  // options, permission) + body. The agent is self-describing — it declares its own model. A
  // `gateway/…` placeholder is the "use the harness default" sentinel, so it is OMITTED from the
  // OpenCode frontmatter (writing it would make OpenCode resolve a literal, non-existent model);
  // the engineer edits the source image with a real provider-qualified model.
  const isConcrete = r.model.includes("/") && !r.model.startsWith("gateway/");
  const modelLine = isConcrete ? `model: ${r.model}\n` : "";
  const options = r.reasoningEffort ? `options:\n  reasoningEffort: ${r.reasoningEffort}\n` : "";
  const permission = r.permission
    ? `permission:\n${Object.entries(r.permission).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`
    : "";
  return `---
name: ${r.name}
description: ${r.description}
mode: ${r.mode}
${modelLine}${options}${permission}---

# ${r.role}

You are the **${r.role}** in an Arke specification workflow. You write the **${r.writes}** of the work.

This agent declares its own model (\`${r.model}\`) and provider in its image
(\`agents/${r.name}/config.yaml\`, executor.config). Edit that image — not a central registry — to
change the model; the credential is resolved host-side via the referenced provider profile.
`;
}

/**
 * The project's `.arke/config.json` (SPEC-016 revised) created during init: host-side provider/auth
 * PROFILES — the harness endpoint + a `credentialsRef` resolved on the host, never sent to the
 * client. Agents declare their own model+provider in their image and reference a profile by name
 * (`executor.config.auth.profile`). Process-wide coordinator settings come from the global source.
 */
function configFile(): string {
  const config = {
    $comment:
      "Arke project config (SPEC-016 revised), created by `arke` scaffolding. `providers` are " +
      "host-side provider/auth profiles: the harness endpoint + a credentialsRef resolved on the " +
      "host (never sent to the client). Agents declare their own model+provider in " +
      "agents/<name>/config.yaml and reference a profile by executor.config.auth.profile. Replace the " +
      "gateway placeholder models in the agent images with real vendor ids. Process-wide coordinator " +
      "settings (port, maxProjects, OTLP) come from the global/launch source, not this file.",
    providers: {
      "opencode-local": {
        harness: "opencode",
        host: "localhost",
        port: 4096,
        cwd: ".",
        credentialsRef: "opencode/gateway",
      },
    },
    settings: { permissionTimeoutMs: 120000 },
  };
  return JSON.stringify(config, null, 2) + "\n";
}

const SPEC_TEMPLATE = `---
spec_id: SPEC-YYYY-MM-DD-short-slug
title: <one line>
status: draft
branch: feat/<short-slug>
owner: <handle>
capabilities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# <Title>

## Why
<The problem and the motivation. What forces this change?>

## What changes
- ADDED <capability> — <behaviour> (FR-xx)
- MODIFIED <capability> — <behaviour> (breaking: no)

---

## Requirements

### Requirement: <name>
\`capability: <cap>\` · \`delta: ADDED (<branch>)\`

The system SHALL <observable behaviour>.

#### Scenario: <name>
- **WHEN** <condition>
- **THEN** <expected outcome>
- **AND** <additional expectation>

---

## Design

### Architectural decision
<The key decision and its rationale.>

### Target architecture
<Diagram or prose of the components and how they interact.>

---

## Tasks
- [ ] <task>

### Testing
- Unit: <…>
- Integration: <…>

### Definition of done
All scenarios pass; typecheck and build are green; a reviewer has signed off.
`;

const SPECS_README = `# Specifications

This directory is the source of truth for the work. Each specification is a markdown file
authored with the agent roster, reviewed through a pull request, and projected onto the board.

- \`specification.template.md\` — the canonical anatomy (Why / Requirements / Design / Tasks).
- One file per specification, named for its slug.

The specification — not the code, not the ticket — is the unit of work.
`;

const AGENTS_STUB = `# AGENTS.md

> Grounding baseline. This stub is created by \`arke\` scaffolding and is enriched in full by the
> researcher grounding session after the repository is analysed. Do not hand-merge — a refresh
> rewrites this file and git history preserves the previous version.

## Project
<Awaiting grounding analysis: module structure, key entry points, and conventions.>

## Conventions
<Awaiting grounding analysis.>
`;

const POLICY_STUB = `/**
 * Permission policy stub (Arke scaffolding).
 *
 * Classifies a requested action into a risk tier so the coordinator can decide whether it runs
 * in-band, requires confirmation, or is marshalled into a durable proposal. Replace the body with
 * your project's real policy; the shape is what the coordinator expects.
 */
export type ActionTier = "low" | "medium" | "high";

export function classify(action: { name: string }): ActionTier {
  // Default-closed: anything not explicitly classified is treated as high-risk.
  return "high";
}
`;

const PROJECTION_STUB = `/**
 * Projection stub (Arke scaffolding).
 *
 * Deterministically projects a specification/status change onto an external system of record
 * (issue tracker, docs, …). Every projection is logged as a governed action. Replace the body
 * with your project's real projection; keep it deterministic and side-effect-logged.
 */
export interface ProjectionInput {
  specId: string;
  trigger: string;
}

export async function project(_input: ProjectionInput): Promise<void> {
  // no-op stub
}
`;

const REPOS_README = `# .repos — vendored reference material

Read-only grounding material vendored by Arke scaffolding. Treat everything here as reference,
not as part of the project's own source. Safe to delete and re-vendor.
`;
