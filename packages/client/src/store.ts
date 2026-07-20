import React from 'react';

// ---------- tiny pub/sub store ----------
function createStore(initial) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = (typeof patch === 'function') ? patch(state) : patch;
      state = { ...state, ...p };
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
  };
}

let UID = 100;
const uid = (p?) => (p || 'id') + '-' + (++UID);
const now = () => Date.now();


export const store = createStore({
  project: null,
  view: 'picker',
  activeSpec: null,
  activeCard: null,
  // SPEC-023: a card folds N sessions; `activeSession` is the chosen session for detail/diff, and
  // `sessionPicker` holds the disambiguation overlay when a card has more than one session.
  activeSession: null,
  sessionPicker: null,
  specs: [],
  cards: [],
  events: [],
  audit: [],
  notifs: [],
  projections: [],
  // SPEC-025: live repository identity + per-spec git/PR status for the Overview's Repository panel,
  // folded from repo.identity/repo.status events and seeded by the connection snapshot.
  repo: null,
  gitBranches: [],
  agents: [],
  harnesses: [],
  integrations: [],
  // Host-optional governance assurance level (SPEC-024): { level, hostConfigured }, filled from the
  // coordinator's governance.status. In the offline demo, show the host-less 'solo' baseline.
  governance: null,
  tiers: [],
  // Roster resolution table (role → instance → tier label) from the live registry (SPEC-005).
  roster: [],
  // Registry config/health warnings from the live registry projection (SPEC-005).
  registryWarnings: [],
  // Authoring cockpit transient state (SPEC-006): outbound queue depth + a reconnect/queue notice.
  cockpit: { queued: 0, notice: null },
  // Live multi-model review panel (SPEC-007): the current panel projection, and the set of specIds
  // that have a completed review (the cockpit approval gate reads this).
  panel: null,
  reviewedSpecs: [],
  // Pending agent elicitation (SPEC-011): a structured question overlay for the active session.
  elicitation: null,
  // Live generation proposal (SPEC-013): the agent's pre-write artefacts awaiting review.
  generation: null,
  permission: null,
  // SPEC-039: conformance drift panel overlay for delivered specs.
  driftPanel: null,
  entryFolder: null,
  theme: 'light',
  density: 'comfortable',
  runtimeMode: 'supervised',
  // SPEC-033: the default brand accent is teal (#0E7490 via ACCENT_HEX), applied by applyTheme to
  // --primary/--ring. Surfaces, text and the neutral --accent hover token stay monochrome; 'mono'
  // restores the near-black primary. Selectable in the tweaks panel.
  accent: 'teal',
  liveStream: true,
  // SPEC-030: per-project auto-PR preference — when true, the implementer opens the PR itself on
  // delivery; when false (default), delivery stops at the human diff-review gate. Seeded from the
  // coordinator snapshot's `delivery` block and flipped via the Settings toggle (delivery.configure).
  autoOpenPr: false,
  // Live coordinator link (SPEC-003). `connection` mirrors the transport state machine;
  // `live` flips true once a snapshot arrives, at which point the mock engine stands down.
  connection: 'offline',
  // Consecutive failed (re)connect attempts to the coordinator; a sustained count means the
  // coordinator itself is unreachable (crashed / not started), distinct from the harness being down.
  connectionAttempts: 0,
  live: false,
  // The single project the connected coordinator serves (SPEC-004). Null until a snapshot arrives.
  // The coordinator is single-project; there is no multi-project list.
  connectedProject: null,
  // The coordinator-relative path the initialisation screen should scaffold. Defaults to the
  // project root ('.'); the clone flow sets it to the cloned subdirectory so scaffolding targets
  // the freshly cloned repo, not the coordinator root.
  entryPath: '.',
  // Durable recents from the coordinator (SPEC-018 project.list). Real projects, most-recent-first.
  recents: [],
  // Onboarding state (SPEC-004), folded from the coordinator snapshot + events. Defaults assume a
  // reachable harness so the mock-only prototype shows the picker directly.
  harnessReachable: true,
  harnessReachabilityReason: null,
  harnessReachabilityPartial: false,
  // SPEC-019: whether ANY harness is configured (globally or per-project). Defaults true so the
  // mock-only prototype shows the picker directly; a live snapshot with `configured: false` flips
  // the launch screen to first-run quick setup.
  harnessSetup: { configured: true },
  harnessConnecting: false,
  harnessConnectError: null,
  // Host-agent catalog for the launch screen (SPEC-019 follow-up): per-agent installed/running,
  // detected host-wide (NOT project-scoped). null until the first harness.hostAgents response.
  hostAgents: null,
  projectState: null,
  missingSentinels: [],
  tierDefaults: null,
  scaffold: null,
});

// ---------- helpers to mutate ----------
function logEvent(kind, card, text) {
  store.set((s) => ({ events: [{ id: uid('ev'), ts: now(), kind, card, text }, ...s.events].slice(0, 60) }));
}
function logAudit(entry) {
  store.set((s) => ({ audit: [{ id: uid('au'), ts: now(), status: 'ok', ...entry }, ...s.audit].slice(0, 80) }));
}
function notify(kind, text, view) {
  store.set((s) => ({ notifs: [{ id: uid('nt'), ts: now(), kind, text, read: false, view }, ...s.notifs].slice(0, 40) }));
}
function markNotifsRead() {
  store.set((s) => ({ notifs: s.notifs.map((n) => ({ ...n, read: true })) }));
}

const COL_ORDER = ['authoring', 'review', 'implementing', 'diff', 'delivered'];

function moveCard(id, col, patch) {
  store.set((s) => ({ cards: s.cards.map((c) => c.id === id ? { ...c, col, ...patch } : c) }));
}
function patchCard(id, patch) {
  store.set((s) => ({ cards: s.cards.map((c) => c.id === id ? { ...c, ...patch } : c) }));
}

function raisePermission(card, action, command) {
  const req = { id: uid('pm'), cardId: card.id, cardTitle: card.title, action, command, harness: card.harness, ts: now() };
  store.set({ permission: req });
  patchCard(card.id, { needsHuman: true, status: 'waiting' });
  logEvent('permission.requested', card.id, 'permission.requested · ' + card.id + ' · ' + command + ' — awaiting human');
  logAudit({ actor: store.get().project ? 'priya.n' : 'system', kind: 'permission', text: 'Permission requested: ' + action + ' (' + card.id + ')', detail: command, status: 'pending' });
  notify('permission', card.id + ' is waiting on you — ' + action, 'board');
}

function resolvePermission(approved) {
  const s = store.get();
  const req = s.permission;
  if (!req) return;
  store.set({ permission: null });
  const card = s.cards.find((c) => c.id === req.cardId);
  logAudit({ actor: 'priya.n', kind: 'permission', text: (approved ? 'Approved' : 'Denied') + ': ' + req.action + ' (' + req.cardId + ')', detail: req.command, status: approved ? 'ok' : 'denied' });
  if (approved) {
    patchCard(req.cardId, { needsHuman: false, status: 'running', progress: Math.max(85, (card && card.progress) || 85) });
    logEvent('permission.granted', req.cardId, 'permission.granted · ' + req.cardId + ' · ' + req.command);
  } else {
    patchCard(req.cardId, { needsHuman: true, status: 'waiting' });
    logEvent('permission.denied', req.cardId, 'permission.denied · ' + req.cardId + ' · ' + req.command);
  }
}


function acceptDiff(id) {
  const s = store.get();
  const card = s.cards.find((c) => c.id === id);
  moveCard(id, 'delivered', { status: 'done' });
  logEvent('pr.merged', id, 'pr.merged · ' + id + ' · squash-merged into main');
  logAudit({ actor: 'marco.f', kind: 'approval', text: 'Reviewer approved & merged ' + id, detail: card ? card.title : '', status: 'ok' });
  notify('merge', id + ' merged into main', 'board');
}

function openDriftPanel(cardId) {
  const s = store.get();
  const card = s.cards.find((c) => c.id === cardId);
  if (!card) return;
  const unresolved = (card.conformanceResolutions || []).filter((r) => !r.resolution);
  if (unresolved.length === 0) return;
  store.set({ driftPanel: { cardId, card } });
}

function closeDriftPanel() {
  store.set({ driftPanel: null });
}

// SPEC-033: brand-accent hexes applied to --primary/--ring. `teal` (#0E7490) is the default; it
// clears WCAG AA in both themes (≈5.1:1 white-on-teal for text; ≈3.7:1 teal-on-#0A0A0A for the
// component/focus ring in dark), so a separate dark-theme teal is not needed. `mono` = no override
// (near-black primary from the tokens).
const ACCENT_HEX = { mono: null, indigo: '#4F46E5', teal: '#0E7490', green: '#15803D', amber: '#B45309' };
function applyTheme() {
  const s = store.get();
  const root = document.documentElement;
  root.classList.toggle('dark', s.theme === 'dark');
  root.setAttribute('data-density', s.density);
  root.setAttribute('data-accent', s.accent);
  const hex = ACCENT_HEX[s.accent];
  if (hex) {
    root.style.setProperty('--primary', hex);
    root.style.setProperty('--primary-foreground', '#FAFAFA');
    root.style.setProperty('--ring', hex);
  } else {
    root.style.removeProperty('--primary');
    root.style.removeProperty('--primary-foreground');
    root.style.removeProperty('--ring');
  }
}


// ---------- React hook ----------
export function useStore(selector?) {
  const [, force] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    const unsubscribe = store.subscribe(force);
    return () => {
      unsubscribe();
    };
  }, []);
  const s = store.get();
  return selector ? selector(s) : s;
}

export const engine = { raisePermission, resolvePermission, acceptDiff, openDriftPanel, closeDriftPanel, logEvent, logAudit, notify, markNotifsRead, moveCard, patchCard, applyTheme, COL_ORDER };
