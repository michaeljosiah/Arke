import React from 'react';
import { Icon } from '../icons';
import { KanbanCard, Button, Badge, Card, Callout, StatusDot, Tabs, AgentMessage, Textarea } from '../ds';
import { ago } from '../utils';
import { store, useStore, engine } from '../store';
import { liveSend, reconnectLive, promoteSpecLive, deliverSpecLive, transitionSpecLive, fetchGovernance, steerTaskLive } from '../live';
import { openCard } from '../nav';

const e = React.createElement;

// SPEC-024: the legal governed status edges the board may OFFER as a manual move. This mirrors the
// coordinator's authoritative LEGAL_TRANSITIONS — the server still refuses any illegal move, so this is
// only a UI affordance. `draft → in-review` is intentionally omitted here: promotion has its own gated
// "Promote to review" button (the well-formedness / review-panel door), not a bare status flip.
const MANUAL_MOVES: Record<string, Array<{ to: string; label: string }>> = {
  'in-review': [{ to: 'approved', label: 'Approve' }, { to: 'draft', label: 'Send back to draft' }],
  approved: [{ to: 'in-review', label: 'Reopen (in-review)' }, { to: 'delivered', label: 'Mark delivered' }],
  delivered: [{ to: 'in-review', label: 'Reopen (in-review)' }],
};

/** The governance assurance badge (SPEC-024, host-optional): how strongly the approver-≠-owner invariant
 *  is enforced. `host-enforced` = webhooks + branch protection; `solo`/`team` = host-less. */
function GovernanceBadge() {
  const gov = useStore((s: any) => s.governance) as { level?: string; hostConfigured?: boolean } | undefined;
  React.useEffect(() => { void fetchGovernance(); }, []);
  if (!gov?.level) return null;
  const LABEL: Record<string, string> = { 'host-enforced': 'Host-enforced', team: 'Team', solo: 'Solo' };
  const title =
    gov.level === 'host-enforced'
      ? 'A git host is configured — PR review + branch protection enforce an approver distinct from the owner'
      : 'No git host — governed transitions are human-triggered; self-approval is permitted but flagged';
  return e('span', { title, style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 9px' } },
    e(StatusDot, { status: gov.level === 'host-enforced' ? 'agree' : 'idle' }),
    'Governance: ' + (LABEL[gov.level] ?? gov.level));
}

/** Transport health (SPEC-010): live dot when open, spinner while reconnecting, error banner on a
 *  permanent close with a manual Reconnect — distinct from the transient reconnecting state. */
function ConnectionIndicator() {
  const { connection, live } = useStore();
  if (!live) return null; // mock/demo mode has no live transport to report
  if (connection === 'closed' || connection === 'disposed') {
    return e('div', { role: 'alert', style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 'var(--radius-md)', background: 'var(--destructive-bg, var(--secondary))', border: '1px solid var(--destructive)' } },
      e('span', { style: { color: 'var(--destructive)', display: 'flex' } }, e(Icon, { name: 'alert', size: 13 })),
      e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--foreground)' } }, 'Coordinator connection lost'),
      e(Button, { size: 'sm', variant: 'outline', onClick: () => reconnectLive() }, 'Reconnect'));
  }
  const reconnecting = connection === 'reconnecting' || connection === 'connecting';
  return e('div', { 'aria-live': 'polite', style: { display: 'flex', alignItems: 'center', gap: 6 } },
    e(StatusDot, { status: reconnecting ? 'running' : 'agree', pulse: reconnecting }),
    e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, reconnecting ? 'reconnecting…' : 'live'));
}

// All seven BoardColumn values from @arke/contracts — every derived column must have a container,
// or cards in `approved`/`needs-human` would be invisible (SPEC-010).
const COLS = [
  { id: 'authoring', label: 'Authoring' },
  { id: 'review', label: 'In review' },
  { id: 'approved', label: 'Approved' },
  { id: 'implementing', label: 'Implementing' },
  { id: 'needs-human', label: 'Needs human' },
  { id: 'diff', label: 'Diff review' },
  { id: 'delivered', label: 'Delivered' },
];

function BoardCard({ c }: any) {
  const open = () => openCard(c);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const showBar = (c.col === 'authoring' || c.col === 'implementing') && !c.needsHuman;
  // Manual board moves (SPEC-024): the human dispatches the gated `spec.transition` op — never a direct
  // column write. We OFFER only legal-adjacent targets for the card's current frontmatter status; the
  // server is the real gate and refuses anything illegal. (Live cards carry the frontmatter `status`; the
  // offline demo's session-status cards have no entry here, so no menu shows.)
  const moves = MANUAL_MOVES[c.status] || [];
  const move = async (to: string, ev: any) => {
    ev.stopPropagation();
    setMenuOpen(false);
    const res = await transitionSpecLive(c.specId || c.id, to);
    const err = res?.ok === false ? res.error : res?.result && res.result.ok === false ? res.result.error : null;
    if (err) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `move failed — ${err}` } }));
  };
  // Promote-to-review on a draft spec card runs the SINGLE gated door (SPEC-024): promoteSpecLive now
  // dispatches the governed `approveDraft` op (well-formedness → completed review panel → no running
  // authoring session → branch guard), never the deleted ungated `spec.promote`. The card moves only
  // when the resulting spec.status event arrives, never by a direct column write. One card per spec (SPEC-023).
  const canPromote = c.col === 'authoring';
  const promote = async (ev: any) => {
    ev.stopPropagation();
    const res = await promoteSpecLive(c.specId || c.id);
    // Two failure shapes: an offline refusal resolves `{ ok:false, error }` directly, while a
    // server refusal is the WS frame `{ ok:true, result:{ ok:false, error } }` — surface either.
    const err = res?.ok === false ? res.error : res?.result && res.result.ok === false ? res.result.error : null;
    if (err) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `promote failed — ${err}` } }));
  };
  // Deliver is the explicit, decoupled start of delivery on an APPROVED spec (SPEC-024): approval parks
  // the spec in the backlog; the human (or, later, an automation) chooses when to fan the tasks out. Same
  // governed-command discipline as promote — the card moves only when the resulting status/session events
  // arrive, never by a direct column write.
  const canDeliver = c.col === 'approved';
  const deliver = async (ev: any) => {
    ev.stopPropagation();
    const res = await deliverSpecLive(c.specId || c.id);
    const err = res?.ok === false ? res.error : res?.result && res.result.ok === false ? res.result.error : null;
    if (err) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `deliver failed — ${err}` } }));
  };
  return e('div', { className: 'so-enter', onClick: open, style: { cursor: 'pointer', position: 'relative' } },
    showBar ? e('div', { style: { position: 'absolute', left: 11, right: 11, top: 0, height: 2, background: 'var(--secondary)', borderRadius: 999, overflow: 'hidden', zIndex: 2 } },
      e('div', { style: { height: '100%', width: (c.progress || 0) + '%', background: 'var(--foreground)', transition: 'width .6s ease' } })) : null,
    e(KanbanCard, { taskId: c.id, title: c.title, status: c.status, harness: c.harness, model: c.model, needsHuman: c.needsHuman }),
    canPromote ? e('button', { onClick: promote, title: 'Promote this draft to in-review', style: { marginTop: 6, width: '100%', padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--card)', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)', fontSize: 11, cursor: 'pointer' } }, 'Promote to review') : null,
    canDeliver ? e('button', { onClick: deliver, title: 'Start delivery — fan the approved spec\'s tasks out', style: { marginTop: 6, width: '100%', padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--card)', color: 'var(--foreground)', fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, cursor: 'pointer' } }, 'Deliver') : null,
    moves.length > 0
      ? e('div', { style: { marginTop: 6 } },
          e('button', { onClick: (ev: any) => { ev.stopPropagation(); setMenuOpen((v) => !v); }, title: 'Manual governed move — runs the same gate as a webhook', style: { width: '100%', padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--card)', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 } }, 'Move', e(Icon, { name: 'chevron', size: 12 })),
          menuOpen
            ? e('div', { style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 } },
                moves.map((m) => e('button', { key: m.to, onClick: (ev: any) => void move(m.to, ev), style: { textAlign: 'left', padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--background)', color: 'var(--foreground)', fontFamily: 'var(--font-sans)', fontSize: 11, cursor: 'pointer' } }, m.label)))
            : null)
      : null,
  );
}

function Column({ col, cards }: any) {
  return e('div', { style: { width: 248, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 12px' } },
      e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--foreground)', fontWeight: 600 } }, col.label),
      e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)' } }, cards.length)),
    e('div', { style: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: 2 } },
      cards.map((c) => e(BoardCard, { key: c.id + '-' + c.col, c })),
      cards.length === 0 ? e('div', { style: { border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)', padding: 16, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)' } }, 'empty') : null),
  );
}

function EventRail() {
  const { events, liveStream } = useStore();
  const KIND = { 'permission.requested': 'lock', 'permission.granted': 'check', 'permission.denied': 'x', 'diff.finalised': 'diff', 'session.busy': 'terminal', 'spec.authored': 'fileText', 'turn.quiescent': 'checkCircle', 'pr.merged': 'merge' };
  return e('div', { style: { width: 290, flex: 'none', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--background)' } },
    e('div', { style: { padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 } },
      e(StatusDot, { status: liveStream ? 'running' : 'idle', pulse: liveStream }),
      e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--foreground)' } }, 'Event stream'),
      e('div', { style: { flex: 1 } }),
      e('button', { onClick: () => store.set({ liveStream: !liveStream }), title: liveStream ? 'Pause' : 'Resume', style: { display: 'flex', width: 26, height: 26, alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--card)', color: 'var(--muted-foreground)', cursor: 'pointer' } }, e(Icon, { name: liveStream ? 'pause' : 'play', size: 13 }))),
    e('div', { style: { flex: 1, overflowY: 'auto', padding: '8px 0' } },
      events.length === 0 ? e('div', { style: { padding: '24px 16px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--neutral-400)', lineHeight: 1.6 } }, liveStream ? 'no events yet · waiting on the harness' : 'stream paused') : null,
      events.map((ev) => e('div', { key: ev.id, className: 'so-enter', style: { display: 'flex', gap: 9, padding: '7px 16px', alignItems: 'flex-start' } },
        e('span', { style: { flex: 'none', marginTop: 1, color: ev.kind.startsWith('permission') ? 'var(--destructive)' : 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: KIND[ev.kind] || 'dot', size: 13 })),
        e('div', { style: { minWidth: 0 } },
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.45, color: 'var(--foreground)', wordBreak: 'break-word' } }, ev.text),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)', marginTop: 1 } }, ago(ev.ts)))))),
  );
}

export function Board() {
  const { cards } = useStore();
  const empty = cards.length === 0;
  return e('div', { style: { height: '100%', display: 'flex', minHeight: 0 } },
    e('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', padding: '18px 22px', minHeight: 0, minWidth: 0 } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 } },
        e('p', { style: { margin: 0, maxWidth: 600, fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.5, color: 'var(--muted-foreground)' } }, 'A card moves because the work moved, not because a person dragged it. Columns are computed from frontmatter, session and CI state — projected live from the harness event stream.'),
        e('div', { style: { flex: 1 } }),
        e(GovernanceBadge, null),
        e(ConnectionIndicator, null),
        e(Badge, { variant: 'secondary' }, 'event-driven')),
      empty
        ? e('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
            e('div', { style: { maxWidth: 380, textAlign: 'center' } },
              e('div', { style: { width: 52, height: 52, margin: '0 auto 16px', borderRadius: 'var(--radius-xl)', background: 'var(--secondary)', color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: 'board', size: 24 })),
              e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 16, fontWeight: 600, color: 'var(--foreground)' } }, 'No work in flight'),
              e('p', { style: { margin: '8px 0 18px', fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.55, color: 'var(--muted-foreground)' } }, 'The board projects real delivery state. Approve a specification and fan it into tasks, and cards will appear here as the harness reports events.'),
              e(Button, { iconLeft: e(Icon, { name: 'chat', size: 15 }), onClick: () => store.set({ view: 'cockpit' }) }, 'Go to authoring')))
        : e('div', { style: { flex: 1, display: 'flex', gap: 16, minHeight: 0, overflowX: 'auto' } },
            COLS.map((col) => e(Column, { key: col.id, col, cards: cards.filter((c) => c.col === col.id) })))),
    e(EventRail, null),
    e(SessionPicker, null),
  );
}

/** Disambiguation overlay (SPEC-023): when a spec card folds more than one session, choosing which
 *  session's detail/diff to open. Never mutates board state — it only sets the active session + view. */
function SessionPicker() {
  const picker = useStore((s: any) => s.sessionPicker) as any;
  if (!picker) return null;
  const choose = (s: any) => store.set({ activeCard: picker.specId, activeSession: s.sessionId, view: s.status === 'done' ? 'diff' : 'session', sessionPicker: null });
  return e('div', { onClick: () => store.set({ sessionPicker: null }), style: { position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(10,10,10,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 } },
    e('div', { onClick: (ev: any) => ev.stopPropagation(), style: { width: 480, maxHeight: '72vh', display: 'flex', flexDirection: 'column', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', boxShadow: 'var(--shadow-lg)' } },
      e('div', { style: { padding: '14px 18px', borderBottom: '1px solid var(--border)' } },
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600 } }, picker.title),
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', marginTop: 2 } }, picker.sessions.length + ' sessions — choose one to open')),
      e('div', { style: { overflowY: 'auto' } },
        picker.sessions.map((s: any) => e('button', { key: s.sessionId, onClick: () => choose(s), onMouseEnter: (ev: any) => ev.currentTarget.style.background = 'var(--accent)', onMouseLeave: (ev: any) => ev.currentTarget.style.background = 'var(--background)', style: { appearance: 'none', textAlign: 'left', width: '100%', cursor: 'pointer', background: 'var(--background)', border: 'none', borderBottom: '1px solid var(--line-soft)', padding: '11px 18px', display: 'flex', alignItems: 'center', gap: 12 } },
          e(StatusDot, { status: s.needsHuman ? 'attention' : s.status === 'running' ? 'running' : s.status === 'done' ? 'agree' : 'idle', pulse: s.status === 'running' }),
          e('div', { style: { flex: 1, minWidth: 0 } },
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.sessionId),
            e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, (s.kind === 'spec' ? 'authoring' : 'task') + ' · ' + s.status + (s.harness ? ' · ' + s.harness : ''))),
          e('span', { style: { color: 'var(--neutral-400)', display: 'flex' } }, e(Icon, { name: 'chevron', size: 16 }))))),
    ));
}

const DIFF_FILES = [
  { path: 'migrations/0042_add_idempotency_key.sql', added: 18, removed: 0 },
  { path: 'src/payments/schema.py', added: 9, removed: 3 },
  { path: 'src/payments/retry.py', added: 41, removed: 8 },
  { path: 'tests/retry_idempotency_test.py', added: 16, removed: 1 },
];
const DIFF_HUNK = [
  { t: 'meta', s: '@@ src/payments/retry.py @@ def handle_retry(event):' },
  { t: 'ctx', s: '  payment = lookup(event.payment_id)' },
  { t: 'del', s: '  charge(payment)' },
  { t: 'add', s: '  if seen(event.idempotency_key):' },
  { t: 'add', s: '      return Noop("duplicate webhook")' },
  { t: 'add', s: '  with idempotent(event.idempotency_key):' },
  { t: 'add', s: '      charge(payment)' },
  { t: 'ctx', s: '  record(event)' },
];

function DiffView() {
  const [file, setFile] = React.useState(0);
  return e('div', { style: { display: 'flex', height: '100%', minHeight: 0 } },
    e('div', { style: { width: 280, flex: 'none', borderRight: '1px solid var(--border)', overflowY: 'auto', padding: 10 } },
      DIFF_FILES.map((f, i) => e('button', { key: f.path, onClick: () => setFile(i), style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 3, border: 'none', borderRadius: 'var(--radius-md)', background: file === i ? 'var(--accent)' : 'transparent', cursor: 'pointer' } },
        e('span', { style: { flex: 'none', color: 'var(--muted-foreground)', display: 'flex' } }, e(Icon, { name: 'file', size: 14 })),
        e('span', { style: { flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, f.path.split('/').pop()),
        e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--success)' } }, '+' + f.added),
        e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--destructive)' } }, '−' + f.removed)))),
    e('div', { style: { flex: 1, overflowY: 'auto', background: 'var(--neutral-950)', minWidth: 0 } },
      e('div', { style: { padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#A1A1A1' } }, DIFF_FILES[file].path),
      e('div', { style: { padding: '10px 0', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.8 } },
        DIFF_HUNK.map((l, i) => e('div', { key: i, style: { padding: '0 16px', background: l.t === 'add' ? 'rgba(34,197,94,0.12)' : l.t === 'del' ? 'rgba(231,0,11,0.12)' : 'transparent', color: l.t === 'meta' ? '#737373' : l.t === 'add' ? '#86EFAC' : l.t === 'del' ? '#FCA5A5' : '#D4D4D4', display: 'flex', gap: 10 } },
          e('span', { style: { width: 12, flex: 'none', color: '#525252' } }, l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''),
          e('span', { style: { whiteSpace: 'pre' } }, l.s))))),
  );
}

export function DiffReview() {
  const { activeCard, activeSession, cards } = useStore();
  const card: any = cards.find((c) => c.id === activeCard) || cards.find((c) => c.col === 'diff') || {};
  // Resolve the folded session being reviewed (SPEC-023) — the chosen one, else the first done task.
  const sessions: any[] = card.sessions || [];
  const session: any = sessions.find((s) => s.sessionId === activeSession) || sessions.find((s) => s.status === 'done') || sessions[0] || {};
  const d = session.diff;
  const summary = d ? `+${d.added} −${d.removed} across ${d.files} files` : '+84 −12 across 4 files';
  return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    e('div', { style: { padding: '14px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 } },
      e(Button, { variant: 'ghost', size: 'sm', iconLeft: e(Icon, { name: 'arrowLeft', size: 15 }), onClick: () => store.set({ view: 'board' }) }, 'Board'),
      e('div', { style: { flex: 1 } },
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, (card.id || 'T-2') + ' · ' + (card.title || 'Idempotency key column + index')),
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, `diff.finalised · ${summary} · ` + (session.harness || card.harness || 'OpenCode') + (session.sessionId ? ' · ' + session.sessionId : ''))),
      e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'refresh', size: 14 }) }, 'Revert run'),
      e(Button, { iconLeft: e(Icon, { name: 'pr', size: 15 }), onClick: () => { engine.acceptDiff(session.sessionId || card.id || 'T-2'); store.set({ view: 'board' }); } }, 'Accept & open PR')),
    e('div', { style: { flex: 1, minHeight: 0 } }, e(DiffView, null)),
  );
}

const TODOS = [
  { t: 'Read repo context & AGENTS.md', s: 'done' },
  { t: 'Write migration 0042_add_idempotency_key.sql', s: 'done' },
  { t: 'Guard retry handler on idempotency_key', s: 'running' },
  { t: 'Add idempotency test (WHEN/THEN)', s: 'idle' },
  { t: 'Open pull request', s: 'gate' },
];
const TRANSCRIPT = [
  { role: 'agent', agent: 'Implementation', model: 'mid-tier', text: 'Read the spec and grounded in src/payments. Adding the migration and the unique index on (tenant_id, idempotency_key).' },
  { role: 'agent', agent: 'Implementation', model: 'mid-tier', text: 'Migration written. Guarding handle_retry so a seen key returns a no-op. Running typecheck and checks next.' },
];

/** Cheap djb2 content fingerprint (mirrors cockpit.tsx's textSig): changes whenever the text changes,
 *  regardless of length, so a same-length streamed correction still invalidates the signature. */
function textSig(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export function Session() {
  const { activeCard, activeSession, cards } = useStore();
  const card: any = cards.find((c) => c.id === activeCard) || { id: 'T-4', title: 'Guard the retry handler', sessions: [] };
  // Resolve the folded session for detail (SPEC-023): the chosen one, else the sole/first session.
  const sessions: any[] = card.sessions || [];
  const session: any = sessions.find((s) => s.sessionId === activeSession) || sessions[0] || { status: 'running', harness: 'Claude Code', model: 'Sonnet', transcript: [] };
  const [tab, setTab] = React.useState('transcript');

  // Interactive composer: steer a real (non-demo) TASK session — same prompt.send op the authoring
  // cockpit uses, addressed at this session instead. Restricted to kind:'task': a card also folds
  // kind:'spec' (authoring) sessions, and the send path below always addresses `agent: 'implementer'`
  // — sending that into an authoring session would inject the wrong agent into the wrong conversation.
  // `idle` IS steerable here (SPEC-009 revised, single-session delivery): the coordinator no longer
  // dispatches one task per turn with idle as an artificial terminal signal — the whole task list goes
  // to ONE session that may take several turns, so idle just means "ready for the next one," exactly
  // like an authoring session. The board only marks a delivery `done` once every task in the spec's
  // checklist is checked off (observeDeliveryProgress on the coordinator); only `error`/`done`/etc. — a
  // genuinely terminal status — should disable this composer.
  const isLive = !!session.sessionId;
  const isTask = session.kind === 'task';
  const canSteer = isLive && isTask && (session.status === 'running' || session.status === 'idle');
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  // A single ordered turn list merged from the FULL live transcript — both human and agent/tool turns,
  // not just what this composer itself sends. A user-role entry can already be there on open (a
  // reload, or another client's earlier follow-up), so it must be shown as a human turn, not dropped:
  // dropping it would silently hide real history compared to what this screen rendered before this
  // composer existed.
  const [turns, setTurns] = React.useState<any[]>([]);
  const scroller = React.useRef<any>(null);
  const liveTranscript = session.transcript || [];
  const transcriptSig = liveTranscript.map((t: any) => `${t.messageId}:${textSig(t.text ?? '')}:${t.isStreaming ? 1 : 0}`).join('|');
  // Merge the transcript into `turns`, resetting it (and the draft/error) first when the ACTIVE SESSION
  // itself changed (so a previously-viewed task's turns/draft don't linger into a newly opened one).
  // Both concerns share one effect deliberately: two separate effects (merge; reset-on-switch) both
  // fire on the same mount/switch commit, and since React runs effects in declaration order, a later
  // "reset" effect would clobber the merge effect's just-populated state every time.
  const lastSessionId = React.useRef<string | undefined>(session.sessionId);
  React.useEffect(() => {
    const switched = lastSessionId.current !== session.sessionId;
    lastSessionId.current = session.sessionId;
    if (switched) { setSendError(null); setDraft(''); }
    setTurns((prev) => {
      let next = switched ? [] : prev;
      for (const t of liveTranscript) {
        const key = 'm:' + t.messageId;
        const entry = { key, kind: t.role === 'user' ? 'human' : 'agent', tool: t.role === 'tool', text: t.text, streaming: t.isStreaming };
        const idx = next.findIndex((x: any) => x.key === key);
        if (idx === -1) next = [...next, entry];
        else if (next[idx].text !== entry.text || next[idx].streaming !== entry.streaming) { next = next.slice(); next[idx] = { ...next[idx], ...entry }; }
      }
      return next;
    });
  }, [transcriptSig, session.sessionId]);
  React.useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [turns.length, sending]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !canSteer) return;
    setSending(true);
    setSendError(null);
    setDraft('');
    try {
      const res = await steerTaskLive({ sessionId: session.sessionId, specId: card.specId ?? card.id, message: text });
      const err = res?.ok === false ? res.error : res?.result && res.result.ok === false ? res.result.error : null;
      if (err) {
        setDraft((d) => d || text); // restore the text if the composer is still empty
        setSendError(err);
      }
    } finally {
      setSending(false);
    }
  };

  return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    e('div', { style: { padding: '14px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 } },
      e(Button, { variant: 'ghost', size: 'sm', iconLeft: e(Icon, { name: 'arrowLeft', size: 15 }), onClick: () => store.set({ view: 'board' }) }, 'Board'),
      e('div', { style: { flex: 1, minWidth: 0 } },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, card.id + ' · ' + card.title),
          e(StatusDot, { status: session.needsHuman ? 'attention' : session.status, pulse: session.status === 'running' })),
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, (session.harness || card.harness || 'OpenCode') + ' · ' + (session.model || card.model || '—') + (session.sessionId ? ' · ' + session.sessionId : ''))),
      e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'refresh', size: 14 }) }, 'Restore checkpoint'),
      e(Button, { iconLeft: e(Icon, { name: 'pr', size: 15 }), onClick: () => engine.raisePermission({ id: session.sessionId || card.id, title: card.title }, 'open pull request', 'gh pr create --fill --base main') }, 'Open pull request')),
    e('div', { style: { padding: '0 22px', borderBottom: '1px solid var(--border)' } },
      e(Tabs, { tabs: [{ id: 'transcript', label: 'Transcript' }, { id: 'todos', label: 'Todos', count: TODOS.length }, { id: 'diff', label: 'Diff' }], value: tab, onChange: setTab })),
    e('div', { style: { flex: 1, minHeight: 0, overflow: 'hidden' } },
      tab === 'transcript' ? e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
        e('div', { ref: scroller, style: { flex: 1, overflowY: 'auto', padding: 22, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 } },
          (isLive
            ? turns.map((m: any) => e(AgentMessage, { key: m.key, role: m.kind === 'human' ? 'user' : 'agent', agent: m.tool ? 'Tool' : 'Implementation', model: session.model || card.model || 'mid-tier' }, (m.text || '…') + (m.streaming ? ' ▍' : '')))
            : TRANSCRIPT.map((m, i) => e(AgentMessage, { key: i, role: m.role, agent: m.agent, model: m.model }, m.text))),
          e(Callout, { variant: 'default', label: 'Runtime receipts' }, 'The board reacts to typed receipts — turn quiescence, diff finalisation — captured around each agent turn, with automatic git checkpoints for rescue and audit.')),
        (isLive && isTask) ? e('div', { style: { padding: '10px 22px', borderTop: '1px solid var(--border)' } },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-end' } },
            e('div', { style: { flex: 1, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: canSteer ? 'var(--background)' : 'var(--secondary)' } },
              e(Textarea, { rows: 2, value: draft, placeholder: canSteer ? 'Steer the implementer…' : `session is ${session.status} — no longer steerable`, onChange: (ev: any) => setDraft(ev.target.value), onKeyDown: (ev: any) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) void send(); } })),
            e('button', { onClick: () => void send(), disabled: !canSteer || sending || !draft.trim(), title: 'Send (⌘⏎)',
              style: {
                display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34,
                borderRadius: 'var(--radius-md)', border: 'none',
                background: (!canSteer || sending || !draft.trim()) ? 'var(--secondary)' : 'var(--primary)',
                color: (!canSteer || sending || !draft.trim()) ? 'var(--neutral-400)' : 'var(--primary-foreground)',
                cursor: (!canSteer || sending || !draft.trim()) ? 'default' : 'pointer', flex: 'none',
              } },
              e(Icon, { name: sending ? 'refresh' : 'arrowUp', size: 15 }))),
          sendError ? e('p', { style: { margin: '6px 0 0', fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--warning, #B45309)' } }, sendError) : null) : null) : null,
      tab === 'todos' ? e('div', { style: { height: '100%', overflowY: 'auto', padding: 22, maxWidth: 620 } },
        TODOS.map((t, i) => e('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: 8, background: 'var(--card)' } },
          t.s === 'gate' ? e('span', { style: { color: 'var(--destructive)', display: 'flex' } }, e(Icon, { name: 'lock', size: 16 })) : t.s === 'done' ? e('span', { style: { color: 'var(--success)', display: 'flex' } }, e(Icon, { name: 'checkCircle', size: 16 })) : e(StatusDot, { status: t.s === 'running' ? 'running' : 'idle', pulse: t.s === 'running' }),
          e('span', { style: { flex: 1, fontFamily: 'var(--font-sans)', fontSize: 13, color: t.s === 'idle' ? 'var(--muted-foreground)' : 'var(--foreground)' } }, t.t),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: t.s === 'gate' ? 'var(--destructive)' : 'var(--muted-foreground)' } }, t.s === 'gate' ? 'needs a human' : t.s)))) : null,
      tab === 'diff' ? e('div', { style: { height: '100%', minHeight: 0 } }, e(DiffView, null)) : null),
  );
}

export function PermissionOverlay() {
  const req = useStore((s) => s.permission);
  const [message, setMessage] = React.useState('');
  React.useEffect(() => { setMessage(''); }, [req && req.permissionId]);
  if (!req) return null;
  // once | always | reject (SPEC-016). Live mode sends over the transport; mock uses the engine.
  const decide = (verb) => {
    if (req.live) {
      liveSend({ type: 'respondToPermission', permissionId: req.permissionId, decision: verb, message: message || undefined });
      store.set({ permission: null });
    } else {
      engine.resolvePermission(verb !== 'reject');
    }
  };
  return e('div', { style: { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(10,10,10,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 } },
    e('div', { style: { width: 480, background: 'var(--popover)', border: '1px solid color-mix(in srgb, var(--destructive) 40%, var(--border))', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' } },
      e('div', { style: { padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 } },
        e('span', { style: { width: 34, height: 34, borderRadius: 'var(--radius-md)', background: 'var(--danger-bg)', color: 'var(--destructive)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }, e(Icon, { name: 'lock', size: 18 })),
        e('div', null,
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--destructive)' } }, 'Permission requested'),
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600, color: 'var(--foreground)' } }, req.action))),
      e('div', { style: { padding: 20 } },
        e('p', { style: { margin: '0 0 14px', fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.55, color: 'var(--muted-foreground)' } }, 'The agent on ' + req.cardTitle + ' (' + req.cardId + ') wants to run a gated action on ' + req.harness + '. The agent proposes; you decide; the harness executes.'),
        e('div', { style: { background: 'var(--neutral-950)', borderRadius: 'var(--radius-md)', padding: '11px 14px', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: '#86EFAC', marginBottom: 14 } }, '$ ' + req.command),
        e('input', { value: message, onChange: (ev) => setMessage(ev.target.value), placeholder: 'Optional message to the agent…', style: { width: '100%', boxSizing: 'border-box', marginBottom: 16, padding: '9px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--foreground)', fontFamily: 'var(--font-sans)', fontSize: 13 } }),
        e('div', { style: { display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' } },
          e(Button, { variant: 'outline', onClick: () => decide('reject') }, 'Reject'),
          e(Button, { variant: 'outline', onClick: () => decide('always') }, 'Always allow'),
          e(Button, { iconLeft: e(Icon, { name: 'check', size: 15 }), onClick: () => decide('once') }, 'Allow once'))),
    ),
  );
}
