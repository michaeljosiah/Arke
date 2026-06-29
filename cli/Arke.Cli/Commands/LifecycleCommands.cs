using System.Diagnostics;
using Spectre.Console;
using Spectre.Console.Cli;

namespace Arke.Cli.Commands;

/// <summary>`arke up` — bring the stack up (coordinator + client + managed harness) and report ready.</summary>
public sealed class UpCommand : AsyncCommand<UpCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandOption("--open")]
        public bool Open { get; set; }

        [CommandOption("--no-client")]
        public bool NoClient { get; set; }

        [CommandOption("--no-manage-harness")]
        public bool NoManageHarness { get; set; }
    }

    protected override async Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct)
    {
        var cfg = s.Config();
        // Preserve a prior run handle: if an earlier `up` started the coordinator and this `up`
        // only attaches + starts the client, we must keep the coordinator's PID so `down` still
        // stops it ("stop exactly what up started").
        var handle = RunHandle.Load(cfg.ProjectRoot) ?? new RunHandle();
        handle.StartedAt = handle.StartedAt == 0 ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : handle.StartedAt;

        var alreadyUp = await CoordinatorClient.IsReachableAsync(cfg.CoordinatorUrl);
        if (alreadyUp)
        {
            // Attaching — leave any existing CoordinatorPid in the handle untouched.
            if (!s.Json) AnsiConsole.MarkupLineInterpolated($"[grey]coordinator already running at[/] {cfg.CoordinatorUrl} [grey]— attaching[/]");
        }
        else
        {
            // arke up manages the harness by default (Decision #8) — the coordinator owns it (SPEC-016).
            // Pass the SELECTED port so the spawned coordinator binds where we will look for it.
            var env = new Dictionary<string, string?>
            {
                ["ARKE_MANAGE_HARNESS"] = s.NoManageHarness ? "false" : "true",
                ["ARKE_COORDINATOR_PORT"] = new Uri(cfg.CoordinatorUrl).Port.ToString(),
                // Root the coordinator at the chosen project (SPEC-018). `npm run --workspace` runs
                // the coordinator with its package dir as cwd, so without this the default project
                // would be the coordinator package itself, not the user's project (--project / cwd).
                ["ARKE_PROJECT_ROOT"] = cfg.ProjectRoot,
            };
            var coord = Proc.StartNpm(cfg.ProjectRoot, "run dev:coordinator", env);
            handle.CoordinatorPid = coord.Id;
            handle.CoordinatorStart = Proc.StartTicks(coord);
        }

        if (!s.NoClient)
        {
            var client = Proc.StartNpm(cfg.ProjectRoot, $"run dev --workspace @arke/client -- --port {ArkeConfig.DefaultClientPort} --strictPort");
            handle.ClientPid = client.Id;
            handle.ClientStart = Proc.StartTicks(client);
        }

        handle.Save(cfg.ProjectRoot);

        var ready = await WaitForReady(cfg.CoordinatorUrl, TimeSpan.FromSeconds(40));
        if (!ready)
            return Output.Error($"coordinator did not become ready at {cfg.CoordinatorUrl} within 40s", s.Json);

        // Don't report a healthy stack while the UI is down — wait for the client too (unless --no-client).
        if (!s.NoClient && !await Proc.WaitForHttpAsync(cfg.ClientUrl, TimeSpan.FromSeconds(40)))
            return Output.Error($"client did not become ready at {cfg.ClientUrl} within 40s (port in use, or the dev server exited)", s.Json);

        if (s.Json)
            return Output.Ok(s, new { ok = true, coordinator = cfg.CoordinatorUrl, client = s.NoClient ? null : cfg.ClientUrl, manageHarness = !s.NoManageHarness });

        AnsiConsole.MarkupLineInterpolated($"[green]coordinator ready[/]  {cfg.CoordinatorUrl}");
        if (!s.NoClient) AnsiConsole.MarkupLineInterpolated($"[green]client[/]            {cfg.ClientUrl}");
        AnsiConsole.MarkupLineInterpolated($"[grey]managed harness:[/]  {(s.NoManageHarness ? "off (attach)" : "on")}");

        if (s.Open) Proc.OpenBrowser(cfg.ClientUrl);
        return 0;
    }

    private static async Task<bool> WaitForReady(string url, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (await CoordinatorClient.IsReachableAsync(url)) return true;
            await Task.Delay(400);
        }
        return false;
    }
}

/// <summary>`arke down` — stop exactly the services `arke up` started (never an external harness).</summary>
public sealed class DownCommand : Command<DownCommand.Settings>
{
    public sealed class Settings : GlobalSettings { }

    protected override int Execute(CommandContext context, Settings s, CancellationToken ct)
    {
        var cfg = s.Config();
        var handle = RunHandle.Load(cfg.ProjectRoot);
        if (handle is null)
            return s.Json ? Output.Ok(s, new { ok = true, stopped = Array.Empty<string>() }) : Note(s, "nothing to stop (no run handle)");

        // Kill only if the live PID still matches the start-time we recorded — a stale handle's
        // PID may since have been reused by an unrelated process.
        var stopped = new List<string>();
        if (handle.ClientPid is int cp && Proc.KillIfMatches(cp, handle.ClientStart)) stopped.Add("client");
        if (handle.CoordinatorPid is int kp && Proc.KillIfMatches(kp, handle.CoordinatorStart)) stopped.Add("coordinator");
        RunHandle.Clear(cfg.ProjectRoot);

        return s.Json ? Output.Ok(s, new { ok = true, stopped }) : Note(s, $"stopped: {string.Join(", ", stopped.Count > 0 ? stopped : new List<string> { "(nothing running)" })}");
    }

    private static int Note(Settings s, string msg)
    {
        AnsiConsole.WriteLine(msg);
        return 0;
    }
}

/// <summary>`arke open` — launch the browser at the client URL (assumes the stack is up).</summary>
public sealed class OpenCommand : Command<OpenCommand.Settings>
{
    public sealed class Settings : GlobalSettings { }

    protected override int Execute(CommandContext context, Settings s, CancellationToken ct)
    {
        var cfg = s.Config();
        Proc.OpenBrowser(cfg.ClientUrl);
        if (!s.Json) AnsiConsole.MarkupLineInterpolated($"[grey]opening[/] {cfg.ClientUrl}");
        return 0;
    }
}

/// <summary>`arke status` — readiness of coordinator/client + config summary; exit 0 only if reachable.</summary>
public sealed class StatusCommand : AsyncCommand<StatusCommand.Settings>
{
    public sealed class Settings : GlobalSettings { }

    protected override async Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct)
    {
        var cfg = s.Config();
        var reachable = await CoordinatorClient.IsReachableAsync(cfg.CoordinatorUrl);
        var status = new
        {
            coordinator = new { url = cfg.CoordinatorUrl, reachable },
            client = new { url = cfg.ClientUrl },
            manageHarness = cfg.ManageHarness,
            projectRoot = cfg.ProjectRoot,
        };

        if (s.Json) { Output.Ok(s, status); return reachable ? 0 : 1; }

        var table = new Table().Border(TableBorder.Rounded);
        table.AddColumn("service");
        table.AddColumn("state");
        table.AddRow("coordinator", reachable ? "[green]reachable[/]" : "[red]down[/]");
        table.AddRow("coordinator url", cfg.CoordinatorUrl);
        table.AddRow("client url", cfg.ClientUrl);
        table.AddRow("manage harness", cfg.ManageHarness ? "on" : "off");
        AnsiConsole.Write(table);
        return reachable ? 0 : 1;
    }
}

/// <summary>`arke doctor` — diagnose the environment (config, reachability, toolchain).</summary>
public sealed class DoctorCommand : AsyncCommand<DoctorCommand.Settings>
{
    public sealed class Settings : GlobalSettings { }

    protected override async Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct)
    {
        var cfg = s.Config();
        var configPresent = File.Exists(Path.Combine(cfg.ProjectRoot, ".arke", "config.json"));
        var reachable = await CoordinatorClient.IsReachableAsync(cfg.CoordinatorUrl);
        var npm = Which(OperatingSystem.IsWindows() ? "npm.cmd" : "npm");

        var checks = new
        {
            projectRoot = cfg.ProjectRoot,
            configPresent,
            coordinatorReachable = reachable,
            coordinatorUrl = cfg.CoordinatorUrl,
            clientUrl = cfg.ClientUrl,
            npmFound = npm,
        };

        if (s.Json) { Output.Ok(s, checks); return 0; }

        AnsiConsole.MarkupLineInterpolated($"project root      {cfg.ProjectRoot}");
        AnsiConsole.MarkupLineInterpolated($".arke/config.json {(configPresent ? "[green]found[/]" : "[yellow]missing[/]")}");
        AnsiConsole.MarkupLineInterpolated($"coordinator       {(reachable ? "[green]reachable[/]" : "[grey]not running[/]")} ({cfg.CoordinatorUrl})");
        AnsiConsole.MarkupLineInterpolated($"npm               {(npm ? "[green]found[/]" : "[red]not found[/]")}");
        return 0;
    }

    private static bool Which(string exe)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = OperatingSystem.IsWindows() ? "where" : "which",
                Arguments = exe,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var p = Process.Start(psi)!;
            p.WaitForExit(3000);
            return p.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }
}
