import React from 'react';
import { Icon } from '../icons';
import { Button, Input, Card, SpecCard, StatusDot, Tabs, Badge } from '../ds';
import { Wordmark } from '../shell';
import { Page, SectionHead } from '../utils';
import { store, useStore } from '../store';
import { liveSend, openProjectLive } from '../live';

const e = React.createElement;

/**
 * The supported coding agents for first-run quick setup (SPEC-019), matching the canonical
 * `arke-design` `SO_HarnessSetup` panel. Omnigent is a substrate choice: instead of install/start
 * commands it prompts for an Omnigent URL the coordinator validates before connecting (no
 * auto-detection). `driver` is sent verbatim to `harness.connect`.
 */
const HARNESS_SETUP = [
  { id: 'opencode', name: 'OpenCode', driver: 'opencode', scheme: 'opencode://', host: 'localhost:4096', recommended: true, note: 'open source · self-hostable · the reference harness', install: 'curl -fsSL https://opencode.ai/install | sh', start: 'opencode serve --port 4096' },
  { id: 'claude-code', name: 'Claude Code', driver: 'claude-code', scheme: 'acp://', host: 'localhost:7223', note: 'speaks ACP · normalised by the local coordinator', install: 'npm i -g @anthropic-ai/claude-code', start: 'claude-code acp --port 7223' },
  { id: 'codex', name: 'Codex', driver: 'codex', scheme: 'codex://', host: 'localhost:8088', note: 'experimental adapter · capability-flagged', install: 'npm i -g @openai/codex', start: 'codex serve --port 8088' },
  { id: 'omnigent', name: 'Omnigent', driver: 'omnigent', substrate: true, scheme: '', host: '', note: 'meta-harness substrate — enter your Omnigent URL to validate & connect', placeholder: 'https://omnigent.internal:8790' },
] as const;

/**
 * First-run quick setup (SPEC-019): choose a coding agent (or the Omnigent substrate), see its
 * install/start commands, or point at an existing host and Connect. The coordinator validates the
 * endpoint, persists the harness to the GLOBAL config, and reloads the context — the fresh snapshot
 * then flips the harness gate. Authentication happens in the harness; Arke never collects credentials.
 */
function HarnessSetup() {
  const connecting = useStore((s) => s.harnessConnecting);
  const error = useStore((s) => s.harnessConnectError);
  const [sel, setSel] = React.useState<string>('opencode');
  const h = HARNESS_SETUP.find((x) => x.id === sel) ?? HARNESS_SETUP[0];
  const [host, setHost] = React.useState<string>(h.host);
  React.useEffect(() => { setHost(h.host); }, [sel]);
  const connect = () => {
    const value = host.trim();
    if (!value) return;
    store.set({ harnessConnecting: true, harnessConnectError: null });
    liveSend({ type: 'harness.connect', driver: h.driver, endpoint: (h.scheme || '') + value });
  };
  const Cmd = ({ label, cmd }: any) => e('div', { style: { marginBottom: 10 } },
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, marginBottom: 4 } }, label),
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--neutral-950)', borderRadius: 'var(--radius-md)', padding: '8px 11px' } },
      e('span', { style: { flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#86EFAC', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '$ ' + cmd),
      e('span', { style: { display: 'flex', color: '#737373', cursor: 'pointer' }, onClick: () => { try { void navigator.clipboard?.writeText(cmd); } catch { /* ignore */ } } }, e(Icon, { name: 'copy', size: 13 }))));
  return e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 14, marginBottom: 18, background: 'var(--background)' } },
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, marginBottom: 8 } }, 'Choose your coding agent'),
    e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 } },
      HARNESS_SETUP.map((x) => e('button', { key: x.id, onClick: () => setSel(x.id),
        style: { display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 'var(--radius-md)', cursor: 'pointer', border: '1px solid ' + (sel === x.id ? 'var(--foreground)' : 'var(--border)'), background: sel === x.id ? 'var(--accent)' : 'var(--card)', fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500, color: 'var(--foreground)' } },
        e('span', { style: { display: 'flex', color: sel === x.id ? 'var(--foreground)' : 'var(--muted-foreground)' } }, e(Icon, { name: 'server', size: 14 })),
        x.name,
        (x as any).recommended ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted-foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 5px' } }, 'recommended') : null))),
    e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 12 } }, h.note),
    (h as any).substrate ? null : e(Cmd, { label: 'Install', cmd: (h as any).install }),
    (h as any).substrate ? null : e(Cmd, { label: 'Start', cmd: (h as any).start }),
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 8px' } },
      e('span', { style: { flex: 1, height: 1, background: 'var(--border)' } }),
      e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, (h as any).substrate ? 'Omnigent URL' : 'or point at an existing host'),
      e('span', { style: { flex: 1, height: 1, background: 'var(--border)' } })),
    e('div', { style: { display: 'flex', gap: 8 } },
      e('div', { style: { flex: 1, minWidth: 0 } }, e(Input, { mono: true, prefix: h.scheme || undefined, placeholder: (h as any).placeholder, value: host, onChange: (ev: any) => setHost(ev.target.value) })),
      e(Button, { variant: 'secondary', style: { flex: 'none' }, disabled: connecting || !host.trim(), onClick: connect }, connecting ? 'Connecting…' : 'Connect')),
    error ? e('p', { style: { margin: '8px 0 0', fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--warning, #B45309)' } }, 'could not connect — ' + error) : null,
    e('p', { style: { margin: '10px 0 0', fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--muted-foreground)', lineHeight: 1.5 } }, 'Authentication happens in the harness — Arke never collects credentials.'));
}

/**
 * First-run picker — follows the canonical `arke-design` launch screen (numbered steps:
 * 1 Harness, 2 Open a project, then Recent projects), wired to REAL coordinator state. The
 * coordinator is single-project, so "Recent projects" reflects the one connected project; the
 * entry cards stay disabled until a harness is confirmed reachable.
 */
export function Picker() {
  const live = useStore((s) => s.live);
  const connection = useStore((s) => s.connection);
  const cp = useStore((s) => s.connectedProject);
  const projectState = useStore((s) => s.projectState);
  const recents = useStore((s) => s.recents);
  const harnessReachable = useStore((s) => s.harnessReachable);
  const reason = useStore((s) => s.harnessReachabilityReason);
  const harnessSetup = useStore((s) => s.harnessSetup);
  const [setup, setSetup] = React.useState(false);
  const [cloneOpen, setCloneOpen] = React.useState(false);
  const [cloneUrl, setCloneUrl] = React.useState('');
  const [reprobing, setReprobing] = React.useState(false);

  // probe state mirrors the template: checking (connecting) → reachable / unreachable.
  const connecting = !live && (connection === 'connecting' || connection === 'reconnecting' || connection === 'offline');
  const probe = live ? (harnessReachable ? 'reachable' : 'unreachable') : (connecting ? 'checking' : 'unreachable');
  const ready = probe === 'reachable';
  // First-run quick setup (SPEC-019): when live and NO harness is configured anywhere (global or
  // project), guide setup (choose an agent / point at a host) instead of the configured-but-down
  // re-probe card. A configured-but-unreachable harness keeps the re-probe path.
  const configured = harnessSetup?.configured !== false;
  const showQuickSetup = live && !configured && !ready;
  // Scaffolding is the remedy for a project that has no harness yet: a greenfield/has-code/partial
  // project must be able to reach Initialisation even when the harness is unreachable, because the
  // `config` scaffold step is what writes .arke/config.json and brings the harness up. A method-ready
  // project that's unreachable is a genuine harness-down situation and stays gated. (PR #10 review)
  const canScaffold = ready || (!!projectState && projectState !== 'method-ready');
  const endpoint = (cp && cp.endpoint) || 'opencode://localhost:4096';
  const STATE_LABEL: Record<string, string> = { 'method-ready': 'method-ready', 'partial-scaffold': 'partial scaffold', 'has-code': 'existing code', 'empty': 'empty · ready to scaffold' };

  const reprobe = () => { setReprobing(true); liveSend({ type: 'harness.probe' }); setTimeout(() => setReprobing(false), 1000); };
  // entryPath is the coordinator-relative path the init screen scaffolds. Open/New target the
  // project root ('.'); Clone targets the freshly cloned subdirectory so scaffolding writes there.
  const toInit = (name: string, path: string) => store.set({ project: { name, specs: 0 }, entryPath: path, view: 'init' });
  const enter = (name: string, state: string | null) => store.set({ project: { name, specs: 0 }, entryPath: '.', view: state === 'method-ready' ? 'library' : 'init' });
  const openProject = () => { if (cp) enter(cp.name, projectState); };
  // Switch the coordinator's active project to a recent, then route into it by its real state.
  const openRecent = (entry: any) => {
    if (cp && entry.projectId === cp.projectId) return enter(cp.name, projectState);
    void openProjectLive({ projectId: entry.projectId }).then((res) => {
      if (res?.ok) enter(res.result.name, res.result.state);
    });
  };
  const clone = () => {
    const url = cloneUrl.trim();
    if (!url) return;
    const name = (url.split('/').pop() || 'repo').replace(/\.git$/, '');
    liveSend({ type: 'repo.clone', url, targetPath: name });
    toInit(name, name); // scaffold the cloned dir, not the coordinator root
  };

  const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, color: 'var(--foreground)' } as const;
  const stepNum = (n: string, label: string, extra?: any) => e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
    e('span', { style: { width: 18, height: 18, borderRadius: 999, background: 'var(--secondary)', color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600 } }, n),
    e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600 } }, label),
    e('span', { style: { flex: 1 } }), extra || null);

  const EntryCard = ({ icon, title, sub, onClick, primary, enabled = ready }: any) => e('button', { onClick: enabled ? onClick : undefined, disabled: !enabled,
    style: { appearance: 'none', textAlign: 'left', cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid ' + (primary ? 'var(--foreground)' : 'var(--border)'), background: primary ? 'var(--foreground)' : 'var(--card)', color: primary ? 'var(--background)' : 'var(--foreground)', width: '100%' } },
    e('span', { style: { display: 'flex', color: primary ? 'var(--background)' : 'var(--muted-foreground)' } }, e(Icon, { name: icon, size: 18 })),
    e('div', { style: { flex: 1, minWidth: 0 } },
      e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600 } }, title),
      e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: primary ? 'rgba(255,255,255,0.7)' : 'var(--muted-foreground)' } }, sub)),
    e('span', { style: { display: 'flex', color: primary ? 'var(--background)' : 'var(--neutral-400)' } }, e(Icon, { name: 'arrowRight', size: 16 })));

  // Real recents from the coordinator registry (SPEC-018 project.list), most-recent-first.
  const recentList = ready ? (recents || []) : [];

  return e('div', { style: { height: '100%', width: '100%', background: 'var(--muted)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto' } },
    e('div', { style: { width: 540, padding: '40px 32px 64px' } },
      e('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: 14 } },
        e('div', { style: { background: 'var(--primary)', borderRadius: 'var(--radius-xl)', padding: '14px 22px' } }, e(Wordmark, { size: 26, onDark: true }))),
      e('p', { style: { textAlign: 'center', margin: '0 0 22px', fontFamily: 'var(--font-sans)', fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', fontWeight: 600 } }, 'Specification Orchestrator'),

      e(Card, { padding: 22 },
        // 1 · harness readiness
        stepNum('1', 'Harness', ready ? e('button', { onClick: () => setSetup((o) => !o), style: linkBtn }, setup ? 'Hide' : 'Change host') : null),
        probe === 'checking'
          ? e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--background)', marginBottom: 18 } },
              e(StatusDot, { status: 'running', pulse: true }),
              e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)' } }, 'probing for a coding agent on the host…'))
          : ready
            ? e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--background)', marginBottom: setup ? 12 : 18 } },
                e(StatusDot, { status: 'agree' }),
                e('div', { style: { flex: 1, minWidth: 0 } },
                  e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600 } }, 'Reachable'),
                  e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, endpoint)),
                cp && cp.harness ? e(Badge, { variant: 'secondary' }, cp.harness) : null)
            : e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', border: '1px solid color-mix(in srgb, var(--warning) 40%, var(--border))', borderRadius: 'var(--radius-lg)', background: 'var(--warning-bg, var(--secondary))', marginBottom: 12 } },
                e('span', { style: { color: 'var(--warning, #B45309)', display: 'flex' } }, e(Icon, { name: 'alert', size: 16 })),
                e('div', { style: { flex: 1, minWidth: 0 } },
                  e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600 } }, 'No coding agent is running'),
                  e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--muted-foreground)' } }, !configured ? 'Arke runs on a coding agent on the host. Install it, start it, or point at an existing host.' : reason ? 'reason: ' + reason : 'Arke runs on a coding agent on the host. Start one (e.g. opencode serve), then re-probe.'))),
        showQuickSetup
          ? e(HarnessSetup)
          : (probe === 'unreachable') || setup
          ? e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 14, marginBottom: 18, background: 'var(--background)' } },
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', lineHeight: 1.6, marginBottom: 10 } },
                'The harness is configured in ', e('span', { style: { color: 'var(--foreground)' } }, '.arke/config.json'), ' on the host — the client never holds the endpoint or credentials. Start the harness, then re-probe.'),
              e(Button, { variant: 'secondary', iconLeft: e(Icon, { name: 'refresh', size: 14 }), disabled: reprobing, onClick: reprobe }, reprobing ? 're-probing…' : 'Re-probe'))
          : null,

        // 2 · entry
        stepNum('2', 'Open a project', ready ? null : e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, canScaffold ? 'scaffold to configure a harness' : 'connect a harness first')),
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: 9, marginBottom: cloneOpen ? 10 : 18 } },
          e(EntryCard, { icon: 'folder', title: 'Open folder', sub: 'Open the connected project — Arke detects and adapts', primary: true, enabled: canScaffold, onClick: openProject }),
          e(EntryCard, { icon: 'branch', title: 'Clone repository', sub: 'Clone a URL into a new working folder', enabled: canScaffold, onClick: () => setCloneOpen((o) => !o) }),
          e(EntryCard, { icon: 'folderPlus', title: 'New project', sub: 'Scaffold a greenfield, method-ready project', enabled: canScaffold, onClick: () => toInit((cp && cp.name) || 'new-service', '.') })),
        cloneOpen ? e('div', { style: { display: 'flex', gap: 8, marginBottom: 18 } },
          e('div', { style: { flex: 1, minWidth: 0 } }, e(Input, { mono: true, prefix: 'https://', placeholder: 'github.com/acme/repo', value: cloneUrl, onChange: (ev: any) => setCloneUrl(ev.target.value) })),
          e(Button, { style: { flex: 'none' }, disabled: !canScaffold || !cloneUrl.trim(), onClick: clone }, 'Clone')) : null,

        recentList.length
          ? e('div', null,
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 10 } }, 'Recent projects'),
              e('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
                recentList.map((p: any) => e('button', { key: p.projectId || p.root || p.name, onClick: () => openRecent(p), style: { appearance: 'none', textAlign: 'left', cursor: 'pointer', background: 'var(--background)', border: '1px solid ' + (cp && p.projectId === cp.projectId ? 'var(--foreground)' : 'var(--border)'), borderRadius: 'var(--radius-lg)', padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 12 },
                  onMouseEnter: (ev: any) => ev.currentTarget.style.background = 'var(--accent)', onMouseLeave: (ev: any) => ev.currentTarget.style.background = 'var(--background)' },
                  e('span', { style: { color: 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: 'folder', size: 18 })),
                  e('div', { style: { flex: 1, minWidth: 0 } },
                    e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--foreground)' } }, p.name + (cp && p.projectId === cp.projectId ? '  ·  active' : '')),
                    e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, (STATE_LABEL[p.lastState] || p.lastState || 'unknown') + (p.root ? ' · ' + p.root : ''))),
                  e('span', { style: { color: 'var(--neutral-400)', display: 'flex' } }, e(Icon, { name: 'chevron', size: 16 }))))))
          : e('div', { style: { padding: '16px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)', textAlign: 'center', fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)' } },
              ready ? 'No recent projects — open a folder to begin' : canScaffold ? 'Scaffold a new project to begin' : 'Connect a harness to see your project'),
      ),
      e('p', { style: { textAlign: 'center', margin: '16px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)', lineHeight: 1.6 } }, 'the client never holds credentials · the host is the trust boundary'),
    ),
  );
}

const SCAFFOLD = [
  { id: 'config', icon: 'settings', title: 'Project configuration', detail: '.arke/config.json — the registry: tier→model mapping (capable/mid/fast) and the role roster; vendor model ids live only here', lines: ['+ .arke/config.json'] },
  { id: 'agents', icon: 'bot', title: 'Agent roster', detail: '.opencode/agents/ — six canonical roles: spec-author, architect, reviewer-a/b, implementer, researcher', lines: ['+ .opencode/agents/spec-author.md', '+ .opencode/agents/architect.md', '+ .opencode/agents/implementer.md', '+ .opencode/agents/researcher.md'] },
  { id: 'specs', icon: 'fileText', title: 'Specification structure', detail: 'docs/specifications/ with specification.template.md — SHALL statements, WHEN/THEN scenarios, delta tags', lines: ['+ docs/specifications/', '+ docs/specifications/specification.template.md'] },
  { id: 'grounding', icon: 'book', title: 'Grounding baseline', detail: 'AGENTS.md baseline stub, enriched in full by the researcher grounding session', lines: ['+ AGENTS.md', '+ .repos/ (read-only references)'] },
  { id: 'plugins', icon: 'shield', title: 'Policy & projection plugins', detail: 'Permission policy hooks and deterministic spec → record projection', lines: ['+ .opencode/plugins/policy.ts', '+ .opencode/plugins/projection.ts'] },
];

export function Initialisation() {
  const project = useStore((s) => s.project);
  const tiers = useStore((s) => s.tiers);
  const live = useStore((s) => s.live);
  const tierDefaults = useStore((s) => s.tierDefaults);
  const projectState = useStore((s) => s.projectState);
  const missingSentinels = useStore((s) => s.missingSentinels);
  const scaffold = useStore((s) => s.scaffold);
  const entryPath = useStore((s) => s.entryPath);
  const [repo, setRepo] = React.useState('github.com/acme/new-service');
  const [running, setRunning] = React.useState(false);
  const [done, setDone] = React.useState({});
  const [log, setLog] = React.useState([]);
  const [finished, setFinished] = React.useState(false);

  // In live mode the scaffold runs on the coordinator and its progress folds into store.scaffold;
  // offline (prototype) it falls back to a simulation so the screen still demos. Tier defaults come
  // from the registry — when absent, scaffolding is blocked rather than run with empty values (D9).
  const liveSteps = (scaffold && scaffold.steps) || {};
  const isDone = (id) => live ? (liveSteps[id] === 'done' || liveSteps[id] === 'skipped') : !!done[id];
  const isRunningStep = (id) => live ? liveSteps[id] === 'running' : running;
  const effLog = live ? ((scaffold && scaffold.log) || []) : log;
  const effRunning = live ? !!(scaffold && scaffold.running) : running;
  const effFinished = live ? !!(scaffold && scaffold.done) : finished;
  // The coordinator now supplies gateway tier defaults even for a greenfield project, so scaffolding
  // is no longer blocked: the `config` step writes .arke/config.json (which the engineer then edits
  // with real models). Kept as a guard only for a truly empty registry.
  const tiersBlocked = live && (!tierDefaults || !tierDefaults.capable || !tierDefaults.mid);
  // Tier rows: registry-resolved models in live mode; the static prototype tiers otherwise. Three
  // logical tiers — capable (authoring/review), mid (implementation), fast (routine/classification).
  const tierRows = live
    ? [
        { tier: 'capable', label: 'Capable tier', model: (tierDefaults && tierDefaults.capable) || 'capable — not configured' },
        { tier: 'mid', label: 'Mid tier', model: (tierDefaults && tierDefaults.mid) || 'mid — not configured' },
        { tier: 'fast', label: 'Fast tier', model: (tierDefaults && tierDefaults.fast) || 'fast — not configured' },
      ]
    : tiers;

  const run = () => {
    if (tiersBlocked) return;
    if (live) {
      store.set({ scaffold: { steps: {}, log: [], running: true, done: false } });
      // Scaffold the path the picker selected (the cloned subdir for a clone, '.' otherwise) so a
      // cloned repo is made method-ready in place rather than writing into the coordinator root.
      liveSend({ type: 'scaffold.run', path: entryPath || '.' });
      return;
    }
    setRunning(true); setDone({}); setLog([]); setFinished(false);
    let i = 0;
    const stepAll = () => {
      if (i >= SCAFFOLD.length) {
        setLog((l) => [...l, { t: 'ok', m: 'project is method-ready — 0 errors, typecheck passes' }]);
        setFinished(true); setRunning(false); return;
      }
      const s = SCAFFOLD[i];
      setLog((l) => [...l, { t: 'run', m: 'scaffolding ' + s.title.toLowerCase() + '…' }]);
      setTimeout(() => {
        setLog((l) => [...l, ...s.lines.map((m) => ({ t: 'file', m }))]);
        setDone((d) => ({ ...d, [s.id]: true }));
        i++; setTimeout(stepAll, 350);
      }, 650);
    };
    stepAll();
  };

  const stateNote = projectState === 'partial-scaffold'
    ? 'Partial scaffold detected — missing: ' + (missingSentinels || []).join(', ') + '. Existing files are left untouched; only what is missing will be added.'
    : projectState === 'has-code'
      ? 'Existing code detected — scaffolding adds the method structure only and never modifies your source.'
      : null;

  return e(Page, { max: 1000 },
    e(SectionHead, { eyebrow: 'Setup', title: 'Initialise a method-ready project', sub: 'Scaffolding a repository is a first-class action, not a manual checklist. This writes the agent roster, the specification structure, the grounding baseline and the governance plugins so the repo is method-ready from the first commit.' }),
    stateNote ? e('div', { style: { marginBottom: 14, padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--secondary)', fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--foreground)' } }, stateNote) : null,
    e('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' } },
      e('div', null,
        e(Card, { padding: 18, style: { marginBottom: 16 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, marginBottom: 8 } }, 'Repository'),
          e(Input, { mono: true, prefix: 'https://', value: repo, onChange: (ev) => setRepo(ev.target.value) }),
          e('div', { style: { display: 'flex', gap: 12, marginTop: 14, flexWrap: 'wrap' } },
            tierRows.map((t) => e('div', { key: t.tier, style: { flex: '1 1 120px', minWidth: 0 } },
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, color: 'var(--muted-foreground)', marginBottom: 6 } }, t.label),
              e(Input, { mono: true, size: 'sm', value: t.model, onChange: () => {} })))),
          e('p', { style: { margin: '10px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: tiersBlocked ? 'var(--warning, #B45309)' : 'var(--muted-foreground)', lineHeight: 1.5 } },
            tiersBlocked ? 'tier defaults are not configured — configure the registry (.arke/config.json) before scaffolding' : 'agents reference logical tiers, resolved per project to the internal gateway')),
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          SCAFFOLD.map((s) => e('div', { key: s.id, style: { display: 'flex', gap: 12, padding: '13px 15px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--card)' } },
            e('span', { style: { flex: 'none', width: 32, height: 32, borderRadius: 'var(--radius-md)', background: isDone(s.id) ? 'var(--success-bg)' : 'var(--secondary)', color: isDone(s.id) ? 'var(--success)' : 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: isDone(s.id) ? 'check' : s.icon, size: 17 })),
            e('div', { style: { flex: 1 } },
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' } }, s.title),
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)', lineHeight: 1.45, marginTop: 2 } }, s.detail)),
            isDone(s.id) ? e(StatusDot, { status: 'done' }) : isRunningStep(s.id) ? e(StatusDot, { status: 'running', pulse: true }) : e(StatusDot, { status: 'idle' }),
          )),
        ),
      ),
      e('div', { style: { position: 'sticky', top: 0 } },
        e('div', { style: { background: 'var(--neutral-950)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border)', overflow: 'hidden', display: 'flex', flexDirection: 'column', height: 420 }, role: 'log', 'aria-live': 'polite' },
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' } },
            e('span', { style: { display: 'flex', color: '#A1A1A1' } }, e(Icon, { name: 'terminal', size: 15 })),
            e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#A1A1A1' } }, 'arke init · ' + (project ? project.name : 'new-service'))),
          e('div', { style: { flex: 1, overflowY: 'auto', padding: '14px', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.7 } },
            effLog.length === 0 ? e('div', { style: { color: '#737373' } }, '$ awaiting init…') : null,
            effLog.map((l, i) => e('div', { key: i, style: { color: l.t === 'ok' ? '#4ADE80' : l.t === 'err' ? '#F87171' : l.t === 'skip' ? '#FBBF24' : l.t === 'file' ? '#A1A1A1' : '#E5E5E5' } }, (l.t === 'file' ? '  ' : '$ ') + l.m)),
          ),
        ),
        e('div', { style: { display: 'flex', gap: 10, marginTop: 14, justifyContent: 'flex-end' } },
          e(Button, { variant: 'outline', onClick: () => store.set({ project: null, view: 'picker' }) }, 'Cancel'),
          effFinished
            ? e(Button, { iconLeft: e(Icon, { name: 'arrowRight', size: 15 }), onClick: () => store.set({ view: 'cockpit' }) }, 'Open authoring cockpit')
            : e(Button, { disabled: effRunning || tiersBlocked, iconLeft: e(Icon, { name: effRunning ? 'refresh' : 'play', size: 15 }), onClick: run }, effRunning ? 'Scaffolding…' : 'Run scaffold')),
      ),
    ),
  );
}

export function Library() {
  const specs = useStore((s) => s.specs);
  const [q, setQ] = React.useState('');
  const [filter, setFilter] = React.useState('all');
  const counts = specs.reduce((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {} as any);
  const tabs = [
    { id: 'all', label: 'All', count: specs.length },
    { id: 'draft', label: 'Draft', count: counts.draft || 0 },
    { id: 'in-review', label: 'In review', count: counts['in-review'] || 0 },
    { id: 'approved', label: 'Approved', count: counts.approved || 0 },
    { id: 'merged', label: 'Merged', count: counts.merged || 0 },
  ];
  const ql = q.toLowerCase();
  // Search by title, specId, capability, or status (SPEC-008).
  const filtered = specs.filter((s) => (filter === 'all' || s.status === filter) && (
    s.title.toLowerCase().includes(ql) ||
    s.specId.toLowerCase().includes(ql) ||
    (s.status || '').toLowerCase().includes(ql) ||
    (s.capabilities || []).some((c: string) => c.toLowerCase().includes(ql))
  ));
  const open = (s) => store.set({ activeSpec: s.specId, view: s.status === 'draft' || s.status === 'in-review' ? 'cockpit' : 'board' });

  if (specs.length === 0) {
    return e('div', { style: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 } },
      e('div', { style: { maxWidth: 420, textAlign: 'center' } },
        e('div', { style: { width: 56, height: 56, margin: '0 auto 18px', borderRadius: 'var(--radius-xl)', background: 'var(--secondary)', color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: 'fileText', size: 26 })),
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 18, fontWeight: 600, color: 'var(--foreground)', letterSpacing: '-0.01em' } }, 'No specifications yet'),
        e('p', { style: { margin: '8px 0 20px', fontFamily: 'var(--font-sans)', fontSize: 13.5, lineHeight: 1.6, color: 'var(--muted-foreground)' } }, 'The specification is the unit of work. Author the first one with the agents — it is co-authored, grounded in the codebase, and persisted to docs/specifications.'),
        e('div', { style: { display: 'flex', gap: 10, justifyContent: 'center' } },
          e(Button, { iconLeft: e(Icon, { name: 'plus', size: 15 }), onClick: () => store.set({ view: 'cockpit', activeSpec: 'SPEC-016' }) }, 'Author a specification'),
          e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'folderPlus', size: 15 }), onClick: () => store.set({ view: 'init' }) }, 'Scaffold project')),
        e('div', { style: { marginTop: 22, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)' } }, 'docs/specifications/ · empty')),
    );
  }

  return e(Page, { max: 1100 },
    e(SectionHead, { eyebrow: 'Specification', title: 'Specifications',
      sub: 'Every specification in this project. The specification is the unit of work — versioned in docs/specifications and reviewed through pull request like any other code.',
      action: e(Button, { iconLeft: e(Icon, { name: 'plus', size: 15 }), onClick: () => store.set({ view: 'cockpit', activeSpec: 'SPEC-016' }) }, 'New specification') }),
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 } },
      e('div', { style: { width: 300 } }, e(Input, { placeholder: 'Search specifications…', value: q, onChange: (ev) => setQ(ev.target.value) })),
      e('div', { style: { flex: 1 } }),
      e(Tabs, { tabs, value: filter, onChange: setFilter })),
    filtered.length === 0
      ? e('div', { style: { padding: 56, textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 'var(--radius-xl)' } },
          e('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: 10, color: 'var(--neutral-400)' } }, e(Icon, { name: 'search', size: 22 })),
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 500, color: 'var(--foreground)' } }, 'No specifications match'),
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--muted-foreground)', marginTop: 4 } }, q ? 'Try a different search.' : 'No specifications in this state.'))
      : e('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 14 } },
          filtered.map((s) => e(SpecCard, { key: s.specId, specId: s.specId, title: s.title, status: s.status, warn: s.hasDivergence, meta: ((s.capabilities && s.capabilities.length ? s.capabilities.join(', ') + ' · ' : '') + (s.updatedAt || s.updated || '')) || s.branch, onClick: () => open(s) }))),
  );
}
