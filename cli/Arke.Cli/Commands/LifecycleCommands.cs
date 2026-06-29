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
        var handle = new RunHandle { StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };

        var alreadyUp = await CoordinatorClient.IsReachableAsync(cfg.CoordinatorUrl);
        if (alreadyUp)
        {
            if (!s.Json) AnsiConsole.MarkupLineInterpolated($"[grey]coordinator already running at[/] {cfg.CoordinatorUrl} [grey]— attaching[/]");
        }
        else
        {
            // arke up manages the harness by default (Decision #8) — the coordinator owns it (SPEC-016).
            var env = new Dictionary<string, string?>
            {
                ["ARKE_MANAGE_HARNESS"] = s.NoManageHarness ? "false" : "true",
            };
            var coord = Proc.StartNpm(cfg.ProjectRoot, "run dev:coordinator", env);
            handle.CoordinatorPid = coord.Id;
        }

        if (!s.NoClient)
        {
            var client = Proc.StartNpm(cfg.ProjectRoot, $"run dev --workspace @arke/client -- --port {ArkeConfig.DefaultClientPort} --strictPort");
            handle.ClientPid = client.Id;
        }

        handle.Save(cfg.ProjectRoot);

        var ready = await WaitForReady(cfg.CoordinatorUrl, TimeSpan.FromSeconds(40));
        if (!ready)
            return Output.Error($"coordinator did not become ready at {cfg.CoordinatorUrl} within 40s", s.Json);

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

        var stopped = new List<string>();
        if (handle.ClientPid is int cp) { Proc.Kill(cp); stopped.Add("client"); }
        if (handle.CoordinatorPid is int kp) { Proc.Kill(kp); stopped.Add("coordinator"); }
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
