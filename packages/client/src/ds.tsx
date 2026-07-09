// Arke Design System components — replaces window.ArkeDesignSystem_b87656
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from './icons';
import { highlightCode, normalizeLang } from './markdown-theme';
import { useStore } from './store';

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
      width: '100%', border: 'none', borderRadius: 0,
      background: 'transparent', color: 'var(--foreground)',
      fontFamily: 'var(--font-sans)', fontSize: 14, padding: '4px 2px',
      resize: 'none', outline: 'none', boxSizing: 'border-box',
      lineHeight: 1.55,
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

// ---------- Markdown (SPEC-032) ----------
// A shared, sanitised markdown renderer used by the cockpit conversation and the spec preview,
// mirroring OpenCode v2's session-ui markdown rendering. All input (agent transcript, spec file) is
// untrusted: no raw HTML is rendered (react-markdown ignores it by default — no rehype-raw), links
// are restricted to http/https/mailto and open externally with rel=noopener. Fenced code is
// subtly highlighted (SPEC-033 teal accent) and copyable; the parse is memoised so an unchanged
// turn never re-parses during streaming.

/** Allow only http(s)/mailto links; anything else (javascript:, data:, …) is neutralised to text. */
function safeHref(href: any): string | null {
  if (!href || typeof href !== 'string') return null;
  const u = href.trim();
  return /^(https?:|mailto:)/i.test(u) ? u : null;
}

function fallbackCopy(text: string, done: () => void) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.pointerEvents = 'none';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done();
  } catch { /* clipboard unavailable — leave silently */ }
}

/** Copy control for a code block: copies the exact source (excludes highlighting markup + fences). */
function CopyButton({ text }: any) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1400); };
    const clip = (typeof navigator !== 'undefined' && navigator.clipboard) ? navigator.clipboard : null;
    if (clip?.writeText) clip.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  };
  return e('button', { className: 'arke-code-copy', onClick: onCopy, title: copied ? 'Copied' : 'Copy', 'aria-label': copied ? 'Copied' : 'Copy code' },
    e(Icon, { name: copied ? 'check' : 'copy', size: 13 }));
}

/** A fenced code block: neutral surface + Geist Mono, shiki highlight when the language is known and
 *  the highlighter is ready, else plain monospace. Highlighting never blocks the surrounding text. */
function CodeBlock({ code, lang, isDark }: any) {
  const norm = normalizeLang(lang);
  const [html, setHtml] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    setHtml(null);
    if (!norm) return; // unknown/absent language → stay plain
    highlightCode(code, norm, isDark).then((h) => { if (alive) setHtml(h); }).catch(() => { /* stay plain */ });
    return () => { alive = false; };
  }, [code, norm, isDark]);
  return e('div', { className: 'arke-code', 'data-lang': norm || undefined },
    e(CopyButton, { text: code }),
    html
      ? e('div', { className: 'arke-code-scroll', dangerouslySetInnerHTML: { __html: html } })
      : e('div', { className: 'arke-code-scroll' }, e('pre', null, e('code', null, code))),
  );
}

function makeMarkdownComponents(isDark: boolean): any {
  return {
    // Unwrap <pre> — CodeBlock provides its own container, so we avoid a <div> inside <pre>.
    pre: ({ children }: any) => children,
    code: ({ className, children }: any) => {
      const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
      const m = /language-([\w-]+)/.exec(className || '');
      const isBlock = !!m || raw.includes('\n');
      if (!isBlock) return e('code', { className: 'arke-inline-code' }, children);
      return e(CodeBlock, { code: raw.replace(/\n$/, ''), lang: m ? m[1] : null, isDark });
    },
    a: ({ href, children }: any) => {
      const safe = safeHref(href);
      return safe ? e('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, children) : e('span', null, children);
    },
    img: ({ src, alt }: any) => (safeHref(src) ? e('img', { src, alt: alt || '', loading: 'lazy' }) : (alt ? e('span', null, alt) : null)),
  };
}

/**
 * Render untrusted markdown. `mode` tunes prose density (chat vs preview); `streaming` appends a
 * blinking caret at the tail. The ReactMarkdown element is memoised by (text, theme) so re-renders
 * driven by unrelated store updates don't re-parse an unchanged turn.
 */
export const Markdown = React.memo(function Markdown({ text, mode, streaming }: any) {
  const isDark = useStore((s: any) => s.theme === 'dark');
  const components = React.useMemo(() => makeMarkdownComponents(isDark), [isDark]);
  const md = React.useMemo(
    () => e(ReactMarkdown as any, { remarkPlugins: [remarkGfm], urlTransform: (u: string) => safeHref(u) ?? '', components }, text || ''),
    [text, components],
  );
  const cls = 'arke-md' + (mode === 'preview' ? ' arke-md-preview' : '') + (streaming ? ' arke-streaming' : '');
  return e('div', { className: cls }, md);
});

// ---------- AgentMessage ----------
// Agent turns: no bubble — flowing text (rendered markdown, SPEC-032) beneath a small icon+name
// header. User (human) turns: right-aligned subtle pill shown literally, matching OpenCode's pattern.
export function AgentMessage({ children, role, agent, model, streaming }: any) {
  const isAgent = role === 'agent';
  const agentBody = typeof children === 'string'
    ? e('div', { style: { paddingLeft: 26 } }, e(Markdown, { text: children, mode: 'chat', streaming }))
    : e('div', { style: { paddingLeft: 26, fontFamily: 'var(--font-sans)', fontSize: 14, lineHeight: 1.6, color: 'var(--foreground)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, children);
  return e('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: isAgent ? 'flex-start' : 'flex-end' } },
    isAgent ? e('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      e('span', { style: { width: 20, height: 20, borderRadius: 'var(--radius-sm)', background: 'var(--secondary)', color: 'var(--muted-foreground)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } },
        e(Icon, { name: 'bot', size: 11 })),
      e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--foreground)' } }, agent || 'Agent'),
      model ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)' } }, model) : null,
    ) : null,
    isAgent
      ? agentBody
      : e('div', { style: { maxWidth: 'min(82%, 64ch)', padding: '8px 12px', borderRadius: 10, background: 'var(--secondary)', fontFamily: 'var(--font-sans)', fontSize: 14, lineHeight: 1.55, color: 'var(--foreground)', wordBreak: 'break-word', whiteSpace: 'pre-wrap' } }, children),
  );
}

// ---------- SplitPane (SPEC-032) ----------
// A draggable divider between two panels. The split ratio (left-panel fraction) persists to
// localStorage; both panels clamp to minimum widths so neither collapses. The divider is a focusable
// role="separator": ArrowLeft/Right nudge it, Home (or double-click) resets to the default.
function readRatio(key: string | undefined, def: number): number {
  try {
    const v = key ? localStorage.getItem(key) : null;
    const n = v == null ? NaN : parseFloat(v);
    return Number.isFinite(n) && n > 0.1 && n < 0.9 ? n : def;
  } catch { return def; }
}

export function SplitPane({ left, right, storageKey, defaultRatio = 0.38, minLeft = 340, minRight = 380 }: any) {
  const containerRef = React.useRef<any>(null);
  const [ratio, setRatio] = React.useState(() => readRatio(storageKey, defaultRatio));
  const lastRatio = React.useRef(ratio);
  const cleanupRef = React.useRef<null | (() => void)>(null);
  lastRatio.current = ratio;

  const clampRatio = (r: number, width: number): number => {
    if (!width) return Math.min(Math.max(r, 0.15), 0.85);
    const minR = minLeft / width;
    const maxR = 1 - minRight / width;
    if (minR > maxR) return 0.5; // window too narrow for both minimums → split evenly
    return Math.min(Math.max(r, minR), maxR);
  };
  const persist = (r: number) => { try { if (storageKey) localStorage.setItem(storageKey, String(r)); } catch { /* ignore */ } };

  const startDrag = (ev: any) => {
    ev.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (e: any) => {
      const rect = el.getBoundingClientRect();
      const r = clampRatio((e.clientX - rect.left) / rect.width, rect.width);
      lastRatio.current = r;
      setRatio(r);
    };
    const up = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      cleanupRef.current = null;
      persist(lastRatio.current);
    };
    cleanupRef.current = up;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  React.useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);

  const nudge = (delta: number) => {
    const width = containerRef.current ? containerRef.current.getBoundingClientRect().width : 0;
    setRatio((r) => { const nr = clampRatio(r + delta, width); persist(nr); return nr; });
  };
  const reset = () => { persist(defaultRatio); setRatio(defaultRatio); };
  const onKeyDown = (ev: any) => {
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); nudge(-0.03); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); nudge(0.03); }
    else if (ev.key === 'Home') { ev.preventDefault(); reset(); }
  };

  return e('div', { ref: containerRef, style: { display: 'flex', height: '100%', width: '100%', minWidth: 0 } },
    e('div', { style: { flexGrow: 0, flexShrink: 0, flexBasis: `${ratio * 100}%`, minWidth: minLeft, maxWidth: `calc(100% - ${minRight + 6}px)`, minHeight: 0, display: 'flex', overflow: 'hidden' } }, left),
    e('div', {
      role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize panels', tabIndex: 0,
      'aria-valuenow': Math.round(ratio * 100), 'aria-valuemin': 0, 'aria-valuemax': 100,
      className: 'arke-split-handle', onMouseDown: startDrag, onDoubleClick: reset, onKeyDown, title: 'Drag to resize · double-click to reset',
    }),
    e('div', { style: { flex: '1 1 0', minWidth: minRight, minHeight: 0, display: 'flex', overflow: 'hidden' } }, right),
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
  const TONE = { draft: 'var(--foreground)', 'in-review': 'var(--warning)', approved: 'var(--success)', delivered: 'var(--neutral-400)' };
  const STATUS_LABEL = { draft: 'Draft', 'in-review': 'In review', approved: 'Approved', delivered: 'Delivered' };
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
      e('span', { style: { flex: 'none', marginTop: 2, color: TONE[status] || 'var(--neutral-400)' } }, e(StatusDot, { status: status === 'approved' ? 'agree' : status === 'delivered' ? 'idle' : status === 'in-review' ? 'waiting' : 'running', pulse: status === 'draft' })),
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

// inject shared animation keyframes globally once
if (typeof document !== 'undefined') {
  const styleId = 'so-ds-pulse';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = [
      '@keyframes soPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }',
      '@keyframes arkeSpinner { to { transform: rotate(360deg); } }',
      '@keyframes arkeBlink { 50%{opacity:0;} }',
      // --- rendered markdown (SPEC-032) ---
      '.arke-md{font-family:var(--font-sans);font-size:14px;line-height:1.6;color:var(--foreground);word-break:break-word;}',
      '.arke-md.arke-md-preview{font-size:12.5px;line-height:1.55;}',
      '.arke-md>*:first-child{margin-top:0;}',
      '.arke-md>*:last-child{margin-bottom:0;}',
      '.arke-md p{margin:0 0 8px;}',
      '.arke-md h1,.arke-md h2,.arke-md h3,.arke-md h4,.arke-md h5,.arke-md h6{font-weight:600;line-height:1.3;margin:16px 0 8px;letter-spacing:-0.01em;}',
      '.arke-md h1{font-size:1.4em;} .arke-md h2{font-size:1.24em;} .arke-md h3{font-size:1.1em;} .arke-md h4,.arke-md h5,.arke-md h6{font-size:1em;}',
      '.arke-md ul,.arke-md ol{margin:0 0 8px;padding-left:20px;}',
      '.arke-md li{margin:2px 0;} .arke-md li::marker{color:var(--muted-foreground);} .arke-md li>ul,.arke-md li>ol{margin:2px 0;}',
      '.arke-md a{color:var(--primary);text-decoration:underline;text-underline-offset:2px;}',
      '.arke-md blockquote{margin:8px 0;padding:2px 0 2px 12px;border-left:3px solid var(--border);color:var(--muted-foreground);}',
      '.arke-md hr{border:none;border-top:1px solid var(--border);margin:14px 0;}',
      '.arke-md strong{font-weight:600;} .arke-md em{font-style:italic;}',
      '.arke-md img{max-width:100%;border-radius:var(--radius-sm);}',
      '.arke-md table{border-collapse:collapse;margin:8px 0;font-size:0.95em;display:block;overflow-x:auto;max-width:100%;}',
      '.arke-md th,.arke-md td{border:1px solid var(--border);padding:5px 9px;text-align:left;}',
      '.arke-md th{background:var(--secondary);font-weight:600;}',
      '.arke-md code.arke-inline-code{font-family:var(--font-mono);font-size:0.88em;background:var(--secondary);border:1px solid var(--border);border-radius:4px;padding:0.5px 5px;}',
      '.arke-md ul.contains-task-list{list-style:none;padding-left:4px;} .arke-md li.task-list-item{list-style:none;} .arke-md li.task-list-item input{margin-right:7px;}',
      // --- fenced code block ---
      '.arke-code{position:relative;margin:8px 0;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--secondary);}',
      '.arke-code-scroll{overflow-x:auto;padding:10px 12px;}',
      '.arke-code pre{margin:0;background:transparent !important;font-family:var(--font-mono);font-size:12.5px;line-height:1.55;}',
      '.arke-code code{font-family:var(--font-mono);background:transparent;border:none;padding:0;font-size:inherit;}',
      '.arke-code-copy{position:absolute;top:6px;right:6px;z-index:1;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);color:var(--muted-foreground);cursor:pointer;opacity:0;transition:opacity .12s,color .12s,background .12s;}',
      '.arke-code:hover .arke-code-copy,.arke-code-copy:focus-visible{opacity:1;}',
      '.arke-code-copy:hover{color:var(--foreground);background:var(--accent);}',
      // --- streaming caret ---
      '.arke-md.arke-streaming>*:last-child::after{content:"";display:inline-block;width:6px;height:1em;margin-left:2px;vertical-align:text-bottom;background:var(--primary);animation:arkeBlink 1s step-end infinite;}',
      '@media (prefers-reduced-motion: reduce){ .arke-md.arke-streaming>*:last-child::after{animation:none;} }',
      // --- split-pane divider (SPEC-032) ---
      '.arke-split-handle{flex:0 0 6px;align-self:stretch;cursor:col-resize;position:relative;background:transparent;border:none;padding:0;margin:0;}',
      '.arke-split-handle::before{content:"";position:absolute;top:0;bottom:0;left:50%;transform:translateX(-50%);width:1px;background:var(--border);transition:background .12s,width .12s;}',
      '.arke-split-handle:hover::before,.arke-split-handle:focus-visible::before{width:2px;background:var(--primary);}',
      '.arke-split-handle:focus-visible{outline:none;}',
    ].join('\n');
    document.head.appendChild(s);
  }
}
