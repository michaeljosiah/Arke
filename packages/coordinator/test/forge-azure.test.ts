import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AzureReposForge, parseAzReposPrList, makeForge, resolveAzureCoordinates } from "../src/forge/index.js";

/** SPEC-038 Increment 2: the AzureReposForge leaf — Service-Hook mapping, Basic-auth verify, az PR parsing. */

const FIXTURES = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/azure-service-hooks.json", import.meta.url)), "utf8"),
) as Record<string, { eventType: string; resource: unknown } & Record<string, unknown>>;

const forge = new AzureReposForge();
/** Map a fixture the way the ingress will: Azure's event type lives in the payload, so pass "" as eventName. */
const map = (key: string) => forge.mapWebhookEvent("", FIXTURES[key]);

// ---- Service-Hook event mapping (real payload fixtures) ----
test("git.pullrequest.created → opened, branch stripped of refs/heads/", () => {
  assert.deepEqual(map("created"), { kind: "opened", branch: "feat/spec-038", prNumber: 42 });
});

test("git.pullrequest.updated status completed → merged (advances to delivered like a GitHub merge)", () => {
  assert.deepEqual(map("completed"), { kind: "merged", branch: "feat/spec-038", prNumber: 42 });
});

test("git.pullrequest.updated status abandoned → closed-unmerged", () => {
  assert.deepEqual(map("abandoned"), { kind: "closed-unmerged", branch: "feat/spec-038", prNumber: 42 });
});

test("a human reviewer vote===10 → approved, approver = that person's uniqueName", () => {
  assert.deepEqual(map("approvedByHuman"), {
    kind: "approved",
    branch: "feat/spec-038",
    prNumber: 42,
    approver: "christie@fabrikam.com",
  });
});

test("a container/team reviewer vote does NOT misattribute the approver", () => {
  const t = map("approvedByContainerOnly");
  assert.notEqual(t.kind, "approved", "a container vote must not set an approver");
  // With no human approval, an active update is a reopen candidate (coordinator gates on prior-closed).
  assert.equal(t.kind, "reopened");
});

test("an active update with no approval → reopened candidate (coordinator applies only vs prior-closed)", () => {
  assert.deepEqual(map("reactivated"), { kind: "reopened", branch: "feat/spec-038", prNumber: 42 });
});

test("a forced push maps to force-push; a plain push is ignored (Azure carries no force flag)", () => {
  assert.deepEqual(map("pushForced"), { kind: "force-push", branch: "feat/spec-038" });
  const plain = map("pushPlain");
  assert.equal(plain.kind, "ignored");
});

test("an unrecognised event → ignored with a reason", () => {
  const t = map("unknown");
  assert.equal(t.kind, "ignored");
  assert.match((t as { reason: string }).reason, /git\.pullrequest\.commented/);
});

test("mapping is idempotent — the same completed update re-mapped yields the identical transition", () => {
  assert.deepEqual(map("completed"), map("completed"));
});

test("mapWebhookEvent falls back to the eventName arg when the payload has no eventType", () => {
  const t = forge.mapWebhookEvent("git.pullrequest.created", { resource: { pullRequestId: 9, sourceRefName: "refs/heads/x" } });
  assert.deepEqual(t, { kind: "opened", branch: "x", prNumber: 9 });
});

// ---- verifyWebhook: HTTP Basic auth (NOT an HMAC), fail-closed ----
test("verifyWebhook accepts the configured Basic-auth credential and rejects a wrong/missing one", () => {
  const cred = "arke:s3cr3t";
  const b64 = Buffer.from(cred, "utf8").toString("base64");
  assert.equal(forge.verifyWebhook({ authorization: `Basic ${b64}` }, "{}", cred), true);
  const wrong = Buffer.from("arke:nope", "utf8").toString("base64");
  assert.equal(forge.verifyWebhook({ authorization: `Basic ${wrong}` }, "{}", cred), false);
  assert.equal(forge.verifyWebhook({}, "{}", cred), false, "no Authorization header → fail-closed");
  assert.equal(forge.verifyWebhook({ authorization: `Basic ${b64}` }, "{}", ""), false, "no configured secret → fail-closed");
});

test("verifyWebhook does NOT accept a GitHub HMAC header (it is not HMAC-checked)", () => {
  const cred = "arke:s3cr3t";
  // A GitHub-style signature header must not authenticate an Azure webhook.
  assert.equal(forge.verifyWebhook({ "x-hub-signature-256": "sha256=deadbeef" }, "{}", cred), false);
});

// ---- az repos pr JSON parsing (the gh stderr sniff does not transfer) ----
test("parseAzReposPrList parses an open PR, a draft, and the empty (no-PR) case", () => {
  assert.deepEqual(parseAzReposPrList(JSON.stringify([{ pullRequestId: 7, status: "active", isDraft: false }])), {
    ok: true,
    pr: { number: 7, status: "open" },
  });
  assert.deepEqual(parseAzReposPrList(JSON.stringify([{ pullRequestId: 7, status: "active", isDraft: true }])), {
    ok: true,
    pr: { number: 7, status: "draft" },
  });
  assert.deepEqual(parseAzReposPrList("[]"), { ok: true, pr: null });
  assert.deepEqual(parseAzReposPrList(""), { ok: true, pr: null }, "empty stdout is treated as no PR, not a crash");
});

test("parseAzReposPrList skips a malformed leading entry and finds the valid active PR behind it", () => {
  const json = JSON.stringify([{ status: "active" }, { pullRequestId: 8, status: "active", isDraft: false }]);
  assert.deepEqual(parseAzReposPrList(json), { ok: true, pr: { number: 8, status: "open" } }, "a leading entry with no pullRequestId must not null-out a valid PR");
});

test("parseAzReposPrList reports a genuine parse failure as ok:false (not a false 'no PR')", () => {
  const r = parseAzReposPrList("not json");
  assert.equal(r.ok, false);
});

// ---- the delivery instruction is Azure-flavoured, factory builds the leaf ----
test("autoOpenPrInstruction emits az repos pr create with --target-branch", () => {
  assert.match(forge.autoOpenPrInstruction("main").command, /^az repos pr create --target-branch main$/);
  assert.match(forge.autoOpenPrInstruction(undefined).command, /^az repos pr create$/);
});

test("makeForge('azure-repos') builds an AzureReposForge", () => {
  assert.ok(makeForge("azure-repos") instanceof AzureReposForge);
});

// ---- resolveAzureCoordinates: the config override → az board-read coordinates ----
test("resolveAzureCoordinates uses the parsed Azure remote when there's no config override", () => {
  const parsed = { host: "dev.azure.com", owner: "acme", project: "Platform", repo: "svc" };
  assert.deepEqual(resolveAzureCoordinates(undefined, parsed), parsed, "the normal auto-detected Azure remote is unchanged");
});

test("resolveAzureCoordinates lets a config override supply Azure coordinates for a masked/mirror remote", () => {
  // Remote is a non-Azure mirror (or absent); the pinned forge config carries the real Azure org/project/repo.
  const parsedMirror = { host: "git.mirror.internal", owner: "x", repo: "y" };
  assert.deepEqual(
    resolveAzureCoordinates({ host: "dev.azure.com", owner: "acme", project: "Platform", repo: "svc" }, parsedMirror),
    { host: "dev.azure.com", owner: "acme", project: "Platform", repo: "svc" },
    "config coordinates win per-field over the mirror remote",
  );
  assert.deepEqual(
    resolveAzureCoordinates({ host: "acme.visualstudio.com", owner: "acme", repo: "svc" }, null),
    { host: "acme.visualstudio.com", owner: "acme", repo: "svc" },
    "config-only coordinates work with no remote at all",
  );
});

test("resolveAzureCoordinates fails LOUD (null) when the forge is pinned Azure but no Azure host is resolvable", () => {
  // Pinned azure-repos over a GitHub remote WITHOUT explicit coordinates → null, so the caller returns a clear
  // error instead of aiming `az repos` at github.com (the P2 the review flagged).
  assert.equal(resolveAzureCoordinates(undefined, { host: "github.com", owner: "acme", repo: "svc" }), null);
  assert.equal(resolveAzureCoordinates({ owner: "acme", repo: "svc" }, null), null, "no host at all → null");
  assert.equal(resolveAzureCoordinates({ host: "dev.azure.com", repo: "svc" }, null), null, "missing owner → null");
  assert.equal(resolveAzureCoordinates({ host: "dev.azure.com", owner: "acme" }, null), null, "missing repo → null");
});
