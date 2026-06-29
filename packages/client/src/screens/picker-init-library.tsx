import React from 'react';
import { Icon } from '../icons';
import { Button, Input, Card, SpecCard, StatusDot, Tabs } from '../ds';
import { Wordmark } from '../shell';
import { Page, SectionHead } from '../utils';
import { store, useStore } from '../store';
import { liveSend } from '../live';

const e = React.createElement;

/**
 * Harness-setup guidance surface (SPEC-004). Shown in place of the project list when the
 * coordinator reports no reachable harness. "Retry connection" re-probes without a reconnect;
 * an "Edit endpoint" affordance is offered so a stuck probe still has a path forward. No project
 * action is reachable from here — the gate is the only surface until a harness is confirmed.
 */
export function HarnessGuidance() {
  const reason = useStore((s) => s.harnessReachabilityReason);
  const partial = useStore((s) => s.harnessReachabilityPartial);
  const [endpoint, setEndpoint] = React.useState('localhost:4096');
  const [editing, setEditing] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const retry = () => {
    setRetrying(true);
    liveSend({ type: 'harness.probe' });
    setTimeout(() => setRetrying(false), 1200);
  };
  const drivers = [
    { name: 'OpenCode', install: 'npm i -g opencode', start: 'opencode serve --port 4096' },
    { name: 'Claude Code (ACP)', install: 'see docs/harnesses', start: 'acp serve' },
  ];
  return e('div', { style: { height: '100%', width: '100%', background: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' } },
    e('div', { style: { width: 520, padding: 32 } },
      e('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: 16 } },
        e('div', { style: { background: 'var(--primary)', borderRadius: 'var(--radius-xl)', padding: '14px 22px' } }, e(Wordmark, { size: 26, onDark: true }))),
      e(Card, { padding: 22 },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
          e('span', { style: { color: 'var(--warning, #B45309)', display: 'flex' } }, e(Icon, { name: 'alert', size: 18 })),
          e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600, color: 'var(--foreground)' } }, partial ? 'Harness responded, but is not ready' : 'No harness is reachable')),
        e('p', { style: { margin: '0 0 16px', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted-foreground)', lineHeight: 1.6 } },
          reason ? 'reason: ' + reason : 'Start a coding-agent harness, then retry. No project can be opened until a harness is confirmed reachable.'),
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 } },
          drivers.map((d) => e('div', { key: d.name, style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' } },
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--foreground)', marginBottom: 6 } }, d.name),
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, '$ ' + d.install),
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, '$ ' + d.start)))),
        editing
          ? e('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
              e('div', { style: { flex: 1, minWidth: 0 } }, e(Input, { mono: true, prefix: 'opencode://', value: endpoint, onChange: (ev) => setEndpoint(ev.target.value) })),
              e(Button, { variant: 'secondary', style: { flex: 'none' }, onClick: () => setEditing(false) }, 'Save'))
          : null,
        e('div', { style: { display: 'flex', gap: 10 } },
          e(Button, { iconLeft: e(Icon, { name: 'refresh', size: 15 }), disabled: retrying, onClick: retry }, retrying ? 'Retrying…' : 'Retry connection'),
          e(Button, { variant: 'outline', onClick: () => setEditing((v) => !v) }, 'Edit endpoint'))),
      e('p', { style: { textAlign: 'center', margin: '18px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)', lineHeight: 1.6 } }, 'the client never holds credentials · the host is the trust boundary'),
    ),
  );
}

export function Picker() {
  const live = useStore((s) => s.live);
  const connection = useStore((s) => s.connection);
  const connectedProject = useStore((s) => s.connectedProject);
  const projectState = useStore((s) => s.projectState);
  const harnessReachable = useStore((s) => s.harnessReachable);
  const [cloneUrl, setCloneUrl] = React.useState('');
  // Clone a remote repository: the coordinator validates the URL (https/ssh only) and target,
  // runs git clone on the host, then folder-state detection (SPEC-004). The client only sends intent.
  const clone = () => {
    const url = cloneUrl.trim();
    if (!url) return;
    const name = (url.split('/').pop() || 'repo').replace(/\.git$/, '');
    liveSend({ type: 'repo.clone', url, targetPath: name });
    store.set({ project: { name, specs: 0 }, view: 'init' });
  };
  // The reachability gate (SPEC-004): once live, no project action is shown until a harness is
  // confirmed reachable. In the mock-only prototype `harnessReachable` defaults true.
  if (live && !harnessReachable) return e(HarnessGuidance);

  // The coordinator is single-project: it serves exactly one project (its ARKE_PROJECT_ROOT).
  // There is no multi-project list — the picker reflects the real connected project + state.
  const connected = live;
  const cp = connectedProject;
  const connLabel = connected ? 'connected' : (connection === 'connecting' || connection === 'reconnecting' ? 'connecting…' : 'not connected');
  const connDot = connected ? 'agree' : (connection === 'connecting' || connection === 'reconnecting' ? 'running' : 'idle');
  const isMock = (cp && cp.harness) === 'Mock';
  const STATE_LABEL = { 'method-ready': 'method-ready · open the spec library', 'partial-scaffold': 'partial scaffold · finish setup', 'has-code': 'existing code · scaffold the method', 'empty': 'empty · ready to scaffold' };
  const openConnected = () => {
    if (!cp) return;
    store.set({ project: { name: cp.name, specs: 0 }, view: projectState === 'method-ready' ? 'library' : 'init' });
  };

  return e('div', { style: { height: '100%', width: '100%', background: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' } },
    e('div', { style: { width: 460, padding: 32 } },
      e('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: 16 } },
        e('div', { style: { background: 'var(--primary)', borderRadius: 'var(--radius-xl)', padding: '14px 22px' } }, e(Wordmark, { size: 26, onDark: true }))),
      e('p', { style: { textAlign: 'center', margin: '0 0 24px', fontFamily: 'var(--font-sans)', fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', fontWeight: 600 } }, 'Specification Orchestrator'),
      e(Card, { padding: 22 },
        // Real coordinator connection status (not a cosmetic host field).
        e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isMock ? 8 : 18 } },
          e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)' } }, 'Coordinator'),
          e('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, e(StatusDot, { status: connDot }), e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, connLabel + (connected && cp && cp.harness ? ' · ' + cp.harness : '')))),
        isMock ? e('p', { style: { margin: '0 0 18px', padding: '8px 10px', borderRadius: 'var(--radius-md)', background: 'var(--secondary)', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--warning, #B45309)', lineHeight: 1.5 } }, 'mock harness — no OpenCode configured (.arke/config.json). Onboarding & scaffolding are real; agent sessions need a live OpenCode server.') : null,
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)', marginBottom: 10 } }, 'Project'),
        connected && cp
          ? e('button', { onClick: openConnected, style: { width: '100%', appearance: 'none', textAlign: 'left', cursor: 'pointer', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, transition: 'var(--transition-control)' },
              onMouseEnter: (ev: any) => ev.currentTarget.style.background = 'var(--accent)', onMouseLeave: (ev: any) => ev.currentTarget.style.background = 'var(--background)' },
              e('span', { style: { color: 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: 'folder', size: 18 })),
              e('div', { style: { flex: 1, minWidth: 0 } },
                e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--foreground)' } }, cp.name),
                e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, (STATE_LABEL[projectState] || (projectState || 'inspecting…')) + (cp.path ? ' · ' + cp.path : ''))),
              e('span', { style: { color: 'var(--neutral-400)', display: 'flex' } }, e(Icon, { name: 'chevron', size: 16 })))
          : e('div', { style: { padding: '16px 14px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', lineHeight: 1.6 } },
              connected ? 'connected, no project resolved' : 'no coordinator — start it: npm run dev:coordinator'),
        e('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
          e('div', { style: { flex: 1, minWidth: 0 } }, e(Input, { mono: true, prefix: 'git://', placeholder: 'https://… or ssh://… to clone', value: cloneUrl, onChange: (ev) => setCloneUrl(ev.target.value) })),
          e(Button, { variant: 'secondary', style: { flex: 'none' }, disabled: !connected || !cloneUrl.trim(), onClick: clone }, 'Clone')),
        e('button', { disabled: !connected, onClick: () => connected && store.set({ project: { name: (cp && cp.name) || 'new-service', specs: 0 }, view: 'init' }), style: { marginTop: 10, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '11px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)', background: 'transparent', cursor: connected ? 'pointer' : 'not-allowed', opacity: connected ? 1 : 0.5, fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500, color: 'var(--muted-foreground)' } },
          e(Icon, { name: 'plus', size: 15 }), 'Initialise / scaffold this project'),
      ),
      e('p', { style: { textAlign: 'center', margin: '18px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)', lineHeight: 1.6 } }, 'the client never holds credentials · the host is the trust boundary'),
    ),
  );
}

const SCAFFOLD = [
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
  const tiersBlocked = live && (!tierDefaults || !tierDefaults.capable || !tierDefaults.mid);
  // Tier rows: registry-resolved models in live mode; the static prototype tiers otherwise.
  const tierRows = live
    ? [
        { tier: 'capable', label: 'Capable tier', model: (tierDefaults && tierDefaults.capable) || 'capable — not configured' },
        { tier: 'mid', label: 'Mid tier', model: (tierDefaults && tierDefaults.mid) || 'mid — not configured' },
      ]
    : tiers;

  const run = () => {
    if (tiersBlocked) return;
    if (live) {
      store.set({ scaffold: { steps: {}, log: [], running: true, done: false } });
      liveSend({ type: 'scaffold.run', path: '.' });
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
  const filtered = specs.filter((s) => (filter === 'all' || s.status === filter) && (s.title.toLowerCase().includes(q.toLowerCase()) || s.specId.toLowerCase().includes(q.toLowerCase())));
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
          filtered.map((s) => e(SpecCard, { key: s.specId, specId: s.specId, title: s.title, status: s.status, meta: 'docs/specifications/' + s.slug + '.' + (s.fmt || 'md') + ' · ' + (s.tasks ? s.tasks + ' tasks' : s.updated), onClick: () => open(s) }))),
  );
}
