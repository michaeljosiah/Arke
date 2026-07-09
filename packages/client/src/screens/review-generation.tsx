import React from 'react';
import { Icon } from '../icons';
import { Button, Badge, Card, Callout, StatusDot, Tabs } from '../ds';
import { Page, SectionHead } from '../utils';
import { store, engine, useStore } from '../store';
import { triggerGenerationLive, approveGenerationLive, rejectGenerationLive, sendBackReviewLive, transitionSpecLive } from '../live';
import { collectApproval, approveAll as approveAllArtifacts, isApprovable, needsSorTarget, effectiveSorTarget, type ArtifactDecision, type ArtifactEditInput } from '../generation-logic';

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

/** The review panel renders live (wired to the coordinator) once a snapshot has arrived, else the demo. */
export function Review() {
  const live = useStore((s: any) => s.live);
  return live ? e(LiveReview) : e(DemoReview);
}

const SEV_STATUS: Record<string, string> = { blocking: 'diverge', suggestion: 'agree', question: 'agree' };

/**
 * Live author-adjudicated review (SPEC-035). Reviewers critique the draft in parallel on distinct
 * models; the spec-author then adjudicates every issue — accept (applied to the draft) or dismiss (with
 * a rationale) — looping up to three rounds while blockers drive material change. The human no longer
 * triages issues: on convergence the coordinator auto-promotes draft→in-review and this screen presents
 * the consolidated report, leaving the human a single decision — Approve or Send back.
 */
function LiveReview() {
  const { panel } = useStore();
  const [busy, setBusy] = React.useState<string | null>(null);

  if (!panel) {
    return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 40 } },
      e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, 'No review running'),
      e('p', { style: { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--muted-foreground)', maxWidth: 460, textAlign: 'center', lineHeight: 1.5 } }, 'Start a review from the authoring cockpit. Reviewers critique the specification on distinct models, then the spec-author adjudicates their issues and applies the accepted ones — you only approve the result.'),
      e(Button, { variant: 'outline', onClick: () => store.set({ view: 'cockpit' }) }, 'Back to authoring'));
  }

  const reviewers = panel.reviewers || [];
  const agreed = new Set<string>(panel.agreedIds || []);
  const converged = panel.status === 'converged';
  const failed = panel.status === 'failed';
  const adjudicating = panel.phase === 'adjudicating';
  const round = panel.round || 1;
  const allIssues = reviewers.flatMap((r: any) => (r.issues || []).map((i: any) => ({ ...i, role: r.role })));
  const unresolved = panel.unresolvedBlockers || [];

  const statusLabel = failed ? 'Review failed' : converged ? 'Converged — ready to approve' : adjudicating ? 'Author adjudicating…' : 'Reviewing…';
  const statusVariant = converged ? 'default' : failed ? 'outline' : 'secondary';

  const approve = async () => {
    setBusy('approve');
    const res = await transitionSpecLive(panel.specId, 'approved');
    setBusy(null);
    // spec.transition returns the coordinator frame: a governance/illegal-transition refusal arrives as
    // ok:true with result.applied !== 'approved' (or result.error). Only a real 'approved' is success.
    const applied = res?.result?.applied;
    if (applied === 'approved') store.set((s: any) => ({ view: 'board', cockpit: { ...s.cockpit, notice: `${panel.specId} approved` } }));
    else {
      const why = (res && res.ok === false && res.error) || res?.result?.error || 'the server did not approve the specification';
      store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `approval refused — ${why}` } }));
    }
  };
  const sendBack = async () => {
    setBusy('sendback');
    const res = await sendBackReviewLive(panel.specId);
    setBusy(null);
    if (res && res.ok === false) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `send-back failed — ${res.error}` } }));
    else store.set({ view: 'cockpit' });
  };

  // Disposition badge for one issue (author's decision): applied / dismissed / pending.
  const dispositionBadge = (f: any) => f.disposition === 'accept' ? e(Badge, { variant: 'default' }, 'applied')
    : f.disposition === 'dismiss' ? e(Badge, { variant: 'outline' }, 'dismissed')
    : adjudicating ? e(StatusDot, { status: 'running', pulse: true }) : null;

  return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    e('div', { style: { padding: '18px var(--page-pad) 14px', borderBottom: '1px solid var(--border)' } },
      e('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 16 } },
        e('div', { style: { flex: 1 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 6 } }, panel.specId + ' · Author-adjudicated review'),
          e('h1', { style: { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 21, fontWeight: 600, letterSpacing: '-0.02em' } }, 'Reviewers critique, the author adjudicates'),
          e('p', { style: { margin: '6px 0 0', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--muted-foreground)', maxWidth: 660, lineHeight: 1.5 } }, 'Two models review the specification independently; the spec-author then folds in the valid critiques and justifies what it declines. You review the outcome and approve.')),
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          e(Badge, { variant: statusVariant }, statusLabel),
          e(Button, { variant: 'outline', size: 'sm', onClick: () => store.set({ view: 'cockpit' }) }, 'Back to authoring'))),
      panel.collisionNote ? e(Callout, { variant: 'default', style: { marginTop: 12, borderColor: 'var(--warning)' } }, panel.collisionNote) : null,
      e('div', { style: { display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' } },
        e(Badge, { variant: 'secondary' }, allIssues.length + ' issues'),
        e('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, e(StatusDot, { status: 'agree' }), e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)' } }, agreed.size + ' in agreement')),
        e(Badge, { variant: 'outline' }, 'Round ' + round + (converged ? ' · done' : ' of 3')),
        (panel.rounds || []).map((rd: any) => e('span', { key: rd.round, style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, `r${rd.round}: +${rd.applied}/−${rd.dismissed}${rd.reconvened ? ' ↻' : ''}`)))),
    e('div', { style: { flex: 1, overflowY: 'auto', padding: 'var(--page-pad)' } },
      // Converged report: the human's single decision point.
      converged ? e(Card, { padding: 0, style: { marginBottom: 18, borderColor: unresolved.length ? 'var(--warning)' : 'var(--success)' } },
        e('div', { style: { padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 } },
          e('div', { style: { flex: 1 } },
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600 } }, (panel.reachedCap ? 'Review stopped at the round cap' : 'Review converged') + ' in ' + (panel.convergedRounds || round) + ' round' + ((panel.convergedRounds || round) === 1 ? '' : 's')),
            e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: panel.reachedCap ? 'var(--warning)' : 'var(--muted-foreground)', marginTop: 2 } }, panel.reachedCap ? 'The 3-round cap was reached while a blocker fix was still pending re-review — check the final changes before approving.' : 'The draft was auto-promoted to in-review. Approve it, or send it back to reopen authoring.')),
          e(Button, { variant: 'outline', disabled: !!busy, onClick: sendBack }, busy === 'sendback' ? '…' : 'Send back'),
          e(Button, { iconLeft: e(Icon, { name: 'check', size: 15 }), disabled: !!busy, onClick: approve }, busy === 'approve' ? 'Approving…' : 'Approve specification')),
        unresolved.length ? e('div', { style: { padding: '12px 16px' } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--warning)', marginBottom: 8 } }, unresolved.length + ' blocking issue' + (unresolved.length === 1 ? '' : 's') + ' the author declined — review before approving'),
          e('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            unresolved.map((b: any) => e('div', { key: b.issueId, style: { padding: '10px 12px', border: '1px solid var(--warning)', borderRadius: 'var(--radius-md)', background: 'var(--card)' } },
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--foreground)' } }, b.text),
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', marginTop: 3 } }, (b.section || '').toLowerCase()),
              b.rationale ? e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)', marginTop: 4, fontStyle: 'italic' } }, '“' + b.rationale + '”') : null)))) : null) : null,
      failed ? e(Callout, { variant: 'default', style: { marginBottom: 18, borderColor: 'var(--destructive)' } }, 'The review did not complete. Re-run it from the authoring cockpit.') : null,
      // Reviewer columns — each issue tagged with the author's disposition (applied / dismissed).
      e('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(' + Math.max(reviewers.length, 1) + ', 1fr)', gap: 14 } },
        reviewers.map((r: any) => e(Card, { key: r.role, padding: 0 },
          e('div', { style: { padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 } },
            e('div', { style: { flex: 1 } },
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600 } }, r.role),
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, r.model)),
            r.status === 'error' ? e(Badge, { variant: 'outline' }, 'errored')
              : r.status === 'running' ? e(StatusDot, { status: 'running', pulse: true })
              : e('span', { style: { display: 'flex', color: 'var(--success)' } }, e(Icon, { name: 'check', size: 15 }))),
          e('div', { style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 } },
            r.status === 'error' ? e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--destructive)', padding: '6px 0' } }, r.error || 'reviewer failed')
            : (r.issues || []).length === 0 ? e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)', padding: '6px 0' } }, r.status === 'running' ? 'reading the spec & source…' : 'no issues raised')
            : (r.issues || []).map((f: any) => e('div', { key: f.issueId, style: { display: 'flex', gap: 8, alignItems: 'flex-start', opacity: f.disposition === 'dismiss' ? 0.6 : 1 } },
                e('span', { style: { marginTop: 3, flex: 'none' } }, e(StatusDot, { status: agreed.has(f.issueId) ? 'agree' : SEV_STATUS[f.severity] || 'diverge' })),
                e('div', { style: { flex: 1, minWidth: 0 } },
                  e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--foreground)' } }, f.text),
                  e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)', marginTop: 2 } }, (f.section || '').toLowerCase() + ' · ' + f.severity + (agreed.has(f.issueId) ? ' · concurred' : '')),
                  f.disposition === 'dismiss' && f.rationale ? e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--muted-foreground)', marginTop: 3, fontStyle: 'italic' } }, '“' + f.rationale + '”') : null),
                e('span', { style: { flex: 'none', marginTop: 1 } }, dispositionBadge(f))))),
        )))),
  );
}

function DemoReview() {
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

/** The generation workspace renders live (wired to the coordinator) once a snapshot has arrived, else the demo. */
export function Generation() {
  const live = useStore((s: any) => s.live);
  return live ? e(LiveGeneration) : e(DemoGeneration);
}

const TARGET_LABEL: Record<string, string> = { docs: 'Documentation', tests: 'Tests', ticket: 'Tickets', tracking: 'Tracking' };
const SOR_TARGETS = ['jira', 'github', 'azure-devops'];

/**
 * Centred empty state — no live proposal. Informational only: generation runs automatically when a
 * spec is approved (the approved-spec boundary — SPEC-013 — so we do NOT offer a generate-from-here
 * button that could dispatch against unapproved source or the wrong active spec). Explicit regeneration
 * belongs on an existing approved proposal, not this empty view.
 */
function GenEmpty() {
  return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 40 } },
    e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'sparkle', size: 26 })),
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, 'No generation proposal'),
    e('p', { style: { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--muted-foreground)', maxWidth: 480, textAlign: 'center', lineHeight: 1.5 } },
      'When a specification is approved, an agent proposes the downstream artefacts — documentation, tickets, test scaffolds and tracking entries — for you to review here. Nothing is written until you approve.'),
    e(Button, { variant: 'outline', onClick: () => store.set({ view: 'cockpit' }) }, 'Back to authoring'));
}

/** Centred error/timeout state with a Retry that re-triggers generation for the spec. */
function GenError({ specId, error }: { specId: string; error?: string }) {
  const [busy, setBusy] = React.useState(false);
  const retry = async () => {
    setBusy(true);
    const res = await triggerGenerationLive(specId);
    setBusy(false);
    if (res && res.ok === false) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `generation failed — ${res.error}` } }));
  };
  return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 40 } },
    e('span', { style: { display: 'flex', color: 'var(--destructive)' } }, e(Icon, { name: 'alert', size: 26 })),
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, 'Generation failed'),
    e('p', { style: { margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)', maxWidth: 480, textAlign: 'center', lineHeight: 1.5 } }, error || 'The agent did not return a usable proposal.'),
    e('div', { style: { display: 'flex', gap: 8, marginTop: 2 } },
      e(Button, { disabled: busy, iconLeft: e(Icon, { name: 'refresh', size: 14 }), onClick: retry }, busy ? 'Retrying…' : 'Retry generation'),
      e(Button, { variant: 'outline', onClick: () => store.set({ view: 'cockpit' }) }, 'Back to authoring')));
}

/**
 * Live generation workspace (SPEC-013): renders the agent's pre-write artefact proposal for review.
 * The human approves, edits or rejects each artefact on a preview; a ticket/tracking artefact with no
 * integration target is flagged invalid and cannot be approved until a target is supplied. Approving
 * sends the decision + final content to the coordinator, which records it to the trace BEFORE any write
 * and fans out. Nothing is written before approval; this screen holds no authoritative state.
 */
function LiveGeneration() {
  const { generation } = useStore();
  const proposalId = generation?.proposalId;
  const [decisions, setDecisions] = React.useState({} as Record<string, ArtifactDecision>);
  const [edits, setEdits] = React.useState({} as Record<string, ArtifactEditInput>);
  const [sel, setSel] = React.useState(null as string | null);
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // A fresh proposal (new proposalId) resets all local review state and selects its first artefact.
  React.useEffect(() => {
    setDecisions({}); setEdits({}); setEditing(false);
    const first = generation && generation.artifacts && generation.artifacts[0];
    setSel(first ? first.id : null);
  }, [proposalId]);

  if (!generation) return e(GenEmpty);
  if (generation.status === 'error') return e(GenError, { specId: generation.specId, error: generation.error });

  const artifacts = (generation.artifacts || []) as any[];
  const groups = [...new Set(artifacts.map((a) => a.target))];
  const selected = artifacts.find((a) => a.id === sel) || null;
  const approvedCount = artifacts.filter((a) => decisions[a.id] === 'approved').length;
  const set = (id: string, d: ArtifactDecision) => setDecisions((s) => ({ ...s, [id]: d }));
  const patchEdit = (id: string, patch: ArtifactEditInput) => setEdits((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  const approve = async () => {
    const { approvedArtifactIds, edits: editList } = collectApproval(artifacts, decisions, edits);
    if (approvedArtifactIds.length === 0) return;
    setBusy(true);
    const res = await approveGenerationLive(generation.specId, generation.proposalId, approvedArtifactIds, editList);
    setBusy(false);
    if (res && res.ok === false) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `approval failed — ${res.error}` } }));
    // On success the coordinator emits generation.decided, which clears the proposal → the empty state shows.
  };
  const reject = async () => {
    setBusy(true);
    const res = await rejectGenerationLive(generation.specId, generation.proposalId);
    setBusy(false);
    if (res && res.ok === false) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `reject failed — ${res.error}` } }));
  };

  return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    e('div', { style: { padding: '18px var(--page-pad) 0' } },
      e(SectionHead, { eyebrow: generation.specId + ' · Generation', title: 'Propose, decide, execute',
        sub: 'An agent proposed the downstream artefacts from the approved specification. Approve, edit or reject each on its preview — nothing is written to any system of record before you approve.',
        action: e('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          e(Badge, { variant: 'secondary' }, approvedCount + ' of ' + artifacts.length + ' approved'),
          e(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => setDecisions(approveAllArtifacts(artifacts, edits)) }, 'Approve all'),
          e(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: reject }, 'Reject'),
          e(Button, { disabled: approvedCount === 0 || busy, iconLeft: e(Icon, { name: 'zap', size: 15 }), onClick: approve }, busy ? 'Writing…' : 'Approve & write')) })),
    e('div', { style: { flex: 1, display: 'flex', gap: 0, minHeight: 0, borderTop: '1px solid var(--border)' } },
      // Left: the artefacts grouped by target, with a per-item review-state icon.
      e('div', { style: { width: 420, flex: 'none', borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '14px 18px' } },
        groups.map((g) => e('div', { key: g, style: { marginBottom: 16 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 8 } }, TARGET_LABEL[g] || g),
          artifacts.filter((a) => a.target === g).map((a) => {
            const d = decisions[a.id];
            const approvable = isApprovable(a, edits[a.id]);
            const icon = d === 'approved' ? 'checkCircle' : d === 'rejected' ? 'x' : !approvable ? 'alert' : 'dot';
            const iconColor = d === 'approved' ? 'var(--success)' : d === 'rejected' ? 'var(--destructive)' : !approvable ? 'var(--warning)' : 'var(--neutral-400)';
            return e('button', { key: a.id, onClick: () => { setSel(a.id); setEditing(false); }, style: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 6, border: '1px solid ' + (sel === a.id ? 'var(--foreground)' : 'var(--border)'), borderRadius: 'var(--radius-lg)', background: 'var(--card)', cursor: 'pointer' } },
              e('span', { style: { flex: 'none', display: 'flex', color: iconColor } }, e(Icon, { name: icon, size: 16 })),
              e('div', { style: { flex: 1, minWidth: 0 } },
                e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500, color: 'var(--foreground)' } }, a.title),
                e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, effectiveSorTarget(a, edits[a.id]) ? (effectiveSorTarget(a, edits[a.id]) + ' · ' + a.target) : a.target)));
          }))),
      ),
      // Right: the selected artefact's preview, review controls, inline edit, and invalid-target fix.
      e('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
        selected ? e(ArtifactPane, { key: selected.id, a: selected, decision: decisions[selected.id], edit: edits[selected.id], editing, setEditing, set, patchEdit }) : null),
    ),
  );
}

/** The right-hand preview of one artefact: title, review-state controls, inline edit, invalid-target fix. */
function ArtifactPane({ a, decision, edit, editing, setEditing, set, patchEdit }: any) {
  const effTarget = effectiveSorTarget(a, edit);
  const approvable = isApprovable(a, edit);
  const content = edit?.content !== undefined ? edit.content : a.content;
  const invalid = needsSorTarget(a.target) && !effTarget;
  return e('div', { style: { flex: 1, overflowY: 'auto', padding: 22 } },
    e('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14 } },
      e('div', { style: { flex: 1, minWidth: 0 } },
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, a.title),
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted-foreground)', marginTop: 2 } }, (effTarget ? effTarget + ' · ' : '') + a.target)),
      e('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
        e(Button, { size: 'sm', variant: decision === 'approved' ? 'default' : 'outline', disabled: !approvable, onClick: () => set(a.id, 'approved') }, decision === 'approved' ? 'Approved' : 'Approve'),
        e(Button, { size: 'sm', variant: decision === 'rejected' ? 'destructive' : 'ghost', onClick: () => set(a.id, 'rejected') }, decision === 'rejected' ? 'Rejected' : 'Reject'),
        e(Button, { size: 'sm', variant: 'ghost', iconLeft: e(Icon, { name: 'pencil', size: 14 }), onClick: () => setEditing((x: boolean) => !x) }, editing ? 'Done' : 'Edit'))),
    invalid ? e(Callout, { variant: 'default', label: 'Invalid — no integration target specified', style: { marginBottom: 14, borderColor: 'var(--warning)' } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
        e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)' } }, 'Route this to:'),
        SOR_TARGETS.map((t) => e('button', { key: t, onClick: () => patchEdit(a.id, { sorTarget: t }), style: { fontFamily: 'var(--font-mono)', fontSize: 11, padding: '3px 9px', borderRadius: 999, cursor: 'pointer', border: '1px solid ' + (effTarget === t ? 'var(--foreground)' : 'var(--border)'), background: effTarget === t ? 'var(--foreground)' : 'var(--card)', color: effTarget === t ? 'var(--background)' : 'var(--foreground)' } }, t)))) : null,
    editing
      ? e('textarea', { value: content, onChange: (ev: any) => patchEdit(a.id, { content: ev.target.value }), spellCheck: false, style: { width: '100%', minHeight: 260, boxSizing: 'border-box', background: 'var(--neutral-950)', borderRadius: 'var(--radius-lg)', padding: '16px 18px', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, color: '#E5E5E5', border: '1px solid var(--border)', resize: 'vertical' } })
      : e('div', { style: { background: 'var(--neutral-950)', borderRadius: 'var(--radius-lg)', padding: '16px 18px', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, color: '#E5E5E5', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, content),
    edit?.content !== undefined && edit.content !== a.content ? e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', marginTop: 8 } }, 'edited — your version will be written, not the original proposal') : null);
}

function DemoGeneration() {
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
