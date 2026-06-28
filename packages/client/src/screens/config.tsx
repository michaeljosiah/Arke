// Arke — Integrations screen (ported from canonical screens_gov.jsx SO_Integrations)
import React from 'react';
import { Icon } from '../icons';
import { Button, Badge, Card, Callout, StatusDot } from '../ds';
import { Page, SectionHead } from '../utils';
import { store, useStore } from '../store';

const e = React.createElement;

const WIRING = {
  'agent-side': { label: 'Agent-side', note: 'the agent invokes it in-session, gated by a permission prompt' },
  'projection-side': { label: 'Projection-side', note: 'a deterministic plugin writes the record on a status change' },
  'both': { label: 'Agent-side & projection-side', note: 'repos in-session; work items by deterministic projection' },
  '—': { label: 'Not wired', note: 'connect on the host to enable' },
};

const STATUS = {
  connected: { dot: 'agree', text: 'connected', color: 'var(--success)' },
  partial: { dot: 'waiting', text: 'attention', color: 'var(--warning)' },
  disconnected: { dot: 'idle', text: 'not connected', color: 'var(--muted-foreground)' },
};

export function Integrations() {
  const integrations = useStore((s) => s.integrations);
  return e(Page, { max: 1020 },
    e(SectionHead, { eyebrow: 'Delivery', title: 'Integrations',
      sub: 'The external systems a project writes to. Each is authorised once on the host — the client never holds credentials — and shows whether it is connected, what it enables, and how it is wired. Integrations are required before generation opens a pull request or a projection writes a ticket, but never to author or review a specification.',
      action: e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'plus', size: 15 }) }, 'Add integration') }),
    e('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
      (integrations || []).map((it) => {
        const st = STATUS[it.status] || STATUS.disconnected;
        const wr = WIRING[it.wiring] || WIRING['—'];
        const off = it.status === 'disconnected';
        return e(Card, { key: it.id, padding: 0 },
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px' } },
            e('span', { style: { flex: 'none', width: 40, height: 40, borderRadius: 'var(--radius-md)', background: off ? 'var(--secondary)' : 'var(--primary)', color: off ? 'var(--muted-foreground)' : 'var(--primary-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: it.icon, size: 19 })),
            e('div', { style: { flex: 1, minWidth: 0 } },
              e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, it.name),
                e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 11, color: st.color } }, e(StatusDot, { status: st.dot, pulse: it.status === 'partial' }), st.text),
                it.status !== 'disconnected' ? e(Badge, { variant: 'secondary' }, wr.label) : null),
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted-foreground)', marginTop: 3 } }, it.mechanism + (it.account && it.account !== '—' ? ' · ' + it.account : ''))),
            off
              ? e(Button, { size: 'sm', iconLeft: e(Icon, { name: 'external', size: 13 }) }, 'Connect on host')
              : it.status === 'partial'
                ? e(Button, { size: 'sm', variant: 'outline', iconLeft: e(Icon, { name: 'refresh', size: 13 }),
                    onClick: () => store.set({ integrations: store.get().integrations.map((x) => x.id === it.id ? { ...x, status: 'connected', host: 'authorised on host · token never leaves it' } : x) }) }, 'Re-authorise')
                : e(Button, { size: 'sm', variant: 'outline' }, 'Manage')),
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 18, padding: '11px 18px', borderTop: '1px solid var(--border)', background: 'var(--muted)', flexWrap: 'wrap' } },
            e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              it.enables.map((en) => e('span', { key: en, style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-sans)', fontSize: 12, color: off ? 'var(--neutral-400)' : 'var(--foreground)' } },
                e('span', { style: { display: 'flex', color: off ? 'var(--neutral-400)' : 'var(--success)' } }, e(Icon, { name: off ? 'minus' : 'check', size: 13 })), en))),
            e('div', { style: { flex: 1 } }),
            e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: it.status === 'partial' ? 'var(--warning)' : 'var(--neutral-400)' } },
              e(Icon, { name: 'lock', size: 12 }), it.host)));
      })),
    e('div', { style: { marginTop: 18 } },
      e(Callout, { variant: 'default', label: 'The host owns the credential path' }, 'An integration is authorised on the harness host, exactly like the harness itself, so its tokens never reach the browser. The registry shows status and walks you to the host-side connection rather than collecting anything. Projection-side writes are deterministic code, not free-form agent behaviour — so the record is reliable and audited.')),
  );
}
