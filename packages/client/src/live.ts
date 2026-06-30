import { store, engine } from './store';
import { ArkeTransport, type TransportState } from './transport';
import { OutboundQueue } from './outbound-queue';

/**
 * Live coordinator wiring (SPEC-003). Connects the client to the coordinator over
 * {@link ArkeTransport}, applies the `snapshot` frame and folds subsequent `event` frames into
 * the store so the board renders real delivery state. When no coordinator is reachable the
 * app stays on its mock data; the first snapshot flips `live` on and the mock engine stands
 * down. Column derivation mirrors the coordinator's read model (a card moves because the work
 * moved — never set by hand).
 */

const COORDINATOR_URL =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ARKE_COORDINATOR_URL ??
  'ws://127.0.0.1:4319';

type Col = 'authoring' | 'review' | 'approved' | 'implementing' | 'needs-human' | 'diff' | 'merged';

interface LiveCard {
  id: string;
  specId: string;
  kind: 'spec' | 'task';
  title: string;
  col: Col;
  status: string;
  harness?: string;
  model?: string;
  needsHuman: boolean;
  progress: number;
  transcript: any[];
  diff?: { added: number; removed: number; files: number };
}

let transport: ArkeTransport | null = null;
const cards = new Map<string, LiveCard>();
const specStatus = new Map<string, string>();
const reachByEndpoint = new Map<string, { reachable: boolean; reason?: string; partial?: boolean }>();
let evSeq = 0;

function deriveColumn(card: LiveCard, ss?: string): Col {
  if (card.needsHuman) return 'needs-human';
  if (card.kind === 'task') return card.status === 'done' ? 'diff' : 'implementing';
  switch (ss) {
    case 'draft': return 'authoring';
    case 'in-review': return 'review';
    case 'approved': return 'approved';
    case 'merged': return 'merged';
    default: return 'authoring';
  }
}

function progressFor(status: string, col: Col): number {
  if (status === 'done' || col === 'merged') return 100;
  if (status === 'waiting') return 80;
  if (status === 'running') return 55;
  if (status === 'error') return 100;
  return 12;
}

function ensureCard(id: string, specId: string, kind: 'spec' | 'task'): LiveCard {
  let c = cards.get(id);
  if (!c) {
    c = { id, specId, kind, title: id, col: 'authoring', status: 'idle', needsHuman: false, progress: 12, transcript: [] };
    cards.set(id, c);
  }
  return c;
}

const MAX_TRANSCRIPT = 100;

function transcriptEntry(card: LiveCard, messageId: string, role: string) {
  let entry = card.transcript.find((t) => t.messageId === messageId);
  if (!entry) {
    entry = { messageId, role, text: '', toolCalls: [], isStreaming: true };
    card.transcript.push(entry);
    if (card.transcript.length > MAX_TRANSCRIPT) card.transcript.shift();
  }
  return entry;
}

function rail(kind: string, text: string, ts: number) {
  store.set((s: any) => ({ events: [{ id: 'lv-' + (++evSeq), ts, kind, text }, ...s.events].slice(0, 60) }));
}

function applyEvent(ev: any) {
  // Discard events from a project other than the active one (SPEC-018). On a slow connection,
  // frames queued for project A can arrive after we've switched to B; the coordinator stamps
  // every event with projectId so we can drop the stale ones rather than fold them into B's board.
  const activeId = (store.get() as any).connectedProject?.projectId;
  if (ev.projectId && activeId && ev.projectId !== activeId) return;
  const ts = ev.ts || Date.now();
  switch (ev.type) {
    case 'spec.status': {
      specStatus.set(ev.specId, ev.status);
      const c = ensureCard(ev.specId, ev.specId, 'spec');
      c.col = deriveColumn(c, ev.status);
      // SPEC-008: live-update the spec library badge for this spec (no reload).
      store.set((s: any) => ({
        specs: (s.specs || []).map((sp: any) => sp.specId === ev.specId ? { ...sp, status: ev.status } : sp),
      }));
      if (ev.reason) rail('spec.status', `spec.status · ${ev.specId} · ${ev.status}${ev.reason ? ' (' + ev.reason + ')' : ''}`, ts);
      break;
    }
    case 'generation.proposed': {
      // SPEC-013: the agent's pre-write artefact proposal for review.
      store.set({ generation: { specId: ev.specId, proposalId: ev.sessionId, artifacts: ev.artifacts, status: 'pending-review' } });
      rail('generation.proposed', `generation.proposed · ${ev.specId} · ${(ev.artifacts || []).length} artefacts`, ts);
      break;
    }
    case 'generation.decided': {
      const cur: any = store.get().generation;
      if (cur && cur.proposalId === ev.sessionId) store.set({ generation: null });
      rail('generation.decided', `generation.decided · ${ev.specId} · ${ev.decision}`, ts);
      break;
    }
    case 'generation.error': {
      store.set((s: any) => ({ generation: s.generation && s.generation.specId === ev.specId ? { ...s.generation, status: 'error', error: ev.reason } : s.generation, cockpit: { ...s.cockpit, notice: `generation failed — ${ev.reason}` } }));
      rail('generation.error', `generation.error · ${ev.specId} · ${ev.reason}`, ts);
      break;
    }
    case 'elicitation.asked': {
      // SPEC-011: an agent's structured question — surfaced as an overlay for the session, not a chat line.
      store.set({ elicitation: { sessionId: ev.sessionId, elicitationId: ev.elicitationId, question: ev.question, options: ev.options || [] } });
      rail('elicitation.asked', `elicitation.asked · ${ev.sessionId} · ${ev.question}`, ts);
      break;
    }
    case 'elicitation.replied':
    case 'elicitation.rejected': {
      const cur: any = store.get().elicitation;
      if (cur && cur.elicitationId === ev.elicitationId) store.set({ elicitation: null });
      break;
    }
    case 'spec.branch-mismatch': {
      store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `branch mismatch on ${ev.specId}: frontmatter '${ev.frontmatterBranch}' ≠ pushed '${ev.pushedBranch}'` } }));
      rail('spec.branch-mismatch', `spec.branch-mismatch · ${ev.specId}`, ts);
      break;
    }
    case 'spec.divergence-warning': {
      store.set((s: any) => ({ specs: (s.specs || []).map((sp: any) => sp.specId === ev.specId ? { ...sp, hasDivergence: true } : sp) }));
      rail('spec.divergence-warning', `spec.divergence-warning · ${ev.specId}`, ts);
      break;
    }
    case 'projection.stale': {
      store.set((s: any) => ({ projections: (s.projections || []).map((p: any) => (p.recordRef === ev.recordRef || p.target === ev.target) ? { ...p, stale: true } : p) }));
      rail('projection.stale', `projection.stale · ${ev.specId} · ${ev.target}`, ts);
      break;
    }
    case 'session.status': {
      const c = ensureCard(ev.sessionId, ev.specId, ev.kind);
      c.status = ev.status;
      if (ev.model) c.model = ev.model;
      c.harness = ev.harness;
      c.needsHuman = ev.status === 'waiting';
      c.col = deriveColumn(c, specStatus.get(ev.specId));
      c.progress = progressFor(c.status, c.col);
      if (ev.status === 'running') rail('session.busy', `session.busy · ${ev.sessionId} · running`, ts);
      break;
    }
    case 'permission.asked': {
      const c = cards.get(ev.sessionId);
      if (c) { c.needsHuman = true; c.col = 'needs-human'; }
      // Raise the live approval overlay (SPEC-016). Auto-granted asks never reach the client.
      store.set({
        permission: {
          id: ev.permissionId, live: true, permissionId: ev.permissionId,
          cardId: ev.sessionId, cardTitle: (c && c.title) || ev.sessionId,
          action: ev.title, command: ev.detail || ev.title, harness: ev.harness || 'OpenCode', ts,
        },
      });
      rail('permission.requested', `permission.requested · ${ev.sessionId} · ${ev.title} — awaiting human`, ts);
      break;
    }
    case 'permission.replied': {
      const c = cards.get(ev.sessionId);
      if (c) { c.needsHuman = false; c.col = deriveColumn(c, specStatus.get(c.specId)); }
      const cur: any = store.get().permission;
      if (cur && cur.permissionId === ev.permissionId) store.set({ permission: null });
      rail(ev.granted ? 'permission.granted' : 'permission.denied', `permission.${ev.granted ? 'granted' : 'denied'} · ${ev.sessionId}`, ts);
      break;
    }
    case 'message.part': {
      const c = cards.get(ev.sessionId);
      if (c) { const en = transcriptEntry(c, ev.messageId, ev.role); en.text += ev.delta; en.isStreaming = !ev.done; }
      rail('session.busy', `session.busy · ${ev.sessionId} · ${ev.delta.trim()}`, ts);
      break;
    }
    case 'message.updated': {
      const c = cards.get(ev.sessionId);
      if (c) { const en = transcriptEntry(c, ev.messageId, ev.role); en.text = ev.text; en.toolCalls = ev.toolCalls || []; en.isStreaming = ev.isStreaming; }
      break;
    }
    case 'diff.finalized': {
      const c = cards.get(ev.sessionId);
      if (c) c.diff = { added: ev.added, removed: ev.removed, files: ev.files };
      rail('diff.finalised', `diff.finalised · ${ev.sessionId} · +${ev.added} −${ev.removed} across ${ev.files} files`, ts);
      break;
    }
    case 'turn.quiescent': {
      rail('turn.quiescent', `turn.quiescent · ${ev.sessionId}`, ts);
      break;
    }
    case 'scaffold.step': {
      // Fold scaffold progress for the initialisation screen's terminal panel (SPEC-004).
      store.set((s: any) => ({
        scaffold: {
          ...(s.scaffold ?? { steps: {}, log: [], running: true, done: false }),
          // An error step is terminal: ScaffoldRunner stops and emits no scaffold.done, so clear
          // `running` (and flag `error`) — otherwise the init screen stays stuck on "Scaffolding…"
          // and the retry path is unreachable.
          running: ev.status === 'error' ? false : (ev.status === 'running' ? true : (s.scaffold?.running ?? true)),
          error: ev.status === 'error' ? (ev.detail || ev.step) : (s.scaffold?.error ?? null),
          steps: { ...(s.scaffold?.steps ?? {}), [ev.step]: ev.status },
          log: [
            ...((s.scaffold?.log ?? [])),
            { t: ev.status === 'error' ? 'err' : ev.status === 'skipped' ? 'skip' : ev.status === 'done' ? 'file' : 'run', m: `${ev.step}: ${ev.status}${ev.detail ? ' — ' + ev.detail : ''}` },
          ].slice(-80),
        },
      }));
      rail('scaffold.step', `scaffold.step · ${ev.step} · ${ev.status}`, ts);
      break;
    }
    case 'scaffold.done': {
      store.set((s: any) => ({
        scaffold: { ...(s.scaffold ?? { steps: {}, log: [] }), running: false, done: true },
      }));
      rail('scaffold.done', `scaffold.done · ${(ev.stepsRun || []).join(', ')}`, ts);
      break;
    }
    case 'registry.updated': {
      // Live registry projection (SPEC-005): refresh the harness list with current reachability,
      // capabilities and catalog state. Tier labels only — no model strings cross the wire.
      applyRegistryInstances(ev.instances);
      break;
    }
    case 'spec.approval-failed': {
      // Surface an approval failure (branch guard, dirty tree, git error) in the cockpit (SPEC-006).
      store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `approval failed — ${ev.reason}` } }));
      rail('spec.approval-failed', `spec.approval-failed · ${ev.specId} · ${ev.reason}`, ts);
      break;
    }
    case 'registry.warning': {
      // Surface unsolicited live warnings in the store (deduped by reason+detail); the snapshot /
      // re-probe path is authoritative and replaces the list.
      store.set((s: any) => {
        const w = { reason: ev.reason, detail: ev.detail };
        const exists = (s.registryWarnings || []).some((x: any) => x.reason === w.reason && x.detail === w.detail);
        return exists ? {} : { registryWarnings: [...(s.registryWarnings || []), w] };
      });
      rail('registry.warning', `registry.warning · ${ev.reason}${ev.detail ? ' · ' + ev.detail : ''}`, ts);
      break;
    }
    case 'panel.started': {
      // A multi-model review panel began (SPEC-007). `reviewers[].model` is a tier LABEL, never a
      // vendor model id (SPEC-005). Replace any prior panel for this spec.
      store.set({
        panel: {
          panelId: ev.panelId, specId: ev.specId, status: 'running',
          reviewers: (ev.reviewers || []).map((r: any) => ({ role: r.role, model: r.model, status: 'running', issues: [] })),
          agreedIds: [], notice: null,
        },
      });
      rail('panel.started', `panel.started · ${ev.specId} · ${(ev.reviewers || []).length} reviewers`, ts);
      break;
    }
    case 'panel.issue': {
      updatePanel(ev.panelId, (p: any) => {
        const r = p.reviewers.find((x: any) => x.role === ev.reviewerRole);
        if (r && !r.issues.some((i: any) => i.issueId === ev.issueId)) {
          r.issues = [...r.issues, { issueId: ev.issueId, section: ev.section, sectionHash: ev.sectionHash, text: ev.text, severity: ev.severity, decision: null }];
        }
      });
      break;
    }
    case 'panel.agreed': {
      updatePanel(ev.panelId, (p: any) => {
        p.agreedIds = [...new Set([...(p.agreedIds || []), ...(ev.issueIds || [])])];
      });
      rail('panel.agreed', `panel.agreed · ${ev.section} · ${(ev.issueIds || []).length} reviewers concur`, ts);
      break;
    }
    case 'panel.reviewer-error': {
      updatePanel(ev.panelId, (p: any) => {
        const r = p.reviewers.find((x: any) => x.role === ev.reviewerRole);
        if (r) { r.status = 'error'; r.error = ev.reason; }
      });
      rail('panel.reviewer-error', `panel.reviewer-error · ${ev.reviewerRole} · ${ev.reason}`, ts);
      break;
    }
    case 'panel.complete': {
      updatePanel(ev.panelId, (p: any) => {
        p.status = ev.status;
        for (const r of p.reviewers) if (r.status === 'running') r.status = 'done';
      });
      // Key the gate off the completed panel's OWN specId (carried on the event), not the current
      // store slot — a late completion of a superseded panel must not mark a different spec reviewed.
      if (ev.status === 'complete' && ev.specId) {
        store.set((s: any) => ({ reviewedSpecs: s.reviewedSpecs.includes(ev.specId) ? s.reviewedSpecs : [...s.reviewedSpecs, ev.specId] }));
      }
      rail('panel.complete', `panel.complete · ${ev.status} · ${ev.issueCount} issues`, ts);
      break;
    }
    case 'panel.config-error': {
      // The panel could not start (same-model pair, too few distinct capable models). Surface it on
      // the panel projection if one exists, and always on the cockpit notice line.
      store.set((s: any) => ({
        cockpit: { ...s.cockpit, notice: `review panel could not start — ${ev.reason}` },
        panel: s.panel && s.panel.specId === ev.specId ? { ...s.panel, status: 'failed', notice: ev.reason } : s.panel,
      }));
      rail('panel.config-error', `panel.config-error · ${ev.reason}`, ts);
      break;
    }
    case 'panel.stale-file-warning': {
      // Accepting an issue when the reviewed section changed since panel start needs confirmation.
      updatePanel(ev.panelId, (p: any) => { p.notice = `the reviewed section changed since the panel ran — re-confirm to route issue ${ev.issueId}`; });
      rail('panel.stale-file-warning', `panel.stale-file-warning · ${ev.specId} · ${ev.issueId}`, ts);
      break;
    }
    case 'review.gate-failed': {
      // The finalisation gate rejected an approve issued without a completed review (SPEC-007).
      store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `approval blocked — ${ev.reason}` } }));
      rail('review.gate-failed', `review.gate-failed · ${ev.specId} · ${ev.reason}`, ts);
      break;
    }
    case 'harness.reachability': {
      // Per-endpoint probe result. Track each endpoint and recompute the aggregate (any reachable
      // → reachable) so a live "Retry connection" updates the gate without a reconnect (SPEC-004).
      reachByEndpoint.set(ev.endpoint, { reachable: ev.reachable, reason: ev.reason, partial: ev.partial });
      const all = [...reachByEndpoint.values()];
      const reachable = all.some((r) => r.reachable);
      const failed = all.find((r) => !r.reachable);
      store.set({
        harnessReachable: reachable,
        harnessReachabilityReason: reachable ? null : (failed?.reason ?? null),
        harnessReachabilityPartial: reachable ? false : (failed?.partial ?? false),
      });
      break;
    }
    default:
      break;
  }
  publish();
}

function publish() {
  store.set({ cards: [...cards.values()] });
}

/** Immutably mutate the current panel projection if it matches `panelId`. */
function updatePanel(panelId: string, fn: (p: any) => void) {
  store.set((s: any) => {
    if (!s.panel || s.panel.panelId !== panelId) return {};
    const next = { ...s.panel, reviewers: s.panel.reviewers.map((r: any) => ({ ...r })) };
    fn(next);
    return { panel: next };
  });
}

// ---- registry projection (SPEC-005) ----
const TIER_META: Record<string, { label: string; note: string }> = {
  capable: { label: 'Capable tier', note: 'authoring & review' },
  mid: { label: 'Standard tier', note: 'implementation' },
  fast: { label: 'Fast tier', note: 'routine, classification & projection drafts' },
};

/** Map registry instance projections to the harnesses-screen shape (tier labels only, no models). */
function applyRegistryInstances(instances: any[]) {
  store.set({
    harnesses: (instances || []).map((i) => ({
      id: i.id,
      name: i.id,
      driver: i.driver,
      endpoint: i.endpoint,
      status: i.reachable ? 'connected' : 'idle',
      caps: i.caps || [],
      serves: i.serves || [],
      catalogUnavailable: !!i.catalogUnavailable,
    })),
  });
}

/** Fold the whole registry projection (instances + tier resolution + roster + warnings). */
function applyRegistrySnapshot(reg: any) {
  if (!reg) {
    store.set({ harnesses: [], tiers: [], roster: [], registryWarnings: [] });
    return;
  }
  applyRegistryInstances(reg.instances || []);
  store.set({
    tiers: (reg.tierResolution || []).map((t) => ({
      tier: t.tier,
      label: TIER_META[t.tier]?.label ?? t.tier,
      note: TIER_META[t.tier]?.note ?? '',
      model: t.label, // a leak-free resolution label (e.g. "capable — opencode"), never a model id
    })),
    roster: reg.roster || [],
    registryWarnings: reg.warnings || [], // authoritative snapshot of warnings (replaces, not appends)
  });
}

/**
 * Re-probe the live registry on demand (SPEC-005). Uses the request path so the coordinator
 * re-runs the adapter probe and returns a fresh, authoritative projection — replacing stale
 * reachability/caps/catalog and clearing resolved warnings rather than appending forever.
 */
export async function reprobeRegistry(): Promise<void> {
  const res = await liveRequest('registry.probe');
  if (res?.ok && res.result) applyRegistrySnapshot(res.result);
}

/** Seed the local read model from a coordinator snapshot frame (cards + onboarding state). */
function applySnapshot(snap: any) {
  const snapCards: any[] = Array.isArray(snap?.cards) ? snap.cards : [];
  cards.clear();
  specStatus.clear();
  const SPEC_COL_TO_STATUS: Record<string, string> = { authoring: 'draft', review: 'in-review', approved: 'approved', merged: 'merged' };
  for (const c of snapCards) {
    const col: Col = c.column ?? c.col ?? 'authoring';
    cards.set(c.id, {
      id: c.id, specId: c.specId, kind: c.kind, title: c.title, col,
      status: c.status, harness: c.harness, model: c.model, needsHuman: c.needsHuman,
      progress: progressFor(c.status, col), transcript: c.transcript ?? [],
    });
    if (c.kind === 'spec' && SPEC_COL_TO_STATUS[col]) specStatus.set(c.specId, SPEC_COL_TO_STATUS[col]);
  }
  // Snapshot is authoritative; switch the UI to live and let the mock engine stand down. It also
  // carries the onboarding state (SPEC-004): harness reachability + the project classification.
  reachByEndpoint.clear();
  store.set({
    cards: [...cards.values()],
    live: true,
    events: [],
    connectedProject: snap?.projectName ? { projectId: snap.projectId ?? null, name: snap.projectName, path: snap.projectPath ?? null, harness: snap.harness ?? null, endpoint: snap.harnessEndpoint ?? null } : null,
    harnessReachable: snap?.harnessReachable ?? true,
    harnessReachabilityReason: snap?.harnessReachabilityReason ?? null,
    harnessReachabilityPartial: snap?.harnessReachabilityPartial ?? false,
    projectState: snap?.projectState ?? null,
    missingSentinels: snap?.missingSentinels ?? [],
    tierDefaults: snap?.tierDefaults ?? null,
    specs: Array.isArray(snap?.specs) ? snap.specs : [], // SPEC-008: live spec library for this project
  });
  applyRegistrySnapshot(snap?.registry); // SPEC-005: live harnesses & model tiering
  engine.stop();
  void refreshRecents(); // SPEC-018: populate the picker's real recents
  // Run a deferred cockpit-queue drain now that the post-reconnect snapshot has been applied.
  if (drainPending) {
    drainPending = false;
    void drainCockpitQueue();
  }
}

// ---- request/response over the same WS (SPEC-017/018) ----
let reqSeq = 0;
const pending = new Map<string, (r: any) => void>();

/** Send a coordinator op and resolve with its `{ ok, result | error }` response. */
export function liveRequest(op: string, args?: unknown, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve) => {
    if (!transport) return resolve({ ok: false, error: 'not connected' });
    const id = 'c' + ++reqSeq;
    pending.set(id, resolve);
    transport.send({ type: 'request', id, op, args });
    setTimeout(() => { if (pending.delete(id)) resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
  });
}

/** Refresh the durable recents list for the picker (SPEC-018 project.list). */
export async function refreshRecents(): Promise<void> {
  const res = await liveRequest('project.list');
  if (res?.ok && Array.isArray(res.result)) store.set({ recents: res.result });
}

/** Open/switch the active project; the coordinator re-snapshots. Returns the open result. */
export async function openProjectLive(target: { projectId?: string; path?: string }): Promise<any> {
  // A cold open may spawn + health-check a managed harness, which can take much longer than the
  // default request window; allow 90s so the UI doesn't report a still-in-progress open as failed.
  const res = await liveRequest('project.open', target, 90000);
  if (res?.ok) void refreshRecents();
  return res;
}

function onFrame(frame: any) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'snapshot' && Array.isArray(frame.cards)) applySnapshot(frame);
  else if (frame.type === 'event' && frame.event) applyEvent(frame.event);
  else if (frame.type === 'response' && pending.has(frame.id)) {
    pending.get(frame.id)!(frame);
    pending.delete(frame.id);
  } else if (frame.type === 'folder.inspected') {
    // Result of folder.inspect / repo.clone (SPEC-004): refresh the onboarding classification so
    // the initialisation screen can explain exactly what is present and what will be added.
    store.set({ projectState: frame.state ?? null, missingSentinels: frame.missingSentinels ?? [] });
  }
}

/** Start (idempotently) the live link to the coordinator. */
export function startLive(): ArkeTransport {
  if (transport) return transport;
  transport = new ArkeTransport({
    url: COORDINATOR_URL,
    onMessage: onFrame,
    baseDelayMs: 600,
    maxDelayMs: 8000,
  });
  store.set({ connection: transport.state });
  transport.subscribe((state: TransportState) => {
    store.set({ connection: state });
    // On reconnect, defer the cockpit-queue drain until AFTER the first snapshot is processed: the
    // transport fires 'open' before the snapshot, and a drain that re-binds the project here can race
    // ahead of the coordinator's default-project snapshot (which would then overwrite connectedProject
    // and drop the replayed prompt's events). applySnapshot() triggers the deferred drain (PR #18
    // review round 5).
    if (state === 'open' && outbound.size > 0) drainPending = true;
  });
  return transport;
}

// ---- authoring cockpit (SPEC-006) ----
const outbound = new OutboundQueue<any>(50);
// Set on reconnect-with-queue; the drain is run by applySnapshot once the first snapshot lands.
let drainPending = false;
// The projectId the offline prompts were authored against — the drain re-binds to THIS, not the
// post-reconnect default snapshot's project (PR #18 review round 5).
let queuedForProject: string | null = null;
// prompt.send resolves only when the agent's turn completes, which routinely exceeds the default
// request window — use a long ceiling so a normal turn is not reported as a spurious timeout.
const PROMPT_TIMEOUT_MS = 10 * 60_000;

/** True when the coordinator socket is connected (used to decide send-now vs. queue). */
export function isCoordinatorConnected(): boolean {
  return !!transport && transport.state === 'open';
}

/** Re-bind to the project the prompts were queued for, then drain them SEQUENTIALLY against it. */
async function drainCockpitQueue(): Promise<void> {
  if (outbound.size === 0) { queuedForProject = null; return; }
  // Re-bind this fresh socket to the project the prompts were authored against (NOT the post-reconnect
  // default). If the rebind fails (project forgotten/unopenable), keep the queue intact rather than
  // dispatching against the wrong project (PR #18 review rounds 3 & 5).
  const target = queuedForProject ?? (store.get() as any).connectedProject?.projectId;
  if (target) {
    const reopened = await liveRequest('project.open', { projectId: target }, 90000);
    if (!reopened?.ok) {
      store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `reconnected, but couldn't reopen the project — ${outbound.size} message${outbound.size === 1 ? '' : 's'} held` } }));
      return; // queue + queuedForProject intact for the next attempt
    }
  }
  const items = outbound.takeAll();
  store.set((s: any) => ({ cockpit: { ...s.cockpit, queued: 0, notice: `reconnected — replaying ${items.length} queued message${items.length === 1 ? '' : 's'}` } }));
  // Replay in order (FIFO). Each is marked `replay: true` so the coordinator rejects it if the target
  // session can't be confirmed live (e.g. after a restart) instead of executing blindly (PR #18 final
  // review). When a session is rejected as stale, DROP that session's later prompts too — resubmitting
  // them would only be rejected again, and re-queuing them looped forever (PR #18 final review). A
  // mid-drain disconnect is different: hold the unsent remainder for the next reconnect.
  const rejectedSessions = new Set<string>();
  const requeue: any[] = [];
  let dropped = 0;
  for (const cmd of items) {
    if (rejectedSessions.has(cmd.sessionId)) { dropped++; continue; } // same stale session → drop
    if (!isCoordinatorConnected()) { requeue.push(cmd); continue; }   // socket dropped → retry on reconnect
    const res = await submitCockpitPrompt({ ...cmd, replay: true });
    if (!res?.ok) {
      if (!isCoordinatorConnected()) requeue.push(cmd);               // disconnected during the call
      else { rejectedSessions.add(cmd.sessionId); dropped++; }        // server rejected (stale) → drop session
    }
  }
  for (const cmd of requeue) outbound.enqueue(cmd);
  if (outbound.size === 0) {
    queuedForProject = null; // fully drained (or all dropped) → release the binding (PR #18 review round 6)
    if (dropped > 0) store.set((s: any) => ({ cockpit: { ...s.cockpit, queued: 0, notice: `dropped ${dropped} queued message${dropped === 1 ? '' : 's'} for stale session${dropped === 1 ? '' : 's'}` } }));
    return;
  }
  // Items remain only because the socket dropped mid-drain; they're held for the next reconnect.
  store.set((s: any) => ({ cockpit: { ...s.cockpit, queued: outbound.size, notice: `connection dropped mid-replay — ${outbound.size} message${outbound.size === 1 ? '' : 's'} held` } }));
}

/** Issue a prompt.send request and surface a stale-session (or other) rejection in the cockpit. */
async function submitCockpitPrompt(args: any): Promise<any> {
  const res = await liveRequest('prompt.send', args, PROMPT_TIMEOUT_MS);
  if (!res?.ok) store.set((s: any) => ({ cockpit: { ...s.cockpit, notice: `message rejected — ${res?.error ?? 'unknown error'}` } }));
  return res;
}

/**
 * Send a cockpit prompt (SPEC-006). When connected it goes straight through (returning the
 * coordinator's response so a stale-session rejection is visible); when offline it is queued,
 * bounded at 50 — a full queue is refused, never silently dropped.
 */
export async function sendCockpitPrompt(args: { sessionId: string; agent: string; tier: string; message: string; correlationId?: string }): Promise<{ status: 'sent' | 'rejected' | 'queued' | 'full'; error?: string; correlationId?: string }> {
  if (transport && transport.state === 'open') {
    const res = await submitCockpitPrompt(args);
    return res?.ok ? { status: 'sent', correlationId: res.result?.correlationId ?? args.correlationId } : { status: 'rejected', error: res?.error };
  }
  const accepted = outbound.enqueue(args);
  // Remember which project these offline prompts belong to, so the reconnect drain re-binds to it.
  if (accepted && !queuedForProject) queuedForProject = (store.get() as any).connectedProject?.projectId ?? null;
  store.set((s: any) => ({ cockpit: { ...s.cockpit, queued: outbound.size, notice: accepted ? `offline — queued ${outbound.size} message${outbound.size === 1 ? '' : 's'}` : 'offline — queue full (50); message not queued' } }));
  return { status: accepted ? 'queued' : 'full' };
}

/**
 * Read the working specification file for the preview (SPEC-006). Fails fast while offline rather
 * than queuing in the transport — a queued read would replay against the coordinator's default
 * project on a fresh socket and could replace the preview with another project's spec (PR #18
 * review round 4). The 30s poll simply retries once reconnected.
 */
export function fetchSpecFile(specId: string): Promise<any> {
  if (!isCoordinatorConnected()) return Promise.resolve({ ok: false, error: 'offline' });
  return liveRequest('spec.file', { specId });
}

/**
 * Approve the working draft: branch-guarded commit + status advance on the host (SPEC-006). A
 * governed write must NOT be queued in the reconnecting transport — a queued approval could replay
 * on a later reconnect and commit without a visible result (PR #18 review round 3). Refuse offline.
 */
export function approveDraftLive(specId: string, branch?: string): Promise<any> {
  if (!isCoordinatorConnected()) {
    return Promise.resolve({ ok: false, error: 'offline — reconnect to approve (approval is not queued)' });
  }
  return liveRequest('approveDraft', { specId, branch }, 30000);
}

/**
 * Convene the review panel on the current draft — passes a reference, never file content (SPEC-006).
 * Like approval, a governed action: refuse while offline rather than letting the transport queue and
 * replay it later with no visible response (PR #18 review round 4).
 */
export function convenePanelLive(specId: string, branch?: string): Promise<any> {
  if (!isCoordinatorConnected()) {
    return Promise.resolve({ ok: false, error: 'offline — reconnect to convene a review' });
  }
  return liveRequest('convenePanel', { specId, branch });
}

/**
 * Adjudicate a review issue (SPEC-007): accept (route to the spec author), dismiss, or send back.
 * A governed action like approve/convene — refused while offline rather than queued. Pass
 * `confirm: true` to override a stale-file warning when the reviewed section changed since the panel ran.
 */
export function adjudicateIssueLive(panelId: string, issueId: string, action: 'accepted' | 'dismissed' | 'sent-back', rationale?: string, confirm?: boolean): Promise<any> {
  if (!isCoordinatorConnected()) {
    return Promise.resolve({ ok: false, error: 'offline — reconnect to adjudicate' });
  }
  return liveRequest('adjudicateIssue', { panelId, issueId, action, rationale, confirm }, 30000);
}

export function stopLive(): void {
  transport?.dispose();
  transport = null;
  store.set({ connection: 'offline', live: false });
}

/** The outbound send path for steering / permission decisions (queued while reconnecting). */
export function liveSend(msg: unknown): void {
  transport?.send(msg);
}

// ---- session detail: rescue / steering / diff-gate (SPEC-011) ----
// All governed mutations: refused while offline (not queued), routed coordinator → adapter. Returns a
// CONSISTENT business-result shape `{ ok, ... }` in every case (offline, transport failure, or the
// coordinator's unwrapped result) so callers never have to special-case the WS frame vs the result.
const governed = async (op: string, args: unknown): Promise<any> => {
  if (!isCoordinatorConnected()) return { ok: false, error: "offline" };
  const res = await liveRequest(op, args, 30000);
  if (!res?.ok) return { ok: false, error: res?.error ?? "request failed" }; // transport-level failure
  return res.result ?? { ok: true }; // the coordinator's business result
};

/** Approve a session's diff so the coordinator may open its PR (idempotent server-side). */
export const approvePrLive = (sessionId: string) => governed("pr.approve", { sessionId });
/** Roll a session back to the checkpoint before `messageId` (needs the harness `revert` capability). */
export const revertSessionLive = (sessionId: string, messageId: string) => governed("revert", { sessionId, messageId });
/** Undo the most recent revert. */
export const unrevertSessionLive = (sessionId: string) => governed("unrevert", { sessionId });
/** Re-fetch the diff from the adapter and re-emit diff.finalized. */
export const refreshDiffLive = (sessionId: string) => governed("diff.refresh", { sessionId });
/** Answer an agent elicitation question (SPEC-012). */
export const elicitationReplyLive = (sessionId: string, questionId: string, answer: string) => governed("elicitation.reply", { sessionId, questionId, answer });
/** Decline an agent elicitation question (SPEC-012). */
export const elicitationRejectLive = (sessionId: string, questionId: string) => governed("elicitation.reject", { sessionId, questionId });
/** Trigger/regenerate the downstream-artefact proposal for a spec (SPEC-013). */
export const triggerGenerationLive = (specId: string) => governed("spec.generate", { specId });
/** Approve a generation proposal (optionally a subset + edits) — governed (SPEC-013). */
export const approveGenerationLive = (specId: string, proposalId: string, approvedArtifactIds?: string[], edits?: Array<{ id: string; content?: string; sorTarget?: string }>) =>
  governed("generation.approve", { specId, proposalId, approvedArtifactIds, edits });
/** Reject a generation proposal (SPEC-013). */
export const rejectGenerationLive = (specId: string, proposalId: string) => governed("generation.reject", { specId, proposalId });

/** Manual reconnect from the board's error state (SPEC-010): dispose any dead socket and start fresh. */
export function reconnectLive(): void {
  stopLive();
  startLive();
}

/** Promote a draft spec to in-review from the board (SPEC-010) — a governed coordinator command,
 *  refused while offline (not queued), exactly like approve/convene. */
export function promoteSpecLive(specId: string): Promise<any> {
  if (!isCoordinatorConnected()) return Promise.resolve({ ok: false, error: "offline — reconnect to promote" });
  return liveRequest("spec.promote", { specId }, 30000);
}
