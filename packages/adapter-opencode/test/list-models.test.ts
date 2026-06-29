import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";
import { OpenCodeAdapter, canonicalizeRoot } from "../src/index.js";

const projectRoot = canonicalizeRoot(tmpdir());
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch so a GET /config/providers returns `doc`; everything else 404s. */
function stubProviders(doc: unknown): void {
  globalThis.fetch = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/config/providers")) {
      return new Response(JSON.stringify(doc), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function adapter(): OpenCodeAdapter {
  return new OpenCodeAdapter({ baseUrl: "http://127.0.0.1:4096", projectRoot });
}

test("listModels flattens providers' models into ModelInfo {id, provider, displayName}", async () => {
  stubProviders({
    providers: [
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        models: {
          "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" },
          "claude-sonnet-4.6": { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
        },
      },
      { id: "anthropic", models: { "claude-opus-4.8": { name: "Claude Opus 4.8" } } },
    ],
  });
  const models = await adapter().listModels();
  assert.equal(models.length, 3);
  assert.deepEqual(
    models.find((m) => m.id === "gpt-5.5"),
    { id: "gpt-5.5", provider: "github-copilot", displayName: "GPT-5.5" },
  );
  // A model whose key is the id (no nested id field) still resolves via its map key.
  assert.deepEqual(
    models.find((m) => m.id === "claude-opus-4.8"),
    { id: "claude-opus-4.8", provider: "anthropic", displayName: "Claude Opus 4.8" },
  );
});

test("listModels returns an empty list for an unexpected/empty providers shape (defensive)", async () => {
  stubProviders({});
  assert.deepEqual(await adapter().listModels(), []);
});

test("listModels omits a provider with no id and a model with no id", async () => {
  stubProviders({
    providers: [
      { models: { x: { id: "x" } } }, // provider has no id/name → skipped
      { id: "p", models: { "": {} } }, // model id empty and key empty → skipped
    ],
  });
  assert.deepEqual(await adapter().listModels(), []);
});
