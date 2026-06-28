import React from 'react';
import { Icon } from './icons';

const e = React.createElement;

export function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

export function Label({ children, style }: { children?; style?: React.CSSProperties }) {
  return e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', ...style } }, children);
}

export function Meta({ children, style }: { children?; style?: React.CSSProperties }) {
  return e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted-foreground)', ...style } }, children);
}

export function Page({ children, max, pad }: { children?; max?: string | number; pad?: string }) {
  return e('div', { style: { height: '100%', overflowY: 'auto' } },
    e('div', { style: { padding: pad || 'var(--page-pad)', maxWidth: max || 'none', margin: max ? '0 auto' : 0 } }, children));
}

export function SectionHead({ eyebrow, title, sub, action, style }: any) {
  return e('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 18, ...style } },
    e('div', { style: { flex: 1, minWidth: 0 } },
      eyebrow ? e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 6 } }, eyebrow) : null,
      e('h1', { style: { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 21, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--foreground)' } }, title),
      sub ? e('p', { style: { margin: '6px 0 0', fontFamily: 'var(--font-sans)', fontSize: 13.5, lineHeight: 1.5, color: 'var(--muted-foreground)', maxWidth: 620 } }, sub) : null),
    action || null);
}

export function Empty({ icon, title, body }: { icon: string; title: string; body: string }) {
  return e('div', { style: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, padding: 40 } },
    e('span', { style: { color: 'var(--neutral-400)' } }, e(Icon, { name: icon, size: 28 })),
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 16, fontWeight: 600, color: 'var(--foreground)' } }, title),
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, maxWidth: 380, textAlign: 'center', color: 'var(--muted-foreground)', lineHeight: 1.5 } }, body));
}

export const statusTone = { draft: 'draft', 'in-review': 'review', approved: 'approved', merged: 'merged' };
