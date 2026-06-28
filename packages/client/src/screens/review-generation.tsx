import React from 'react';
import { Icon } from '../icons';
import { Button, Badge, Card, Callout, StatusDot, Tabs } from '../ds';
import { Page, SectionHead } from '../utils';
import { store, engine } from '../store';

const e = React.createElement;

const REVIEWERS = [
  { id: 'A', model: 'Opus', harness: 'OpenCode' },
  { id: 'B', model: 'GPT-5.5', harness: 'OpenCode' },
  { id: 'C', model: 'Sonnet', harness: 'Claude Code' },
];
const FINDINGS = [
  { key: 'ac-vague', section: 'Requirements', sev: 'diverge', text: 'Acceptance criteria are too vague — quantify the retention window.', by: ['A', 'B'] },
  { key: 'err-path', section: 'Design', sev: 'diverge', text: 'Missing error path in the POST /retries API contract.', by: ['A', 'C'] },
  { key: 'schema-ok', section: 'Design', sev: 'agree', text: 'Data model agrees with the live schema.', by: ['A'] },
  { key: 'scope-ok', section: 'Requirements', sev: 'agree', text: 'Scope boundary is clear and v1-appropriate.', by: ['B'] },
  { key: 'naming', section: 'Design', sev: 'diverge', text: 'Naming clashes with module X (rate-limit middleware).', by: ['B'] },
  { key: 'atomic-ok', section: 'Tasks', sev: 'agree', text: 'Tasks are atomic enough to dispatch independently.', by: ['C'] },
];

export function Review() {
  const [n, setN] = React.useState(3);
  const [running, setRunning] = React.useState(false);
  const [shown, setShown] = React.useState(FINDINGS.length);
  const [decisions, setDecisions] = React.useState({} as any);
  const reviewers = REVIEWERS.slice(0, n);
  const active = FINDINGS.filter((f) => f.by.some((r) => reviewers.find((x) => x.id === r)));

  const run = () => {
    setRunning(true); setShown(0); setDecisions({});
    let i = 0;
    const iv = setInterval(() => { i++; setShown(i); if (i >= active.length) { clearInterval(iv); setRunning(false); } }, 500);
  };
  const decide = (key, d) => setDecisions((x) => ({ ...x, [key]: d }));

  const diverging = active.filter((f) => f.sev === 'diverge');
  const accepted = Object.values(decisions).filter((d) => d === 'accepted').length;

  const reviewerFindings = (rid) => active.filter((f, idx) => f.by.includes(rid) && idx < shown);

  return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    e('div', { style: { padding: '18px var(--page-pad) 14px', borderBottom: '1px solid var(--border)' } },
      e('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 16 } },
        e('div', { style: { flex: 1 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 6 } }, 'SPEC-014 · Review panel'),
          e('h1', { style: { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 21, fontWeight: 600, letterSpacing: '-0.02em' } }, 'Cross-model review, grounded in the source'),
          e('p', { style: { margin: '6px 0 0', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--muted-foreground)', maxWidth: 640, lineHeight: 1.5 } }, 'Different models have different blind spots. Each reviewer critiques the same specification independently; agreement and divergence are surfaced, and accepted points feed back into the draft.')),
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--muted-foreground)' } }, 'Reviewers'),
          e('div', { style: { display: 'flex', gap: 4 } }, [2, 3].map((k) => e('button', { key: k, onClick: () => setN(k), style: { width: 30, height: 30, borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: n === k ? 'var(--primary)' : 'var(--card)', color: n === k ? 'var(--primary-foreground)' : 'var(--foreground)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, cursor: 'pointer' } }, k))),
          e(Button, { iconLeft: e(Icon, { name: running ? 'refresh' : 'play', size: 14 }), disabled: running, onClick: run }, running ? 'Reviewing…' : 'Re-run panel'))),
      e('div', { style: { display: 'flex', gap: 10, marginTop: 14 } },
        e(Badge, { variant: 'secondary' }, active.length + ' findings'),
        e('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, e(StatusDot, { status: 'diverge' }), e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)' } }, diverging.length + ' divergent')),
        e('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, e(StatusDot, { status: 'agree' }), e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)' } }, (active.length - diverging.length) + ' in agreement')),
        e('div', { style: { flex: 1 } }),
        accepted ? e(Badge, { variant: 'default' }, accepted + ' fed back to authoring') : null)),
    e('div', { style: { flex: 1, overflowY: 'auto', padding: 'var(--page-pad)' } },
      e('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(' + n + ', 1fr)', gap: 14, marginBottom: 18 } },
        reviewers.map((r) => e(Card, { key: r.id, padding: 0 },
          e('div', { style: { padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 } },
            e('span', { style: { width: 28, height: 28, borderRadius: 'var(--radius-sm)', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700 } }, r.id),
            e('div', { style: { flex: 1 } },
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600 } }, 'Reviewer ' + r.id),
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, r.model + ' · ' + r.harness)),
            running && reviewerFindings(r.id).length < active.filter((f) => f.by.includes(r.id)).length ? e(StatusDot, { status: 'running', pulse: true }) : e('span', { style: { display: 'flex', color: 'var(--success)' } }, e(Icon, { name: 'check', size: 15 }))),
          e('div', { style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 } },
            reviewerFindings(r.id).map((f) => e('div', { key: f.key, style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
              e('span', { style: { marginTop: 3, flex: 'none' } }, e(StatusDot, { status: f.sev === 'agree' ? 'agree' : 'diverge' })),
              e('div', null,
                e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--foreground)' } }, f.text),
                e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)', marginTop: 2 } }, f.section.toLowerCase())))),
            reviewerFindings(r.id).length === 0 ? e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)', padding: '6px 0' } }, running ? 'reading the spec & source…' : '—') : null),
        ))),
      e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 10 } }, 'Adjudicate — the reviewers propose, the human decides'),
      e('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        diverging.map((f) => {
          const d = decisions[f.key];
          return e('div', { key: f.key, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: '1px solid ' + (d === 'accepted' ? 'var(--success)' : 'var(--border)'), borderRadius: 'var(--radius-lg)', background: d === 'accepted' ? 'var(--success-bg)' : d === 'dismissed' ? 'var(--muted)' : 'var(--card)', opacity: d === 'dismissed' ? 0.6 : 1 } },
            e(StatusDot, { status: 'diverge' }),
            e('div', { style: { flex: 1, minWidth: 0 } },
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--foreground)' } }, f.text),
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', marginTop: 2 } }, f.section.toLowerCase() + ' · raised by ' + f.by.map((x) => 'Reviewer ' + x).join(', '))),
            d ? e(Badge, { variant: d === 'accepted' ? 'default' : 'outline' }, d === 'accepted' ? 'fed back' : d === 'revise' ? 'sent back' : 'dismissed')
              : e('div', { style: { display: 'flex', gap: 6 } },
                  e(Button, { size: 'sm', onClick: () => decide(f.key, 'accepted') }, 'Accept'),
                  e(Button, { size: 'sm', variant: 'outline', onClick: () => decide(f.key, 'revise') }, 'Send back'),
                  e(Button, { size: 'sm', variant: 'ghost', onClick: () => decide(f.key, 'dismissed') }, 'Dismiss')));
        })),
      e('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 } },
        e(Button, { variant: 'outline', onClick: () => store.set({ view: 'cockpit' }) }, 'Back to authoring'),
        e(Button, { iconLeft: e(Icon, { name: 'check', size: 15 }), onClick: () => store.set({ view: 'generation' }) }, 'Finalise & generate'))),
  );
}

const ARTIFACTS = [
  { id: 'd1', group: 'Documentation', target: 'docs/payment-retry.md', det: false, title: 'Feature documentation', preview: '# Payment retry\n\nIdempotent retries keyed on `idempotency_key`. A repeated webhook is a no-op…' },
  { id: 'j1', group: 'Jira tickets', target: 'PAY-320', det: true, title: 'Story · Add idempotency_key migration', preview: 'Summary: Add idempotency_key migration\nType: Story · Points: 3\nLinked spec: SPEC-014' },
  { id: 'j2', group: 'Jira tickets', target: 'PAY-321', det: true, title: 'Story · Guard the retry handler', preview: 'Summary: Guard the retry handler\nType: Story · Points: 5\nLinked spec: SPEC-014' },
  { id: 't1', group: 'Tests', target: 'tests/retry_idempotency_test.py', det: false, title: 'Test scaffold · idempotency', preview: 'def test_repeated_webhook_is_noop():\n    # WHEN a seen idempotency_key arrives THEN no charge\n    ...' },
  { id: 'k1', group: 'Tracking', target: 'board · SPEC-014', det: true, title: 'Tracking entry from spec state', preview: 'Projected delivery state from frontmatter status + session + CI. No manual card.' },
];

export function Generation() {
  const [state, setState] = React.useState(() => Object.fromEntries(ARTIFACTS.map((a) => [a.id, 'proposed'])));
  const [sel, setSel] = React.useState(ARTIFACTS[0].id);
  const [executing, setExecuting] = React.useState(false);
  const [log, setLog] = React.useState([] as any[]);
  const [done, setDone] = React.useState(false);
  const groups = [...new Set(ARTIFACTS.map((a) => a.group))];
  const approved = ARTIFACTS.filter((a) => state[a.id] === 'approved');
  const selected = ARTIFACTS.find((a) => a.id === sel);
  const set = (id, v) => setState((s) => ({ ...s, [id]: v }));

  const execute = () => {
    setExecuting(true); setLog([]); setDone(false);
    let i = 0;
    const iv = setInterval(() => {
      if (i >= approved.length) {
        clearInterval(iv); setExecuting(false); setDone(true);
        engine.notify('projection', approved.length + ' artifacts written from SPEC-014', 'projections');
        return;
      }
      const a = approved[i];
      setLog((l) => [...l, { m: (a.det ? 'plugin → ' : 'mcp → ') + a.target + (a.det ? '  (deterministic)' : ''), ok: true }]);
      engine.logAudit({ actor: a.det ? 'projection-plugin' : 'priya.n', kind: 'projection', text: 'Wrote ' + a.group.toLowerCase() + ': ' + a.target, detail: a.det ? 'deterministic · trigger: spec-status' : 'agent-side · approved on preview', status: 'ok' });
      i++;
    }, 500);
  };

  return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    e('div', { style: { padding: '18px var(--page-pad) 0' } },
      e(SectionHead, { eyebrow: 'SPEC-014 · Generation', title: 'Propose, decide, execute',
        sub: 'The specification is agreed. An agent proposes the downstream artifacts; you approve, edit or reject each on a preview. Nothing is written to a system of record before approval — and projections to records are deterministic.',
        action: e('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          e(Badge, { variant: 'secondary' }, approved.length + ' of ' + ARTIFACTS.length + ' approved'),
          e(Button, { disabled: approved.length === 0 || executing, iconLeft: e(Icon, { name: 'zap', size: 15 }), onClick: execute }, executing ? 'Writing…' : 'Execute writes')) })),
    e('div', { style: { flex: 1, display: 'flex', gap: 0, minHeight: 0, borderTop: '1px solid var(--border)' } },
      e('div', { style: { width: 420, flex: 'none', borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '14px 18px' } },
        groups.map((g) => e('div', { key: g, style: { marginBottom: 16 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 } }, g,
            ARTIFACTS.find((a) => a.group === g && a.det) ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500, letterSpacing: 0, textTransform: 'none', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '0 6px' } }, 'deterministic') : null),
          ARTIFACTS.filter((a) => a.group === g).map((a) => {
            const st = state[a.id];
            return e('button', { key: a.id, onClick: () => setSel(a.id), style: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 6, border: '1px solid ' + (sel === a.id ? 'var(--foreground)' : 'var(--border)'), borderRadius: 'var(--radius-lg)', background: 'var(--card)', cursor: 'pointer' } },
              e('span', { style: { flex: 'none', display: 'flex', color: st === 'approved' ? 'var(--success)' : st === 'rejected' ? 'var(--destructive)' : 'var(--neutral-400)' } }, e(Icon, { name: st === 'approved' ? 'checkCircle' : st === 'rejected' ? 'x' : 'dot', size: 16 })),
              e('div', { style: { flex: 1, minWidth: 0 } },
                e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500, color: 'var(--foreground)' } }, a.title),
                e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, a.target)));
          }))),
      ),
      e('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
        selected ? e('div', { style: { flex: 1, overflowY: 'auto', padding: 22 } },
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
            e('div', { style: { flex: 1 } },
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, selected.title),
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted-foreground)', marginTop: 2 } }, (selected.det ? 'projection-side · ' : 'agent-side · ') + selected.target)),
            state[selected.id] === 'proposed'
              ? e('div', { style: { display: 'flex', gap: 8 } }, e(Button, { size: 'sm', iconLeft: e(Icon, { name: 'check', size: 14 }), onClick: () => set(selected.id, 'approved') }, 'Approve'), e(Button, { size: 'sm', variant: 'ghost', onClick: () => set(selected.id, 'rejected') }, 'Reject'))
              : e(Badge, { variant: state[selected.id] === 'approved' ? 'default' : 'outline' }, state[selected.id])),
          e('div', { style: { background: 'var(--neutral-950)', borderRadius: 'var(--radius-lg)', padding: '16px 18px', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, color: '#E5E5E5', whiteSpace: 'pre-wrap' } }, selected.preview),
          selected.det ? e(Callout, { variant: 'default', label: 'Why this projection is deterministic', style: { marginTop: 16 } }, 'A non-deterministic agent should not author a system-of-record entry. A plugin reacting to the spec-status change performs it the same way every time, and logs it.') : null) : null,
        (executing || done) ? e('div', { style: { flex: 'none', borderTop: '1px solid var(--border)', background: 'var(--neutral-950)', padding: '12px 18px', maxHeight: 150, overflowY: 'auto' } },
          log.map((l, i) => e('div', { key: i, style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#A1A1A1', lineHeight: 1.7 } }, e('span', { style: { color: '#4ADE80' } }, '✓ '), l.m)),
          done ? e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#4ADE80', lineHeight: 1.7 } }, '— all writes complete · logged to audit trace') : null) : null),
    ),
  );
}
