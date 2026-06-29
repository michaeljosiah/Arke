/**
 * Minimal SSE parser for Omnigent's per-session stream (`GET /v1/sessions/{id}/stream`).
 *
 * Frames are `event: <name>\ndata: <json>\n\n`. The JSON payload already carries its own `type`, so
 * we yield the parsed `data` object and ignore the `event:` line. The stream is live-tail only (no
 * replay, no sequence numbers) and terminates with a literal `data: [DONE]` sentinel.
 */
export async function* parseOmnigentSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue; // comment / heartbeat / lone event: line
        if (data === "[DONE]") return; // Omnigent's terminal sentinel
        try {
          yield JSON.parse(data);
        } catch {
          /* ignore a malformed frame rather than killing the stream */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
