// SpecOne Orchestrator — Picker, Project initialisation, Spec library.
(function () {
  const e = React.createElement;
  const Icon = window.SO_Icon;
  const use = window.SO_use;
  const store = window.SO_Store;
  const NS = window.SpecOneDesignSystem_b87656;
  const { Button, Input, Badge, Card, Callout, SpecCard, StatusDot, Tabs } = NS;
  const Wordmark = window.SO_Wordmark;
  const { SO_Page, SO_SectionHead } = window;

  // ---------------- Project picker (first-run · folder-first entry) ----------------
  const SAMPLE_FOLDERS = [
    { name: 'asset-platform', path: '~/code/asset-platform', mode: 'ready' },
    { name: 'legacy-billing', path: '~/code/legacy-billing', mode: 'source' },
    { name: 'new-idea', path: '~/work/new-idea', mode: 'empty' },
  ];

  function FolderChooser({ onClose, onPick }) {
    const [sel, setSel] = React.useState(null);
    const [manual, setManual] = React.useState('');
    return e('div', { style: { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(10,10,10,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }, onClick: onClose },
      e('div', { onClick: (ev) => ev.stopPropagation(), style: { width: 480, background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' } },
        e('div', { style: { padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 } },
          e('span', { style: { color: 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: 'folder', size: 18 })),
          e('div', { style: { flex: 1 } },
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600 } }, 'Open folder'),
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--muted-foreground)' } }, 'A folder becomes the project — empty or existing code both work'))),
        e('div', { style: { padding: 12 } },
          SAMPLE_FOLDERS.map((f) => e('button', { key: f.name, onClick: () => { setSel(f.name); setManual(''); }, style: { appearance: 'none', textAlign: 'left', cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 6, borderRadius: 'var(--radius-md)', border: '1px solid ' + (sel === f.name ? 'var(--foreground)' : 'var(--border)'), background: sel === f.name ? 'var(--accent)' : 'var(--card)' } },
            e('span', { style: { color: 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: 'folder', size: 17 })),
            e('div', { style: { flex: 1, minWidth: 0 } },
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600 } }, f.name),
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, f.path)),
            sel === f.name ? e('span', { style: { color: 'var(--foreground)', display: 'flex' } }, e(Icon, { name: 'check', size: 16 })) : null)),
          e(Input, { mono: true, placeholder: '/path/to/another/folder', value: manual, onChange: (ev) => { setManual(ev.target.value); setSel(null); } })),
        e('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '12px 18px', borderTop: '1px solid var(--border)' } },
          e(Button, { variant: 'outline', onClick: onClose }, 'Cancel'),
          e(Button, { disabled: !sel && !manual.trim(), onClick: () => { if (manual.trim()) { onPick({ name: (manual.split('/').filter(Boolean).pop() || 'folder'), path: manual.trim(), mode: 'source' }); } else { onPick(SAMPLE_FOLDERS.find((x) => x.name === sel)); } } }, 'Open')))); 
  }

  function Picker() {
    const [endpoint, setEndpoint] = React.useState('opencode://localhost:4096');
    const [firstRun, setFirstRun] = React.useState(false);
    const [probe, setProbe] = React.useState('checking');
    const [setup, setSetup] = React.useState(false);
    const [chooser, setChooser] = React.useState(false);
    const [cloneOpen, setCloneOpen] = React.useState(false);
    const [cloneUrl, setCloneUrl] = React.useState('github.com/acme/identity');

    React.useEffect(() => {
      setProbe('checking');
      const t = setTimeout(() => setProbe(firstRun ? 'unreachable' : 'reachable'), 950);
      return () => clearTimeout(t);
    }, [firstRun]);

    const recents = firstRun ? [] : [
      { name: 'asset-platform', specs: 14, meta: 'github.com/acme/asset-platform' },
      { name: 'billing-core', specs: 6, meta: 'github.com/acme/billing-core' },
      { name: 'identity', specs: 9, meta: 'github.com/acme/identity' },
    ];
    const ready = probe === 'reachable';
    const recheck = (ep) => { if (ep) setEndpoint(ep); setProbe('checking'); setTimeout(() => { setProbe('reachable'); setSetup(false); }, 800); };
    const toInit = (f) => store.set({ entryFolder: f, view: 'init' });
    const openRecent = (p) => store.set({ project: { name: p.name, specs: p.specs }, view: 'cockpit', activeSpec: 'SPEC-014' });
    const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, color: 'var(--foreground)' };
    const stepNum = (n, label, extra) => e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
      e('span', { style: { width: 18, height: 18, borderRadius: 999, background: 'var(--secondary)', color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600 } }, n),
      e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600 } }, label),
      e('span', { style: { flex: 1 } }), extra || null);

    const EntryCard = ({ icon, title, sub, onClick, primary }) => e('button', { onClick: ready ? onClick : undefined, disabled: !ready,
      style: { appearance: 'none', textAlign: 'left', cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.5, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid ' + (primary ? 'var(--foreground)' : 'var(--border)'), background: primary ? 'var(--foreground)' : 'var(--card)', color: primary ? 'var(--background)' : 'var(--foreground)', width: '100%' } },
      e('span', { style: { display: 'flex', color: primary ? 'var(--background)' : 'var(--muted-foreground)' } }, e(Icon, { name: icon, size: 18 })),
      e('div', { style: { flex: 1, minWidth: 0 } },
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600 } }, title),
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: primary ? 'rgba(255,255,255,0.7)' : 'var(--muted-foreground)' } }, sub)),
      e('span', { style: { display: 'flex', color: primary ? 'var(--background)' : 'var(--neutral-400)' } }, e(Icon, { name: 'arrowRight', size: 16 })));

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
                    e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, endpoint)))
              : e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', border: '1px solid color-mix(in srgb, var(--warning) 40%, var(--border))', borderRadius: 'var(--radius-lg)', background: 'var(--warning-bg)', marginBottom: 12 } },
                  e('span', { style: { color: 'var(--warning)', display: 'flex' } }, e(Icon, { name: 'alert', size: 16 })),
                  e('div', { style: { flex: 1, minWidth: 0 } },
                    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600 } }, 'No coding agent is running'),
                    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--muted-foreground)' } }, 'Arke runs on a coding agent on the host. Install it, start it, or point at an existing host.'))),
          (!ready && probe !== 'checking') || setup
            ? e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 14, marginBottom: 18, background: 'var(--background)' } },
                e(window.SO_HarnessSetup, { onConnect: (ep) => recheck(ep) }))
            : null,

          // 2 · entry
          stepNum('2', 'Open a project', ready ? null : e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, 'connect a harness first')),
          e('div', { style: { display: 'flex', flexDirection: 'column', gap: 9, marginBottom: cloneOpen ? 10 : 18 } },
            e(EntryCard, { icon: 'folder', title: 'Open folder', sub: 'A folder becomes the project — Arke detects and adapts', primary: true, onClick: () => setChooser(true) }),
            e(EntryCard, { icon: 'branch', title: 'Clone repository', sub: 'Clone a URL into a new working folder', onClick: () => setCloneOpen((o) => !o) }),
            e(EntryCard, { icon: 'folderPlus', title: 'New project', sub: 'Scaffold a greenfield, method-ready project', onClick: () => toInit({ name: 'new-service', path: '~/code/new-service', mode: 'empty' }) })),
          cloneOpen ? e('div', { style: { display: 'flex', gap: 8, marginBottom: 18 } },
            e('div', { style: { flex: 1, minWidth: 0 } }, e(Input, { mono: true, prefix: 'https://', value: cloneUrl, onChange: (ev) => setCloneUrl(ev.target.value) })),
            e(Button, { style: { flex: 'none' }, disabled: !ready, onClick: () => { const nm = (cloneUrl.split('/').pop() || 'repo').replace(/\.git$/, ''); toInit({ name: nm, path: '~/code/' + nm, mode: 'source', clone: true }); } }, 'Clone')) : null,

          recents.length
            ? e('div', null,
                e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 10 } }, 'Recent projects'),
                e('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
                  recents.map((p) => e('button', { key: p.name, onClick: () => openRecent(p), style: { appearance: 'none', textAlign: 'left', cursor: 'pointer', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 12 },
                    onMouseEnter: (ev) => ev.currentTarget.style.background = 'var(--accent)', onMouseLeave: (ev) => ev.currentTarget.style.background = 'var(--background)' },
                    e('span', { style: { color: 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: 'folder', size: 18 })),
                    e('div', { style: { flex: 1, minWidth: 0 } },
                      e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--foreground)' } }, p.name),
                      e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, p.specs + ' specifications · ' + p.meta)),
                    e('span', { style: { color: 'var(--neutral-400)', display: 'flex' } }, e(Icon, { name: 'chevron', size: 16 }))))))
            : e('div', { style: { padding: '16px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)', textAlign: 'center', fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)' } }, 'No recent projects — open a folder to begin'),
        ),
        e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '16px 0 0' } },
          e('button', { onClick: () => { setSetup(false); setChooser(false); setCloneOpen(false); setFirstRun((f) => !f); }, style: { ...linkBtn, color: 'var(--muted-foreground)', fontWeight: 500 } }, firstRun ? '← Back to demo workspace' : 'View as a new user →')),
        e('p', { style: { textAlign: 'center', margin: '10px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)', lineHeight: 1.6 } }, 'the client never holds credentials · the host is the trust boundary'),

        chooser ? e(FolderChooser, { onClose: () => setChooser(false), onPick: (f) => { setChooser(false); toInit(f); } }) : null,
      ),
    );
  }

  // ---------------- Project initialisation / scaffolding ----------------
  const SCAFFOLD = [
    { id: 'agents', icon: 'bot', title: 'Agent roster', detail: '.opencode/agents/ — Product Owner, Technical Architect, Engineering, Implementation, Reviewer', lines: ['+ .opencode/agents/product-owner.md', '+ .opencode/agents/technical-architect.md', '+ .opencode/agents/engineering.md', '+ .opencode/agents/implementation.md'] },
    { id: 'specs', icon: 'fileText', title: 'Specification structure', detail: 'docs/specifications/ with specification.template.md — SHALL statements, WHEN/THEN scenarios, delta tags', lines: ['+ docs/specifications/', '+ docs/specifications/specification.template.md'] },
    { id: 'ground', icon: 'book', title: 'Grounding baseline', detail: 'AGENTS.md symlinked to CLAUDE.md — completion gates, priorities, reference repos under .repos', lines: ['+ AGENTS.md', '~ CLAUDE.md -> AGENTS.md', '+ .repos/ (read-only references)'] },
    { id: 'plugins', icon: 'shield', title: 'Policy & projection plugins', detail: 'Direction-of-truth hooks and deterministic spec → record projection', lines: ['+ .opencode/plugins/direction-of-truth.ts', '+ .opencode/plugins/projection.ts'] },
    { id: 'config', icon: 'settings', title: 'Project configuration', detail: '.arke/config.json — model-tier mapping, harness registry and integrations (specs stay in tool-neutral docs/specifications/)', lines: ['+ .arke/config.json', '+ .arke/ (tool folder)'] },
  ];

  function Initialisation() {
    const folder = use((s) => s.entryFolder) || { name: 'new-service', path: '~/code/new-service', mode: 'empty' };
    const tiers = use((s) => s.tiers);
    const mode = folder.mode || 'empty';
    const [phase, setPhase] = React.useState('inspecting');
    const [running, setRunning] = React.useState(false);
    const [done, setDone] = React.useState({});
    const [log, setLog] = React.useState([]);
    const [finished, setFinished] = React.useState(false);

    React.useEffect(() => {
      setPhase('inspecting'); setDone({}); setFinished(false); setRunning(false); setLog([]);
      const body = mode === 'ready'
        ? [{ t: 'file', m: 'found .arke/config.json' }, { t: 'file', m: 'found docs/specifications/ \u00b7 14 specifications' }, { t: 'file', m: 'found .opencode/agents/ \u00b7 5 agents' }, { t: 'ok', m: 'project is already method-ready' }]
        : mode === 'source'
          ? [{ t: 'file', m: 'no .arke/config.json' }, { t: 'file', m: 'source detected \u00b7 1,284 files across 38 dirs' }, { t: 'file', m: 'existing code will be grounded read-only' }, { t: 'warn', m: 'not method-ready \u2014 scaffold available' }]
          : [{ t: 'file', m: 'no .arke/config.json' }, { t: 'file', m: 'folder is empty' }, { t: 'warn', m: 'greenfield scaffold available' }];
      const lines = [{ t: 'run', m: 'inspect ' + folder.path }, ...body];
      let i = 0; const ids = [];
      const tick = () => { if (i < lines.length) { setLog((l) => [...l, lines[i]]); i++; ids.push(setTimeout(tick, 200)); } else { ids.push(setTimeout(() => setPhase('result'), 300)); } };
      ids.push(setTimeout(tick, 180));
      return () => ids.forEach(clearTimeout);
    }, [folder.path, mode]);

    const run = () => {
      setRunning(true); setDone({}); setFinished(false);
      setLog((l) => [...l, { t: 'run', m: (mode === 'source' ? 'make method-ready ' : 'scaffold ') + folder.name }]);
      let i = 0;
      const stepAll = () => {
        if (i >= SCAFFOLD.length) {
          setLog((l) => [...l, { t: 'ok', m: 'project is method-ready \u2014 0 errors, typecheck passes' }]);
          setFinished(true); setRunning(false); return;
        }
        const s = SCAFFOLD[i];
        setLog((l) => [...l, { t: 'run', m: 'scaffolding ' + s.title.toLowerCase() + '\u2026' }]);
        setTimeout(() => {
          setLog((l) => [...l, ...s.lines.map((m) => ({ t: 'file', m }))]);
          setDone((d) => ({ ...d, [s.id]: true }));
          i++; setTimeout(stepAll, 320);
        }, 560);
      };
      stepAll();
    };

    const openProject = () => store.set({ project: { name: folder.name, specs: mode === 'ready' ? 14 : 0 }, view: 'cockpit', activeSpec: 'SPEC-014', entryFolder: null });
    const cancel = () => store.set({ entryFolder: null, view: 'picker' });

    const TITLE = mode === 'ready' ? 'Open an existing project' : mode === 'source' ? 'Make this project method-ready' : 'Scaffold a greenfield project';
    const SUB = mode === 'ready'
      ? 'This folder is already set up for the method \u2014 it has the tool config, the specification structure and the agent roster. Open it and start authoring.'
      : mode === 'source'
        ? 'This folder has source code but is not yet method-ready. Arke scaffolds the specification structure, agent roster, grounding and governance plugins, and grounds the agents on your existing code. Your source is never modified.'
        : 'This folder is empty. Arke scaffolds a method-ready project from scratch: agent roster, specification structure, grounding baseline and governance plugins.';

    const term = e('div', { style: { position: 'sticky', top: 0 } },
      e('div', { style: { background: 'var(--neutral-950)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border)', overflow: 'hidden', display: 'flex', flexDirection: 'column', height: 440 } },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' } },
          e('span', { style: { display: 'flex', color: '#A1A1A1' } }, e(Icon, { name: 'terminal', size: 15 })),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#A1A1A1' } }, 'arke \u00b7 ' + (phase === 'inspecting' ? 'inspect' : 'init') + ' \u00b7 ' + folder.name)),
        e('div', { style: { flex: 1, overflowY: 'auto', padding: '14px', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.7 } },
          log.map((l, i) => l ? e('div', { key: i, style: { color: l.t === 'ok' ? '#4ADE80' : l.t === 'warn' ? '#FBBF24' : l.t === 'file' ? '#A1A1A1' : '#E5E5E5' } }, (l.t === 'file' ? '  ' : '$ ') + l.m) : null))),
      e('div', { style: { display: 'flex', gap: 10, marginTop: 14, justifyContent: 'flex-end' } },
        e(Button, { variant: 'outline', onClick: cancel }, 'Cancel'),
        phase === 'inspecting' ? e(Button, { disabled: true, iconLeft: e(Icon, { name: 'refresh', size: 15 }) }, 'Inspecting\u2026')
          : mode === 'ready' ? e(Button, { iconLeft: e(Icon, { name: 'arrowRight', size: 15 }), onClick: openProject }, 'Open project')
            : finished ? e(Button, { iconLeft: e(Icon, { name: 'arrowRight', size: 15 }), onClick: openProject }, 'Open authoring cockpit')
              : e(Button, { disabled: running, iconLeft: e(Icon, { name: running ? 'refresh' : 'play', size: 15 }), onClick: run }, running ? 'Scaffolding\u2026' : (mode === 'source' ? 'Make method-ready' : 'Run scaffold'))));

    const leftReady = e('div', null,
      e(Card, { padding: 18 },
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, marginBottom: 6 } }, 'Detected in this folder'),
        [['settings', '.arke/config.json', 'tool config \u00b7 tier mapping \u00b7 integrations'], ['fileText', 'docs/specifications/', '14 specifications'], ['bot', '.opencode/agents/', '5 agents \u00b7 committed as markdown'], ['shield', '.opencode/plugins/', 'direction-of-truth \u00b7 projection']].map((r) => e('div', { key: r[1], style: { display: 'flex', alignItems: 'center', gap: 11, padding: '10px 0', borderBottom: '1px solid var(--line-soft)' } },
          e('span', { style: { color: 'var(--success)', display: 'flex' } }, e(Icon, { name: 'check', size: 15 })),
          e('div', { style: { flex: 1, minWidth: 0 } },
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--foreground)' } }, r[1]),
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--muted-foreground)' } }, r[2]))))));

    const leftScaffold = e('div', null,
      mode === 'source' ? e(Callout, { variant: 'default', label: 'Your source is never modified' }, 'Arke adds specification, agent and governance scaffolding alongside your code and grounds the agents on it read-only. Nothing in your existing source is changed.') : null,
      e(Card, { padding: 18, style: { margin: mode === 'source' ? '14px 0 16px' : '0 0 16px' } },
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, marginBottom: 8 } }, 'Model tiers'),
        e('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          tiers.map((t) => e('div', { key: t.tier, style: { flex: '1 1 120px', minWidth: 0 } },
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, color: 'var(--muted-foreground)', marginBottom: 6 } }, t.label),
            e(Input, { mono: true, size: 'sm', value: t.model, onChange: () => {} })))),
        e('p', { style: { margin: '10px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', lineHeight: 1.5 } }, 'tier defaults pre-filled \u00b7 resolved per project to the gateway')),
      e('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        SCAFFOLD.map((s) => e('div', { key: s.id, style: { display: 'flex', gap: 12, padding: '13px 15px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--card)' } },
          e('span', { style: { flex: 'none', width: 32, height: 32, borderRadius: 'var(--radius-md)', background: done[s.id] ? 'var(--success-bg)' : 'var(--secondary)', color: done[s.id] ? 'var(--success)' : 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: done[s.id] ? 'check' : s.icon, size: 17 })),
          e('div', { style: { flex: 1 } },
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' } }, s.title),
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)', lineHeight: 1.45, marginTop: 2 } }, s.detail)),
          done[s.id] ? e(StatusDot, { status: 'done' }) : running ? e(StatusDot, { status: 'running', pulse: true }) : e(StatusDot, { status: 'idle' })))));

    return e(SO_Page, { max: 1000 },
      e(SO_SectionHead, { eyebrow: 'Setup', title: TITLE, sub: SUB }),
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--card)' } },
        e('span', { style: { color: 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: 'folder', size: 17 })),
        e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600 } }, folder.path),
        folder.clone ? e(Badge, { variant: 'secondary' }, 'cloned') : null,
        e('span', { style: { flex: 1 } }),
        e(Badge, { variant: 'secondary' }, phase === 'inspecting' ? 'inspecting\u2026' : mode === 'ready' ? 'method-ready' : mode === 'source' ? 'existing code' : 'empty folder')),
      e('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' } },
        phase === 'inspecting'
          ? e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '20px 16px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)', color: 'var(--muted-foreground)' } },
              e(StatusDot, { status: 'running', pulse: true }), e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12 } }, 'inspecting the folder\u2026'))
          : mode === 'ready' ? leftReady : leftScaffold,
        term),
    );
  }

  // ---------------- Spec library ----------------
  function Library() {
    const specs = use((s) => s.specs);
    const [q, setQ] = React.useState('');
    const [filter, setFilter] = React.useState('all');
    const counts = specs.reduce((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {});
    const tabs = [
      { id: 'all', label: 'All', count: specs.length },
      { id: 'draft', label: 'Draft', count: counts.draft || 0 },
      { id: 'in-review', label: 'In review', count: counts['in-review'] || 0 },
      { id: 'approved', label: 'Approved', count: counts.approved || 0 },
      { id: 'merged', label: 'Merged', count: counts.merged || 0 },
    ];
    const filtered = specs.filter((s) => (filter === 'all' || s.status === filter) && (s.title.toLowerCase().includes(q.toLowerCase()) || s.specId.toLowerCase().includes(q.toLowerCase())));
    const open = (s) => store.set({ activeSpec: s.specId, view: s.status === 'draft' || s.status === 'in-review' ? 'cockpit' : 'board' });

    // no specifications at all — a real empty state with a primary path forward
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

    return e(SO_Page, { max: 1100 },
      e(SO_SectionHead, { eyebrow: 'Specification', title: 'Specifications',
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

  window.SO_Picker = Picker;
  window.SO_Init = Initialisation;
  window.SO_Library = Library;
})();
