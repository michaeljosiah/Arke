import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { DomainEvent } from "@arke/contracts";
import { ProjectContext } from "../src/project-context.js";
import { CrossRepoLinker } from "../src/cross-repo-linker.js";
import { MockAdapter } from "../src/mock-adapter.js";
import { Trace } from "../src/trace.js";
import { GrantStore } from "../src/grant-store.js";
import { ProjectRegistry } from "../src/project-registry.js";

/**
 * SPEC-030 cross-repo, end to end across TWO+ project contexts sharing one supervisor {@link CrossRepoLinker}.
 * Proves the first cross-context interaction in Arke: a canonical spec in one repo projects pointer stubs
 * into a peer's own context, and a material canonical change marks the peer's ripple stale — each write
 * executed by the TARGET context on its own files/trace (SPEC-018 isolation), acknowledged there.
 */

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

/** A temp git repo with an `origin` remote resolving to `slug`, seeded with the given spec files. */
function repo(slug: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-xrepo-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "remote", "add", "origin", `https://github.com/${slug}`);
  mkdirSync(resolve(dir, "docs", "specifications"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(resolve(dir, "docs", "specifications", name), body, "utf8");
  return dir;
}

function ctx(dir: string, projectId: string, linker: CrossRepoLinker, events?: DomainEvent[]): ProjectContext {
  return new ProjectContext({
    projectId,
    root: dir,
    adapter: new MockAdapter(),
    trace: new Trace(join(dir, ".arke", "trace.ndjson")),
    grants: new GrantStore(join(dir, ".arke", "grants.ndjson")),
    endpoints: [],
    registry: new ProjectRegistry({ persist: false }),
    publish: (e) => events?.push(e),
    linker,
  });
}

const canonicalSpec = (status = "draft") => `---
spec_id: SPEC-100
title: Retry contract
status: ${status}
branch: feat/x
owner: alice
ripples:
  - repo: acme/widgets
    spec: SPEC-200
    kind: delta
  - repo: acme/gizmos
    spec: generated
    kind: pointer
  - repo: acme/nowhere
    spec: generated
    kind: pointer
---

# Retry contract

## Requirements

### Requirement: A thing
The system SHALL do a thing.

#### Scenario: it works
- **WHEN** asked
- **THEN** it does
`;

const rippleSpec = `---
spec_id: SPEC-200
title: Widget retry side
status: draft
branch: feat/y
owner: bob
canonical:
  repo: acme/contracts
  spec: SPEC-100
---

# Widget retry side
`;

/** Build the three-context world (canonical A + widgets B + gizmos C) sharing one linker. */
function world() {
  const bEvents: DomainEvent[] = [];
  const holder: { list: ProjectContext[] } = { list: [] };
  const linker = new CrossRepoLinker(() => holder.list);
  const aDir = repo("acme/contracts", { "100.retry.md": canonicalSpec() });
  const bDir = repo("acme/widgets", { "200.widget.md": rippleSpec });
  const cDir = repo("acme/gizmos", {});
  const A = ctx(aDir, "A", linker);
  const B = ctx(bDir, "B", linker, bEvents);
  const C = ctx(cDir, "C", linker);
  holder.list = [A, B, C];
  after(() => { void A.stop(); void B.stop(); void C.stop(); });
  return { A, B, C, aDir, bDir, cDir, bEvents };
}

test("the linker resolves a ripple's org/repo slug to the peer context via its git remote", async () => {
  const { A } = world();
  const links = (await A.dispatch("spec.links", { specId: "SPEC-100" })) as any;
  const byRepo = Object.fromEntries((links.ripples as any[]).map((r) => [r.repo, r]));
  assert.equal(byRepo["acme/widgets"].status, "resolved"); // B is registered
  assert.equal(byRepo["acme/widgets"].projectId, "B");
  assert.equal(byRepo["acme/gizmos"].status, "resolved"); // C is registered
  assert.equal(byRepo["acme/nowhere"].status, "unresolved"); // no such project → inert
});

test("spec.ripple.project writes a pointer stub into the target's OWN context, idempotent; delta skipped; unresolved inert", async () => {
  const { A, cDir } = world();
  const res = (await A.dispatch("spec.ripple.project", { specId: "SPEC-100" })) as any;
  const byRepo = Object.fromEntries((res.results as any[]).map((r) => [r.repo, r]));
  assert.equal(byRepo["acme/widgets"].status, "skipped-authored"); // a delta ripple is authored, not generated
  assert.equal(byRepo["acme/gizmos"].status, "written");
  assert.equal(byRepo["acme/nowhere"].status, "unresolved"); // no target → inert, not an error

  const stub = resolve(cDir, "docs", "specifications", "ripple-SPEC-100.md");
  assert.ok(existsSync(stub), "the pointer stub landed in the gizmos repo");
  const text = readFileSync(stub, "utf8");
  assert.match(text, /GENERATED POINTER — do not hand-edit/);
  assert.match(text, /canonical:\n\s+repo: acme\/contracts\n\s+spec: SPEC-100/);
  assert.ok(!/The system SHALL do a thing/.test(text), "a stub is a pointer, not a copy of the requirements");

  // Idempotent: re-running rewrites nothing.
  const again = (await A.dispatch("spec.ripple.project", { specId: "SPEC-100" })) as any;
  assert.equal(again.results.find((r: any) => r.repo === "acme/gizmos").changed, false);
});

test("a material canonical change cascades staleness to the peer's delta ripple; ack clears it (both traced in the peer)", async () => {
  // Canonical starts `approved`; a reopen (approved → in-review) is a material lifecycle change.
  const bEvents: DomainEvent[] = [];
  const holder: { list: ProjectContext[] } = { list: [] };
  const linker = new CrossRepoLinker(() => holder.list);
  const A = ctx(repo("acme/contracts", { "100.retry.md": canonicalSpec("approved") }), "A", linker);
  const bDir = repo("acme/widgets", { "200.widget.md": rippleSpec });
  const B = ctx(bDir, "B", linker, bEvents);
  holder.list = [A, B];
  after(() => { void A.stop(); void B.stop(); });

  await A.dispatch("spec.transition", { specId: "SPEC-100", to: "in-review", actor: "carol" });

  // B's delta ripple is now stale, surfaced in B (not A) with the canonical trigger.
  const staleEv = bEvents.find((e) => e.type === "spec.ripple-stale") as any;
  assert.ok(staleEv, "B emitted spec.ripple-stale");
  assert.equal(staleEv.specId, "SPEC-200");
  assert.equal(staleEv.canonicalSpec, "SPEC-100");
  assert.equal(staleEv.kind, "delta");
  const links = (await B.dispatch("spec.links", { specId: "SPEC-200" })) as any;
  assert.equal(links.stale, true);

  // Acknowledging in B clears it and emits spec.ripple-acked; the canonical (A) never wrote B's files.
  const ack = (await B.dispatch("spec.ripple.ack", { specId: "SPEC-200", reason: "no local impact", actor: "bob" })) as any;
  assert.equal(ack.ok, true);
  assert.ok(bEvents.some((e) => e.type === "spec.ripple-acked" && (e as any).specId === "SPEC-200"));
  assert.equal(((await B.dispatch("spec.links", { specId: "SPEC-200" })) as any).stale, false);
});

test("spec.ripple.ack refuses a spec that is not a currently-stale ripple", async () => {
  const { B } = world();
  await assert.rejects(() => Promise.resolve(B.dispatch("spec.ripple.ack", { specId: "SPEC-200", reason: "x" })), /not a currently-stale ripple/);
});
