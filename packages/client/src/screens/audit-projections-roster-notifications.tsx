import React from 'react';
import { Icon } from '../icons';
import { Button, Badge, Card, Callout, StatusDot, Tabs } from '../ds';
import { Page, SectionHead, Empty, ago } from '../utils';
import { store, useStore, engine } from '../store';

const e = React.createElement;

export function Audit() {
  const audit = useStore((s) => s.audit);
  const [filter, setFilter] = React.useState('all');
  const KIND = { approval: { icon: 'check', label: 'Approval' }, permission: { icon: 'lock', label: 'Permission' }, projection: { icon: 'link', label: 'Projection' }, session: { icon: 'terminal', label: 'Session' }, spec: { icon: 'fileText', label: 'Spec' } };
  const tabs = [{ id: 'all', label: 'All' }, { id: 'approval', label: 'Approvals' }, { id: 'permission', label: 'Permissions' }, { id: 'projection', label: 'Projections' }];
  const rows = audit.filter((a) => filter === 'all' || a.kind === filter);
  return e(Page, { max: 980 },
    e(SectionHead, { eyebrow: 'Governance', title: 'Audit & activity trace',
      sub: 'Every governed action — permission decisions and deterministic projections — logged with the change that triggered it. The local trace is the audit source of truth.',
      action: e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'download', size: 15 }) }, 'Export NDJSON') }),
    audit.length === 0
      ? e(Empty, { icon: 'history', title: 'No activity yet', body: 'Once agents act and you approve gated steps, every governed action is logged here with the change that triggered it.' })
      : e(React.Fragment, null,
    e('div', { style: { marginBottom: 14 } }, e(Tabs, { tabs, value: filter, onChange: setFilter, mono: false })),
    e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', background: 'var(--card)' } },
      rows.map((a, i) => e('div', { key: a.id, className: i === 0 ? 'so-enter' : undefined, style: { display: 'flex', gap: 14, padding: '13px 18px', borderBottom: i < rows.length - 1 ? '1px solid var(--line-soft)' : 'none', alignItems: 'flex-start' } },
        e('span', { style: { flex: 'none', width: 30, height: 30, borderRadius: 'var(--radius-md)', background: 'var(--secondary)', color: a.status === 'pending' ? 'var(--warning)' : a.status === 'denied' ? 'var(--destructive)' : 'var(--foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: (KIND[a.kind] || {}).icon || 'dot', size: 15 })),
        e('div', { style: { flex: 1, minWidth: 0 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 500, color: 'var(--foreground)' } }, a.text),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', marginTop: 2 } }, a.detail)),
        e('div', { style: { flex: 'none', textAlign: 'right' } },
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--foreground)' } }, a.actor),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)', marginTop: 2 } }, ago(a.ts))),
        e('div', { style: { flex: 'none', width: 78, textAlign: 'right' } },
          a.status === 'pending' ? e(Badge, { tone: 'warn' }, 'pending') : a.status === 'denied' ? e(Badge, { variant: 'destructive' }, 'denied') : e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--success)' } }, e(StatusDot, { status: 'agree' }), 'logged'))))) ),
  );
}

export function Projections() {
  const projections = useStore((s) => s.projections);
  const systems = [...new Set(projections.map((p) => p.system))] as string[];
  const okN = projections.filter((p) => p.health === 'ok').length;
  const warnN = projections.filter((p) => p.health !== 'ok').length;
  const Stat = ({ label, value, dot }: any) => e('div', { style: { flex: 1, padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--card)' } },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } }, dot ? e(StatusDot, { status: dot }) : null, e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' } }, value)),
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)', marginTop: 2 } }, label));
  return e(Page, { max: 1020 },
    e(SectionHead, { eyebrow: 'Delivery', title: 'Record sync',
      sub: 'Health of writes to your systems of record (Jira, Azure DevOps). Each entry is a projection of the specification — driven deterministically by a plugin on a status change, never free-form agent behaviour, and every write is logged.' }),
    projections.length === 0
      ? e(Empty, { icon: 'link', title: 'Nothing to sync yet', body: 'When a specification is approved, its tickets, work items and tracking entries are projected to your systems of record and their health appears here.' })
      : e(React.Fragment, null,
    e('div', { style: { display: 'flex', gap: 12, marginBottom: 20 } },
      e(Stat, { label: 'Connected systems', value: systems.length }),
      e(Stat, { label: 'Healthy projections', value: okN, dot: 'agree' }),
      e(Stat, { label: 'Need attention', value: warnN, dot: warnN ? 'waiting' : 'idle' })),
    systems.map((sys) => e('div', { key: sys, style: { marginBottom: 22 } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
        e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'link', size: 16 })),
        e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600 } }, sys),
        e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, 'MCP at host · tokens never leave it')),
      e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', background: 'var(--card)' } },
        projections.filter((p) => p.system === sys).map((p, i, arr) => e('div', { key: p.id, style: { display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderBottom: i < arr.length - 1 ? '1px solid var(--line-soft)' : 'none' } },
          e(StatusDot, { status: p.health === 'ok' ? 'agree' : 'waiting', pulse: p.health !== 'ok' }),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--foreground)', width: 70 } }, p.id),
          e('span', { style: { flex: 1, minWidth: 0, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, p.title),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', cursor: 'pointer' }, onClick: () => store.set({ view: 'board' }) }, p.spec),
          e(Badge, { variant: 'secondary' }, p.state),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: p.health === 'ok' ? 'var(--neutral-400)' : 'var(--warning)', width: 130, textAlign: 'right' } }, p.last),
          p.health !== 'ok' ? e(Button, { size: 'sm', variant: 'outline', iconLeft: e(Icon, { name: 'refresh', size: 13 }), onClick: () => store.set({ projections: store.get().projections.map((x) => x.id === p.id ? { ...x, health: 'ok', last: 'just now' } : x) }) }, 'Retry') : e('span', { style: { width: 78 } }))))),
    )),
  );
}

export function Agents() {
  const { agents, tiers } = useStore();
  return e(Page, { max: 1020 },
    e(SectionHead, { eyebrow: 'Project', title: 'Agent roster',
      sub: 'The agents ship into the repository, not onto a machine — committed as markdown with frontmatter and reviewed through pull request like the specification. Agents reference logical model tiers, resolved per project to the gateway.',
      action: e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'plus', size: 15 }) }, 'Add agent') }),
    e('div', { style: { display: 'flex', gap: 10, marginBottom: 20 } },
      tiers.map((t) => e('div', { key: t.tier, style: { flex: 1, padding: '12px 16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 12 } },
        e('span', { style: { width: 34, height: 34, borderRadius: 'var(--radius-md)', background: 'var(--secondary)', color: 'var(--foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: 'cpu', size: 17 })),
        e('div', { style: { flex: 1 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600 } }, t.label),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, t.note)),
        e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--foreground)', background: 'var(--secondary)', padding: '3px 8px', borderRadius: 'var(--radius-sm)' } }, t.model)))),
    e('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 } },
      agents.map((a) => e(Card, { key: a.id, padding: 16 },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
          e('span', { style: { width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }, e(Icon, { name: a.icon, size: 18 })),
          e('div', { style: { flex: 1, minWidth: 0 } },
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600 } }, a.role),
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, 'writes ' + a.writes)),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' } }, a.tier + ' · ' + a.model)),
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', padding: '7px 9px', background: 'var(--secondary)', borderRadius: 'var(--radius-sm)', marginBottom: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, a.path),
        e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          a.perms.map((p) => e('span', { key: p, style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 8px' } }, p))))),
    ),
  );
}

export function Notifications() {
  const notifs = useStore((s) => s.notifs);
  const KIND = { permission: 'lock', review: 'users', diff: 'diff', projection: 'link', merge: 'merge' };
  return e(Page, { max: 820 },
    e(SectionHead, { eyebrow: 'Governance', title: 'Notifications',
      sub: 'What needs attention — approvals waiting, reviews due, projections and merges.',
      action: e(Button, { variant: 'outline', onClick: () => engine.markNotifsRead() }, 'Mark all read') }),
    notifs.length === 0
      ? e(Empty, { icon: 'bell', title: "You're all caught up", body: 'Approvals waiting, reviews due, projections and merges will show up here as the harness reports them.' })
      : e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', background: 'var(--card)' } },
      notifs.map((n, i) => e('button', { key: n.id, onClick: () => store.set({ view: n.view || 'board' }), style: { display: 'flex', gap: 14, width: '100%', textAlign: 'left', padding: '14px 18px', border: 'none', borderBottom: i < notifs.length - 1 ? '1px solid var(--line-soft)' : 'none', background: n.read ? 'transparent' : 'var(--accent)', cursor: 'pointer' } },
        e('span', { style: { flex: 'none', width: 32, height: 32, borderRadius: 'var(--radius-md)', background: 'var(--secondary)', color: n.kind === 'permission' ? 'var(--destructive)' : 'var(--foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: KIND[n.kind] || 'dot', size: 16 })),
        e('div', { style: { flex: 1, minWidth: 0 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--foreground)', fontWeight: n.read ? 400 : 500 } }, n.text),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)', marginTop: 2 } }, n.kind + ' · ' + ago(n.ts))),
        n.read ? null : e('span', { style: { flex: 'none', width: 8, height: 8, borderRadius: 999, background: 'var(--destructive)', marginTop: 6 } }))),
    ),
  );
}
