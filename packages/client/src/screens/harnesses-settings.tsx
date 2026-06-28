import React from 'react';
import { Icon } from '../icons';
import { Button, Badge, Card, Callout, StatusDot, Switch } from '../ds';
import { Page, SectionHead } from '../utils';
import { store, useStore } from '../store';

const e = React.createElement;

const ALL_CAPS = ['events', 'todos', 'diff', 'permissions', 'commands'];

function Seg({ value, options, onChange }: any) {
  return e('div', { style: { display: 'inline-flex', padding: 3, background: 'var(--secondary)', borderRadius: 'var(--radius-md)', gap: 3 } },
    options.map((o) => e('button', { key: o.v, onClick: () => onChange(o.v), style: { padding: '6px 13px', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500, background: value === o.v ? 'var(--background)' : 'transparent', color: value === o.v ? 'var(--foreground)' : 'var(--muted-foreground)', boxShadow: value === o.v ? 'var(--shadow-xs)' : 'none' } }, o.label)));
}

export function Harnesses() {
  const { harnesses, tiers } = useStore();
  return e(Page, { max: 1020 },
    e(SectionHead, { eyebrow: 'Project', title: 'Harnesses & models',
      sub: 'A registry of connected harnesses with their capabilities and models. You choose a role and a model; a routing layer chooses the harness — tier → model → harness. Capability flags absorb the differences.',
      action: e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'plus', size: 15 }) }, 'Connect harness') }),
    e('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 26 } },
      harnesses.map((h) => e(Card, { key: h.id, padding: 0 },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px' } },
          e('span', { style: { flex: 'none', width: 40, height: 40, borderRadius: 'var(--radius-md)', background: h.status === 'connected' ? 'var(--primary)' : 'var(--secondary)', color: h.status === 'connected' ? 'var(--primary-foreground)' : 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: 'server', size: 19 })),
          e('div', { style: { flex: 1, minWidth: 0 } },
            e('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, h.name),
              h.primary ? e(Badge, { variant: 'secondary' }, 'primary') : null,
              e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 11, color: h.status === 'connected' ? 'var(--success)' : 'var(--muted-foreground)' } }, e(StatusDot, { status: h.status === 'connected' ? 'agree' : 'idle', pulse: h.status === 'connected' }), h.status)),
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted-foreground)', marginTop: 3 } }, h.endpoint)),
          e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5, maxWidth: 260, justifyContent: 'flex-end' } },
            h.models.map((m) => e('span', { key: m, style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--foreground)', background: 'var(--secondary)', padding: '2px 7px', borderRadius: 'var(--radius-sm)' } }, m)))),
        e('div', { style: { display: 'flex', gap: 8, padding: '11px 18px', borderTop: '1px solid var(--border)', background: 'var(--muted)', flexWrap: 'wrap' } },
          ALL_CAPS.map((cap) => { const on = h.caps.includes(cap); return e('span', { key: cap, style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 11, color: on ? 'var(--foreground)' : 'var(--neutral-400)' } },
            e('span', { style: { display: 'flex', color: on ? 'var(--success)' : 'var(--neutral-400)' } }, e(Icon, { name: on ? 'check' : 'minus', size: 12 })), cap); })),
      ))),
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 10 } }, 'Model tiering — logical tier → concrete model'),
    e('div', { style: { display: 'flex', gap: 12, marginBottom: 18 } },
      tiers.map((t) => e(Card, { key: t.tier, padding: 16, style: { flex: 1 } },
        e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          e('div', null,
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600 } }, t.label),
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', marginTop: 2 } }, t.note)),
          e('span', { style: { display: 'flex', color: 'var(--neutral-400)' } }, e(Icon, { name: 'arrowRight', size: 16 }))),
        e('div', { style: { marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--foreground)', background: 'var(--secondary)', padding: '8px 11px', borderRadius: 'var(--radius-sm)' } }, t.model))),
    ),
    e(Callout, { variant: 'default', label: 'Continuity lives in git, not the harness' }, 'A harness session is ephemeral and disposable — the specification and the code are on the feature branch. Switching harnesses loses nothing durable; you start a fresh session against the same branch.'),
  );
}

function Row({ title, sub, children }: any) {
  return e('div', { style: { display: 'flex', alignItems: 'center', gap: 16, padding: '15px 0', borderBottom: '1px solid var(--line-soft)' } },
    e('div', { style: { flex: 1, minWidth: 0 } },
      e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 500, color: 'var(--foreground)' } }, title),
      sub ? e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)', marginTop: 2, maxWidth: 480, lineHeight: 1.45 } }, sub) : null),
    e('div', { style: { flex: 'none' } }, children));
}

export function Settings() {
  const { theme, density, runtimeMode, accent, chrome, liveStream } = useStore();
  const [telemetry, setTelemetry] = React.useState(true);
  const set = (patch) => store.set(patch);
  const Group = ({ title, children }: any) => e('div', { style: { marginBottom: 26 } },
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 4 } }, title),
    e('div', null, children));
  return e(Page, { max: 760 },
    e(SectionHead, { eyebrow: 'Project', title: 'Settings', sub: 'Theme, default runtime mode, connections and telemetry.' }),
    e(Group, { title: 'Appearance' },
      e(Row, { title: 'Theme', sub: 'The system is a neutral monochrome with a full dark token set.' }, e(Seg, { value: theme, onChange: (v) => set({ theme: v }), options: [{ v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }] })),
      e(Row, { title: 'Density', sub: 'Comfortable for prose, compact for dense tool surfaces.' }, e(Seg, { value: density, onChange: (v) => set({ density: v }), options: [{ v: 'comfortable', label: 'Comfortable' }, { v: 'compact', label: 'Compact' }] })),
      e(Row, { title: 'Window chrome', sub: 'The desktop build runs as a signed Electron app; the browser build has no frame.' }, e(Seg, { value: chrome, onChange: (v) => set({ chrome: v }), options: [{ v: 'desktop', label: 'Desktop' }, { v: 'plain', label: 'Browser' }] }))),
    e(Group, { title: 'Governance' },
      e(Row, { title: 'Default runtime mode', sub: 'Supervised asks for approval and writes only within the workspace. Full access is for trusted flows.' }, e(Seg, { value: runtimeMode, onChange: (v) => set({ runtimeMode: v }), options: [{ v: 'supervised', label: 'Supervised' }, { v: 'full-access', label: 'Full access' }] })),
      e(Row, { title: 'Live event stream', sub: 'Project delivery state from harness events as they arrive.' }, e(Switch, { checked: liveStream, onChange: (v) => set({ liveStream: v }) }))),
    e(Group, { title: 'Telemetry' },
      e(Row, { title: 'Observability spans', sub: 'Spans at every boundary persist to a local NDJSON trace — the audit source of truth — and export via OTLP.' }, e(Switch, { checked: telemetry, onChange: setTelemetry })),
      e(Row, { title: 'OTLP endpoint', sub: 'Grafana / Tempo / Prometheus.' }, e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)' } }, 'otlp://localhost:4317'))),
    e(Group, { title: 'About' },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0' } },
        e('span', { style: { width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 14 } }, '//'),
        e('div', null,
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600 } }, 'SpecOne · Specification Orchestrator'),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, 'v0.8 · open source · shadcn/Radix neutral theme')))),
  );
}
