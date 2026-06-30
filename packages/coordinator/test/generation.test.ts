import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArtifacts, resolveApproval, specContentHash, type ArtifactProposal } from "../src/generation.js";

const sample = JSON.stringify([
  { target: "docs", title: "Feature doc", content: "# Doc" },
  { target: "ticket", title: "Story", content: "do it", sorTarget: "jira" },
  { target: "tracking", title: "Board entry", content: "track" }, // missing sorTarget → invalid
  { target: "bogus", title: "x", content: "y" }, // bad target → dropped
  { target: "tests", title: "", content: "z" }, // no title → dropped
]);

test("parseArtifacts reads a JSON array, assigns ids, drops malformed, flags invalid sorTarget", () => {
  const arts = parseArtifacts("here you go:\n```json\n" + sample + "\n```");
  assert.deepEqual(arts.map((a) => a.target), ["docs", "ticket", "tracking"], "bad target + no-title dropped");
  assert.deepEqual(arts.map((a) => a.id), ["art-0", "art-1", "art-2"]);
  assert.equal(arts[0]!.invalid, undefined);
  assert.equal(arts[1]!.invalid, undefined, "ticket with sorTarget is valid");
  assert.match(arts[2]!.invalid!, /no integration target/);
});

test("parseArtifacts returns [] on unparseable output", () => {
  assert.deepEqual(parseArtifacts("no json here"), []);
  assert.deepEqual(parseArtifacts("```json\n{not an array}\n```"), []);
});

test("specContentHash is stable and content-sensitive (CRLF-normalised)", () => {
  assert.equal(specContentHash("a\r\nb"), specContentHash("a\nb"));
  assert.notEqual(specContentHash("a"), specContentHash("b"));
});

const proposal: ArtifactProposal[] = [
  { id: "art-0", target: "docs", title: "D", content: "orig" },
  { id: "art-1", target: "tests", title: "T", content: "t" },
  { id: "art-2", target: "ticket", title: "K", content: "k" }, // invalid (no sorTarget)
];

test("resolveApproval: absent ids ⇒ all; edits override content", () => {
  const r = resolveApproval([proposal[0]!, proposal[1]!], undefined, [{ id: "art-0", content: "edited" }]);
  assert.equal(r.error, undefined);
  assert.equal(r.artifacts.length, 2);
  assert.equal(r.artifacts.find((a) => a.id === "art-0")!.content, "edited", "uses edited content, not the buffer");
});

test("resolveApproval: partial selection writes only the chosen artefacts", () => {
  const r = resolveApproval([proposal[0]!, proposal[1]!], ["art-1"], undefined);
  assert.deepEqual(r.artifacts.map((a) => a.id), ["art-1"]);
});

test("resolveApproval: an invalid artefact in the approved set is refused", () => {
  const inv = { ...proposal[2]!, invalid: "Invalid — no integration target specified" };
  const r = resolveApproval([inv], ["art-2"], undefined);
  assert.ok(r.error, "refused");
  assert.equal(r.artifacts.length, 0);
});
