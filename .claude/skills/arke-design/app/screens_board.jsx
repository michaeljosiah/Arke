// SpecOne Orchestrator — Delivery board (live), Session detail, Diff review, Permission overlay.
(function () {
  const e = React.createElement;
  const Icon = window.SO_Icon;
  const use = window.SO_use;
  const store = window.SO_Store;
  const eng = window.SO_engine;
  const NS = window.SpecOneDesignSystem_b87656;
  const { KanbanCard, Button, Badge, Card, Callout, StatusDot, Tabs, AgentMessage, Textarea } = NS;
  const ago = window.SO_ago;

  const COLS = [
    { id: 'authoring', label: 'Authoring' },
    { id: 'review', label: 'In review' },
    { id: 'implementing', label: 'Implementing' },
    { id: 'diff', label: 'Diff review' },
    { id: 'merged', label: 'Merged' },
  ];

  // ---------- Board card with progress + enter animation ----------
  function BoardCard({ c }) {
    const open = () => store.set({ activeCard: c.id, view: c.col === 'diff' ? 'diff' : 'session' });
    const showBar = (c.col === 'authoring' || c.col === 'implementing') && !c.needsHuman;
    return e('div', { className: 'so-enter', onClick: open, style: { cursor: 'pointer', position: 'relative' } },
      showBar ? e('div', { style: { position: 'absolute', left: 11, right: 11, top: 0, height: 2, background: 'var(--secondary)', borderRadius: 999, overflow: 'hidden', zIndex: 2 } },
        e('div', { style: { height: '100%', width: (c.progress || 0) + '%', background: 'var(--foreground)', transition: 'width .6s ease' } })) : null,
      e(KanbanCard, { taskId: c.id, title: c.title, status: c.status, harness: c.harness, model: c.model, needsHuman: c.needsHuman }),
    );
  }

  function Column({ col, cards }) {
    return e('div', { style: { width: 248, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 12px' } },
        e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--foreground)', fontWeight: 600 } }, col.label),
        e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)' } }, cards.length)),
      e('div', { style: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: 2 } },
        cards.map((c) => e(BoardCard, { key: c.id + '-' + c.col, c })),
        cards.length === 0 ? e('div', { style: { border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)', padding: 16, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)' } }, 'empty') : null),
    );
  }

  function EventRail() {
    const { events, liveStream } = use();
    const KIND = { 'permission.requested': 'lock', 'permission.granted': 'check', 'permission.denied': 'x', 'diff.finalised': 'diff', 'session.busy': 'terminal', 'spec.authored': 'fileText', 'turn.quiescent': 'checkCircle', 'pr.merged': 'merge' };
    return e('div', { style: { width: 290, flex: 'none', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--background)' } },
      e('div', { style: { padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 } },
        e(StatusDot, { status: liveStream ? 'running' : 'idle', pulse: liveStream }),
        e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--foreground)' } }, 'Event stream'),
        e('div', { style: { flex: 1 } }),
        e('button', { onClick: () => store.set({ liveStream: !liveStream }), title: liveStream ? 'Pause' : 'Resume', style: { display: 'flex', width: 26, height: 26, alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--card)', color: 'var(--muted-foreground)', cursor: 'pointer' } }, e(Icon, { name: liveStream ? 'pause' : 'play', size: 13 }))),
      e('div', { style: { flex: 1, overflowY: 'auto', padding: '8px 0' } },
        events.length === 0 ? e('div', { style: { padding: '24px 16px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)', lineHeight: 1.6 } }, liveStream ? 'no events yet · waiting on the harness' : 'stream paused') : null,
        events.map((ev) => e('div', { key: ev.id, className: 'so-enter', style: { display: 'flex', gap: 9, padding: '7px 16px', alignItems: 'flex-start' } },
          e('span', { style: { flex: 'none', marginTop: 1, color: ev.kind.startsWith('permission') ? 'var(--destructive)' : 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: KIND[ev.kind] || 'dot', size: 13 })),
          e('div', { style: { minWidth: 0 } },
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.45, color: 'var(--foreground)', wordBreak: 'break-word' } }, ev.text),
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)', marginTop: 1 } }, ago(ev.ts)))))),
    );
  }

  function Board() {
    const { cards } = use();
    const empty = cards.length === 0;
    return e('div', { style: { height: '100%', display: 'flex', minHeight: 0 } },
      e('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', padding: '18px 22px', minHeight: 0, minWidth: 0 } },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 } },
          e('p', { style: { margin: 0, maxWidth: 600, fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.5, color: 'var(--muted-foreground)' } }, 'A card moves because the work moved, not because a person dragged it. Columns are computed from frontmatter, session and CI state — projected live from the harness event stream.'),
          e('div', { style: { flex: 1 } }),
          e(Badge, { variant: 'secondary' }, 'event-driven')),
        empty
          ? e('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
              e('div', { style: { maxWidth: 380, textAlign: 'center' } },
                e('div', { style: { width: 52, height: 52, margin: '0 auto 16px', borderRadius: 'var(--radius-xl)', background: 'var(--secondary)', color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: 'board', size: 24 })),
                e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 16, fontWeight: 600, color: 'var(--foreground)' } }, 'No work in flight'),
                e('p', { style: { margin: '8px 0 18px', fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.55, color: 'var(--muted-foreground)' } }, 'The board projects real delivery state. Approve a specification and fan it into tasks, and cards will appear here as the harness reports events.'),
                e(Button, { iconLeft: e(Icon, { name: 'chat', size: 15 }), onClick: () => store.set({ view: 'cockpit' }) }, 'Go to authoring')))
          : e('div', { style: { flex: 1, display: 'flex', gap: 16, minHeight: 0, overflowX: 'auto' } },
              COLS.map((col) => e(Column, { key: col.id, col, cards: cards.filter((c) => c.col === col.id) })))),
      e(EventRail, null),
    );
  }

  // ---------- Shared diff view ----------
  const DIFF_FILES = [
    { path: 'migrations/0042_add_idempotency_key.sql', added: 18, removed: 0 },
    { path: 'src/payments/schema.py', added: 9, removed: 3 },
    { path: 'src/payments/retry.py', added: 41, removed: 8 },
    { path: 'tests/retry_idempotency_test.py', added: 16, removed: 1 },
  ];
  const DIFF_HUNK = [
    { t: 'meta', s: '@@ src/payments/retry.py @@ def handle_retry(event):' },
    { t: 'ctx', s: '  payment = lookup(event.payment_id)' },
    { t: 'del', s: '  charge(payment)' },
    { t: 'add', s: '  if seen(event.idempotency_key):' },
    { t: 'add', s: '      return Noop("duplicate webhook")' },
    { t: 'add', s: '  with idempotent(event.idempotency_key):' },
    { t: 'add', s: '      charge(payment)' },
    { t: 'ctx', s: '  record(event)' },
  ];

  function DiffView({ compact }) {
    const [file, setFile] = React.useState(0);
    return e('div', { style: { display: 'flex', height: '100%', minHeight: 0 } },
      e('div', { style: { width: 280, flex: 'none', borderRight: '1px solid var(--border)', overflowY: 'auto', padding: 10 } },
        DIFF_FILES.map((f, i) => e('button', { key: f.path, onClick: () => setFile(i), style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 3, border: 'none', borderRadius: 'var(--radius-md)', background: file === i ? 'var(--accent)' : 'transparent', cursor: 'pointer' } },
          e('span', { style: { flex: 'none', color: 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: 'file', size: 14 })),
          e('span', { style: { flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, f.path.split('/').pop()),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--success)' } }, '+' + f.added),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--destructive)' } }, '−' + f.removed)))),
      e('div', { style: { flex: 1, overflowY: 'auto', background: 'var(--neutral-950)', minWidth: 0 } },
        e('div', { style: { padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#A1A1A1' } }, DIFF_FILES[file].path),
        e('div', { style: { padding: '10px 0', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.8 } },
          DIFF_HUNK.map((l, i) => e('div', { key: i, style: { padding: '0 16px', background: l.t === 'add' ? 'rgba(34,197,94,0.12)' : l.t === 'del' ? 'rgba(231,0,11,0.12)' : 'transparent', color: l.t === 'meta' ? '#737373' : l.t === 'add' ? '#86EFAC' : l.t === 'del' ? '#FCA5A5' : '#D4D4D4', display: 'flex', gap: 10 } },
            e('span', { style: { width: 12, flex: 'none', color: '#525252' } }, l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''),
            e('span', { style: { whiteSpace: 'pre' } }, l.s))))),
    );
  }

  function DiffReview() {
    const { activeCard, cards } = use();
    const card = cards.find((c) => c.id === activeCard) || cards.find((c) => c.col === 'diff') || {};
    return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
      e('div', { style: { padding: '14px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 } },
        e(Button, { variant: 'ghost', size: 'sm', iconLeft: e(Icon, { name: 'arrowLeft', size: 15 }), onClick: () => store.set({ view: 'board' }) }, 'Board'),
        e('div', { style: { flex: 1 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, (card.id || 'T-2') + ' · ' + (card.title || 'Idempotency key column + index')),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, 'diff.finalised · +84 −12 across 4 files · ' + (card.harness || 'OpenCode'))),
        e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'refresh', size: 14 }) }, 'Revert run'),
        e(Button, { iconLeft: e(Icon, { name: 'pr', size: 15 }), onClick: () => { eng.acceptDiff(card.id || 'T-2'); store.set({ view: 'board' }); } }, 'Accept & open PR')),
      e('div', { style: { flex: 1, minHeight: 0 } }, e(DiffView, null)),
    );
  }

  // ---------- Session detail ----------
  const TODOS = [
    { t: 'Read repo context & AGENTS.md', s: 'done' },
    { t: 'Write migration 0042_add_idempotency_key.sql', s: 'done' },
    { t: 'Guard retry handler on idempotency_key', s: 'running' },
    { t: 'Add idempotency test (WHEN/THEN)', s: 'idle' },
    { t: 'Open pull request', s: 'gate' },
  ];
  const TRANSCRIPT = [
    { role: 'agent', agent: 'Implementation', model: 'mid-tier', text: 'Read the spec and grounded in src/payments. Adding the migration and the unique index on (tenant_id, idempotency_key).' },
    { role: 'agent', agent: 'Implementation', model: 'mid-tier', text: 'Migration written. Guarding handle_retry so a seen key returns a no-op. Running typecheck and checks next.' },
  ];

  function Session() {
    const { activeCard, cards } = use();
    const card = cards.find((c) => c.id === activeCard) || { id: 'T-4', title: 'Guard the retry handler', harness: 'Claude Code', model: 'Sonnet', status: 'running' };
    const [tab, setTab] = React.useState('transcript');
    const [msgs, setMsgs] = React.useState(() => TRANSCRIPT.map((m, i) => ({ id: 's' + i, ...m })));
    const [draft, setDraft] = React.useState('');
    const [promote, setPromote] = React.useState(false);
    const [streaming, setStreaming] = React.useState(false);
    const scroller = React.useRef(null);
    React.useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [msgs]);

    const steer = () => {
      if (!draft.trim() || streaming) return;
      const text = draft.trim();
      const wasPromote = promote;
      setMsgs((m) => [...m, { id: 'h' + Date.now(), role: 'human', text }]);
      setDraft('');
      if (wasPromote) {
        eng.logAudit({ actor: 'priya.n', kind: 'spec', text: card.id + ' steering promoted to the specification', detail: 'spec \u2192 in-review \u00b7 ripples to projections', status: 'ok' });
        eng.notify('review', card.id + ' steering changed scope \u2014 ' + card.specId + ' dropped to in-review', 'cockpit');
      }
      const id = 'a' + Date.now();
      setStreaming(true);
      setMsgs((m) => [...m, { id, role: 'agent', agent: 'Implementation', model: card.model, text: '' }]);
      const full = wasPromote
        ? 'Understood \u2014 treating that as a change to what we build, not just how. Promoting it back into the specification, which drops to in-review and re-derives the affected tasks before I continue.'
        : 'Got it. Adjusting the approach on this task and continuing inside the worktree \u2014 re-running checks after the change.';
      const words = full.split(' ');
      let i = 0;
      const iv = setInterval(() => {
        i++;
        setMsgs((m) => m.map((x) => x.id === id ? { ...x, text: words.slice(0, i).join(' ') } : x));
        if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
        if (i >= words.length) { clearInterval(iv); setStreaming(false); setPromote(false); }
      }, 42);
    };

    return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
      e('div', { style: { padding: '14px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 } },
        e(Button, { variant: 'ghost', size: 'sm', iconLeft: e(Icon, { name: 'arrowLeft', size: 15 }), onClick: () => store.set({ view: 'board' }) }, 'Board'),
        e('div', { style: { flex: 1, minWidth: 0 } },
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, card.id + ' · ' + card.title),
            e(StatusDot, { status: card.needsHuman ? 'attention' : card.status, pulse: card.status === 'running' })),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, card.harness + ' · ' + card.model + ' · one git worktree')),
        e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'refresh', size: 14 }) }, 'Restore checkpoint'),
        e(Button, { iconLeft: e(Icon, { name: 'pr', size: 15 }), onClick: () => eng.raisePermission(card, 'open pull request', 'gh pr create --fill --base main') }, 'Open pull request')),
      e('div', { style: { padding: '0 22px', borderBottom: '1px solid var(--border)' } },
        e(Tabs, { tabs: [{ id: 'transcript', label: 'Transcript' }, { id: 'todos', label: 'Todos', count: TODOS.length }, { id: 'diff', label: 'Diff' }], value: tab, onChange: setTab })),
      e('div', { style: { flex: 1, minHeight: 0, overflow: 'hidden' } },
        tab === 'transcript' ? e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
          e('div', { ref: scroller, style: { flex: 1, overflowY: 'auto', padding: 22 } },
            e('div', { style: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14 } },
              msgs.map((m, i) => e(AgentMessage, { key: m.id || i, role: m.role, agent: m.agent, model: m.model }, m.text || '…')),
              e(Callout, { variant: 'default', label: 'Runtime receipts' }, 'The board reacts to typed receipts — turn quiescence, diff finalisation — captured around each agent turn, with automatic git checkpoints for rescue and audit.'))),
          e('div', { style: { flex: 'none', borderTop: '1px solid var(--border)', padding: '12px 22px', background: 'var(--background)' } },
            e('div', { style: { maxWidth: 760 } },
              e(Textarea, { rows: 2, value: draft, placeholder: 'Steer ' + card.id + ' — nudge, correct, or answer the agent in context…', onChange: (ev) => setDraft(ev.target.value), onKeyDown: (ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) steer(); } }),
              e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 9 } },
                e('button', { onClick: () => setPromote((p) => !p), title: 'Anything that changes what is built — not just how — is promoted back into the specification',
                  style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 500, border: '1px solid ' + (promote ? 'var(--foreground)' : 'var(--border)'), background: promote ? 'var(--foreground)' : 'var(--card)', color: promote ? 'var(--background)' : 'var(--muted-foreground)' } },
                  e(Icon, { name: 'flag', size: 13 }), 'Promote change to spec'),
                e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: promote ? 'var(--warning)' : 'var(--neutral-400)' } }, promote ? card.specId + ' → in-review' : '⌘↵ to send · chat steers the work, the spec stays the record'),
                e('div', { style: { flex: 1 } }),
                e(Button, { size: 'sm', disabled: streaming, onClick: steer }, 'Send')))) ) : null,
        tab === 'todos' ? e('div', { style: { height: '100%', overflowY: 'auto', padding: 22, maxWidth: 620 } },
          TODOS.map((t, i) => e('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: 8, background: 'var(--card)' } },
            t.s === 'gate' ? e('span', { style: { color: 'var(--destructive)', display: 'flex' } }, e(Icon, { name: 'lock', size: 16 })) : t.s === 'done' ? e('span', { style: { color: 'var(--success)', display: 'flex' } }, e(Icon, { name: 'checkCircle', size: 16 })) : e(StatusDot, { status: t.s === 'running' ? 'running' : 'idle', pulse: t.s === 'running' }),
            e('span', { style: { flex: 1, fontFamily: 'var(--font-sans)', fontSize: 13, color: t.s === 'idle' ? 'var(--muted-foreground)' : 'var(--foreground)' } }, t.t),
            e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: t.s === 'gate' ? 'var(--destructive)' : 'var(--muted-foreground)' } }, t.s === 'gate' ? 'needs a human' : t.s))) ) : null,
        tab === 'diff' ? e('div', { style: { height: '100%', minHeight: 0 } }, e(DiffView, null)) : null),
    );
  }

  // ---------- Permission overlay (rendered at app level) ----------
  function PermissionOverlay() {
    const req = use((s) => s.permission);
    if (!req) return null;
    return e('div', { style: { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(10,10,10,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 } },
      e('div', { style: { width: 460, background: 'var(--popover)', border: '1px solid color-mix(in srgb, var(--destructive) 40%, var(--border))', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' } },
        e('div', { style: { padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 } },
          e('span', { style: { width: 34, height: 34, borderRadius: 'var(--radius-md)', background: 'var(--danger-bg)', color: 'var(--destructive)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }, e(Icon, { name: 'lock', size: 18 })),
          e('div', null,
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--destructive)' } }, 'Permission requested'),
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600, color: 'var(--foreground)' } }, req.action))),
        e('div', { style: { padding: 20 } },
          e('p', { style: { margin: '0 0 14px', fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.55, color: 'var(--muted-foreground)' } }, 'The agent on ' + req.cardTitle + ' (' + req.cardId + ') wants to run a gated action on ' + req.harness + '. The agent proposes; you decide; the harness executes.'),
          e('div', { style: { background: 'var(--neutral-950)', borderRadius: 'var(--radius-md)', padding: '11px 14px', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: '#86EFAC', marginBottom: 18 } }, '$ ' + req.command),
          e('div', { style: { display: 'flex', gap: 10, justifyContent: 'flex-end' } },
            e(Button, { variant: 'outline', onClick: () => eng.resolvePermission(false) }, 'Deny'),
            e(Button, { iconLeft: e(Icon, { name: 'check', size: 15 }), onClick: () => eng.resolvePermission(true) }, 'Approve'))),
      ),
    );
  }

  window.SO_Board = Board;
  window.SO_Session = Session;
  window.SO_Diff = DiffReview;
  window.SO_PermissionOverlay = PermissionOverlay;
})();
