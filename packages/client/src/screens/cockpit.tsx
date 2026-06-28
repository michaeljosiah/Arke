import React from 'react';
import { Icon } from '../icons';
import { AgentMessage, Button, Textarea, Badge, StatusDot } from '../ds';
import { store } from '../store';

const e = React.createElement;

const ROLES = [
  { role: 'Product Owner', model: 'Opus', writes: 'requirements' },
  { role: 'Technical Architect', model: 'Opus', writes: 'design' },
  { role: 'Engineering', model: 'mid-tier', writes: 'tasks' },
];

function seedSpec() {
  return {
    frontmatter: ['status: draft', 'owner: priya.n', 'spec_id: SPEC-014', 'source_of_truth: git'],
    requirements: [
      { t: 'Summary — idempotent payment retry so a duplicated webhook never double-charges.', shall: false },
      { t: 'SHALL not double-charge given a repeated event id. WHEN a webhook with a seen idempotency_key arrives THEN the retry is a no-op.', shall: true },
      { t: 'Scope — retry handler and payments schema. Evaluation rules are out of scope for v1.', shall: false },
      { t: 'Open question — retention window for processed keys?', shall: false, open: true },
    ],
    design: [
      { t: 'Architectural decision — key on a unique idempotency_key column on the payments table.', shall: false },
      { t: 'Data model — payments.idempotency_key (unique, indexed); processed_at timestamp.', shall: false },
      { t: 'API contract — POST /retries SHALL be idempotent on the key.', shall: true },
      { t: 'Security — keys scoped per tenant; no cross-tenant reuse.', shall: false },
    ],
    tasks: [
      { t: 'Add idempotency_key migration', tier: 'mid-tier' },
      { t: 'Guard the retry handler', tier: 'mid-tier' },
      { t: 'Backfill processed events', tier: 'needs a human' },
      { t: 'Definition of done — typecheck + checks pass', tier: 'gate' },
    ],
  };
}

const SEED_MSGS = [
  { id: 'm1', role: 'agent', agent: 'Product Owner', model: 'Opus', text: 'Captured the requirement: payment retries must be idempotent so a duplicated webhook never double-charges. Acceptance criteria drafted as SHALL statements with WHEN/THEN scenarios.' },
  { id: 'm2', role: 'human', text: 'Good. Move the evaluation rules out of scope for v1 and tighten the acceptance criteria.' },
  { id: 'm3', role: 'agent', agent: 'Technical Architect', model: 'Opus', text: 'Drafting the data model and API contracts from the codebase. An idempotency_key column is added to the payments table; the retry handler keys on it. Preview updated on the right.' },
];

function MiniSelect({ value, options, onChange, icon }: any) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => { const h = (ev) => { if (ref.current && !ref.current.contains(ev.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  return e('div', { ref, style: { position: 'relative' } },
    e('button', { onClick: () => setOpen((o) => !o), style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 500, color: 'var(--foreground)' } },
      icon ? e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: icon, size: 13 })) : null,
      value, e('span', { style: { display: 'flex', color: 'var(--neutral-400)' } }, e(Icon, { name: 'chevronDown', size: 12 }))),
    open ? e('div', { style: { position: 'absolute', bottom: 30, left: 0, minWidth: 150, background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', zIndex: 40, padding: 4 } },
      options.map((o) => e('button', { key: o, onClick: () => { onChange(o); setOpen(false); }, style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 9px', borderRadius: 'var(--radius-sm)', border: 'none', background: o === value ? 'var(--accent)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--foreground)' } }, o))) : null,
  );
}

function Section({ title, children, editing }: any) {
  return e('div', { style: { marginBottom: 22, transition: 'background .4s', background: editing ? 'var(--warning-bg)' : 'transparent', borderRadius: 'var(--radius-md)', padding: editing ? '8px 10px' : '0', margin: editing ? '0 -10px 18px' : '0 0 22px' } },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
      e('h3', { style: { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 14.5, fontWeight: 600, color: 'var(--foreground)', letterSpacing: '-0.01em' } }, title),
      editing ? e(Badge, { variant: 'outline' }, 'editing') : null),
    children);
}

function SpecPreview({ spec, editing }: any) {
  const line = (it, i) => e('div', { key: i, style: { display: 'flex', gap: 8, marginBottom: 7, alignItems: 'flex-start' } },
    it.shall
      ? e('span', { style: { flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 6px', marginTop: 1 } }, 'SHALL')
      : it.open ? e('span', { style: { flex: 'none', color: 'var(--warning)', display: 'flex', marginTop: 2 } }, e(Icon, { name: 'alert', size: 13 }))
      : e('span', { style: { flex: 'none', color: 'var(--neutral-400)', marginTop: -1 } }, '·'),
    e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.6, color: 'var(--foreground)' } }, it.t));
  return e('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--background)', borderLeft: '1px solid var(--border)' } },
    e('div', { style: { padding: '11px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 } },
      e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'fileText', size: 15 })),
      e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--foreground)' } }, 'payment-retry.md'),
      e('span', { style: { marginLeft: 'auto', fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--muted-foreground)' } }, 'a view of the working file in the repo'),
      e(Button, { size: 'sm', iconLeft: e(Icon, { name: 'check', size: 14 }), onClick: () => store.set({ view: 'generation' }) }, 'Approve & persist')),
    e('div', { style: { padding: '9px 20px', background: 'var(--secondary)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16, flexWrap: 'wrap' } },
      spec.frontmatter.map((t, i) => e('span', { key: i, style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, t))),
    e('div', { style: { padding: '20px 22px', overflowY: 'auto', flex: 1 } },
      e(Section, { title: 'Requirements', editing: editing === 'requirements' }, spec.requirements.map(line)),
      e(Section, { title: 'Design', editing: editing === 'design' }, spec.design.map(line)),
      e(Section, { title: 'Tasks', editing: editing === 'tasks' },
        spec.tasks.map((t, i) => e('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          e('span', { style: { flex: 'none', display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'commit', size: 14 })),
          e('span', { style: { flex: 1, fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--foreground)' } }, t.t),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: t.tier === 'needs a human' ? 'var(--warning)' : 'var(--muted-foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 7px' } }, t.tier)))),
    ),
  );
}

export function Cockpit() {
  const [msgs, setMsgs] = React.useState(SEED_MSGS);
  const [spec, setSpec] = React.useState(seedSpec);
  const [draft, setDraft] = React.useState('');
  const [role, setRole] = React.useState('Technical Architect');
  const [model, setModel] = React.useState('Opus');
  const [editing, setEditing] = React.useState(null);
  const [streaming, setStreaming] = React.useState(false);
  const scroller = React.useRef(null);
  React.useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [msgs]);

  const streamReply = (fullText, opts) => {
    const id = 'a' + Date.now();
    setStreaming(true);
    setMsgs((m) => [...m, { id, role: 'agent', agent: opts.agent, model: opts.model, text: '' }]);
    const words = fullText.split(' ');
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setMsgs((m) => m.map((x) => x.id === id ? { ...x, text: words.slice(0, i).join(' ') } : x));
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
      if (i >= words.length) {
        clearInterval(iv); setStreaming(false);
        if (opts.onDone) opts.onDone();
      }
    }, 45);
  };

  const send = () => {
    if (!draft.trim() || streaming) return;
    const text = draft.trim();
    setMsgs((m) => [...m, { id: 'h' + Date.now(), role: 'human', text }]);
    setDraft('');
    const r = ROLES.find((x) => x.role === role) || ROLES[1];
    const target = r.writes;
    setTimeout(() => {
      setEditing(target);
      streamReply('Understood. Updating the ' + target + ' section now — ' + (target === 'tasks' ? 're-deriving the implementation plan and acceptance criteria to match.' : target === 'design' ? 'revising the data model and API contracts grounded in the codebase.' : 'tightening the SHALL statements and scenarios.') + ' The change is reflected in the preview.', {
        agent: role, model,
        onDone: () => {
          setSpec((sp) => {
            const next = { ...sp };
            if (target === 'tasks') next.tasks = [...sp.tasks.slice(0, 2), { t: 'Add retry-attempt metric', tier: 'mid-tier' }, ...sp.tasks.slice(2)];
            else if (target === 'design') next.design = [...sp.design, { t: 'Performance — index on (tenant_id, idempotency_key) keeps lookups O(log n).', shall: false }];
            else next.requirements = sp.requirements.map((x) => x.shall ? { ...x, t: x.t + ' Processed keys retained 30 days.' } : x);
            return next;
          });
          setTimeout(() => setEditing(null), 1200);
        },
      });
    }, 400);
  };

  return e('div', { style: { display: 'flex', height: '100%' } },
    e('div', { style: { width: 430, flex: 'none', display: 'flex', flexDirection: 'column', background: 'var(--background)', minWidth: 0 } },
      e('div', { style: { padding: '11px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 } },
        e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', fontWeight: 600 } }, 'Authoring'),
        streaming ? e('span', { style: { display: 'flex', alignItems: 'center', gap: 5 } }, e(StatusDot, { status: 'running', pulse: true }), e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, 'agent writing')) : null,
        e('div', { style: { flex: 1 } }),
        e(Button, { variant: 'outline', size: 'sm', iconLeft: e(Icon, { name: 'users', size: 14 }), onClick: () => store.set({ view: 'review' }) }, 'Convene review')),
      e('div', { ref: scroller, style: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 } },
        msgs.map((m) => e(AgentMessage, { key: m.id, role: m.role, agent: m.agent, model: m.model }, m.text || '…'))),
      e('div', { style: { padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--background)' } },
        e('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
          e(MiniSelect, { value: role, icon: 'bot', options: ROLES.map((r) => r.role), onChange: (v) => { setRole(v); const r = ROLES.find((x) => x.role === v); if (r) setModel(r.model); } }),
          e(MiniSelect, { value: model, icon: 'cpu', options: ['Opus', 'Sonnet', 'GPT-5.5', 'mid-tier'], onChange: setModel })),
        e(Textarea, { rows: 2, value: draft, placeholder: 'Direct the agents…', onChange: (ev) => setDraft(ev.target.value), onKeyDown: (ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) send(); } }),
        e('div', { style: { display: 'flex', alignItems: 'center', marginTop: 9 } },
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, '⌘↵ to send'),
          e('div', { style: { flex: 1 } }),
          e(Button, { size: 'sm', disabled: streaming, onClick: send }, 'Send'))),
    ),
    e(SpecPreview, { spec, editing }),
  );
}
