import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOmnigentSse } from "../src/sse.js";

/** Build a ReadableStream of UTF-8 chunks, to feed the SSE parser like a fetch body would. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of parseOmnigentSse(stream)) out.push(ev);
  return out;
}

test("parses event:/data: frames and yields the parsed data JSON", async () => {
  const out = await collect(
    streamOf([
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
    ]),
  );
  assert.deepEqual(out, [
    { type: "response.created" },
    { type: "response.output_text.delta", delta: "hi" },
  ]);
});

test("stops at the [DONE] sentinel and ignores frames after it", async () => {
  const out = await collect(
    streamOf(["data: {\"type\":\"response.completed\"}\n\n", "data: [DONE]\n\n", "data: {\"type\":\"late\"}\n\n"]),
  );
  assert.deepEqual(out, [{ type: "response.completed" }]);
});

test("a frame split across chunks is reassembled; malformed JSON is skipped, not fatal", async () => {
  const out = await collect(
    streamOf(["data: {\"type\":\"res", "ponse.created\"}\n\n", "data: not-json\n\n", "data: {\"type\":\"ok\"}\n\n"]),
  );
  assert.deepEqual(out, [{ type: "response.created" }, { type: "ok" }]);
});
