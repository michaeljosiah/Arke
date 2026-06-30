// Arke Design System components — replaces window.ArkeDesignSystem_b87656
import React from 'react';
import { Icon } from './icons';

const e = React.createElement;

// ---------- StatusDot ----------
export function StatusDot({ status, pulse }: { status?: string; pulse?: boolean }) {
  const COLOR = {
    agree: 'var(--success)', running: 'var(--foreground)', done: 'var(--success)',
    idle: 'var(--neutral-400)', waiting: 'var(--warning)', diverge: 'var(--destructive)',
    attention: 'var(--destructive)', warn: 'var(--warning)',
  };
  const col = COLOR[status] || 'var(--neutral-400)';
  return e('span', {
    style: {
      display: 'inline-block', width: 7, height: 7, borderRadius: 999,
      background: col, flex: 'none',
      boxShadow: pulse ? `0 0 0 0 ${col}` : undefined,
      animation: pulse ? 'soPulse 1.8s ease-out infinite' : undefined,
    },
  });
}

// ---------- Badge ----------
export function Badge({ children, variant = 'secondary', tone }: { children?; variant?: string; tone?: string }) {
  const BG = {
    default: 'var(--primary)', secondary: 'var(--secondary)', outline: 'transparent',
    destructive: 'var(--destructive)',
  };
  const FG = {
    default: 'var(--primary-foreground)', secondary: 'var(--foreground)', outline: 'var(--foreground)',
    destructive: 'var(--destructive-foreground)',
  };
  const BORDER = {
    default: 'none', secondary: 'none', outline: '1px solid var(--border)', destructive: 'none',
  };
  const v = tone === 'warn' ? 'outline' : variant;
  return e('span', {
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '1px 8px', borderRadius: 999,
      fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 500,
      background: BG[v] || BG.secondary, color: FG[v] || FG.secondary,
      border: BORDER[v] || BORDER.secondary,
      whiteSpace: 'nowrap',
    },
  }, children);
}

// ---------- Button ----------
export function Button({ children, onClick, disabled, variant = 'default', size = 'md', iconLeft, style }: any) {
  const [hover, setHover] = React.useState(false);
  const BG = {
    default: hover ? '#000' : 'var(--primary)',
    secondary: hover ? 'var(--neutral-200)' : 'var(--secondary)',
    outline: hover ? 'var(--accent)' : 'transparent',
    ghost: hover ? 'var(--accent)' : 'transparent',
    destructive: 'var(--destructive)',
  };
  const FG = {
    default: 'var(--primary-foreground)', secondary: 'var(--foreground)',
    outline: 'var(--foreground)', ghost: 'var(--foreground)', destructive: 'var(--destructive-foreground)',
  };
  const PAD = size === 'sm' ? '5px 10px' : '8px 14px';
  const FS = size === 'sm' ? 12 : 13;
  return e('button', {
    onClick, disabled,
    onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: PAD,
      border: variant === 'outline' ? '1px solid var(--border)' : 'none',
      borderRadius: 'var(--radius-md)', cursor: disabled ? 'not-allowed' : 'pointer',
      fontFamily: 'var(--font-sans)', fontSize: FS, fontWeight: 500,
      background: disabled ? 'var(--secondary)' : (BG[variant] || BG.default),
      color: disabled ? 'var(--muted-foreground)' : (FG[variant] || FG.default),
      transition: 'var(--transition-control)', opacity: disabled ? 0.6 : 1,
      whiteSpace: 'nowrap', ...style,
    },
  }, iconLeft || null, children);
}

// ---------- Input ----------
export function Input({ value, onChange, placeholder, mono, prefix, size: sz }: any) {
  return e('div', { style: { display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--background)', overflow: 'hidden' } },
    prefix ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)', padding: '0 8px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap', background: 'var(--secondary)' } }, prefix) : null,
    e('input', {
      value, onChange, placeholder,
      style: {
        flex: 1, border: 'none', outline: 'none', background: 'transparent',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: sz === 'sm' ? 11.5 : 13, padding: sz === 'sm' ? '5px 8px' : '8px 10px',
        color: 'var(--foreground)',
      },
    }),
  );
}

// ---------- Textarea ----------
export function Textarea({ value, onChange, placeholder, rows, onKeyDown }: any) {
  return e('textarea', {
    value, onChange, placeholder, rows: rows || 3, onKeyDown,
    style: {
      width: '100%', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      background: 'var(--background)', color: 'var(--foreground)',
      fontFamily: 'var(--font-sans)', fontSize: 13, padding: '9px 10px',
      resize: 'none', outline: 'none', boxSizing: 'border-box',
      lineHeight: 1.5,
    },
  });
}

// ---------- Card ----------
export function Card({ children, padding = 16, style }: any) {
  return e('div', {
    style: {
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-xl)', padding, ...style,
    },
  }, children);
}

// ---------- Callout ----------
export function Callout({ children, label, variant = 'default', style }: any) {
  return e('div', {
    style: {
      padding: '12px 14px', borderRadius: 'var(--radius-lg)',
      background: 'var(--secondary)', border: '1px solid var(--border)', ...style,
    },
  },
    label ? e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--foreground)', marginBottom: 5 } }, label) : null,
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--muted-foreground)', lineHeight: 1.55 } }, children),
  );
}

// ---------- Tabs ----------
export function Tabs({ tabs, value, onChange, mono }: any) {
  return e('div', { style: { display: 'flex', gap: 2, borderBottom: '1px solid var(--border)' } },
    tabs.map((t) => {
      const active = t.id === value;
      return e('button', {
        key: t.id, onClick: () => onChange(t.id),
        style: {
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 12px', border: 'none', borderBottom: active ? '2px solid var(--foreground)' : '2px solid transparent',
          background: 'transparent', cursor: 'pointer',
          fontFamily: mono === false ? 'var(--font-sans)' : 'var(--font-sans)',
          fontSize: 13, fontWeight: active ? 600 : 400, color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
          marginBottom: -1,
        },
      }, t.label,
        t.count != null ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, t.count) : null);
    }),
  );
}

// ---------- Switch ----------
export function Switch({ checked, onChange }: any) {
  return e('button', {
    onClick: () => onChange(!checked),
    role: 'switch', 'aria-checked': checked,
    style: {
      position: 'relative', width: 36, height: 20, border: 'none', borderRadius: 999, cursor: 'pointer', padding: 0,
      background: checked ? 'var(--foreground)' : 'var(--border)',
      transition: 'background 0.15s',
    },
  },
    e('span', {
      style: {
        position: 'absolute', top: 3, left: checked ? 19 : 3, width: 14, height: 14,
        borderRadius: 999, background: '#fff', transition: 'left 0.15s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      },
    }),
  );
}

// ---------- AgentMessage ----------
export function AgentMessage({ children, role, agent, model }: any) {
  const isAgent = role === 'agent';
  return e('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, alignItems: isAgent ? 'flex-start' : 'flex-end' } },
    isAgent ? e('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
      e('span', { style: { width: 24, height: 24, borderRadius: 'var(--radius-sm)', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        e(Icon, { name: 'bot', size: 13 })),
      e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, color: 'var(--foreground)' } }, agent || 'Agent'),
      model ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)' } }, model) : null,
    ) : null,
    e('div', {
      style: {
        maxWidth: '85%', padding: '10px 13px', borderRadius: isAgent ? '4px 12px 12px 12px' : '12px 4px 12px 12px',
        background: isAgent ? 'var(--secondary)' : 'var(--primary)', color: isAgent ? 'var(--foreground)' : 'var(--primary-foreground)',
        fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.55,
      },
    }, children),
  );
}

// ---------- KanbanCard ----------
export function KanbanCard({ taskId, title, status, harness, model, needsHuman }: any) {
  const STATUS_COLOR = {
    running: 'var(--foreground)', waiting: 'var(--warning)', done: 'var(--success)', idle: 'var(--neutral-400)',
  };
  return e('div', {
    style: {
      padding: '11px 13px', background: 'var(--card)', border: needsHuman ? '1px solid color-mix(in srgb, var(--destructive) 50%, var(--border))' : '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-xs)',
    },
  },
    e('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 } },
      e('span', { style: { flex: 'none', marginTop: 2 } }, e(StatusDot, { status: needsHuman ? 'attention' : status, pulse: status === 'running' && !needsHuman })),
      e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500, color: 'var(--foreground)', lineHeight: 1.4, flex: 1 } }, title),
    ),
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, taskId),
      e('span', { style: { flex: 1 } }),
      needsHuman ? e('span', { style: { display: 'flex', color: 'var(--destructive)' } }, e(Icon, { name: 'lock', size: 11 })) : null,
      e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted-foreground)' } }, harness),
      e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)' } }, model),
    ),
  );
}

// ---------- SpecCard ----------
export function SpecCard({ specId, title, status, meta, onClick, warn }: any) {
  const [hover, setHover] = React.useState(false);
  const TONE = { draft: 'var(--foreground)', 'in-review': 'var(--warning)', approved: 'var(--success)', merged: 'var(--neutral-400)' };
  const STATUS_LABEL = { draft: 'Draft', 'in-review': 'In review', approved: 'Approved', merged: 'Merged' };
  return e('div', {
    onClick,
    onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
    style: {
      padding: '14px 16px', background: hover ? 'var(--accent)' : 'var(--card)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', cursor: 'pointer',
      transition: 'var(--transition-control)',
    },
  },
    e('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 } },
      e('span', { style: { flex: 'none', marginTop: 2, color: TONE[status] || 'var(--neutral-400)' } }, e(StatusDot, { status: status === 'approved' ? 'agree' : status === 'merged' ? 'idle' : status === 'in-review' ? 'waiting' : 'running', pulse: status === 'draft' })),
      e('div', { style: { flex: 1, minWidth: 0 } },
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600, color: 'var(--foreground)', marginBottom: 3, lineHeight: 1.35 } }, title),
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)' } }, specId),
      ),
      // SPEC-008: divergence warning — read-model status differs from the file's frontmatter status.
      warn ? e('span', { title: 'Status diverges from the file frontmatter', style: { flex: 'none', color: 'var(--warning)', display: 'flex' } }, e(Icon, { name: 'alert', size: 15 })) : null,
    ),
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-sans)', fontSize: 11.5, color: TONE[status] || 'var(--foreground)', fontWeight: 500 } }, STATUS_LABEL[status] || status),
      e('span', { style: { flex: 1 } }),
      e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 } }, meta),
    ),
  );
}

// inject pulse animation globally once
if (typeof document !== 'undefined') {
  const styleId = 'so-ds-pulse';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = '@keyframes soPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }';
    document.head.appendChild(s);
  }
}
