import { store, engine } from './store';
import { ArkeTransport, type TransportState } from './transport';

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
  const ts = ev.ts || Date.now();
  switch (ev.type) {
    case 'spec.status': {
      specStatus.set(ev.specId, ev.status);
      const c = ensureCard(ev.specId, ev.specId, 'spec');
      c.col = deriveColumn(c, ev.status);
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
          running: ev.status === 'running' ? true : (s.scaffold?.running ?? true),
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
    harnessReachable: snap?.harnessReachable ?? true,
    harnessReachabilityReason: snap?.harnessReachabilityReason ?? null,
    harnessReachabilityPartial: snap?.harnessReachabilityPartial ?? false,
    projectState: snap?.projectState ?? null,
    missingSentinels: snap?.missingSentinels ?? [],
    tierDefaults: snap?.tierDefaults ?? null,
  });
  engine.stop();
}

function onFrame(frame: any) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'snapshot' && Array.isArray(frame.cards)) applySnapshot(frame);
  else if (frame.type === 'event' && frame.event) applyEvent(frame.event);
  else if (frame.type === 'folder.inspected') {
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
  transport.subscribe((state: TransportState) => store.set({ connection: state }));
  return transport;
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
