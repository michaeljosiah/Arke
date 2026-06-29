using System.Text.Json;

namespace Arke.Cli;

/// <summary>
/// Resolves the coordinator address, client URL, and project root from <c>.arke/config.json</c>
/// (+ <c>ARKE_*</c> env vars + flags) — the same single config file the rest of Arke reads
/// (SPEC-005). The CLI keeps no config of its own.
/// </summary>
public sealed class ArkeConfig
{
    public required string ProjectRoot { get; init; }
    public required string CoordinatorUrl { get; init; }
    public required string ClientUrl { get; init; }
    public bool ManageHarness { get; init; }

    public const int DefaultCoordinatorPort = 4319;
    public const int DefaultClientPort = 5188;

    /// <summary>
    /// Walk up from <paramref name="start"/> to the Arke project root. The canonical marker is
    /// <c>.arke/</c>; it takes priority so that invoking from a workspace subpackage (which has
    /// its own <c>package.json</c>, e.g. <c>packages/client</c>) still resolves the repo root and
    /// not the subpackage. Only when no <c>.arke/</c> exists anywhere do we fall back to the
    /// nearest <c>package.json</c>.
    /// </summary>
    public static string FindProjectRoot(string? start = null)
    {
        var startDir = start ?? Directory.GetCurrentDirectory();

        for (var d = new DirectoryInfo(startDir); d is not null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, ".arke")))
                return d.FullName;

        for (var d = new DirectoryInfo(startDir); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "package.json")))
                return d.FullName;

        return startDir;
    }

    public static ArkeConfig Load(string? projectOverride = null, string? coordinatorOverride = null)
    {
        var root = projectOverride is not null ? Path.GetFullPath(projectOverride) : FindProjectRoot();
        var env = Environment.GetEnvironmentVariables();

        int coordPort = DefaultCoordinatorPort;
        int clientPort = DefaultClientPort;
        bool manage = false;

        var configPath = Path.Combine(root, ".arke", "config.json");
        if (File.Exists(configPath))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(configPath));
                if (doc.RootElement.TryGetProperty("settings", out var settings))
                {
                    if (settings.TryGetProperty("coordinatorPort", out var p) && p.TryGetInt32(out var pv)) coordPort = pv;
                    if (settings.TryGetProperty("manageHarness", out var m) && m.ValueKind is JsonValueKind.True or JsonValueKind.False) manage = m.GetBoolean();
                }
            }
            catch { /* fall back to defaults on a malformed file */ }
        }

        coordPort = IntEnv(env, "ARKE_COORDINATOR_PORT", coordPort);
        manage = BoolEnv(env, "ARKE_MANAGE_HARNESS", manage);

        var coordUrl = coordinatorOverride
            ?? StrEnv(env, "ARKE_COORDINATOR_URL")
            ?? $"ws://127.0.0.1:{coordPort}";
        var clientUrl = StrEnv(env, "ARKE_CLIENT_URL") ?? $"http://localhost:{clientPort}";

        return new ArkeConfig
        {
            ProjectRoot = root,
            CoordinatorUrl = coordUrl,
            ClientUrl = clientUrl,
            ManageHarness = manage,
        };
    }

    private static string? StrEnv(System.Collections.IDictionary env, string key) =>
        env[key] as string is { Length: > 0 } v ? v : null;

    private static int IntEnv(System.Collections.IDictionary env, string key, int fallback) =>
        int.TryParse(env[key] as string, out var v) ? v : fallback;

    private static bool BoolEnv(System.Collections.IDictionary env, string key, bool fallback) =>
        env[key] as string is { } s ? (s == "1" || s.Equals("true", StringComparison.OrdinalIgnoreCase)) : fallback;
}
