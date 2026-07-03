import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { DomainEvent } from "@arke/contracts";
import { ScaffoldRunner } from "../src/scaffold.js";

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
  const result = await runner.run();

  assert.equal(result.ok, true);
  // six canonical role files
  for (const name of ["spec-author", "architect", "reviewer-a", "reviewer-b", "implementer", "researcher"]) {
    assert.ok(existsSync(resolve(root, `.opencode/agents/${name}.md`)), `${name}.md should exist`);
  }
  assert.ok(existsSync(resolve(root, "docs/specifications/specification.template.md")));
  assert.ok(existsSync(resolve(root, "docs/specifications/README.md")));
  assert.ok(existsSync(resolve(root, "AGENTS.md")));
  assert.ok(existsSync(resolve(root, ".arke/plugins/projection.ts")));
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

test("roster ships both the Omnigent source image and the materialised agent, each declaring its model", async () => {
  const root = fresh();
  const { runner } = harness(root);
  await runner.run();
  // The Omnigent source (agents/<name>/config.yaml) declares harness + model + provider.
  const src = readFileSync(resolve(root, "agents/spec-author/config.yaml"), "utf8");
  assert.match(src, /harness: opencode-native/);
  assert.match(src, /model: gateway\/spec-author/);
  assert.match(src, /profile: opencode-local/);
  // The materialised agent (.opencode/agents/<name>.md) OMITS a `gateway/…` placeholder model — that
  // is the "use the harness default" sentinel; writing it would make OpenCode resolve a literal,
  // non-existent model. (A concrete provider-qualified model IS written through — see the adapter.)
  const author = readFileSync(resolve(root, ".opencode/agents/spec-author.md"), "utf8");
  assert.doesNotMatch(author, /^model:/m); // no placeholder model line
  assert.doesNotMatch(author, /^tier:/m); // the logical-tier indirection is gone
  // Reviewers declare DISTINCT placeholder models so panel independence (SPEC-007) holds out of the box.
  const rA = readFileSync(resolve(root, "agents/reviewer-a/config.yaml"), "utf8");
  const rB = readFileSync(resolve(root, "agents/reviewer-b/config.yaml"), "utf8");
  assert.match(rA, /model: gateway\/reviewer-a/);
  assert.match(rB, /model: gateway\/reviewer-b/);
});

test("re-running is idempotent — unchanged artefacts are skipped", async () => {
  const root = fresh();
  const first = harness(root);
  await first.runner.run();
  const second = harness(root);
  const result = await second.runner.run();
  // every non-repos step should report skipped (all up to date)
  for (const step of ["agents", "specs", "grounding", "plugins"]) {
    const terminal = stepEvents(second.events).find((e) => e.step === step && e.status !== "running");
    assert.equal(terminal?.status, "skipped", `${step} should be skipped on re-run`);
  }
  assert.equal(result.ok, true);
});

test("a user-modified artefact is left untouched and reported skipped (user-modified)", async () => {
  const root = fresh();
  await harness(root).runner.run();
  // simulate a user editing AGENTS.md after the scaffold
  const agentsMd = resolve(root, "AGENTS.md");
  writeFileSync(agentsMd, "# my own AGENTS\nhand-written", "utf8");
  const { runner, events } = harness(root);
  await runner.run();
  // content preserved
  assert.equal(readFileSync(agentsMd, "utf8"), "# my own AGENTS\nhand-written");
  const grounding = stepEvents(events).find((e) => e.step === "grounding" && e.status !== "running");
  assert.equal(grounding?.status, "skipped");
  assert.match(grounding?.detail ?? "", /user-modified/);
});

test("a stale-marked artefact is overwritten on re-run", async () => {
  const root = fresh();
  await harness(root).runner.run();
  const agentsMd = resolve(root, "AGENTS.md");
  writeFileSync(agentsMd, "# diverged", "utf8");
  // mark it stale in the manifest
  const manifestPath = resolve(root, ".arke/scaffold-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.stale = ["AGENTS.md"];
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const { runner } = harness(root);
  await runner.run();
  assert.match(readFileSync(agentsMd, "utf8"), /Grounding baseline/); // back to scaffold content
});

test("resumeFrom skips earlier steps", async () => {
  const root = fresh();
  const { runner, events } = harness(root);
  await runner.run({ resumeFrom: "specs" });
  const steps = stepEvents(events).map((e) => e.step);
  assert.ok(!steps.includes("agents"), "agents should be skipped entirely when resuming from specs");
  assert.ok(steps.includes("specs"));
  // agents artefacts were never created
  assert.ok(!existsSync(resolve(root, ".opencode/agents/spec-author.md")));
});

test("the repos step is skipped with a reason when git is unavailable", async () => {
  const root = fresh();
  const { runner, events } = harness(root, () => false);
  await runner.run();
  const repos = stepEvents(events).find((e) => e.step === "repos" && e.status !== "running");
  assert.equal(repos?.status, "skipped");
  assert.equal(repos?.detail, "git not found on PATH");
  assert.ok(!existsSync(resolve(root, ".repos/README.md")));
});

test("a greenfield scaffold is NOT blocked — it writes a provider/auth profile config", async () => {
  const root = fresh();
  const { runner } = harness(root);
  // True greenfield: scaffolding proceeds and creates .arke/config.json with a host-side provider/auth
  // profile (SPEC-016 revised). Agents declare their own models in their images (edited host-side).
  const result = await runner.run();
  assert.equal(result.ok, true);
  const cfgPath = resolve(root, ".arke/config.json");
  assert.ok(existsSync(cfgPath), ".arke/config.json should be created by the config step");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  // A provider/auth profile the adapter talks to — the endpoint + a host-side credentialsRef.
  const profile = cfg.providers["opencode-local"];
  assert.ok(profile, "config carries an opencode-local provider profile");
  assert.equal(profile.harness, "opencode");
  assert.equal(profile.credentialsRef, "opencode/gateway");
  // The tier registry (instances/roster/serves) is gone — agents own their model now.
  assert.equal(cfg.registry, undefined);
});

test("the config step is idempotent — an existing user config is left untouched", async () => {
  const root = fresh();
  // a pre-existing, user-authored config must not be clobbered by scaffolding
  const cfgPath = resolve(root, ".arke/config.json");
  mkdirSync(resolve(root, ".arke"), { recursive: true });
  writeFileSync(cfgPath, '{"mine":true}', "utf8");
  const { runner, events } = harness(root);
  await runner.run();
  assert.equal(readFileSync(cfgPath, "utf8"), '{"mine":true}'); // untouched
  const cfgStep = stepEvents(events).find((e) => e.step === "config" && e.status !== "running");
  assert.equal(cfgStep?.status, "skipped");
  assert.match(cfgStep?.detail ?? "", /user-modified/);
});

test("a failing step stops execution and records resume state", async () => {
  const root = fresh();
  // Pre-create a *directory* named AGENTS.md so the grounding write throws (EISDIR/EPERM).
  mkdirSync(resolve(root, "AGENTS.md"), { recursive: true });
  const { runner, events } = harness(root);
  const result = await runner.run();

  assert.equal(result.ok, false);
  const grounding = stepEvents(events).find((e) => e.step === "grounding" && e.status === "error");
  assert.ok(grounding, "grounding should report an error");
  // steps after the failure were not attempted
  assert.ok(!stepEvents(events).some((e) => e.step === "plugins"));
  // manifest recorded progress up to the last success (specs)
  const manifest = JSON.parse(readFileSync(resolve(root, ".arke/scaffold-manifest.json"), "utf8"));
  assert.equal(manifest.lastCompletedStep, "specs");
});
