import React from 'react';
import { parseSpecDoc, SPEC_ANATOMY } from '@arke/contracts';
import { Icon } from '../icons';
import { AgentMessage, Button, Textarea, Badge, StatusDot } from '../ds';
import { store, useStore } from '../store';
import { fetchSpecFile, approveDraftLive, convenePanelLive, sendCockpitPrompt, liveRequest, isCoordinatorConnected } from '../live';

const e = React.createElement;

/** Cheap djb2 content fingerprint: changes whenever the text changes, regardless of length — so a
 *  same-length `message.updated` snapshot still invalidates the transcript signature (PR #18 final review). */
function textSig(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

// ============================ LIVE MODE (SPEC-006) ============================
// The authoring agents surfaced in the composer (capable tier; the registry resolves the model).
const LIVE_ROLES = ['spec-author', 'architect'];
const PREVIEW_POLL_MS = 30000; // fallback re-poll guarding against a missed message.updated

const DELTA_STYLE: Record<string, { border?: string; badge: string; color: string; strike?: boolean }> = {
  ADDED: { border: 'var(--success)', badge: 'ADDED', color: 'var(--success)' },
  MODIFIED: { border: 'var(--warning)', badge: 'MODIFIED', color: 'var(--warning)' },
  REMOVED: { badge: 'REMOVED', color: 'var(--destructive)', strike: true },
};

function DeltaBadge({ kind }: any) {
  const st = DELTA_STYLE[kind];
  if (!st) return null;
  return e('span', { style: { flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', color: st.color, border: `1px solid ${st.color}`, borderRadius: 999, padding: '1px 6px' } }, st.badge);
}

function RequirementBlock({ req }: any) {
  const st = req.deltaKind ? DELTA_STYLE[req.deltaKind] : null;
  return e('div', { style: { marginBottom: 12, paddingLeft: st?.border ? 10 : 0, borderLeft: st?.border ? `3px solid ${st.border}` : 'none' } },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 } },
      e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--foreground)', textDecoration: st?.strike ? 'line-through' : 'none' } }, req.title),
      req.deltaKind ? e(DeltaBadge, { kind: req.deltaKind }) : null,
      req.capability ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted-foreground)' } }, req.capability) : null),
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, lineHeight: 1.55, color: st?.strike ? 'var(--muted-foreground)' : 'var(--foreground)', textDecoration: st?.strike ? 'line-through' : 'none', whiteSpace: 'pre-wrap' } }, requirementProse(req.body)));
}

/** The requirement prose minus the `capability:`/`delta:` metadata line (shown as a badge instead). */
function requirementProse(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*`?capability:/.test(l) && !/delta:\s*`?(ADDED|MODIFIED|REMOVED)/i.test(l))
    .join('\n')
    .trim();
}

function PreviewSection({ section, requirements }: any) {
  if (!section.present) {
    return e('div', { style: { marginBottom: 22 } },
      e('h3', { style: { margin: '0 0 6px', fontFamily: 'var(--font-sans)', fontSize: 14.5, fontWeight: 600, color: 'var(--foreground)' } }, section.title),
      e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--neutral-400)', fontStyle: 'italic' } }, '— empty —'));
  }
  return e('div', { style: { marginBottom: 22 } },
    e('h3', { style: { margin: '0 0 8px', fontFamily: 'var(--font-sans)', fontSize: 14.5, fontWeight: 600, color: 'var(--foreground)' } }, section.title),
    section.key === 'requirements'
      ? (requirements.length ? requirements.map((r, i) => e(RequirementBlock, { key: i, req: r })) : e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--neutral-400)' } }, 'no requirements yet'))
      : e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, lineHeight: 1.55, color: 'var(--foreground)', whiteSpace: 'pre-wrap' } }, section.markdown));
}

function LivePreview({ file, doc, inFlight, refreshed, onApprove, approving, reviewed }: any) {
  const fm = doc?.frontmatter ?? {};
  const chip = (t: string, v?: string) => v ? e('span', { key: t, style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, `${t}: ${v}`) : null;
  return e('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--background)', borderLeft: '1px solid var(--border)' } },
    e('div', { style: { padding: '11px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 } },
      e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'fileText', size: 15 })),
      e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--foreground)' } }, file?.path ?? 'specification'),
      inFlight ? e('span', { style: { display: 'flex', alignItems: 'center', gap: 5 } }, e(StatusDot, { status: 'running', pulse: true }), e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, 'writing…')) : null,
      refreshed ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, 'refreshed') : null,
      e('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 } },
        // The finalisation gate (SPEC-007) is enforced server-side; mirror it here so the button is
        // disabled until a panel has completed for this spec, with a hint at why.
        !reviewed && file?.exists ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' }, title: 'A multi-model review must complete before this draft can be approved.' }, 'review required') : null,
        e(Button, { size: 'sm', disabled: inFlight || approving || !file?.exists || !reviewed, iconLeft: e(Icon, { name: 'check', size: 14 }), onClick: onApprove }, approving ? 'Approving…' : 'Approve & persist'))),
    e('div', { style: { padding: '9px 20px', background: 'var(--secondary)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16, flexWrap: 'wrap' } },
      chip('spec', fm.spec_id || file?.specId), chip('status', fm.status || file?.status), chip('branch', fm.branch || file?.branch)),
    e('div', { style: { padding: '20px 22px', overflowY: 'auto', flex: 1 } },
      !file?.exists
        ? e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--muted-foreground)' } }, 'No working specification file found for this spec on the active project.')
        : (doc?.sections ?? []).map((sec, i) => e(PreviewSection, { key: i, section: sec, requirements: doc.requirements }))),
  );
}

function LiveCockpit() {
  const { activeSpec, activeCard, cards, cockpit, reviewedSpecs } = useStore();
  // Resolve the spec to author: prefer the ACTIVE board/session card's spec when one is selected (so
  // "Go to authoring" from a card opens that card's spec, not a stale activeSpec), then activeSpec,
  // then the first spec card (PR #18 review rounds 5–6).
  const specId = (activeCard ? cards.find((c: any) => c.id === activeCard)?.specId : null)
    || activeSpec
    || (cards.find((c: any) => c.kind === 'spec')?.specId)
    || null;
  const [file, setFile] = React.useState<any>(null);
  const [refreshed, setRefreshed] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [role, setRole] = React.useState('spec-author');
  const [tier, setTier] = React.useState('capable');
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  // A single ordered conversation: human turns are appended when accepted, agent turns are merged
  // from the live transcript as they arrive — so order is chronological (PR #18 review round 2).
  const [convo, setConvo] = React.useState<any[]>([]);
  // messageId → the agent role that produced it, captured at send time, so each agent turn keeps its
  // own attribution even if the composer's role selector changes later (PR #18 review round 2).
  const roleByMsgId = React.useRef<Map<string, string>>(new Map());
  const lastSentRole = React.useRef<string | undefined>(undefined); // fallback attribution
  // The tier each turn ran at (client-safe label; vendor model ids never reach the client per
  // SPEC-005). Shown on agent turns when the session card carries no resolved model (PR #18 round 6).
  const tierByMsgId = React.useRef<Map<string, string>>(new Map());
  const lastSentTier = React.useRef<string | undefined>(undefined);
  const latestSpec = React.useRef<string | null>(specId); // guards against stale spec.file responses
  const [approving, setApproving] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const scroller = React.useRef<any>(null);
  // Grounding files (SPEC-020): host-side context for the discussion, uploaded via the composer.
  const [grounding, setGrounding] = React.useState<any[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const fileInput = React.useRef<any>(null);
  const refreshGrounding = React.useCallback(() => {
    void liveRequest('grounding.list').then((res: any) => { if (res?.ok && Array.isArray(res.result)) setGrounding(res.result); });
  }, []);
  React.useEffect(() => { refreshGrounding(); }, [refreshGrounding]);
  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    for (const f of Array.from(files)) {
      const content = await f.text().catch(() => '');
      await liveRequest('grounding.upload', { name: f.name, content });
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
    refreshGrounding();
  };

  // Reset all per-spec state when the active spec changes, so a prompt is never routed to the prior
  // spec's session and the preview/conversation don't bleed across specs (PR #18 review round 4).
  React.useEffect(() => {
    latestSpec.current = specId;
    setSessionId(null);
    setConvo([]);
    setFile(null);
    roleByMsgId.current = new Map();
    tierByMsgId.current = new Map();
    lastSentRole.current = undefined;
    lastSentTier.current = undefined;
  }, [specId]);

  // Resolve the live AUTHORING session for this spec. Authoring sessions are spec-kind sessions for
  // this spec (id !== specId) — NOT the spec status card and NOT implementation task sessions, which
  // must stay out of the authoring conversation/in-flight state (PR #18 review round 6). Prefer the
  // session we created; otherwise reuse an existing running/idle authoring session (e.g. after a
  // reload) so follow-ups continue the same session rather than splitting context (round 6).
  const specStatusCard = cards.find((c: any) => c.id === specId);
  const authoringSessions = cards.filter((c: any) => c.specId === specId && c.id !== specId && c.kind === 'spec');
  // A session is REUSABLE for follow-ups only while idle/running — a terminal (done/error/interrupted)
  // session would be rejected by the coordinator's stale-session guard, so we create a fresh one
  // instead (PR #18 review round 7).
  const reusableSession = authoringSessions.find((c: any) => c.status === 'running')
    ?? authoringSessions.find((c: any) => c.status === 'idle');
  const authoringCard = sessionId ? cards.find((c: any) => c.id === sessionId) : null;
  // For display, fall back to the most recent authoring session (even terminal) so its transcript
  // stays visible, then the spec status card.
  const liveCard = authoringCard ?? reusableSession ?? authoringSessions[authoringSessions.length - 1] ?? specStatusCard;
  const inFlight = authoringSessions.some((c: any) => c.status === 'running');
  const transcript = liveCard?.transcript ?? [];
  // Drop user-role echoes: the human turn is already shown optimistically, so a harness echo of the
  // user message must not reappear as a spec-author/architect reply (PR #18 final review).
  const agentTranscript = transcript.filter((t: any) => t.role !== 'user');
  // A signature that changes when a streamed turn is finalised via message.updated (same entry, so
  // length is unchanged) — keyed on a content fingerprint, not length, so a same-length corrected
  // snapshot still re-polls the preview and re-merges the turn (PR #18 review + final review).
  const transcriptSig = agentTranscript.map((t: any) => `${t.messageId}:${textSig(t.text ?? '')}:${t.isStreaming ? 1 : 0}`).join('|');

  // Load the working file on mount/spec change, after each transcript change, and on a 30s fallback.
  const refresh = React.useCallback(async (markRefreshed = false) => {
    if (!specId) return;
    const reqSpec = specId;
    const res = await fetchSpecFile(reqSpec);
    // Discard a late response for a spec we've since navigated away from, so it can't overwrite the
    // current spec's preview (and feed the wrong branch into approve/convene) (PR #18 review round 6).
    if (reqSpec !== latestSpec.current) return;
    if (res?.ok) {
      setFile((prev: any) => {
        if (markRefreshed && prev?.text !== res.result?.text) { setRefreshed(true); setTimeout(() => setRefreshed(false), 2500); }
        return res.result;
      });
    }
  }, [specId]);

  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => { if (transcriptSig) void refresh(true); }, [transcriptSig, refresh]);
  React.useEffect(() => {
    const iv = setInterval(() => void refresh(true), PREVIEW_POLL_MS);
    return () => clearInterval(iv);
  }, [refresh]);

  const doc = React.useMemo(() => (file?.text ? parseSpecDoc(file.text) : null), [file?.text]);

  // Merge live transcript entries into the ordered conversation as they arrive/update — appended
  // after the human turn that prompted them, so the chat stays chronological. Each agent turn keeps
  // the role it was sent to (roleByMsgId), independent of the current composer selection.
  React.useEffect(() => {
    if (!agentTranscript.length) return;
    const modelLabel = liveCard?.model;
    setConvo((prev) => {
      let next = prev;
      for (const t of agentTranscript) {
        const key = 'a:' + t.messageId;
        // Label with the resolved model if the session carries one, else the tier the turn ran at
        // (client-safe; SPEC-005 keeps vendor model ids off the client).
        const label = modelLabel ?? tierByMsgId.current.get(t.messageId) ?? lastSentTier.current;
        const entry = { key, kind: 'agent', text: t.text, agent: roleByMsgId.current.get(t.messageId) ?? lastSentRole.current ?? 'agent', model: label, streaming: t.isStreaming, toolCalls: t.toolCalls || [] };
        const idx = next.findIndex((x: any) => x.key === key);
        if (idx === -1) next = [...next, entry];
        else if (next[idx].text !== entry.text || next[idx].streaming !== entry.streaming) {
          next = next.slice();
          next[idx] = { ...next[idx], text: entry.text, streaming: entry.streaming, model: label };
        }
      }
      return next;
    });
  }, [transcriptSig, liveCard?.model]);

  const send = async () => {
    if (!draft.trim() || !specId || sending) return; // guard double-submit (PR #18 review round 4)
    const text = draft.trim();
    const sentAs = role;
    setSending(true);
    try {
      // Reuse an existing NON-TERMINAL authoring session for this spec (e.g. after a reload) before
      // creating a new one, so follow-ups continue the same harness session/history (PR #18 review
      // rounds 6–7). A terminal tracked session is not reused (it would be rejected as stale).
      const trackedUsable = authoringCard && (authoringCard.status === 'idle' || authoringCard.status === 'running');
      let sid = (trackedUsable ? sessionId : null) ?? reusableSession?.id ?? null;
      if (!sid) {
        // Don't attempt session.create while offline — it would time out and the message would be
        // lost. Keep the draft in the composer and tell the engineer to reconnect (PR #18 review).
        if (!isCoordinatorConnected()) {
          store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: 'offline — reconnect to begin a session for this spec' } }));
          return;
        }
        const created = await liveRequest('session.create', { specId });
        sid = created?.ok ? created.result?.sessionId : null;
      }
      if (!sid) { store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: 'could not create a session for this spec' } })); return; }
      if (sid !== sessionId) setSessionId(sid); // remember the (created or reused) session
      // Record the reply's attribution + tier BEFORE awaiting: prompt.send resolves only when the
      // turn completes, by which time the transcript (and its agent turn) may already be merged — so
      // set roleByMsgId/tierByMsgId by a client-generated correlationId now, with lastSent* fallbacks
      // for turns whose messageId differs from the correlationId (PR #18 review rounds 5–6).
      // Prefix with `msg` so it is a valid OpenCode messageID (the harness rejects ids that don't) and
      // stays identical on the wire — keeping the correlationId the transcript is attributed by intact.
      const correlationId = `msg_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/-/g, '')}`;
      roleByMsgId.current.set(correlationId, sentAs);
      tierByMsgId.current.set(correlationId, tier);
      lastSentRole.current = sentAs;
      lastSentTier.current = tier;
      // Optimistically show the human turn + clear the composer for immediate feedback. Roll back on
      // a rejection/queue-full so the message stays editable (PR #18 review rounds 1–4).
      const key = 'h:' + Date.now();
      setConvo((c) => [...c, { key, kind: 'human', text }]);
      setDraft('');
      const outcome = await sendCockpitPrompt({ sessionId: sid, agent: sentAs, tier, message: text, correlationId });
      if (outcome.status === 'rejected' || outcome.status === 'full') {
        setConvo((c) => c.filter((x: any) => x.key !== key)); // undo the optimistic turn
        setDraft((d) => d || text); // restore the text if the composer is still empty
        return;
      }
      if (outcome.correlationId) roleByMsgId.current.set(outcome.correlationId, sentAs); // attribute the reply
    } finally {
      setSending(false);
    }
  };

  const approve = async () => {
    if (!specId) return;
    setApproving(true);
    const res = await approveDraftLive(specId, file?.branch);
    setApproving(false);
    if (res?.ok) { store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `approved — ${specId} is now in-review` } })); void refresh(); }
    else if (res?.error) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `approval failed — ${res.error}` } }));
    // server-side failures also arrive via the spec.approval-failed event handler in live.ts
  };

  const convene = async () => {
    if (!specId) return;
    const res = await convenePanelLive(specId, file?.branch);
    if (res?.ok) store.set((s: any) => ({ view: 'review', cockpit: { ...s.cockpit, notice: `review requested for ${specId}` } }));
    else if (res?.error) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `convene failed — ${res.error}` } }));
  };

  React.useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [convo.length, sending, inFlight]);

  const turns = convo;
  // Live activity (SPEC-020 UX): while a turn is in flight and the agent hasn't streamed visible text
  // yet, show an animated thinking/working bubble instead of dead air — a long tool-using turn looks
  // identical to a broken one otherwise. When the streaming entry carries toolCalls, name the latest.
  const lastTurn: any = turns[turns.length - 1];
  const streamingWithText = lastTurn && lastTurn.kind === 'agent' && lastTurn.streaming && (lastTurn.text || '').trim();
  const liveTools: string[] = (lastTurn && lastTurn.kind === 'agent' && lastTurn.streaming && lastTurn.toolCalls) || [];
  const showThinking = (sending || inFlight) && !streamingWithText;
  const lastLiveTool: any = liveTools[liveTools.length - 1];
  const thinkingLabel = liveTools.length ? `using ${lastLiveTool?.name ?? lastLiveTool}…` : 'thinking…';
  const ThinkingDots = () => e('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } },
    [0, 1, 2].map((i) => e('span', { key: i, style: { width: 5, height: 5, borderRadius: 999, background: 'var(--muted-foreground)', animation: 'soPulse 1.2s ease-in-out infinite', animationDelay: (i * 0.2) + 's' } })));
  // Small mono chips naming the tools an agent turn used, indented to align under the bubble.
  const ToolChips = ({ tools }: any) => (tools && tools.length)
    ? e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5, margin: '2px 0 0 31px' } },
        tools.map((tc: any, i: number) => e('span', { key: i + String(tc?.name ?? tc), style: { display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted-foreground)', background: 'var(--secondary)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 7px' } },
          e(Icon, { name: 'terminal', size: 10 }), (tc?.name ?? tc))))
    : null;

  return e('div', { style: { display: 'flex', height: '100%' } },
    e('div', { style: { width: 430, flex: 'none', display: 'flex', flexDirection: 'column', background: 'var(--background)', minWidth: 0 } },
      e('div', { style: { padding: '11px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 } },
        e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', fontWeight: 600 } }, 'Authoring'),
        inFlight ? e('span', { style: { display: 'flex', alignItems: 'center', gap: 5 } }, e(StatusDot, { status: 'running', pulse: true }), e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)' } }, 'agent writing')) : null,
        e('div', { style: { flex: 1 } }),
        e(Button, { variant: 'outline', size: 'sm', iconLeft: e(Icon, { name: 'users', size: 14 }), disabled: !specId || !file?.exists || !(doc?.requirements?.length), onClick: () => void convene() }, 'Convene review')),
      cockpit?.notice ? e('div', { style: { padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--secondary)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, cockpit.notice) : null,
      e('div', { ref: scroller, style: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 } },
        turns.length === 0 && !showThinking ? e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--muted-foreground)' } }, specId ? 'Direct the authoring agents to begin shaping the specification.' : 'Open a specification to author.')
          : turns.map((m: any) => e('div', { key: m.key },
              e(AgentMessage, { role: m.kind, agent: m.kind === 'agent' ? m.agent : undefined, model: m.model }, m.text || '…'),
              m.kind === 'agent' ? e(ToolChips, { tools: m.toolCalls }) : null)),
        showThinking ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start' } },
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
            e('span', { style: { width: 24, height: 24, borderRadius: 'var(--radius-sm)', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: 'bot', size: 13 })),
            e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, color: 'var(--foreground)' } }, lastSentRole.current ?? role),
            e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)' } }, thinkingLabel)),
          e('div', { style: { padding: '12px 14px', borderRadius: '4px 12px 12px 12px', background: 'var(--secondary)' } }, e(ThinkingDots))) : null),
      e('div', { style: { padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--background)' } },
        grounding.length ? e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)', alignSelf: 'center' } }, 'grounding:'),
          grounding.map((g: any) => e('span', { key: g.name, title: (g.size ?? 0) + ' bytes', style: { display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', background: 'var(--secondary)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' } },
            e(Icon, { name: 'file', size: 11 }), g.name))) : null,
        e('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
          e(MiniSelect, { value: role, icon: 'bot', options: LIVE_ROLES, onChange: setRole }),
          e(MiniSelect, { value: tier, icon: 'cpu', options: ['capable', 'mid', 'fast'], onChange: setTier })),
        e(Textarea, { rows: 2, value: draft, placeholder: 'Direct the agents…', onChange: (ev: any) => setDraft(ev.target.value), onKeyDown: (ev: any) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) void send(); } }),
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 9 } },
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, '⌘↵ to send'),
          e('button', { onClick: () => fileInput.current?.click(), disabled: uploading, title: 'Upload files as grounding for the discussion',
            style: { display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, color: 'var(--muted-foreground)' } },
            e(Icon, { name: 'file', size: 13 }), uploading ? 'Uploading…' : 'Attach files'),
          e('input', { ref: fileInput, type: 'file', multiple: true, style: { display: 'none' }, onChange: (ev: any) => void onFiles(ev.target.files) }),
          e('div', { style: { flex: 1 } }),
          e(Button, { size: 'sm', disabled: !specId || sending, onClick: () => void send() }, sending ? 'Sending…' : 'Send'))),
    ),
    e(LivePreview, { file, doc, inFlight, refreshed, approving, onApprove: approve, reviewed: !!specId && (reviewedSpecs || []).includes(specId) }),
  );
}

// ============================ DEMO MODE (design baseline) ====================
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
  const ref = React.useRef<any>(null);
  React.useEffect(() => { const h = (ev: any) => { if (ref.current && !ref.current.contains(ev.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  return e('div', { ref, style: { position: 'relative' } },
    e('button', { onClick: () => setOpen((o) => !o), style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 500, color: 'var(--foreground)' } },
      icon ? e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: icon, size: 13 })) : null,
      value, e('span', { style: { display: 'flex', color: 'var(--neutral-400)' } }, e(Icon, { name: 'chevronDown', size: 12 }))),
    open ? e('div', { style: { position: 'absolute', bottom: 30, left: 0, minWidth: 150, background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', zIndex: 40, padding: 4 } },
      options.map((o: any) => e('button', { key: o, onClick: () => { onChange(o); setOpen(false); }, style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 9px', borderRadius: 'var(--radius-sm)', border: 'none', background: o === value ? 'var(--accent)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--foreground)' } }, o))) : null,
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
  const line = (it: any, i: number) => e('div', { key: i, style: { display: 'flex', gap: 8, marginBottom: 7, alignItems: 'flex-start' } },
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
      spec.frontmatter.map((t: string, i: number) => e('span', { key: i, style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, t))),
    e('div', { style: { padding: '20px 22px', overflowY: 'auto', flex: 1 } },
      e(Section, { title: 'Requirements', editing: editing === 'requirements' }, spec.requirements.map(line)),
      e(Section, { title: 'Design', editing: editing === 'design' }, spec.design.map(line)),
      e(Section, { title: 'Tasks', editing: editing === 'tasks' },
        spec.tasks.map((t: any, i: number) => e('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          e('span', { style: { flex: 'none', display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'commit', size: 14 })),
          e('span', { style: { flex: 1, fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--foreground)' } }, t.t),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: t.tier === 'needs a human' ? 'var(--warning)' : 'var(--muted-foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 7px' } }, t.tier)))),
    ),
  );
}

function DemoCockpit() {
  const [msgs, setMsgs] = React.useState(SEED_MSGS);
  const [spec, setSpec] = React.useState(seedSpec);
  const [draft, setDraft] = React.useState('');
  const [role, setRole] = React.useState('Technical Architect');
  const [model, setModel] = React.useState('Opus');
  const [editing, setEditing] = React.useState<any>(null);
  const [streaming, setStreaming] = React.useState(false);
  const scroller = React.useRef<any>(null);
  React.useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [msgs]);

  const streamReply = (fullText: string, opts: any) => {
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
          setSpec((sp: any) => {
            const next = { ...sp };
            if (target === 'tasks') next.tasks = [...sp.tasks.slice(0, 2), { t: 'Add retry-attempt metric', tier: 'mid-tier' }, ...sp.tasks.slice(2)];
            else if (target === 'design') next.design = [...sp.design, { t: 'Performance — index on (tenant_id, idempotency_key) keeps lookups O(log n).', shall: false }];
            else next.requirements = sp.requirements.map((x: any) => x.shall ? { ...x, t: x.t + ' Processed keys retained 30 days.' } : x);
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
        msgs.map((m: any) => e(AgentMessage, { key: m.id, role: m.role, agent: m.agent, model: m.model }, m.text || '…'))),
      e('div', { style: { padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--background)' } },
        e('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
          e(MiniSelect, { value: role, icon: 'bot', options: ROLES.map((r) => r.role), onChange: (v: any) => { setRole(v); const r = ROLES.find((x) => x.role === v); if (r) setModel(r.model); } }),
          e(MiniSelect, { value: model, icon: 'cpu', options: ['Opus', 'Sonnet', 'GPT-5.5', 'mid-tier'], onChange: setModel })),
        e(Textarea, { rows: 2, value: draft, placeholder: 'Direct the agents…', onChange: (ev: any) => setDraft(ev.target.value), onKeyDown: (ev: any) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) send(); } }),
        e('div', { style: { display: 'flex', alignItems: 'center', marginTop: 9 } },
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, '⌘↵ to send'),
          e('div', { style: { flex: 1 } }),
          e(Button, { size: 'sm', disabled: streaming, onClick: send }, 'Send'))),
    ),
    e(SpecPreview, { spec, editing }),
  );
}

/** The cockpit renders live (wired to the coordinator) once a snapshot has arrived, else the demo. */
export function Cockpit() {
  const live = useStore((s: any) => s.live);
  return live ? e(LiveCockpit) : e(DemoCockpit);
}
