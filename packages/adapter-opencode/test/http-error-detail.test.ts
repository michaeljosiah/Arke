import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { OpenCodeError, OpenCodeHttp, canonicalizeRoot, errorDetailFrom } from "../src/index.js";

/**
 * Non-2xx responses must surface WHY, not just the status: OpenCode returns a structured error body
 * (`{ name, data: { message, ref } }`) that previously was discarded, leaving the engineer with a
 * bare "500 Internal Server Error".
 */

test("errorDetailFrom extracts OpenCode's structured error shape", () => {
  assert.equal(
    errorDetailFrom('{"name":"UnknownError","data":{"message":"Unexpected server error.","ref":"err_a9ae8d85"}}'),
    "UnknownError: Unexpected server error. (ref err_a9ae8d85)",
  );
  assert.equal(errorDetailFrom('{"name":"BadRequest","data":{"message":"bad id"}}'), "BadRequest: bad id");
  assert.equal(errorDetailFrom("plain text failure"), "plain text failure");
  assert.equal(errorDetailFrom("   "), undefined);
  // bounded — a huge body never floods the error message
  assert.ok(errorDetailFrom("x".repeat(10_000))!.length <= 200);
});

test("OpenCodeHttp.req attaches the error-body detail to OpenCodeError", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "UnknownError", data: { message: "Unexpected server error.", ref: "err_test1" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const http = new OpenCodeHttp({ baseUrl: `http://127.0.0.1:${port}`, projectRoot: canonicalizeRoot(tmpdir()) });
    await assert.rejects(
      () => http.req("POST", "/session/x/message", { parts: [] }),
      (err: unknown) => {
        assert.ok(err instanceof OpenCodeError);
        assert.equal(err.status, 500);
        assert.match(err.message, /UnknownError: Unexpected server error\. \(ref err_test1\)/);
        assert.equal(err.detail, "UnknownError: Unexpected server error. (ref err_test1)");
        return true;
      },
    );
  } finally {
    server.close();
  }
});
