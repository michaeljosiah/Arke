import React from 'react';
import { store, useStore } from './store';
import { Icon } from './icons';

const e = React.createElement;

// Accent swatch options matching the prototype
const ACCENTS = [
  { label: 'Graphite', value: 'graphite', hex: '#6b7280' },
  { label: 'Slate', value: 'slate', hex: '#475569' },
  { label: 'Zinc', value: 'zinc', hex: '#71717a' },
  { label: 'Stone', value: 'stone', hex: '#78716c' },
  { label: 'Indigo', value: 'indigo', hex: '#4f46e5' },
  { label: 'Violet', value: 'violet', hex: '#7c3aed' },
];

function AccentSwatches({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return e('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap' } },
    ACCENTS.map((a) => e('button', {
      key: a.value,
      title: a.label,
      onClick: () => onChange(a.value),
      style: {
        width: 24, height: 24, borderRadius: '50%', border: value === a.value ? '2px solid var(--foreground)' : '2px solid transparent',
        background: a.hex, cursor: 'pointer', padding: 0, boxSizing: 'border-box',
        outline: value === a.value ? '2px solid var(--background)' : 'none', outlineOffset: -4,
      }
    })));
}

export function Tweaks() {
  const [open, setOpen] = React.useState(false);
  const { theme, density, runtimeMode, accent, chrome, liveStream } = useStore();
  const set = (patch: any) => store.set(patch);

  if (!open) {
    return e('button', {
      onClick: () => setOpen(true),
      title: 'Open dev tweaks panel',
      style: {
        position: 'fixed', bottom: 18, right: 18, zIndex: 9999,
        width: 40, height: 40, borderRadius: '50%',
        background: 'var(--secondary)', border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-md)', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted-foreground)',
      }
    }, e(Icon, { name: 'settings', size: 17 }));
  }

  return e('div', {
    style: {
      position: 'fixed', bottom: 18, right: 18, zIndex: 9999,
      width: 280, background: 'var(--background)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
    }
  },
    // Header
    e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderBottom: '1px solid var(--border)', background: 'var(--secondary)' } },
      e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 } }, 'Dev tweaks'),
      e('button', { onClick: () => setOpen(false), style: { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', display: 'flex', padding: 0 } }, e(Icon, { name: 'x', size: 15 }))),
    // Body
    e('div', { style: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14 } },
      // Theme
      e('div', null,
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)', marginBottom: 7 } }, 'Theme'),
        e('div', { style: { display: 'flex', gap: 6 } },
          ['light', 'dark'].map((t) => e('button', { key: t, onClick: () => set({ theme: t }),
            style: { flex: 1, padding: '6px 0', border: '1px solid', borderColor: theme === t ? 'var(--foreground)' : 'var(--border)', borderRadius: 'var(--radius-sm)', background: theme === t ? 'var(--foreground)' : 'transparent', color: theme === t ? 'var(--background)' : 'var(--muted-foreground)', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 500, cursor: 'pointer', textTransform: 'capitalize' } }, t)))),
      // Density
      e('div', null,
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)', marginBottom: 7 } }, 'Density'),
        e('div', { style: { display: 'flex', gap: 6 } },
          ['comfortable', 'compact'].map((d) => e('button', { key: d, onClick: () => set({ density: d }),
            style: { flex: 1, padding: '6px 0', border: '1px solid', borderColor: density === d ? 'var(--foreground)' : 'var(--border)', borderRadius: 'var(--radius-sm)', background: density === d ? 'var(--foreground)' : 'transparent', color: density === d ? 'var(--background)' : 'var(--muted-foreground)', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 500, cursor: 'pointer', textTransform: 'capitalize' } }, d)))),
      // Runtime mode
      e('div', null,
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)', marginBottom: 7 } }, 'Runtime mode'),
        e('div', { style: { display: 'flex', gap: 6 } },
          ['supervised', 'full-access'].map((r) => e('button', { key: r, onClick: () => set({ runtimeMode: r }),
            style: { flex: 1, padding: '6px 0', border: '1px solid', borderColor: runtimeMode === r ? 'var(--foreground)' : 'var(--border)', borderRadius: 'var(--radius-sm)', background: runtimeMode === r ? 'var(--foreground)' : 'transparent', color: runtimeMode === r ? 'var(--background)' : 'var(--muted-foreground)', fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 500, cursor: 'pointer' } }, r)))),
      // Accent
      e('div', null,
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)', marginBottom: 7 } }, 'Accent'),
        e(AccentSwatches, { value: accent ?? 'graphite', onChange: (v) => set({ accent: v }) })),
    ));
}
