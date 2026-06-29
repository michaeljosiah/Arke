import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CredentialBackendError,
  CredentialPathError,
  CredentialResolver,
} from "../src/credential-resolver.js";

function safeRoot(): string {
  return mkdtempSync(join(tmpdir(), "arke-cred-"));
}

test("env: backend reads a host environment variable", async () => {
  const r = new CredentialResolver({ safeRoot: safeRoot(), env: { TOKEN: "s3cret" } });
  assert.equal(await r.resolve("env:TOKEN"), "s3cret");
});

test("a bare ref defaults to env with a normalised key (opencode/gateway → OPENCODE_GATEWAY)", async () => {
  const r = new CredentialResolver({ safeRoot: safeRoot(), env: { OPENCODE_GATEWAY: "pw" } });
  assert.equal(await r.resolve("opencode/gateway"), "pw");
});

test("file: backend reads a file inside the safe root and trims the trailing newline", async () => {
  const root = safeRoot();
  writeFileSync(join(root, "secret.txt"), "abc123\n", "utf8");
  const r = new CredentialResolver({ safeRoot: root });
  assert.equal(await r.resolve("file:secret.txt"), "abc123");
});

test("file: backend rejects a path that traverses outside the safe root", async () => {
  const r = new CredentialResolver({ safeRoot: safeRoot() });
  await assert.rejects(() => r.resolve("file:../../etc/passwd"), CredentialPathError);
});

test("file: backend rejects an absolute path outside the safe root", async () => {
  const r = new CredentialResolver({ safeRoot: safeRoot() });
  await assert.rejects(() => r.resolve("file:/etc/passwd"), CredentialPathError);
});

test("an unknown scheme is rejected, not treated as a bare env ref", async () => {
  const r = new CredentialResolver({ safeRoot: safeRoot(), env: { VAULT_PROD: "leak" } });
  // Without this, `vault:prod` would normalise to env VAULT_PROD and silently read the wrong value.
  await assert.rejects(() => r.resolve("vault:prod"), CredentialBackendError);
  await assert.rejects(() => r.resolve("envr:TOKEN"), CredentialBackendError); // typo, not "env:"
});

test("keychain: backend errors clearly when no reader is configured", async () => {
  const r = new CredentialResolver({ safeRoot: safeRoot() });
  await assert.rejects(() => r.resolve("keychain:login"), CredentialBackendError);
});

test("keychain: backend uses an injected reader when configured", async () => {
  const r = new CredentialResolver({
    safeRoot: safeRoot(),
    keychain: async (key) => (key === "login" ? "kc-secret" : undefined),
  });
  assert.equal(await r.resolve("keychain:login"), "kc-secret");
});
