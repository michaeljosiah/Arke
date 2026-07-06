// Arke Orchestrator — Project overview dashboard (SPEC-025), `repository` layout.
// Triage on top (what needs the human) beside a live activity rail; a repository panel (branch
// ahead/behind, working-tree dirty count, diff stats, PR status); then sessions/sync and the
// specification pipeline. Every panel is a projection of harness + git events — nothing here is
// hand-maintained. This is the canonical design reference the SPEC-025 implementation follows.
(function () {
  const e = React.createElement;
  const Icon = window.SO_Icon;
  const use = window.SO_use;
  const store = window.SO_Store;
  const NS = window.SpecOneDesignSystem_b87656;
  const { Button, StatusDot } = NS;
  const { SO_Page, SO_SectionHead, SO_Empty } = window;
  const ago = window.SO_ago;

  const mono = (size, color) => ({ fontFamily: 'var(--font-mono)', fontSize: size, color: color || 'var(--muted-foreground)' });
  const sans = (size, weight, color) => ({ fontFamily: 'var(--font-sans)', fontSize: size, fontWeight: weight || 400, color: color || 'var(--foreground)' });

  function Panel({ title, meta, action, children, style }) {
    return e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', background: 'var(--card)', overflow: 'hidden', ...style } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--border)' } },
        e('span', { style: sans(13, 600) }, title),
        meta || null,
        e('span', { style: { flex: 1 } }),
        action || null),
      children);
  }

  function PanelLink({ label, onClick }) {
    return e('button', { onClick, style: { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', ...sans(12, 500, 'var(--muted-foreground)') } },
      label, e(Icon, { name: 'arrowRight', size: 13 }));
  }

  // ---------- triage: everything waiting on a human decision ----------
  function Triage() {
    const { cards, projections } = use();
    const items = [];
    cards.filter((c) => c.needsHuman).forEach((c) => items.push({ key: 'gate-' + c.id, icon: 'lock', tone: 'var(--destructive)', kind: 'permission gate', title: c.id + ' needs a decision', detail: c.title }));
    cards.filter((c) => c.col === 'review').forEach((c) => items.push({ key: 'rev-' + c.id, icon: 'users', tone: 'var(--foreground)', kind: 'review', title: c.id + ' is ready for a review panel', detail: c.title }));
    cards.filter((c) => c.col === 'diff').forEach((c) => items.push({ key: 'diff-' + c.id, icon: 'diff', tone: 'var(--foreground)', kind: 'diff', title: c.id + ' produced a diff', detail: c.title }));
    projections.filter((p) => p.health !== 'ok').forEach((p) => items.push({ key: 'proj-' + p.id, icon: 'link', tone: 'var(--warning)', kind: 'record sync', title: p.system + ' ' + p.id + ' needs attention', detail: p.last }));
    return e(Panel, {
      title: 'Waiting on you',
      meta: items.length ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: 'var(--destructive)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, items.length) : null,
      action: e('span', { style: mono(11, 'var(--neutral-400)') }, 'the agent proposes · you decide'),
    },
      items.length === 0
        ? e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '18px 16px' } },
            e(StatusDot, { status: 'agree' }),
            e('span', { style: sans(13, 400, 'var(--muted-foreground)') }, 'Nothing needs a decision — the harness is working.'))
        : items.map((it, i) => e('div', { key: it.key, style: { display: 'flex', alignItems: 'center', gap: 13, padding: '11px 16px', borderBottom: i < items.length - 1 ? '1px solid var(--line-soft)' : 'none' } },
            e('span', { style: { flex: 'none', width: 30, height: 30, borderRadius: 'var(--radius-md)', background: 'var(--secondary)', color: it.tone, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: it.icon, size: 15 })),
            e('div', { style: { flex: 1, minWidth: 0 } },
              e('div', { style: { ...sans(13.5, 500), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, it.title),
              e('div', { style: { ...mono(11), marginTop: 1 } }, it.kind + ' · ' + it.detail)),
            e(Button, { size: 'sm', variant: it.icon === 'lock' ? 'default' : 'outline', style: { flex: 'none' } }, it.icon === 'lock' ? 'Decide' : 'Open'))),
    );
  }

  // ---------- repository: live branch / diff / PR status ----------
  // Each field is nullable and rendered "—" when unavailable (never a fabricated 0); `dirty` is "—" for a
  // branch that is not the one currently checked out (SPEC-025 Dec #4).
  function Repository() {
    const { repo, gitBranches } = use();
    const Arrow = ({ up, n }) => e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 2, ...mono(11, n ? 'var(--foreground)' : 'var(--neutral-400)') } },
      e('svg', { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        e('path', { d: up ? 'M12 19V5M5 12l7-7 7 7' : 'M12 5v14M5 12l7 7 7-7' })), n == null ? '—' : n);
    return e(Panel, {
      title: 'Repository',
      meta: repo ? e('span', { style: mono(11) }, repo.name + ' · ' + repo.default + ' @ ' + repo.head) : null,
    },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '7px 16px', background: 'var(--muted)', borderBottom: '1px solid var(--border)' } },
        e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), flex: 1 } }, 'branch'),
        e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), width: 84, flex: 'none' } }, 'ahead · behind'),
        e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), width: 96, flex: 'none' } }, 'working tree'),
        e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), width: 88, flex: 'none' } }, 'diff'),
        e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), width: 74, flex: 'none', textAlign: 'right' } }, 'pull request')),
      (gitBranches || []).map((b, i) => e('div', { key: b.specId, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', cursor: 'pointer', borderBottom: i < gitBranches.length - 1 ? '1px solid var(--line-soft)' : 'none' } },
        e('div', { style: { flex: 1, minWidth: 0 } },
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
            e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'branch', size: 13 })),
            e('span', { style: { ...mono(12, 'var(--foreground)'), fontWeight: 600 } }, b.branch)),
          e('div', { style: { ...mono(10.5), marginTop: 2, paddingLeft: 20 } }, b.specId)),
        e('div', { style: { width: 84, flex: 'none', display: 'flex', gap: 8 } }, e(Arrow, { up: true, n: b.ahead }), e(Arrow, { up: false, n: b.behind })),
        e('span', { style: { width: 96, flex: 'none', ...mono(11, b.dirty ? 'var(--warning)' : 'var(--neutral-400)') } }, b.dirty == null ? '—' : b.dirty ? b.dirty + (b.dirty === 1 ? ' file dirty' : ' files dirty') : 'clean'),
        e('span', { style: { width: 88, flex: 'none', ...mono(11) } },
          b.added == null ? '—' : (b.added || b.removed) ? e(React.Fragment, null, e('span', { style: { color: 'var(--success)' } }, '+' + b.added), ' ', e('span', { style: { color: 'var(--destructive)' } }, '−' + b.removed)) : '—'),
        e('span', { style: { width: 74, flex: 'none', textAlign: 'right' } },
          b.pr && b.pr.status ? e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, ...mono(11, b.pr.status === 'open' ? 'var(--success)' : 'var(--muted-foreground)') } }, e(Icon, { name: 'pr', size: 12 }), '#' + b.pr.number + ' ' + b.pr.status) : e('span', { style: mono(11, 'var(--neutral-400)') }, 'unknown')))),
    );
  }

  // ---------- specification pipeline ----------
  const STAGES = [
    { id: 'draft', label: 'Draft' },
    { id: 'in-review', label: 'In review' },
    { id: 'approved', label: 'Approved' },
    { id: 'delivered', label: 'Delivered' }, // SPEC-024: renamed from `merged`
  ];
  const STAGE_FILL = { draft: 'var(--neutral-300)', 'in-review': 'var(--neutral-500)', approved: 'var(--neutral-700)', delivered: 'var(--foreground)' };

  function Pipeline() {
    const specs = use((s) => s.specs);
    const counts = STAGES.map((st) => ({ ...st, n: specs.filter((sp) => sp.status === st.id).length }));
    const total = specs.length || 1;
    return e(Panel, { title: 'Specification pipeline', action: e(PanelLink, { label: 'All specifications', onClick: () => store.set({ view: 'library' }) }) },
      e('div', { style: { padding: '14px 16px 16px' } },
        e('div', { style: { display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--muted)', marginBottom: 14 } },
          counts.filter((c) => c.n > 0).map((c) => e('span', { key: c.id, style: { width: (c.n / total * 100) + '%', background: STAGE_FILL[c.id], borderRight: '2px solid var(--card)' } }))),
        e('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 } },
          counts.map((c) => e('div', { key: c.id, style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--background)', padding: '9px 11px' } },
            e('div', { style: sans(20, 600) }, c.n),
            e('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 2 } },
              e('span', { style: { width: 7, height: 7, borderRadius: 999, background: STAGE_FILL[c.id], flex: 'none' } }),
              e('span', { style: sans(11.5, 500, 'var(--muted-foreground)') }, c.label)))))),
    );
  }

  function Sessions() {
    const cards = use((s) => s.cards);
    const running = cards.filter((c) => c.col === 'authoring' || c.col === 'implementing');
    return e(Panel, { title: 'Sessions in flight', action: e(PanelLink, { label: 'Delivery board', onClick: () => store.set({ view: 'board' }) }) },
      running.length === 0
        ? e('div', { style: { padding: '18px 16px', ...sans(13, 400, 'var(--muted-foreground)') } }, 'No sessions running. Dispatch tasks from an approved specification.')
        : running.map((c, i) => e('div', { key: c.id, style: { display: 'flex', alignItems: 'center', gap: 13, padding: '11px 16px', borderBottom: i < running.length - 1 ? '1px solid var(--line-soft)' : 'none' } },
            e(StatusDot, { status: c.needsHuman ? 'waiting' : 'running', pulse: !c.needsHuman }),
            e('span', { style: { ...mono(12, 'var(--foreground)'), fontWeight: 600, width: 74, flex: 'none' } }, c.id),
            e('div', { style: { flex: 1, minWidth: 0 } },
              e('div', { style: sans(13, 500) }, c.title),
              e('div', { style: { ...mono(10.5), marginTop: 1 } }, c.harness + ' · ' + c.model + ' · ' + (c.needsHuman ? 'awaiting human' : c.col))))),
    );
  }

  function Activity() {
    const { events, liveStream } = use();
    return e(Panel, {
      title: 'Activity',
      meta: liveStream ? e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, ...mono(10.5, 'var(--success)') } }, e(StatusDot, { status: 'agree', pulse: true }), 'live') : null,
      action: e(PanelLink, { label: 'Audit', onClick: () => store.set({ view: 'audit' }) }),
    },
      e('div', { style: { maxHeight: 320, overflowY: 'auto' } },
        events.slice(0, 14).map((ev) => e('div', { key: ev.id, style: { padding: '8px 16px', borderBottom: '1px solid var(--line-soft)' } },
          e('div', { style: { ...mono(11, 'var(--foreground)'), lineHeight: 1.45, wordBreak: 'break-word' } }, ev.text),
          e('div', { style: { ...mono(10, 'var(--neutral-400)'), marginTop: 2 } }, ago(ev.ts))))),
    );
  }

  function Dashboard() {
    const { project, specs, cards } = use();
    if (specs.length === 0 && cards.length === 0) {
      return e(SO_Empty, { icon: 'gauge', title: 'Nothing to show yet', body: 'The overview is a projection of your specifications and sessions. Author a first specification and it fills in on its own.' });
    }
    return e(SO_Page, { max: 1160 },
      e(SO_SectionHead, { eyebrow: 'Project', title: 'Overview', sub: 'What needs a decision, and what the agents are doing across ' + (project ? project.name : 'the project') + '. Every panel is a projection of harness and git events — nothing here is hand-maintained.' }),
      e('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        e('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 330px', gap: 16, alignItems: 'start' } },
          e(Triage, null),
          e(Activity, null)),
        e(Repository, null),
        e('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' } },
          e(Sessions, null),
          e(Pipeline, null))),
    );
  }

  window.SO_Dashboard = Dashboard;
})();
