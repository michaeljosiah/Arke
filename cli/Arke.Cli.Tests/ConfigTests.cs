using Arke.Cli;
using Xunit;

namespace Arke.Cli.Tests;

public class ConfigTests
{
    [Fact]
    public void FindProjectRoot_walks_up_to_the_dir_holding_dot_arke()
    {
        var root = Directory.CreateTempSubdirectory("arke-root-").FullName;
        Directory.CreateDirectory(Path.Combine(root, ".arke"));
        var nested = Directory.CreateDirectory(Path.Combine(root, "a", "b")).FullName;

        Assert.Equal(root, ArkeConfig.FindProjectRoot(nested));
    }

    [Fact]
    public void Load_defaults_to_local_loopback_urls()
    {
        var root = Directory.CreateTempSubdirectory("arke-cfg-").FullName;
        var cfg = ArkeConfig.Load(root);

        Assert.Equal(root, cfg.ProjectRoot);
        Assert.StartsWith("ws://127.0.0.1:", cfg.CoordinatorUrl);
        Assert.StartsWith("http://localhost:", cfg.ClientUrl);
    }

    [Fact]
    public void Load_reads_coordinatorPort_and_manageHarness_from_config()
    {
        var root = Directory.CreateTempSubdirectory("arke-cfg2-").FullName;
        Directory.CreateDirectory(Path.Combine(root, ".arke"));
        File.WriteAllText(
            Path.Combine(root, ".arke", "config.json"),
            """{ "settings": { "coordinatorPort": 4444, "manageHarness": true } }""");

        var cfg = ArkeConfig.Load(root);

        Assert.Equal("ws://127.0.0.1:4444", cfg.CoordinatorUrl);
        Assert.True(cfg.ManageHarness);
    }

    [Fact]
    public void Coordinator_override_wins_over_config()
    {
        var root = Directory.CreateTempSubdirectory("arke-cfg3-").FullName;
        var cfg = ArkeConfig.Load(root, coordinatorOverride: "ws://example:9999");
        Assert.Equal("ws://example:9999", cfg.CoordinatorUrl);
    }
}
