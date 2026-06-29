using System.Diagnostics;
using System.Text.Json;
using Spectre.Console;
using Spectre.Console.Cli;

namespace Arke.Cli;

/// <summary>Flags every command shares: machine output, coordinator override, project dir.</summary>
public class GlobalSettings : CommandSettings
{
    [CommandOption("--json")]
    public bool Json { get; set; }

    [CommandOption("--coordinator <URL>")]
    public string? Coordinator { get; set; }

    [CommandOption("--project <DIR>")]
    public string? Project { get; set; }

    public ArkeConfig Config() => ArkeConfig.Load(Project, Coordinator);
}

/// <summary>Output discipline: structured JSON on stdout for agents, errors on stderr, stable codes.</summary>
public static class Output
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };

    /// <summary>Render an op result: raw JSON under --json, indented JSON otherwise. Returns 0.</summary>
    public static int Render(GlobalSettings s, JsonElement result)
    {
        Console.WriteLine(s.Json ? result.GetRawText() : JsonSerializer.Serialize(result, Pretty));
        return 0;
    }

    public static int Ok(GlobalSettings s, object value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value, s.Json ? null : Pretty));
        return 0;
    }

    public static int Error(string message, bool json)
    {
        if (json) Console.Error.WriteLine(JsonSerializer.Serialize(new { ok = false, error = message }));
        else AnsiConsole.MarkupLineInterpolated($"[red]error:[/] {message}");
        return 1;
    }
}

/// <summary>Spawning the Node coordinator/client and the OS browser (SPEC-017 lifecycle).</summary>
public static class Proc
{
    /// <summary>Start a workspace npm script detached, returning the process. Tree-killable via <see cref="Kill"/>.</summary>
    public static Process StartNpm(string cwd, string npmArgs, IDictionary<string, string?>? env = null)
    {
        var psi = new ProcessStartInfo
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
        };
        if (OperatingSystem.IsWindows())
        {
            psi.FileName = "cmd.exe";
            psi.Arguments = $"/c npm {npmArgs}";
        }
        else
        {
            psi.FileName = "npm";
            psi.Arguments = npmArgs;
        }
        if (env is not null)
            foreach (var kv in env)
                psi.Environment[kv.Key] = kv.Value;
        return Process.Start(psi) ?? throw new ArkeException($"failed to start: npm {npmArgs}");
    }

    /// <summary>UTC start-time ticks of a process, used as a cheap identity check against PID reuse.</summary>
    public static long StartTicks(Process p)
    {
        try { return p.StartTime.ToUniversalTime().Ticks; }
        catch { return 0; }
    }

    /// <summary>
    /// Kill the process tree only if the live PID still matches the identity we recorded — guards
    /// against the OS having reused the PID for an unrelated process after a stale run handle.
    /// </summary>
    public static bool KillIfMatches(int pid, long? startTicks)
    {
        try
        {
            var p = Process.GetProcessById(pid);
            if (startTicks is long expected && expected != 0)
            {
                var actual = StartTicks(p);
                if (actual != 0 && actual != expected) return false; // PID reused — not ours
            }
            p.Kill(entireProcessTree: true);
            return true;
        }
        catch
        {
            return false; // already gone
        }
    }

    public static void OpenBrowser(string url)
    {
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }

    /// <summary>Poll an HTTP URL until it answers (&lt;500) or the timeout elapses — client readiness.</summary>
    public static async Task<bool> WaitForHttpAsync(string url, TimeSpan timeout)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var res = await http.GetAsync(url);
                if ((int)res.StatusCode < 500) return true;
            }
            catch { /* not up yet */ }
            await Task.Delay(400);
        }
        return false;
    }
}

/// <summary>The run handle `arke up` writes so `arke down` can stop exactly what it started.</summary>
public sealed class RunHandle
{
    public int? CoordinatorPid { get; set; }
    public int? ClientPid { get; set; }
    // Process start-time ticks recorded alongside each PID, so `down` can detect PID reuse.
    public long? CoordinatorStart { get; set; }
    public long? ClientStart { get; set; }
    public long StartedAt { get; set; }

    private static string Path(string root) => System.IO.Path.Combine(root, ".arke", "cli-run.json");

    public void Save(string root)
    {
        Directory.CreateDirectory(System.IO.Path.Combine(root, ".arke"));
        File.WriteAllText(Path(root), JsonSerializer.Serialize(this));
    }

    public static RunHandle? Load(string root)
    {
        var p = Path(root);
        if (!File.Exists(p)) return null;
        try { return JsonSerializer.Deserialize<RunHandle>(File.ReadAllText(p)); }
        catch { return null; }
    }

    public static void Clear(string root)
    {
        var p = Path(root);
        if (File.Exists(p)) File.Delete(p);
    }
}
