import React from 'react';
import { Icon } from '../icons';
import { Button, StatusDot } from '../ds';
import { Page, SectionHead, Empty, ago } from '../utils';
import { store, useStore } from '../store';
import { openSpec } from '../nav';
import { refreshRepoStatusLive } from '../live';
import { deriveTriage, derivePipeline, deriveRepoRows, deriveSyncSystems, STAGE_FILL } from './overview-derivations';

const e = React.createElement;

const mono = (size: number, color?: string) => ({ fontFamily: 'var(--font-mono)', fontSize: size, color: color || 'var(--muted-foreground)' });
const sans = (size: number, weight?: number, color?: string) => ({ fontFamily: 'var(--font-sans)', fontSize: size, fontWeight: weight || 400, color: color || 'var(--foreground)' });

// ---- panels ------------------------------------------------------------------

function Panel({ title, meta, action, children, style }: any) {
  return e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', background: 'var(--card)', overflow: 'hidden', ...style } },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--border)' } },
      e('span', { style: sans(13, 600) }, title),
      meta || null,
      e('span', { style: { flex: 1 } }),
      action || null),
    children);
}

function PanelLink({ label, onClick }: any) {
  return e('button', { onClick, style: { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', ...sans(12, 500, 'var(--muted-foreground)') } },
    label, e(Icon, { name: 'arrowRight', size: 13 }));
}

const goTriage = (it: any) => {
  if (it.go === 'spec') openSpec(it.specId);
  else store.set({ view: it.go });
};

function Triage() {
  const { cards, projections } = useStore();
  const items = deriveTriage(cards, projections);
  return e(Panel, {
    title: 'Waiting on you',
    meta: items.length ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: 'var(--destructive)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, items.length) : null,
    action: e('span', { style: mono(11, 'var(--neutral-400)') }, 'the agent proposes · you decide'),
  },
    items.length === 0
      ? e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '18px 16px' } },
          e(StatusDot, { status: 'agree' }),
          e('span', { style: sans(13, 400, 'var(--muted-foreground)') }, 'Nothing needs a decision — the harness is working.'))
      : items.map((it: any, i: number) => e('div', { key: it.key, style: { display: 'flex', alignItems: 'center', gap: 13, padding: '11px 16px', borderBottom: i < items.length - 1 ? '1px solid var(--line-soft)' : 'none' } },
          e('span', { style: { flex: 'none', width: 30, height: 30, borderRadius: 'var(--radius-md)', background: 'var(--secondary)', color: it.tone, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: it.icon, size: 15 })),
          e('div', { style: { flex: 1, minWidth: 0 } },
            e('div', { style: { ...sans(13.5, 500), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, it.title),
            e('div', { style: { ...mono(11), marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, it.kind + ' · ' + it.detail)),
          e(Button, { size: 'sm', variant: it.icon === 'lock' ? 'default' : 'outline', style: { flex: 'none' }, onClick: () => goTriage(it) }, it.cta))),
  );
}

/** A single number|null field: the value, or a degraded "—" with the reason on hover. */
function statCell(value: number | null, degraded: boolean, reason: string, render: (v: number) => any) {
  if (degraded || value === null || value === undefined) return e('span', { title: reason || 'status unavailable', style: mono(11, 'var(--neutral-400)') }, '—');
  return render(value);
}

function Repository() {
  const { repo, gitBranches, specs } = useStore();
  const rows = deriveRepoRows(gitBranches, specs);
  const Arrow = ({ up, n }: any) => e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 2, ...mono(11, n ? 'var(--foreground)' : 'var(--neutral-400)') } },
    e('svg', { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      e('path', { d: up ? 'M12 19V5M5 12l7-7 7 7' : 'M12 5v14M5 12l7 7 7-7' })), n ?? 0);
  const isDeg = (r: any, field: string) => (r.degraded || []).some((d: any) => d.field === field);
  const degReason = (r: any, field: string) => ((r.degraded || []).find((d: any) => d.field === field) || {}).reason || '';
  return e(Panel, {
    title: 'Repository',
    meta: repo ? e('span', { style: mono(11) }, repo.name + (repo.default ? ' · ' + repo.default : '') + (repo.head ? ' @ ' + repo.head : '')) : null,
    action: e(PanelLink, { label: 'Refresh', onClick: () => void refreshRepoStatusLive() }),
  },
    rows.length === 0
      ? e('div', { style: { padding: '18px 16px', ...sans(13, 400, 'var(--muted-foreground)') } }, 'No branch status yet. Spec branches appear here once the coordinator has computed their git state.')
      : e(React.Fragment, null,
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '7px 16px', background: 'var(--muted)', borderBottom: '1px solid var(--border)' } },
            e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), flex: 1 } }, 'branch'),
            e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), width: 84, flex: 'none' } }, 'ahead · behind'),
            e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), width: 96, flex: 'none' } }, 'working tree'),
            e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), width: 96, flex: 'none' } }, 'diff'),
            e('span', { style: { ...mono(10.5, 'var(--neutral-400)'), width: 84, flex: 'none', textAlign: 'right' } }, 'pull request')),
          rows.map((b: any, i: number) => e('div', { key: b.specId, onClick: () => openSpec(b.specId), style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', cursor: 'pointer', borderBottom: i < rows.length - 1 ? '1px solid var(--line-soft)' : 'none' } },
            e('div', { style: { flex: 1, minWidth: 0 } },
              e('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
                e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'branch', size: 13 })),
                e('span', { style: { ...mono(12, 'var(--foreground)'), fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, b.branch || '—')),
              e('div', { style: { ...mono(10.5), marginTop: 2, paddingLeft: 20, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, b.specId + ' · ' + (b.specTitle || ''))),
            e('div', { style: { width: 84, flex: 'none', display: 'flex', gap: 8 } },
              statCell(b.ahead, isDeg(b, 'ahead'), degReason(b, 'ahead'), (v) => e(Arrow, { up: true, n: v })),
              statCell(b.behind, isDeg(b, 'behind'), degReason(b, 'behind'), (v) => e(Arrow, { up: false, n: v }))),
            e('span', { style: { width: 96, flex: 'none' } },
              statCell(b.dirty, false, 'dirty state is only known for the checked-out branch', (v) => e('span', { style: mono(11, v ? 'var(--warning)' : 'var(--neutral-400)') }, v ? v + (v === 1 ? ' file dirty' : ' files dirty') : 'clean'))),
            e('span', { style: { width: 96, flex: 'none', ...mono(11) } },
              isDeg(b, 'diff') || b.added === null
                ? e('span', { title: degReason(b, 'diff') || 'status unavailable', style: mono(11, 'var(--neutral-400)') }, '—')
                : (b.added || b.removed)
                  ? e(React.Fragment, null, e('span', { style: { color: 'var(--success)' } }, '+' + b.added), ' ', e('span', { style: { color: 'var(--destructive)' } }, '−' + b.removed))
                  : '—'),
            e('span', { style: { width: 84, flex: 'none', textAlign: 'right' } },
              b.pr && b.pr.status
                ? e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, ...mono(11, b.pr.status === 'open' ? 'var(--success)' : 'var(--muted-foreground)') } }, e(Icon, { name: 'pr', size: 12 }), '#' + b.pr.number + ' ' + b.pr.status)
                : b.pr && b.pr.number
                  ? e('span', { title: degReason(b, 'pr') || 'PR state unknown', style: mono(11, 'var(--neutral-400)') }, '#' + b.pr.number + ' ?')
                  : isDeg(b, 'pr')
                    ? e('span', { title: degReason(b, 'pr'), style: mono(11, 'var(--neutral-400)') }, 'unknown')
                    : e('span', { style: mono(11, 'var(--neutral-400)') }, '—')))),
        ),
  );
}

function Pipeline() {
  const specs = useStore((s: any) => s.specs);
  const counts = derivePipeline(specs);
  const total = specs.length || 1;
  return e(Panel, { title: 'Specification pipeline', action: e(PanelLink, { label: 'All specifications', onClick: () => store.set({ view: 'library' }) }) },
    e('div', { style: { padding: '14px 16px 16px' } },
      e('div', { style: { display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--muted)', marginBottom: 14 } },
        counts.filter((c) => c.n > 0).map((c) => e('span', { key: c.id, title: c.label + ' · ' + c.n, style: { width: (c.n / total * 100) + '%', background: STAGE_FILL[c.id], borderRight: '2px solid var(--card)' } }))),
      e('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 } },
        counts.map((c) => e('button', { key: c.id, onClick: () => store.set({ view: 'library' }), style: { appearance: 'none', textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--background)', padding: '9px 11px' } },
          e('div', { style: sans(20, 600) }, c.n),
          e('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 2 } },
            e('span', { style: { width: 7, height: 7, borderRadius: 999, background: STAGE_FILL[c.id], flex: 'none' } }),
            e('span', { style: sans(11.5, 500, 'var(--muted-foreground)') }, c.label)))))),
  );
}

function Sessions() {
  const cards = useStore((s: any) => s.cards);
  const running = cards.filter((c: any) => c.col === 'authoring' || c.col === 'implementing');
  return e(Panel, { title: 'Sessions in flight', action: e(PanelLink, { label: 'Delivery board', onClick: () => store.set({ view: 'board' }) }) },
    running.length === 0
      ? e('div', { style: { padding: '18px 16px', ...sans(13, 400, 'var(--muted-foreground)') } }, 'No sessions running. Dispatch tasks from an approved specification.')
      : running.map((c: any, i: number) => e('div', { key: c.id, onClick: () => openSpec(c.specId || c.id), style: { display: 'flex', alignItems: 'center', gap: 13, padding: '11px 16px', cursor: 'pointer', borderBottom: i < running.length - 1 ? '1px solid var(--line-soft)' : 'none' } },
          e(StatusDot, { status: c.needsHuman ? 'waiting' : c.status === 'running' ? 'running' : 'idle', pulse: c.status === 'running' && !c.needsHuman }),
          e('span', { style: { ...mono(12, 'var(--foreground)'), fontWeight: 600, width: 84, flex: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, c.specId || c.id),
          e('div', { style: { flex: 1, minWidth: 0 } },
            e('div', { style: { ...sans(13, 500), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, c.title),
            e('div', { style: { ...mono(10.5), marginTop: 1 } }, (c.harness || '—') + ' · ' + (c.model || '—') + ' · ' + (c.needsHuman ? 'awaiting human' : c.col))))),
  );
}

function SyncHealth() {
  const projections = useStore((s: any) => s.projections);
  const systems = deriveSyncSystems(projections);
  return e(Panel, { title: 'Record sync', action: e(PanelLink, { label: 'Details', onClick: () => store.set({ view: 'projections' }) }) },
    systems.length === 0
      ? e('div', { style: { padding: '18px 16px', ...sans(13, 400, 'var(--muted-foreground)') } }, 'Nothing projected yet.')
      : systems.map((sys, i) => e('div', { key: sys.system, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: i < systems.length - 1 ? '1px solid var(--line-soft)' : 'none' } },
          e(StatusDot, { status: sys.warn ? 'waiting' : 'agree', pulse: !!sys.warn }),
          e('span', { style: sans(13, 500) }, sys.system),
          e('span', { style: mono(11) }, sys.count + (sys.count === 1 ? ' record' : ' records')),
          e('span', { style: { flex: 1 } }),
          sys.warn
            ? e('span', { style: mono(11, 'var(--warning)') }, (sys.lastWarn || 'retrying'))
            : e('span', { style: mono(11, 'var(--neutral-400)') }, 'in step'))),
  );
}

function Activity() {
  const { events, live } = useStore();
  return e(Panel, {
    title: 'Activity',
    meta: live ? e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, ...mono(10.5, 'var(--success)') } }, e(StatusDot, { status: 'agree', pulse: true }), 'live') : null,
    action: e(PanelLink, { label: 'Audit', onClick: () => store.set({ view: 'audit' }) }),
  },
    (events || []).length === 0
      ? e('div', { style: { padding: '18px 16px', ...sans(13, 400, 'var(--muted-foreground)') } }, 'No activity yet.')
      : e('div', { style: { maxHeight: 320, overflowY: 'auto' } },
          (events || []).slice(0, 14).map((ev: any) => e('div', { key: ev.id, style: { padding: '8px 16px', borderBottom: '1px solid var(--line-soft)' } },
            e('div', { style: { ...mono(11, 'var(--foreground)'), lineHeight: 1.45, wordBreak: 'break-word' } }, ev.text),
            e('div', { style: { ...mono(10, 'var(--neutral-400)'), marginTop: 2 } }, ago(ev.ts))))),
  );
}

export function Overview() {
  const { project, specs, cards } = useStore();
  if (specs.length === 0 && cards.length === 0) {
    return e(Empty, { icon: 'gauge', title: 'Nothing to show yet', body: 'The overview is a projection of your specifications and sessions. Author a first specification and it fills in on its own.' });
  }
  return e(Page, { max: 1160 },
    e(SectionHead, {
      eyebrow: 'Project', title: 'Overview',
      sub: 'What needs a decision, and what the agents are doing across ' + (project ? project.name : 'the project') + '. Every panel is a projection of harness and git events — nothing here is hand-maintained.',
    }),
    e('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
      e('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 330px', gap: 16, alignItems: 'start' } },
        e(Triage, null),
        e(Activity, null)),
      e(Repository, null),
      e('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' } },
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 } },
          e(Sessions, null),
          e(SyncHealth, null)),
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 } },
          e(Pipeline, null)))),
  );
}
