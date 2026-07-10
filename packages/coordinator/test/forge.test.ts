import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { parseRemote, forgeIdForRemote, webhookForgeId, makeForge, GitHubForge } from "../src/forge/index.js";
import { mapWebhookEvent } from "../src/spec-lifecycle.js";

/** SPEC-038 Increment 1: the ForgeAdapter seam — remote parsing, the two resolution paths, and the
 *  behaviour-preserving GitHubForge (delegates to the existing functions). */

// ---- parseRemote: GitHub + Azure (https/legacy/ssh) + fallback ----
test("parseRemote handles GitHub https + ssh", () => {
  assert.deepEqual(parseRemote("https://github.com/acme/arke.git"), { host: "github.com", owner: "acme", repo: "arke" });
  assert.deepEqual(parseRemote("git@github.com:acme/arke.git"), { host: "github.com", owner: "acme", repo: "arke" });
});

test("parseRemote handles Azure Repos https, legacy visualstudio.com, and ssh (org + project)", () => {
  assert.deepEqual(parseRemote("https://dev.azure.com/acme/Platform/_git/arke"), { host: "dev.azure.com", owner: "acme", project: "Platform", repo: "arke" });
  assert.deepEqual(parseRemote("https://acme@dev.azure.com/acme/Platform/_git/arke"), { host: "dev.azure.com", owner: "acme", project: "Platform", repo: "arke" });
  assert.deepEqual(parseRemote("https://acme.visualstudio.com/Platform/_git/arke"), { host: "acme.visualstudio.com", owner: "acme", project: "Platform", repo: "arke" });
  assert.deepEqual(parseRemote("git@ssh.dev.azure.com:v3/acme/Platform/arke"), { host: "dev.azure.com", owner: "acme", project: "Platform", repo: "arke" });
});

test("parseRemote returns null for junk", () => {
  assert.equal(parseRemote(""), null);
  assert.equal(parseRemote(undefined), null);
  assert.equal(parseRemote("not a url"), null);
});

test("parseRemote tolerates a :port, userinfo, a trailing slash, and a query string on Azure URLs", () => {
  assert.deepEqual(parseRemote("https://dev.azure.com:443/acme/Platform/_git/arke"), { host: "dev.azure.com", owner: "acme", project: "Platform", repo: "arke" });
  assert.deepEqual(parseRemote("https://dev.azure.com/acme/Platform/_git/arke/"), { host: "dev.azure.com", owner: "acme", project: "Platform", repo: "arke" });
  assert.deepEqual(parseRemote("https://dev.azure.com/acme/Platform/_git/arke?path=/x"), { host: "dev.azure.com", owner: "acme", project: "Platform", repo: "arke" });
});

test("parseRemote handles an Azure/VSTS collection segment (DefaultCollection)", () => {
  assert.deepEqual(parseRemote("https://acme.visualstudio.com/DefaultCollection/Platform/_git/arke"), { host: "acme.visualstudio.com", owner: "acme", project: "Platform", repo: "arke" });
  assert.deepEqual(parseRemote("https://dev.azure.com/acme/DefaultCollection/Platform/_git/arke"), { host: "dev.azure.com", owner: "acme", project: "Platform", repo: "arke" });
});

test("parseRemote fails LOUD (null) on a malformed Azure URL rather than mangling it into junk", () => {
  // No `_git` anchor — the old generic fallback returned {owner:'Platform', repo:'arke'}; now it's null.
  assert.equal(parseRemote("https://dev.azure.com/acme/Platform/arke"), null);
  assert.equal(parseRemote("git@ssh.dev.azure.com:acme/Platform/arke"), null, "an Azure SSH host without the v3 form is refused, not mis-parsed");
});

// ---- forgeIdForRemote: the board/delivery path (remote-based), GitHub default ----
test("forgeIdForRemote maps dev.azure.com/visualstudio.com to azure-repos, else github (default)", () => {
  assert.equal(forgeIdForRemote("https://dev.azure.com/acme/P/_git/r"), "azure-repos");
  assert.equal(forgeIdForRemote("https://acme.visualstudio.com/P/_git/r"), "azure-repos");
  assert.equal(forgeIdForRemote("https://github.com/acme/arke"), "github");
  assert.equal(forgeIdForRemote(undefined), "github", "absent remote defaults to github (no regression)");
  assert.equal(forgeIdForRemote("https://gitlab.com/acme/arke"), "github", "unknown host defaults to github");
});

test("an explicit forge config host overrides the remote", () => {
  assert.equal(forgeIdForRemote("https://github.com/acme/arke", { host: "dev.azure.com" }), "azure-repos");
});

// ---- webhookForgeId: the ingress path (URL-based, NOT the remote) ----
test("webhookForgeId selects by the URL path, not any remote", () => {
  assert.equal(webhookForgeId("/webhooks/github"), "github");
  assert.equal(webhookForgeId("/webhooks/azure"), "azure-repos");
  assert.equal(webhookForgeId("/webhooks/other"), null);
  assert.equal(webhookForgeId(undefined), null);
});

// ---- GitHubForge: behaviour-preserving delegation ----
test("makeForge('github') builds a GitHubForge", () => {
  assert.ok(makeForge("github") instanceof GitHubForge);
});

test("GitHubForge.mapWebhookEvent is byte-identical to the underlying mapWebhookEvent", () => {
  const forge = new GitHubForge();
  const payload = { action: "closed", pull_request: { number: 7, merged: true, head: { ref: "feat/x" } } };
  assert.deepEqual(forge.mapWebhookEvent("pull_request", payload), mapWebhookEvent("pull_request", payload));
});

test("GitHubForge.verifyWebhook accepts a correct HMAC over x-hub-signature-256 and rejects tampering", () => {
  const forge = new GitHubForge();
  const secret = "s3cr3t";
  const body = JSON.stringify({ action: "opened" });
  const sig = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  assert.equal(forge.verifyWebhook({ "x-hub-signature-256": sig }, body, secret), true);
  assert.equal(forge.verifyWebhook({ "x-hub-signature-256": sig }, body + "x", secret), false);
  assert.equal(forge.verifyWebhook({}, body, secret), false, "no signature header → reject");
});

test("GitHubForge.autoOpenPrInstruction emits the gh command with an optional base", () => {
  const forge = new GitHubForge();
  assert.match(forge.autoOpenPrInstruction("main").command, /^gh pr create --base main --fill$/);
  assert.match(forge.autoOpenPrInstruction(undefined).command, /^gh pr create --fill$/);
});
