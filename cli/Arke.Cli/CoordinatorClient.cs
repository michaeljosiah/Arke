using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Arke.Cli;

/// <summary>Raised when the coordinator returns a structured error or is unreachable.</summary>
public sealed class ArkeException(string message) : Exception(message);

/// <summary>
/// The CLI's link to the coordinator (SPEC-017, ADR-0003): one WebSocket transport for both the
/// request/response command surface and the live <c>watch</c> stream. No HTTP control endpoint.
/// </summary>
public static class CoordinatorClient
{
    /// <summary>Send one op and resolve the matching response (ignoring snapshot/event frames).</summary>
    public static async Task<JsonElement> RequestAsync(string url, string op, object? args, CancellationToken ct = default)
    {
        using var ws = new ClientWebSocket();
        using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        connectCts.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            await ws.ConnectAsync(new Uri(url), connectCts.Token);
        }
        catch (Exception e)
        {
            throw new ArkeException($"coordinator unreachable at {url} ({e.Message}). Is `arke up` running?");
        }

        var id = Guid.NewGuid().ToString("N");
        var payload = JsonSerializer.Serialize(new { type = "request", id, op, args });
        await ws.SendAsync(Encoding.UTF8.GetBytes(payload), WebSocketMessageType.Text, true, connectCts.Token);

        while (true)
        {
            var frame = await ReceiveTextAsync(ws, connectCts.Token);
            using var doc = JsonDocument.Parse(frame);
            var root = doc.RootElement;
            if (root.TryGetProperty("type", out var t) && t.GetString() == "response" &&
                root.TryGetProperty("id", out var rid) && rid.GetString() == id)
            {
                if (root.GetProperty("ok").GetBoolean())
                {
                    await CloseAsync(ws);
                    return root.TryGetProperty("result", out var result) ? result.Clone() : default;
                }
                var error = root.TryGetProperty("error", out var e) ? e.GetString() : "unknown error";
                await CloseAsync(ws);
                throw new ArkeException(error ?? "unknown error");
            }
            // snapshot / event frames are not our response — keep reading
        }
    }

    /// <summary>Stream live domain events; invokes <paramref name="onEvent"/> per event frame until cancelled.</summary>
    public static async Task WatchAsync(string url, Action<JsonElement> onEvent, CancellationToken ct)
    {
        using var ws = new ClientWebSocket();
        try
        {
            await ws.ConnectAsync(new Uri(url), ct);
        }
        catch (Exception e)
        {
            throw new ArkeException($"coordinator unreachable at {url} ({e.Message}). Is `arke up` running?");
        }
        while (!ct.IsCancellationRequested)
        {
            string frame;
            try { frame = await ReceiveTextAsync(ws, ct); }
            catch (OperationCanceledException) { break; }
            using var doc = JsonDocument.Parse(frame);
            var root = doc.RootElement;
            if (root.TryGetProperty("type", out var t) && t.GetString() == "event" &&
                root.TryGetProperty("event", out var ev))
            {
                onEvent(ev.Clone());
            }
        }
    }

    /// <summary>True if a coordinator accepts a WebSocket connection at <paramref name="url"/>.</summary>
    public static async Task<bool> IsReachableAsync(string url, CancellationToken ct = default)
    {
        try
        {
            using var ws = new ClientWebSocket();
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(2));
            await ws.ConnectAsync(new Uri(url), cts.Token);
            await CloseAsync(ws);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static async Task<string> ReceiveTextAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        using var sb = new MemoryStream();
        while (true)
        {
            var res = await ws.ReceiveAsync(buffer, ct);
            if (res.MessageType == WebSocketMessageType.Close)
                throw new ArkeException("coordinator closed the connection");
            sb.Write(buffer, 0, res.Count);
            if (res.EndOfMessage) break;
        }
        return Encoding.UTF8.GetString(sb.ToArray());
    }

    private static async Task CloseAsync(ClientWebSocket ws)
    {
        try
        {
            if (ws.State == WebSocketState.Open)
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
        }
        catch { /* best effort */ }
    }
}
