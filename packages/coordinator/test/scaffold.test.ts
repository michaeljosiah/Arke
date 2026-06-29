import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { DomainEvent } from "@arke/contracts";
import { ScaffoldRunner } from "../src/scaffold.js";

const TIERS = { capable: "capable-tier", mid: "mid-tier" };

function harness(root: string, gitProbe = () => true) {
  const events: DomainEvent[] = [];
  const runner = new ScaffoldRunner({
    root,
    harness: "Test",
    emit: async (e) => {
      events.push(e);
    },
    gitProbe,
  });
  return { runner, events };
}

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "arke-scaffold-"));
}

const stepEvents = (events: DomainEvent[]) =>
  events.filter((e): e is Extract<DomainEvent, { type: "scaffold.step" }> => e.type === "scaffold.step");

test("a full scaffold creates the canonical artefacts and writes the manifest", async () => {
  const root = fresh();
  const { runner, events } = harness(root);
  const result = await runner.run({ tiers: TIERS });

  assert.equal(result.ok, true);
  // six canonical role files
  for (const name of ["spec-author", "architect", "reviewer-a", "reviewer-b", "implementer", "researcher"]) {
    assert.ok(existsSync(resolve(root, `.opencode/agents/${name}.md`)), `${name}.md should exist`);
  }
  assert.ok(existsSync(resolve(root, "docs/specifications/specification.template.md")));
  assert.ok(existsSync(resolve(root, "docs/specifications/README.md")));
  assert.ok(existsSync(resolve(root, "AGENTS.md")));
  assert.ok(existsSync(resolve(root, ".opencode/plugins/projection.ts")));
  // manifest records scaffold-time checksums
  const manifest = JSON.parse(readFileSync(resolve(root, ".arke/scaffold-manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.ok(manifest.artefacts["AGENTS.md"].scaffoldChecksum);
  assert.ok(manifest.artefacts["AGENTS.md"].createdAt);
  // a terminal scaffold.done event was emitted with the canonicalised root
  const done = events.find((e) => e.type === "scaffold.done");
  assert.ok(done);
  assert.equal((done as { projectPath: string }).projectPath, resolve(root));
});

test("roster files carry a logical tier, never a vendor model id", async () => {
  const root = fresh();
  const { runner } = harness(root);
  await runner.run({ tiers: TIERS });
  const author = readFileSync(resolve(root, ".opencode/agents/spec-author.md"), "utf8");
  assert.match(author, /tier: capable/);
  assert.doesNotMatch(author, /capable-tier|mid-tier/); // the resolved model name must not leak in
});

test("re-running is idempotent — unchanged artefacts are skipped", async () => {
  const root = fresh();
  const first = harness(root);
  await first.runner.run({ tiers: TIERS });
  const second = harness(root);
  const result = await second.runner.run({ tiers: TIERS });
  // every non-repos step should report skipped (all up to date)
  for (const step of ["agents", "specs", "grounding", "plugins"]) {
    const terminal = stepEvents(second.events).find((e) => e.step === step && e.status !== "running");
    assert.equal(terminal?.status, "skipped", `${step} should be skipped on re-run`);
  }
  assert.equal(result.ok, true);
});

test("a user-modified artefact is left untouched and reported skipped (user-modified)", async () => {
  const root = fresh();
  await harness(root).runner.run({ tiers: TIERS });
  // simulate a user editing AGENTS.md after the scaffold
  const agentsMd = resolve(root, "AGENTS.md");
  writeFileSync(agentsMd, "# my own AGENTS\nhand-written", "utf8");
  const { runner, events } = harness(root);
  await runner.run({ tiers: TIERS });
  // content preserved
  assert.equal(readFileSync(agentsMd, "utf8"), "# my own AGENTS\nhand-written");
  const grounding = stepEvents(events).find((e) => e.step === "grounding" && e.status !== "running");
  assert.equal(grounding?.status, "skipped");
  assert.match(grounding?.detail ?? "", /user-modified/);
});

test("a stale-marked artefact is overwritten on re-run", async () => {
  const root = fresh();
  await harness(root).runner.run({ tiers: TIERS });
  const agentsMd = resolve(root, "AGENTS.md");
  writeFileSync(agentsMd, "# diverged", "utf8");
  // mark it stale in the manifest
  const manifestPath = resolve(root, ".arke/scaffold-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.stale = ["AGENTS.md"];
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const { runner } = harness(root);
  await runner.run({ tiers: TIERS });
  assert.match(readFileSync(agentsMd, "utf8"), /Grounding baseline/); // back to scaffold content
});

test("resumeFrom skips earlier steps", async () => {
  const root = fresh();
  const { runner, events } = harness(root);
  await runner.run({ tiers: TIERS, resumeFrom: "specs" });
  const steps = stepEvents(events).map((e) => e.step);
  assert.ok(!steps.includes("agents"), "agents should be skipped entirely when resuming from specs");
  assert.ok(steps.includes("specs"));
  // agents artefacts were never created
  assert.ok(!existsSync(resolve(root, ".opencode/agents/spec-author.md")));
});

test("the repos step is skipped with a reason when git is unavailable", async () => {
  const root = fresh();
  const { runner, events } = harness(root, () => false);
  await runner.run({ tiers: TIERS });
  const repos = stepEvents(events).find((e) => e.step === "repos" && e.status !== "running");
  assert.equal(repos?.status, "skipped");
  assert.equal(repos?.detail, "git not found on PATH");
  assert.ok(!existsSync(resolve(root, ".repos/README.md")));
});

test("scaffolding is blocked when tier defaults are absent", async () => {
  const root = fresh();
  const { runner } = harness(root);
  await assert.rejects(() => runner.run({ tiers: { capable: "capable-tier" } }), /tier defaults not configured/);
});

test("a failing step stops execution and records resume state", async () => {
  const root = fresh();
  // Pre-create a *directory* named AGENTS.md so the grounding write throws (EISDIR/EPERM).
  mkdirSync(resolve(root, "AGENTS.md"), { recursive: true });
  const { runner, events } = harness(root);
  const result = await runner.run({ tiers: TIERS });

  assert.equal(result.ok, false);
  const grounding = stepEvents(events).find((e) => e.step === "grounding" && e.status === "error");
  assert.ok(grounding, "grounding should report an error");
  // steps after the failure were not attempted
  assert.ok(!stepEvents(events).some((e) => e.step === "plugins"));
  // manifest recorded progress up to the last success (specs)
  const manifest = JSON.parse(readFileSync(resolve(root, ".arke/scaffold-manifest.json"), "utf8"));
  assert.equal(manifest.lastCompletedStep, "specs");
});
