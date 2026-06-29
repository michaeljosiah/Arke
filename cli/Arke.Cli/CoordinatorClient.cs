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
    public static Task<JsonElement> RequestAsync(string url, string op, object? args, CancellationToken ct = default)
        => RequestWithActivationAsync(url, null, op, args, ct);

    /// <summary>
    /// Open ONE connection, optionally activate a project on it first (<paramref name="activate"/> →
    /// a <c>project.open</c> request), then send <paramref name="op"/> and resolve its response.
    /// Because each CLI invocation is its own short-lived connection, the active project does not
    /// persist server-side between commands — so a per-project op must re-activate on its own
    /// connection before issuing (SPEC-018).
    /// </summary>
    public static async Task<JsonElement> RequestWithActivationAsync(string url, object? activate, string op, object? args, CancellationToken ct = default)
    {
        using var ws = new ClientWebSocket();
        // The 30s cap is scoped to CONNECTION establishment only. The response itself can take far
        // longer (a sync `prompt.send` resolves when the agent's turn completes), so send/receive
        // use the caller's token — not the connect cap — and wait as long as the caller allows.
        try
        {
            using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            connectCts.CancelAfter(TimeSpan.FromSeconds(30));
            await ws.ConnectAsync(new Uri(url), connectCts.Token);
        }
        catch (Exception e)
        {
            throw new ArkeException($"coordinator unreachable at {url} ({e.Message}). Is `arke up` running?");
        }

        if (activate is not null)
            await SendAndAwaitAsync(ws, "project.open", activate, ct); // bind this connection's active project

        var result = await SendAndAwaitAsync(ws, op, args, ct);
        await CloseAsync(ws);
        return result;
    }

    /// <summary>Send one request on an open socket and await its matching response (no close).</summary>
    private static async Task<JsonElement> SendAndAwaitAsync(ClientWebSocket ws, string op, object? args, CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString("N");
        var payload = JsonSerializer.Serialize(new { type = "request", id, op, args });
        await ws.SendAsync(Encoding.UTF8.GetBytes(payload), WebSocketMessageType.Text, true, ct);

        while (true)
        {
            var frame = await ReceiveTextAsync(ws, ct);
            using var doc = JsonDocument.Parse(frame);
            var root = doc.RootElement;
            if (root.TryGetProperty("type", out var t) && t.GetString() == "response" &&
                root.TryGetProperty("id", out var rid) && rid.GetString() == id)
            {
                if (root.GetProperty("ok").GetBoolean())
                    return root.TryGetProperty("result", out var result) ? result.Clone() : default;
                var error = root.TryGetProperty("error", out var e) ? e.GetString() : "unknown error";
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
