using Arke.Cli.Commands;
using Spectre.Console.Cli;

// `arke` — spin up, open, and drive Arke headlessly (SPEC-017). Headless and --json-first;
// a client of the coordinator over one WebSocket (ADR-0003), never the harness directly.
var app = new CommandApp();
app.Configure(config =>
{
    config.SetApplicationName("arke");

    // ---- service lifecycle ----
    config.AddCommand<UpCommand>("up").WithDescription("Start coordinator + client (+ managed harness) and report ready.");
    config.AddCommand<DownCommand>("down").WithDescription("Stop exactly the services `arke up` started.");
    config.AddCommand<OpenCommand>("open").WithDescription("Open the browser at the client URL.");
    config.AddCommand<StatusCommand>("status").WithDescription("Report coordinator/client readiness and config.");
    config.AddCommand<DoctorCommand>("doctor").WithDescription("Diagnose the environment (config, reachability, toolchain).");

    // ---- operations (map to the coordinator command surface) ----
    config.AddBranch("project", b =>
    {
        b.SetDescription("List, open, close, and forget projects (SPEC-018).");
        b.AddCommand<ProjectListCommand>("list").WithDescription("List durable recent projects.");
        b.AddCommand<ProjectOpenCommand>("open").WithDescription("Open/activate a project by --path or <PROJECT_ID>.");
        b.AddCommand<ProjectCloseCommand>("close").WithDescription("Close an open (non-default) project.");
        b.AddCommand<ProjectForgetCommand>("forget").WithDescription("Forget a project from recents (never deletes files).");
    });
    config.AddBranch("session", b =>
    {
        b.SetDescription("Create and list sessions.");
        b.AddCommand<SessionCreateCommand>("create").WithDescription("Create a session for a spec (or a child task with --parent).");
        b.AddCommand<SessionListCommand>("list").WithDescription("List current sessions/cards.");
    });
    config.AddCommand<PromptCommand>("prompt").WithDescription("Send (or --async dispatch) a prompt to a session as an agent role at a tier.");
    config.AddCommand<WatchCommand>("watch").WithDescription("Stream normalised domain events as NDJSON.");
    config.AddCommand<TodosCommand>("todos").WithDescription("Read a session's todo list.");
    config.AddCommand<DiffCommand>("diff").WithDescription("Read a session's diff summary.");
    config.AddBranch("permission", b =>
    {
        b.SetDescription("List and decide gated actions.");
        b.AddCommand<PermissionListCommand>("list").WithDescription("List pending permissions.");
        b.AddCommand<PermissionDecideCommand>("decide").WithDescription("Decide a permission: --once | --always | --reject [--message].");
    });
    config.AddBranch("grants", b =>
    {
        b.SetDescription("List and revoke remembered grants.");
        b.AddCommand<GrantsListCommand>("list").WithDescription("List remembered grants.");
        b.AddCommand<GrantsRevokeCommand>("revoke").WithDescription("Revoke a remembered grant.");
    });
    config.AddBranch("agents", b =>
    {
        b.SetDescription("List and materialise portable agent images.");
        b.AddCommand<AgentsListCommand>("list").WithDescription("List agent images under agents/.");
        b.AddCommand<AgentsMaterializeCommand>("materialize").WithDescription("Materialise agent images into the harness convention.");
    });
    config.AddBranch("trace", b =>
    {
        b.SetDescription("Inspect the append-only audit trace.");
        b.AddCommand<TraceTailCommand>("tail").WithDescription("Print the last N trace records.");
    });
});

return await app.RunAsync(args);
