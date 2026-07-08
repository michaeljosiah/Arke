import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ArrayDeadLetterSink,
  DirectoryEscapeError,
  InMemorySessionStore,
  OpenCodeAdapter,
  canonicalizeRoot,
  type OpenCodeConfig,
} from "../src/index.js";
import { StubOpenCodeServer } from "./helpers/stub-server.js";

// SPEC-028: a delivery session runs IN its git worktree. createSession({ cwd }) scopes EVERY request for
// that session (create, prompt, diff, todos) to the worktree directory via the `directory` query param,
// while other sessions keep using the primary project directory.

let server: StubOpenCodeServer;
let baseUrl: string;
let root: string;
let worktree: string;

beforeEach(async () => {
  server = new StubOpenCodeServer();
  baseUrl = await server.start();
  root = canonicalizeRoot(mkdtempSync(join(tmpdir(), "arke-cwd-")));
  worktree = join(root, ".arke", "worktrees", "abc123");
  mkdirSync(worktree, { recursive: true }); // must exist so resolveDirectory's realpath check passes
});

afterEach(async () => {
  await server.stop();
});

function makeAdapter() {
  const config: OpenCodeConfig = { baseUrl, projectRoot: root, permissionTimeoutMs: 200, reconnectBaseMs: 10, reconnectMaxMs: 50 };
  return new OpenCodeAdapter(config, { sessionStore: new InMemorySessionStore(), deadLetterSink: new ArrayDeadLetterSink() });
}

const wireDir = (p: string) => p.replaceAll("\\", "/"); // OpenCode receives the directory in forward-slash form

test("a session created with a cwd scopes create + prompt + diff to that worktree directory", async () => {
  const adapter = makeAdapter();
  const ref = await adapter.createSession({ specId: "SPEC-A", cwd: worktree });

  assert.equal(server.lastDirectories.get("POST /session"), wireDir(worktree), "createSession scoped to the worktree");

  await adapter.dispatchAsync({ sessionId: ref.sessionId, agent: "implementer", parts: [{ type: "text", text: "go" }] });
  assert.equal(server.lastDirectories.get("POST /session/:id/prompt_async"), wireDir(worktree), "the turn runs in the worktree");

  await adapter.getDiff(ref);
  assert.equal(server.lastDirectories.get("GET /session/:id/diff"), wireDir(worktree), "the diff is computed in the worktree");
});

test("a session created WITHOUT a cwd uses the primary project directory", async () => {
  const adapter = makeAdapter();
  const ref = await adapter.createSession({ specId: "SPEC-A" });
  assert.equal(server.lastDirectories.get("POST /session"), wireDir(root), "defaults to the primary directory");
  await adapter.getDiff(ref);
  assert.equal(server.lastDirectories.get("GET /session/:id/diff"), wireDir(root), "and stays there for later requests");
});

test("per-session cwd is isolated: one session in a worktree does not move another session's requests", async () => {
  const adapter = makeAdapter();
  const delivery = await adapter.createSession({ specId: "SPEC-A", cwd: worktree });
  const authoring = await adapter.createSession({ specId: "SPEC-A" });

  await adapter.getDiff(delivery);
  assert.equal(server.lastDirectories.get("GET /session/:id/diff"), wireDir(worktree));
  await adapter.getDiff(authoring);
  assert.equal(server.lastDirectories.get("GET /session/:id/diff"), wireDir(root), "the authoring session stays on the primary directory");
});

test("a cwd that escapes the project root is refused (NFR-1 — never trust a caller path verbatim)", async () => {
  const adapter = makeAdapter();
  const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
  await assert.rejects(() => adapter.createSession({ specId: "SPEC-A", cwd: outside }), DirectoryEscapeError);
});
