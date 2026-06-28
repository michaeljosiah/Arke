import React from 'react';
import { Icon } from './icons';
import { StatusDot } from './ds';
import { store, useStore, engine } from './store';
import { ago } from './utils';

const e = React.createElement;

export function Wordmark({ size = 18, onDark = false }: { size?: number; onDark?: boolean }) {
  return e('div', { style: { display: 'flex', alignItems: 'baseline', gap: 4, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: size, letterSpacing: '-0.02em', color: onDark ? '#FAFAFA' : 'var(--foreground)' } },
    e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: size * 0.66, fontWeight: 500, color: onDark ? '#A1A1A1' : 'var(--muted-foreground)' } }, '//'),
    'Arke');
}

function ChromeBar() {
  const project = useStore((s) => s.project);
  return e('div', { style: { height: 36, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 14px', background: 'var(--secondary)', borderBottom: '1px solid var(--border)', WebkitUserSelect: 'none', userSelect: 'none' } },
    e('div', { style: { display: 'flex', gap: 8 } },
      ['#FF5F57', '#FEBC2E', '#28C840'].map((c) => e('span', { key: c, style: { width: 12, height: 12, borderRadius: 999, background: c, opacity: 0.92 } }))),
    e('div', { style: { flex: 1, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 } },
      e(Wordmark, { size: 13 }),
      project ? e('span', { style: { color: 'var(--neutral-400)' } }, '— ' + project.name) : null,
    ),
    e('div', { style: { width: 52 } }),
  );
}

const NAV = [
  { group: 'Specification', items: [
    { id: 'library', name: 'book', label: 'Specifications' },
    { id: 'cockpit', name: 'chat', label: 'Authoring cockpit' },
    { id: 'review', name: 'users', label: 'Review panel' },
    { id: 'generation', name: 'sparkle', label: 'Generation' },
  ] },
  { group: 'Delivery', items: [
    { id: 'board', name: 'board', label: 'Delivery board' },
    { id: 'projections', name: 'link', label: 'Record sync' },
    { id: 'integrations', name: 'package', label: 'Integrations' },
  ] },
  { group: 'Governance', items: [
    { id: 'audit', name: 'history', label: 'Audit & activity' },
    { id: 'notifications', name: 'bell', label: 'Notifications' },
  ] },
  { group: 'Project', items: [
    { id: 'agents', name: 'bot', label: 'Agent roster' },
    { id: 'harnesses', name: 'server', label: 'Harnesses & models' },
    { id: 'settings', name: 'settings', label: 'Settings' },
  ] },
];

function NavItem({ it, active, onClick, badge }: any) {
  const [hover, setHover] = React.useState(false);
  return e('button', {
    onClick, title: it.label,
    onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
    style: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', appearance: 'none', cursor: 'pointer',
      border: 'none', borderRadius: 'var(--radius-md)', padding: 'var(--nav-pad)', fontFamily: 'var(--font-sans)', fontSize: 13,
      fontWeight: active ? 600 : 450, transition: 'var(--transition-control)',
      background: active ? 'var(--accent)' : hover ? 'var(--accent)' : 'transparent',
      color: active ? 'var(--foreground)' : 'var(--muted-foreground)' },
  },
    e('span', { style: { display: 'flex', color: active ? 'var(--foreground)' : 'var(--muted-foreground)' } }, e(Icon, { name: it.name, size: 17 })),
    e('span', { style: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, it.label),
    badge ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: 'var(--destructive)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, badge) : null,
  );
}

// Maps the transport state machine to a status dot + label for the connection indicator.
const CONN_UI: Record<string, { status: string; pulse: boolean; label: string }> = {
  open: { status: 'agree', pulse: true, label: 'coordinator live' },
  connecting: { status: 'running', pulse: true, label: 'connecting…' },
  reconnecting: { status: 'attention', pulse: true, label: 'reconnecting…' },
  closed: { status: 'idle', pulse: false, label: 'coordinator closed' },
  disposed: { status: 'idle', pulse: false, label: 'disconnected' },
  offline: { status: 'idle', pulse: false, label: 'mock data (no coordinator)' },
};

function Sidebar() {
  const { view, project, notifs, harnesses, connection, live } = useStore();
  const unread = notifs.filter((n) => !n.read).length;
  const conn = CONN_UI[connection] || CONN_UI.offline;
  const go = (id) => store.set({ view: id });
  return e('div', { style: { width: 230, flex: 'none', background: 'var(--background)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    e('button', { onClick: () => store.set({ project: null, view: 'picker' }), style: { display: 'flex', alignItems: 'center', gap: 10, margin: '12px 12px 6px', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--card)', cursor: 'pointer', textAlign: 'left' } },
      e('span', { style: { width: 26, height: 26, borderRadius: 'var(--radius-sm)', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, flex: 'none' } }, '//'),
      e('div', { style: { flex: 1, minWidth: 0 } },
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, project ? project.name : 'no project'),
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, 'switch project')),
      e('span', { style: { color: 'var(--neutral-400)', display: 'flex' } }, e(Icon, { name: 'chevronDown', size: 14 })),
    ),
    e('div', { style: { flex: 1, overflowY: 'auto', padding: '8px 12px' } },
      NAV.map((grp) => e('div', { key: grp.group, style: { marginBottom: 14 } },
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--neutral-400)', padding: '0 8px', marginBottom: 4 } }, grp.group),
        grp.items.map((it) => e(NavItem, { key: it.id, it, active: view === it.id || (view === 'session' && it.id === 'board') || (view === 'diff' && it.id === 'board'),
          onClick: () => go(it.id), badge: it.id === 'notifications' && unread ? unread : null })),
      )),
    ),
    e('div', { style: { borderTop: '1px solid var(--border)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 } },
      e(StatusDot, { status: conn.status, pulse: conn.pulse }),
      e('div', { style: { flex: 1, minWidth: 0 } },
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--foreground)' } }, conn.label),
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted-foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, live ? 'streaming from coordinator' : harnesses.filter((h) => h.status === 'connected').length + ' harnesses')),
    ),
  );
}

function NotifBell() {
  const { notifs } = useStore();
  const [open, setOpen] = React.useState(false);
  const unread = notifs.filter((n) => !n.read).length;
  const ref = React.useRef(null);
  React.useEffect(() => {
    const h = (ev) => { if (ref.current && !ref.current.contains(ev.target)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const KIND_ICON = { permission: 'lock', review: 'users', diff: 'diff', projection: 'link', merge: 'merge' };
  return e('div', { ref, style: { position: 'relative' } },
    e('button', { onClick: () => setOpen((o) => !o), 'aria-label': 'Notifications', style: { position: 'relative', display: 'flex', width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-md)', border: 'none', background: open ? 'var(--accent)' : 'transparent', color: 'var(--muted-foreground)', cursor: 'pointer' } },
      e(Icon, { name: 'bell', size: 18 }),
      unread ? e('span', { style: { position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: 999, background: 'var(--destructive)', boxShadow: '0 0 0 2px var(--background)' } }) : null,
    ),
    open ? e('div', { style: { position: 'absolute', top: 40, right: 0, width: 330, maxHeight: 380, overflowY: 'auto', background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', zIndex: 60 } },
      e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderBottom: '1px solid var(--border)' } },
        e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600 } }, 'Notifications'),
        e('button', { onClick: () => engine.markNotifsRead(), style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--muted-foreground)', background: 'none', border: 'none', cursor: 'pointer' } }, 'Mark all read')),
      notifs.slice(0, 8).map((n) => e('button', { key: n.id, onClick: () => { store.set({ view: n.view || 'notifications' }); setOpen(false); }, style: { display: 'flex', gap: 10, width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', borderBottom: '1px solid var(--line-soft)', background: n.read ? 'transparent' : 'var(--accent)', cursor: 'pointer' } },
        e('span', { style: { color: 'var(--muted-foreground)', display: 'flex', marginTop: 1 } }, e(Icon, { name: KIND_ICON[n.kind] || 'dot', size: 15 })),
        e('div', { style: { flex: 1 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--foreground)', lineHeight: 1.4 } }, n.text),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)', marginTop: 2 } }, ago(n.ts))))),
      e('button', { onClick: () => { store.set({ view: 'notifications' }); setOpen(false); }, style: { display: 'block', width: '100%', textAlign: 'center', padding: '10px', border: 'none', background: 'transparent', fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--foreground)', cursor: 'pointer' } }, 'See all notifications'),
    ) : null,
  );
}

function RuntimeToggle() {
  const mode = useStore((s) => s.runtimeMode);
  const sup = mode === 'supervised';
  return e('button', { onClick: () => store.set({ runtimeMode: sup ? 'full-access' : 'supervised' }),
    title: 'Runtime mode — ' + (sup ? 'supervised (gates on)' : 'full access'),
    style: { display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px 5px 9px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 500, color: 'var(--foreground)' } },
    e('span', { style: { display: 'flex', color: sup ? 'var(--foreground)' : 'var(--warning)' } }, e(Icon, { name: sup ? 'shield' : 'zap', size: 14 })),
    sup ? 'Supervised' : 'Full access');
}

function ThemeToggle() {
  const theme = useStore((s) => s.theme);
  return e('button', { onClick: () => store.set({ theme: theme === 'dark' ? 'light' : 'dark' }), 'aria-label': 'Toggle theme',
    style: { display: 'flex', width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-md)', border: 'none', background: 'transparent', color: 'var(--muted-foreground)', cursor: 'pointer' } },
    e(Icon, { name: theme === 'dark' ? 'sun' : 'moon', size: 18 }));
}

function TopBar({ crumbs, actions }: any) {
  return e('div', { style: { height: 56, flex: 'none', background: 'var(--background)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', padding: '0 18px', gap: 12 } },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
      (crumbs || []).map((c, i) => e(React.Fragment, { key: i },
        i > 0 ? e('span', { style: { color: 'var(--neutral-400)', display: 'flex' } }, e(Icon, { name: 'chevron', size: 14 })) : null,
        e('span', { style: { fontFamily: i === crumbs.length - 1 ? 'var(--font-sans)' : 'var(--font-mono)', fontSize: i === crumbs.length - 1 ? 15 : 12, fontWeight: i === crumbs.length - 1 ? 600 : 400, letterSpacing: i === crumbs.length - 1 ? '-0.01em' : 0, color: i === crumbs.length - 1 ? 'var(--foreground)' : 'var(--muted-foreground)', whiteSpace: 'nowrap' } }, c))),
    ),
    e('div', { style: { flex: 1 } }),
    actions || null,
    e('div', { style: { width: 1, height: 22, background: 'var(--border)', margin: '0 2px' } }),
    e(RuntimeToggle, null),
    e(ThemeToggle, null),
    e(NotifBell, null),
    e('div', { style: { width: 30, height: 30, borderRadius: 999, background: 'var(--secondary)', color: 'var(--foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, marginLeft: 2 } }, 'PN'),
  );
}

export function Shell({ crumbs, actions, children }: any) {
  const chrome = useStore((s) => s.chrome);
  return e('div', { style: { height: '100%', width: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--background)' } },
    chrome === 'desktop' ? e(ChromeBar, null) : null,
    e('div', { style: { flex: 1, display: 'flex', minHeight: 0 } },
      e(Sidebar, null),
      e('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
        e(TopBar, { crumbs, actions }),
        e('div', { style: { flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' } }, children),
      ),
    ),
  );
}
