import assert from "node:assert/strict";
import { test } from "node:test";
import { posix, win32 } from "node:path";
import { detectInstalledWith, hostAgentCatalog, KNOWN_HOST_AGENTS } from "../src/host-agents.js";
import { HarnessReachabilityProbe } from "../src/reachability.js";

// SPEC-019 follow-up: host-agent detection is a pure PATH scan (installed) + a reachability probe
// (running). Both are exercised deterministically here — no real filesystem or network.

test("detectInstalled resolves a bare binary via a POSIX PATH entry", () => {
  // Use explicit `:` delimiter and posix.join so this test is portable across host OSes.
  const env = { PATH: "/usr/bin:/opt/oc/bin" };
  const present = new Set([posix.join("/opt/oc/bin", "opencode")]);
  const exists = (p: string) => present.has(p);
  assert.equal(detectInstalledWith(exists, "opencode", env, "linux"), true);
  assert.equal(detectInstalledWith(exists, "claude", env, "linux"), false);
});

test("detectInstalled honours Windows PATHEXT (bare name resolves to .cmd/.exe)", () => {
  // Use explicit `;` delimiter and win32.join so this test exercises Windows behaviour on any host.
  const env = { PATH: "C:\\tools;C:\\oc", PATHEXT: ".COM;.EXE;.CMD" };
  const present = new Set([win32.join("C:\\oc", "opencode.cmd")]);
  // Windows filesystem lookups are case-insensitive, so PATHEXT's uppercase `.CMD` must match an
  // on-disk `opencode.cmd`. Mirror that in the fake predicate (a case-sensitive Set would not).
  const exists = (p: string) => [...present].some((q) => q.toLowerCase() === p.toLowerCase());
  // Windows: bare `opencode` must match `opencode.cmd` through PATHEXT.
  assert.equal(detectInstalledWith(exists, "opencode", env, "win32"), true);
  // POSIX semantics on the same layout would NOT match (exact name only), proving the ext logic runs.
  assert.equal(detectInstalledWith(exists, "opencode", env, "linux"), false);
});

test("detectInstalled is false when PATH is empty or unset", () => {
  const exists = () => true; // even if everything "exists", an empty PATH yields no dirs to scan
  assert.equal(detectInstalledWith(exists, "opencode", { PATH: "" }, "linux"), false);
  assert.equal(detectInstalledWith(exists, "opencode", {}, "linux"), false);
});

/** A probe stub whose health endpoint(s) are reachable iff their base is in `up`. */
function fakeProbe(up: Set<string>): HarnessReachabilityProbe {
  return new HarnessReachabilityProbe({
    fetchImpl: async (url: string) => {
      const base = url.replace(/\/global\/health$/, "");
      if (up.has(base)) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      throw new Error("ECONNREFUSED");
    },
  });
}

test("catalog: OpenCode installed + server up → running with endpoint; others installed-only", async () => {
  const env = { PATH: "/bin" };
  const present = new Set([posix.join("/bin", "opencode"), posix.join("/bin", "claude"), posix.join("/bin", "copilot")]);
  const agents = await hostAgentCatalog({
    env,
    platform: "linux",
    exists: (p) => present.has(p),
    probe: fakeProbe(new Set(["http://127.0.0.1:4096"])),
    opencodeEndpoints: ["http://127.0.0.1:4096"],
  });
  const ids = agents.map((a) => a.id);
  assert.deepEqual(ids, KNOWN_HOST_AGENTS.map((a) => a.id), "every known agent appears, in order");
  // The four core harnesses (+ Omnigent substrate) the launch screen joins status onto by id.
  assert.deepEqual(ids, ["opencode", "claude-code", "codex", "github-copilot", "omnigent"]);

  const opencode = agents.find((a) => a.id === "opencode");
  assert.deepEqual(opencode, { id: "opencode", name: "OpenCode", installed: true, running: true, endpoint: "http://127.0.0.1:4096" });

  const claude = agents.find((a) => a.id === "claude-code");
  assert.equal(claude?.installed, true, "Claude Code binary detected");
  assert.equal(claude?.running, false, "no adapter/server → never running, even when installed");
  assert.equal(claude?.endpoint, undefined);

  const copilot = agents.find((a) => a.id === "github-copilot");
  assert.equal(copilot?.installed, true, "GitHub Copilot binary detected");
  assert.equal(copilot?.running, false, "no adapter/server → never running, even when installed");

  const codex = agents.find((a) => a.id === "codex");
  assert.equal(codex?.installed, false, "Codex binary absent");

  const omnigent = agents.find((a) => a.id === "omnigent");
  assert.equal(omnigent?.installed, undefined, "substrate agent has no installed signal");
  assert.equal(omnigent?.running, false, "substrate agent is never 'running'");
});

test("catalog: OpenCode installed but server DOWN → installed:true, running:false, no endpoint", async () => {
  const present = new Set([posix.join("/bin", "opencode")]);
  const agents = await hostAgentCatalog({
    env: { PATH: "/bin" },
    platform: "linux",
    exists: (p) => present.has(p),
    probe: fakeProbe(new Set()), // nothing reachable
    opencodeEndpoints: ["http://127.0.0.1:4096"],
  });
  const opencode = agents.find((a) => a.id === "opencode");
  assert.equal(opencode?.installed, true);
  assert.equal(opencode?.running, false, "installed but unreachable → not running");
  assert.equal(opencode?.endpoint, undefined, "no endpoint reported when not running");
});

test("catalog: OpenCode NOT on PATH but server running → running:true (binary off PATH is not a blocker)", async () => {
  // The binary may be absent from this process's PATH while OpenCode was launched another way
  // (npx, container, different login shell). The probe runs regardless of `installed`.
  const agentsUp = await hostAgentCatalog({
    env: { PATH: "/bin" },
    platform: "linux",
    exists: () => false, // nothing on PATH
    probe: fakeProbe(new Set(["http://127.0.0.1:4096"])),
    opencodeEndpoints: ["http://127.0.0.1:4096"],
  });
  const opencodeUp = agentsUp.find((a) => a.id === "opencode");
  assert.equal(opencodeUp?.installed, false);
  assert.equal(opencodeUp?.running, true, "server running even when binary is off PATH");
  assert.equal(opencodeUp?.endpoint, "http://127.0.0.1:4096");

  // When neither binary nor server is present, running stays false.
  const agentsDown = await hostAgentCatalog({
    env: { PATH: "/bin" },
    platform: "linux",
    exists: () => false,
    probe: fakeProbe(new Set()),
    opencodeEndpoints: ["http://127.0.0.1:4096"],
  });
  const opencodeDown = agentsDown.find((a) => a.id === "opencode");
  assert.equal(opencodeDown?.installed, false);
  assert.equal(opencodeDown?.running, false, "no server → not running regardless of PATH");
});
