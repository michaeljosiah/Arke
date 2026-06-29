using System.Text.Json;
using Spectre.Console;
using Spectre.Console.Cli;

namespace Arke.Cli.Commands;

/// <summary>Shared op-call pattern: send to the coordinator, render the result, map errors to exit codes.</summary>
internal static class Ops
{
    /// <summary>
    /// Run an op. When <paramref name="activate"/> (the default, for per-project ops), the project
    /// is resolved per invocation and opened on the op's own connection first (SPEC-018) —
    /// precedence `--project` &gt; the CLI-local recorded default (`arke project open`) &gt; none.
    /// Global ops (project.list/close/forget, which manage projects themselves) pass activate:false.
    /// </summary>
    public static async Task<int> RunAsync(GlobalSettings s, string op, object? args, bool activate = true)
    {
        try
        {
            var url = s.Config().CoordinatorUrl;
            var res = await CoordinatorClient.RequestWithActivationAsync(url, activate ? ResolveActivation(s) : null, op, args);
            return Output.Render(s, res);
        }
        catch (Exception e)
        {
            return Output.Error(e.Message, s.Json);
        }
    }

    /// <summary>Resolve the project to activate for an op: `--project` &gt; CLI-local default &gt; none.</summary>
    private static object? ResolveActivation(GlobalSettings s)
    {
        if (!string.IsNullOrWhiteSpace(s.Project)) return new { path = System.IO.Path.GetFullPath(s.Project) };
        var active = CliActive.Load(s.Config().ProjectRoot);
        if (!string.IsNullOrWhiteSpace(active?.ProjectId)) return new { projectId = active!.ProjectId };
        if (!string.IsNullOrWhiteSpace(active?.Path)) return new { path = active!.Path };
        return null; // no recorded selection → the coordinator's default project
    }
}

public sealed class ProjectListCommand : AsyncCommand<ProjectListCommand.Settings>
{
    public sealed class Settings : GlobalSettings { }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "project.list", null, activate: false);
}

/// <summary>`arke project open` — activate a project by --path or a positional project id (SPEC-018).</summary>
public sealed class ProjectOpenCommand : AsyncCommand<ProjectOpenCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandArgument(0, "[PROJECT_ID]")]
        public string? ProjectId { get; set; }

        [CommandOption("--path <DIR>")]
        public string? Path { get; set; }

        public override ValidationResult Validate() =>
            string.IsNullOrWhiteSpace(ProjectId) && string.IsNullOrWhiteSpace(Path)
                ? ValidationResult.Error("provide a <PROJECT_ID> or --path <DIR>")
                : ValidationResult.Success();
    }

    protected override async Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct)
    {
        // Send an ABSOLUTE path: a relative --path would otherwise be resolved in the coordinator's
        // cwd, not the CLI caller's, opening the wrong directory.
        var absPath = string.IsNullOrWhiteSpace(s.Path) ? null : System.IO.Path.GetFullPath(s.Path);
        try
        {
            var res = await CoordinatorClient.RequestAsync(s.Config().CoordinatorUrl, "project.open", new { projectId = s.ProjectId, path = absPath });
            // Persist the selection locally so subsequent (separate-process) commands re-activate it.
            var pid = res.ValueKind == JsonValueKind.Object && res.TryGetProperty("projectId", out var p) ? p.GetString() : null;
            CliActive.Save(s.Config().ProjectRoot, pid, absPath);
            return Output.Render(s, res);
        }
        catch (Exception e)
        {
            return Output.Error(e.Message, s.Json);
        }
    }
}

public sealed class ProjectCloseCommand : AsyncCommand<ProjectCloseCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandArgument(0, "<PROJECT_ID>")]
        public string ProjectId { get; set; } = "";
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "project.close", new { projectId = s.ProjectId }, activate: false);
}

public sealed class ProjectForgetCommand : AsyncCommand<ProjectForgetCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandArgument(0, "<PROJECT_ID>")]
        public string ProjectId { get; set; } = "";
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "project.forget", new { projectId = s.ProjectId }, activate: false);
}

public sealed class SessionCreateCommand : AsyncCommand<SessionCreateCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandOption("--spec <SPEC_ID>")]
        public string Spec { get; set; } = "";

        [CommandOption("--parent <SESSION_ID>")]
        public string? Parent { get; set; }

        // A session must be tied to a specification (the source of truth) — refuse an empty spec id
        // rather than persisting an unowned session in the graph.
        public override ValidationResult Validate() =>
            string.IsNullOrWhiteSpace(Spec)
                ? ValidationResult.Error("--spec <SPEC_ID> is required")
                : ValidationResult.Success();
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "session.create", new { specId = s.Spec, parent = s.Parent });
}

public sealed class SessionListCommand : AsyncCommand<SessionListCommand.Settings>
{
    public sealed class Settings : GlobalSettings { }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "session.list", null);
}

public sealed class PromptCommand : AsyncCommand<PromptCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandArgument(0, "<SESSION_ID>")]
        public string SessionId { get; set; } = "";

        [CommandOption("--agent <ROLE>")]
        public string Agent { get; set; } = "";

        [CommandOption("--tier <TIER>")]
        public string Tier { get; set; } = "mid";

        [CommandOption("--message <TEXT>")]
        public string? Message { get; set; }

        [CommandOption("--async")]
        public bool Async { get; set; }

        public override Spectre.Console.ValidationResult Validate() =>
            Tier is "capable" or "mid" or "fast"
                ? Spectre.Console.ValidationResult.Success()
                : Spectre.Console.ValidationResult.Error("--tier must be 'capable', 'mid', or 'fast'");
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, s.Async ? "prompt.dispatch" : "prompt.send",
            new { sessionId = s.SessionId, agent = s.Agent, tier = s.Tier, message = s.Message ?? "" });
}

/// <summary>`arke watch` — stream normalised domain events as NDJSON until Ctrl-C.</summary>
public sealed class WatchCommand : AsyncCommand<WatchCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandOption("--session <SESSION_ID>")]
        public string? Session { get; set; }
    }

    protected override async Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct)
    {
        var cfg = s.Config();
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
        try
        {
            await CoordinatorClient.WatchAsync(cfg.CoordinatorUrl, ev =>
            {
                if (s.Session is not null &&
                    (!ev.TryGetProperty("sessionId", out var sid) || sid.GetString() != s.Session))
                    return;
                Console.WriteLine(ev.GetRawText()); // NDJSON, one event per line
            }, cts.Token);
            return 0;
        }
        catch (Exception e)
        {
            return Output.Error(e.Message, s.Json);
        }
    }
}

public sealed class TodosCommand : AsyncCommand<TodosCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandArgument(0, "<SESSION_ID>")]
        public string SessionId { get; set; } = "";
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "todos.get", new { sessionId = s.SessionId });
}

public sealed class DiffCommand : AsyncCommand<DiffCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandArgument(0, "<SESSION_ID>")]
        public string SessionId { get; set; } = "";
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "diff.get", new { sessionId = s.SessionId });
}

public sealed class PermissionListCommand : AsyncCommand<PermissionListCommand.Settings>
{
    public sealed class Settings : GlobalSettings { }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "permission.list", null);
}

/// <summary>`arke permission decide` — explicit once/always/reject (+message); never auto-approves.</summary>
public sealed class PermissionDecideCommand : AsyncCommand<PermissionDecideCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandArgument(0, "<PERMISSION_ID>")]
        public string PermissionId { get; set; } = "";

        [CommandOption("--once")]
        public bool Once { get; set; }

        [CommandOption("--always")]
        public bool Always { get; set; }

        [CommandOption("--reject")]
        public bool Reject { get; set; }

        [CommandOption("--message <TEXT>")]
        public string? Message { get; set; }

        public override Spectre.Console.ValidationResult Validate()
        {
            var n = (Once ? 1 : 0) + (Always ? 1 : 0) + (Reject ? 1 : 0);
            return n == 1
                ? Spectre.Console.ValidationResult.Success()
                : Spectre.Console.ValidationResult.Error("specify exactly one of --once | --always | --reject");
        }
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct)
    {
        var decision = s.Reject ? "reject" : s.Always ? "always" : "once";
        return Ops.RunAsync(s, "permission.decide",
            new { permissionId = s.PermissionId, decision, message = s.Message });
    }
}

public sealed class GrantsListCommand : AsyncCommand<GrantsListCommand.Settings>
{
    public sealed class Settings : GlobalSettings { }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "grant.list", null);
}

public sealed class GrantsRevokeCommand : AsyncCommand<GrantsRevokeCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandArgument(0, "<GRANT_ID>")]
        public string GrantId { get; set; } = "";
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "grant.revoke", new { grantId = s.GrantId });
}

public sealed class AgentsListCommand : AsyncCommand<AgentsListCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandOption("--dir <DIR>")]
        public string? Dir { get; set; }
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "agents.list", new { dir = s.Dir });
}

public sealed class AgentsMaterializeCommand : AsyncCommand<AgentsMaterializeCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandOption("--dir <DIR>")]
        public string? Dir { get; set; }
    }

    protected override Task<int> ExecuteAsync(CommandContext context, Settings s, CancellationToken ct) =>
        Ops.RunAsync(s, "agents.materialize", new { dir = s.Dir });
}

/// <summary>`arke trace tail` — read the local append-only audit trace (no coordinator needed).</summary>
public sealed class TraceTailCommand : Command<TraceTailCommand.Settings>
{
    public sealed class Settings : GlobalSettings
    {
        [CommandOption("--lines <N>")]
        public int Lines { get; set; } = 20;
    }

    protected override int Execute(CommandContext context, Settings s, CancellationToken ct)
    {
        var cfg = s.Config();
        var path = Path.Combine(cfg.ProjectRoot, ".arke", "trace.ndjson");
        if (!File.Exists(path))
            return Output.Error($"no trace at {path}", s.Json);

        var tail = File.ReadLines(path).Where(l => l.Trim().Length > 0).TakeLast(Math.Max(1, s.Lines));
        foreach (var line in tail) Console.WriteLine(line);
        return 0;
    }
}
