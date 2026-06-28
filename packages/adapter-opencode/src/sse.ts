/**
 * Minimal Server-Sent Events parser over a fetch ReadableStream.
 *
 * OpenCode emits `data: <json>` frames on `GET /global/event` (PRD §15.2, integration
 * guide §4). There is no `Last-Event-ID` support, so the caller re-fetches REST state on
 * reconnect rather than replaying. This parser yields the parsed JSON of each `data:` frame.
 */
export async function* parseSse(
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
      // Frames are separated by a blank line (\n\n).
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue; // heartbeat / comment frame
        try {
          yield JSON.parse(data);
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
