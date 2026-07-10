import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normativeHash,
  isMaterialChange,
  flattenDeltaTags,
  verifyGithubSignature,
  mapWebhookEvent,
  isSelfApproval,
  normaliseRemote,
  parseCapabilities,
  parseFrontmatter,
} from "../src/spec-lifecycle.js";
import { createHmac } from "node:crypto";

const BRANCH = "feat/x";

function doc(opts: { status?: string; reqDelta?: string; design?: string; extra?: string } = {}): string {
  return `---
spec_id: SPEC-X
title: X
status: ${opts.status ?? "approved"}
branch: ${BRANCH}
owner: dana
capabilities: [alpha, beta]
updated: 2026-06-01
---

# X

## Requirements

### Requirement: A thing
\`capability: alpha\`${opts.reqDelta ? ` · \`delta: ${opts.reqDelta}\`` : ""}

The system SHALL do a thing.

## Design
${opts.design ?? "The design is simple."}

## Change history
- 2026-06-01 · ${BRANCH} · draft — ADDED x
${opts.extra ?? ""}`;
}

// ---- normative hash ----
test("normativeHash is stable and ignores frontmatter/change-history changes", () => {
  const a = normativeHash(doc({ status: "approved" }));
  const b = normativeHash(doc({ status: "draft" })); // frontmatter status differs
  assert.equal(a, b, "status (frontmatter) change must not change the normative hash");

  const withHistory = doc({ extra: "- 2026-06-02 · feat/x · note\n" });
  assert.equal(normativeHash(withHistory), a, "Change history change must not change the hash");
});

test("normativeHash changes when Requirements or Design change", () => {
  const base = normativeHash(doc());
  assert.notEqual(normativeHash(doc({ reqDelta: "MODIFIED (feat/x)" })), base, "a requirements edit changes the hash");
  assert.notEqual(normativeHash(doc({ design: "A completely different design." })), base, "a design edit changes the hash");
});

test("isMaterialChange needs a baseline and compares normative sections", () => {
  const baseline = normativeHash(doc());
  assert.equal(isMaterialChange(undefined, doc()), false, "no baseline → never material");
  assert.equal(isMaterialChange(baseline, doc({ status: "draft" })), false, "frontmatter-only change → not material");
  assert.equal(isMaterialChange(baseline, doc({ design: "Different." })), true, "design change → material");
});

// ---- flatten ----
test("flatten drops ADDED tags and keeps the body, appends one Change history line", () => {
  const r = flattenDeltaTags(doc({ reqDelta: "ADDED (feat/x)" }), BRANCH, "2026-07-01");
  assert.equal(r.changed, true);
  assert.ok(!/delta:/i.test(r.text), "no delta tags remain");
  assert.ok(/The system SHALL do a thing/.test(r.text), "body retained");
  assert.equal(r.summary.added, 1);
  assert.ok(/2026-07-01 · feat\/x · approved — ADDED: 1/.test(r.text));
});

test("flatten drops MODIFIED tags, retains the requirement body", () => {
  const r = flattenDeltaTags(doc({ reqDelta: "MODIFIED (feat/x)" }), BRANCH, "2026-07-01");
  assert.equal(r.summary.modified, 1);
  assert.ok(/The system SHALL do a thing/.test(r.text));
  assert.ok(!/delta:/i.test(r.text));
});

test("flatten turns a REMOVED requirement into a tombstone under ## Removed", () => {
  const r = flattenDeltaTags(doc({ reqDelta: "REMOVED (Reason: obsolete)" }), BRANCH, "2026-07-01");
  assert.equal(r.summary.removed, 1);
  assert.ok(!/### Requirement: A thing/.test(r.text), "requirement block cut");
  assert.ok(/## Removed/.test(r.text));
  assert.ok(/> REMOVED alpha\/A thing — Reason: obsolete/.test(r.text));
});

test("flatten applies a RENAMED tag in place and notes it in Change history", () => {
  const r = flattenDeltaTags(doc({ reqDelta: "RENAMED (from: Old name)" }), BRANCH, "2026-07-01");
  assert.equal(r.summary.renamed, 1);
  assert.ok(/### Requirement: A thing/.test(r.text), "heading kept (the new name)");
  assert.ok(!/delta:/i.test(r.text));
  assert.ok(/RENAMED Old name → A thing/.test(r.text));
});

test("flatten is idempotent — no delta tags is a no-op", () => {
  const clean = doc({}); // no reqDelta
  const r = flattenDeltaTags(clean, BRANCH, "2026-07-01");
  assert.equal(r.changed, false);
  assert.equal(r.text, clean, "unchanged input returned verbatim");
});

test("flatten does not duplicate a tombstone on re-run", () => {
  const once = flattenDeltaTags(doc({ reqDelta: "REMOVED (Reason: obsolete)" }), BRANCH, "2026-07-01").text;
  const twice = flattenDeltaTags(once, BRANCH, "2026-07-02");
  assert.equal(twice.changed, false, "already-flattened file is a no-op");
  assert.equal((twice.text.match(/> REMOVED alpha\/A thing/g) ?? []).length, 1, "single tombstone");
});

// ---- flatten (HTML, SPEC-036) ----
// An HTML spec's delta tokens live in `<p class="meta">` and its requirements are `<h3>`-delimited; the
// format-dispatched flatten must strip/tombstone them exactly as the markdown path does. Reachable via the
// webhook `merged` transition (not just spec.deliver, which is refused for HTML).
function htmlDoc(reqDelta?: string): string {
  return `<!--arke
---
spec_id: SPEC-X
title: X
status: approved
branch: ${BRANCH}
owner: dana
capabilities: [alpha, beta]
---
-->
<h1>X</h1>
<h2>Requirements</h2>
<h3>Requirement: A thing</h3>
<p class="meta">capability: alpha${reqDelta ? ` · delta: ${reqDelta}` : ""}</p>
<p>The system SHALL do a thing.</p>
<h2>Design</h2>
<p>The design is simple.</p>
<h2>Change history</h2>
<ul>
  <li>2026-06-01 · ${BRANCH} · draft — ADDED x</li>
</ul>
`;
}

test("flatten(HTML) drops an ADDED delta token, keeps the body + tags, appends an <li> history entry", () => {
  const r = flattenDeltaTags(htmlDoc("ADDED (feat/x)"), BRANCH, "2026-07-01");
  assert.equal(r.changed, true);
  assert.equal(r.summary.added, 1);
  assert.ok(!/delta:/i.test(r.text), "no delta token remains");
  assert.ok(/capability: alpha<\/p>/.test(r.text), "capability + closing tag preserved, token excised");
  assert.ok(/<h3>Requirement: A thing<\/h3>/.test(r.text), "requirement heading kept");
  assert.ok(/The system SHALL do a thing/.test(r.text), "body retained");
  assert.ok(/<li>2026-07-01 · feat\/x · approved — ADDED: 1<\/li>/.test(r.text), "history <li> appended");
});

test("flatten(HTML) cuts a REMOVED requirement and tombstones it under <h2>Removed</h2>", () => {
  const r = flattenDeltaTags(htmlDoc("REMOVED (Reason: obsolete)"), BRANCH, "2026-07-01");
  assert.equal(r.summary.removed, 1);
  assert.ok(!/<h3>Requirement: A thing<\/h3>/.test(r.text), "requirement block cut");
  assert.ok(/<h2>Removed<\/h2>/.test(r.text), "Removed section created");
  assert.ok(/<li>REMOVED alpha\/A thing — Reason: obsolete/.test(r.text), "tombstone li");
});

test("flatten(HTML) is a no-op when there are no delta tokens, and does not double-tombstone", () => {
  const clean = htmlDoc();
  const noop = flattenDeltaTags(clean, BRANCH, "2026-07-01");
  assert.equal(noop.changed, false);
  assert.equal(noop.text, clean, "unchanged input returned verbatim");
  const once = flattenDeltaTags(htmlDoc("REMOVED (Reason: obsolete)"), BRANCH, "2026-07-01").text;
  const twice = flattenDeltaTags(once, BRANCH, "2026-07-02");
  assert.equal(twice.changed, false, "already-flattened HTML is a no-op");
  assert.equal((twice.text.match(/REMOVED alpha\/A thing/g) ?? []).length, 1, "single tombstone");
});

// ---- signature ----
test("verifyGithubSignature accepts a correct HMAC and rejects tampering", () => {
  const secret = "s3cr3t";
  const body = JSON.stringify({ a: 1 });
  const sig = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  assert.equal(verifyGithubSignature(secret, body, sig), true);
  assert.equal(verifyGithubSignature(secret, body + "x", sig), false, "tampered body");
  assert.equal(verifyGithubSignature(secret, body, undefined), false, "missing header");
});

// ---- webhook mapping ----
test("mapWebhookEvent maps PR lifecycle actions", () => {
  const pr = (action: string, merged = false) => ({ action, pull_request: { number: 7, merged, head: { ref: BRANCH } } });
  assert.deepEqual(mapWebhookEvent("pull_request", pr("opened")), { kind: "opened", branch: BRANCH, prNumber: 7 });
  assert.deepEqual(mapWebhookEvent("pull_request", pr("reopened")), { kind: "reopened", branch: BRANCH, prNumber: 7 });
  assert.equal(mapWebhookEvent("pull_request", pr("synchronize")).kind, "synchronized"); // a push, not a re-open
  assert.equal(mapWebhookEvent("pull_request", pr("closed", false)).kind, "closed-unmerged");
  assert.equal(mapWebhookEvent("pull_request", pr("closed", true)).kind, "merged");
});

test("mapWebhookEvent maps an approved review and a forced push", () => {
  const review = mapWebhookEvent("pull_request_review", { review: { state: "approved", user: { login: "rae" } }, pull_request: { number: 7, head: { ref: BRANCH } } });
  assert.deepEqual(review, { kind: "approved", branch: BRANCH, prNumber: 7, approver: "rae" });
  assert.equal(mapWebhookEvent("pull_request_review", { review: { state: "commented" } }).kind, "ignored");
  assert.deepEqual(mapWebhookEvent("push", { forced: true, ref: "refs/heads/feat/x" }), { kind: "force-push", branch: BRANCH });
  assert.equal(mapWebhookEvent("push", { forced: false, ref: "refs/heads/feat/x" }).kind, "ignored");
});

test("isSelfApproval is case-insensitive and owner-aware", () => {
  assert.equal(isSelfApproval("Dana", "dana"), true);
  assert.equal(isSelfApproval("rae", "dana"), false);
  assert.equal(isSelfApproval("dana", undefined), false);
});

// ---- helpers ----
test("normaliseRemote handles https and ssh remotes", () => {
  assert.equal(normaliseRemote("https://github.com/acme/arke.git"), "github.com/acme/arke");
  assert.equal(normaliseRemote("git@github.com:acme/arke.git"), "github.com/acme/arke");
  assert.equal(normaliseRemote(undefined), null);
});

test("parseCapabilities reads a frontmatter array", () => {
  const { data } = parseFrontmatter(doc());
  assert.deepEqual(parseCapabilities(data), ["alpha", "beta"]);
});
