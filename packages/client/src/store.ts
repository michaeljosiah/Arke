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
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- seed data ----------
const SPECS = [
  { specId: 'SPEC-016', slug: 'webhook-verify', fmt: 'md', title: 'Webhook signature verification', status: 'draft', owner: 'priya.n', tasks: 0, updated: 'authoring now', branch: 'spec/webhook-verify' },
  { specId: 'SPEC-014', slug: 'payment-retry', fmt: 'md', title: 'Payment retry with idempotency keys', status: 'in-review', owner: 'priya.n', tasks: 6, updated: '12m ago', branch: 'spec/payment-retry' },
  { specId: 'SPEC-013', slug: 'rate-limits', fmt: 'html', title: 'Tenant-scoped API rate limits', status: 'approved', owner: 'marco.f', tasks: 5, updated: '1h ago', branch: 'spec/rate-limits' },
  { specId: 'SPEC-012', slug: 'asset-tagging', fmt: 'md', title: 'Asset tagging taxonomy', status: 'merged', owner: 'priya.n', tasks: 4, updated: 'merged 2d ago', branch: 'spec/asset-tagging' },
  { specId: 'SPEC-011', slug: 'audit-export', fmt: 'html', title: 'Audit log CSV export', status: 'merged', owner: 'marco.f', tasks: 3, updated: 'merged 4d ago', branch: 'spec/audit-export' },
  { specId: 'SPEC-010', slug: 'sso-okta', fmt: 'md', title: 'SSO via Okta SAML', status: 'approved', owner: 'dana.k', tasks: 7, updated: '3h ago', branch: 'spec/sso-okta' },
];

const CARDS = [
  { id: 'SPEC-016', kind: 'spec', title: 'Webhook signature verification', col: 'authoring', status: 'running', harness: 'OpenCode', model: 'Opus', progress: 38, specId: 'SPEC-016' },
  { id: 'SPEC-014', kind: 'spec', title: 'Payment retry with idempotency keys', col: 'review', status: 'waiting', harness: 'OpenCode', model: 'Opus', progress: 100, specId: 'SPEC-014' },
  { id: 'T-3', kind: 'task', title: 'Add idempotency_key migration', col: 'implementing', status: 'running', harness: 'OpenCode', model: 'mid-tier', progress: 64, specId: 'SPEC-014' },
  { id: 'T-4', kind: 'task', title: 'Guard the retry handler', col: 'implementing', status: 'running', harness: 'Claude Code', model: 'Sonnet', progress: 27, specId: 'SPEC-014' },
  { id: 'T-5', kind: 'task', title: 'Backfill processed events', col: 'implementing', status: 'waiting', needsHuman: true, harness: 'Claude Code', model: 'Sonnet', progress: 80, specId: 'SPEC-014' },
  { id: 'T-2', kind: 'task', title: 'Idempotency key column + index', col: 'diff', status: 'done', harness: 'OpenCode', model: 'mid-tier', progress: 100, specId: 'SPEC-014', diff: { added: 84, removed: 12, files: 4 } },
  { id: 'T-9', kind: 'task', title: 'Rate-limit middleware', col: 'implementing', status: 'running', harness: 'OpenCode', model: 'mid-tier', progress: 51, specId: 'SPEC-013' },
  { id: 'SPEC-012', kind: 'spec', title: 'Asset tagging taxonomy', col: 'merged', status: 'done', harness: 'OpenCode', model: 'mid-tier', progress: 100, specId: 'SPEC-012' },
  { id: 'SPEC-011', kind: 'spec', title: 'Audit log CSV export', col: 'merged', status: 'done', harness: 'OpenCode', model: 'mid-tier', progress: 100, specId: 'SPEC-011' },
];

const EVENTS = [
  { id: uid('ev'), ts: now() - 8000, kind: 'session.busy', card: 'T-3', text: 'session.busy · T-3 · writing migration 0042_add_idempotency_key.sql' },
  { id: uid('ev'), ts: now() - 19000, kind: 'permission.requested', card: 'T-5', text: 'permission.requested · T-5 · gh pr create — awaiting human' },
  { id: uid('ev'), ts: now() - 32000, kind: 'diff.finalised', card: 'T-2', text: 'diff.finalised · T-2 · +84 −12 across 4 files' },
  { id: uid('ev'), ts: now() - 58000, kind: 'turn.quiescent', card: 'SPEC-016', text: 'turn.quiescent · SPEC-016 · Architect drafted data model' },
];

const AUDIT = [
  { id: uid('au'), ts: now() - 19000, actor: 'priya.n', kind: 'permission', text: 'Permission requested: open pull request (T-5)', detail: 'gh pr create', status: 'pending' },
  { id: uid('au'), ts: now() - 240000, actor: 'projection-plugin', kind: 'projection', text: 'Jira PAY-318 moved to In Progress', detail: 'trigger: todo.updated · deterministic', status: 'ok' },
  { id: uid('au'), ts: now() - 600000, actor: 'priya.n', kind: 'approval', text: 'Specification SPEC-014 approved & persisted', detail: 'docs/specifications/payment-retry.md', status: 'ok' },
  { id: uid('au'), ts: now() - 900000, actor: 'projection-plugin', kind: 'projection', text: 'Jira PAY-318 created from spec status: approved', detail: 'trigger: spec-status · deterministic', status: 'ok' },
  { id: uid('au'), ts: now() - 1400000, actor: 'marco.f', kind: 'approval', text: 'Reviewer approved generated change for SPEC-013', detail: 'PR #221', status: 'ok' },
];

const NOTIFS = [
  { id: uid('nt'), ts: now() - 19000, kind: 'permission', text: 'T-5 is waiting on you — open pull request', read: false, view: 'board' },
  { id: uid('nt'), ts: now() - 120000, kind: 'review', text: 'Review panel for SPEC-014 has 2 divergent findings', read: false, view: 'review' },
  { id: uid('nt'), ts: now() - 800000, kind: 'projection', text: 'Jira projection PAY-318 succeeded', read: true, view: 'projections' },
];

const PROJECTIONS = [
  { id: 'PAY-318', system: 'Jira', title: 'Payment retry with idempotency keys', state: 'In Progress', spec: 'SPEC-014', health: 'ok', last: '4m ago' },
  { id: 'PAY-319', system: 'Jira', title: 'Add idempotency_key migration', state: 'In Progress', spec: 'SPEC-014', health: 'ok', last: '4m ago' },
  { id: 'RL-204', system: 'Jira', title: 'Tenant-scoped API rate limits', state: 'To Do', spec: 'SPEC-013', health: 'ok', last: '1h ago' },
  { id: '4821', system: 'Azure DevOps', title: 'SSO via Okta SAML', state: 'Active', spec: 'SPEC-010', health: 'warn', last: 'retrying · 2 attempts' },
  { id: 'TAG-77', system: 'Jira', title: 'Asset tagging taxonomy', state: 'Done', spec: 'SPEC-012', health: 'ok', last: '2d ago' },
];

const AGENTS = [
  { id: 'product-owner', role: 'Product Owner', icon: 'fileText', tier: 'frontier', model: 'Opus', writes: 'requirements', path: '.opencode/agents/product-owner.md', perms: ['read', 'spec.write'] },
  { id: 'technical-architect', role: 'Technical Architect', icon: 'layers', tier: 'frontier', model: 'Opus', writes: 'design', path: '.opencode/agents/technical-architect.md', perms: ['read', 'spec.write'] },
  { id: 'engineering', role: 'Engineering', icon: 'code', tier: 'frontier', model: 'Opus', writes: 'tasks', path: '.opencode/agents/engineering.md', perms: ['read', 'spec.write'] },
  { id: 'implementation', role: 'Implementation', icon: 'terminal', tier: 'standard', model: 'Sonnet', writes: 'code', path: '.opencode/agents/implementation.md', perms: ['read', 'edit', 'bash', 'gh'] },
  { id: 'reviewer-a', role: 'Reviewer · panel', icon: 'eye', tier: 'frontier', model: 'Opus', writes: 'critique', path: '.opencode/agents/reviewer.md', perms: ['read'] },
];

const HARNESSES = [
  { id: 'opencode', name: 'OpenCode', endpoint: 'opencode://localhost:4096', status: 'connected', caps: ['events', 'todos', 'diff', 'permissions', 'commands'], models: ['Opus', 'Sonnet', 'mid-tier', 'GPT-5.5'], primary: true },
  { id: 'claude-code', name: 'Claude Code', endpoint: 'acp://localhost:7223', status: 'connected', caps: ['events', 'diff'], models: ['Opus', 'Sonnet'], primary: false },
  { id: 'codex', name: 'Codex', endpoint: '— not connected', status: 'idle', caps: [], models: ['GPT-5.5'], primary: false },
];

const INTEGRATIONS = [
  { id: 'github', name: 'GitHub', icon: 'gitGraph', status: 'connected', wiring: 'agent-side', mechanism: 'gh CLI · GitHub MCP', account: 'acme · 4 repositories', enables: ['Branch & commit in-session', 'Open pull request (gated)'], host: 'authorised on host · token never leaves it', required: 'generation · pull requests' },
  { id: 'jira', name: 'Jira', icon: 'package', status: 'connected', wiring: 'projection-side', mechanism: 'Jira MCP', account: 'acme.atlassian.net · PAY board', enables: ['Create story from spec status', 'Move story on status change'], host: 'authorised on host · token never leaves it', required: 'projection of tickets' },
  { id: 'azure', name: 'Azure DevOps', icon: 'layers', status: 'partial', wiring: 'both', mechanism: 'az CLI · Azure DevOps MCP', account: 'dev.azure.com/acme', enables: ['Repos (agent-side)', 'Work items (projection)'], host: 'work-items scope needs re-auth on host', required: 'projection of work items' },
  { id: 'gitlab', name: 'GitLab', icon: 'gitGraph', status: 'disconnected', wiring: '—', mechanism: 'glab CLI · GitLab MCP', account: '—', enables: ['Branch, commit, open merge request'], host: 'not connected', required: 'optional' },
];

const TIERS = [
  { tier: 'frontier', label: 'Frontier tier', model: 'claude-opus-4', note: 'authoring & review' },
  { tier: 'standard', label: 'Standard tier', model: 'claude-sonnet-4', note: 'implementation' },
  { tier: 'fast', label: 'Fast tier', model: 'claude-haiku-4', note: 'routine, classification & projection drafts' },
];

export const store = createStore({
  project: null,
  view: 'picker',
  activeSpec: 'SPEC-014',
  activeCard: null,
  specs: SPECS,
  cards: CARDS,
  events: EVENTS,
  audit: AUDIT,
  notifs: NOTIFS,
  projections: PROJECTIONS,
  agents: AGENTS,
  harnesses: HARNESSES,
  integrations: INTEGRATIONS,
  tiers: TIERS,
  permission: null,
  entryFolder: null,
  theme: 'light',
  density: 'comfortable',
  runtimeMode: 'supervised',
  accent: 'mono',
  liveStream: true,
  chrome: 'desktop',
  emptyDemo: false,
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

const COL_ORDER = ['authoring', 'review', 'implementing', 'diff', 'merged'];

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

// ---------- the live engine ----------
let timer: ReturnType<typeof setInterval> | null = null;
function tick() {
  const s = store.get();
  if (!s.liveStream || !s.project) return;
  if (s.permission && s.runtimeMode === 'supervised') return;

  const running = s.cards.filter((c) => c.status === 'running' && (c.col === 'authoring' || c.col === 'implementing'));
  if (running.length === 0) return;
  const card = pick(running);
  const step = 6 + Math.floor(Math.random() * 14);
  let np = Math.min(100, (card.progress || 0) + step);

  if (card.col === 'implementing' && card.progress < 90 && np >= 90 && Math.random() < 0.5 && !card.needsHuman) {
    if (s.runtimeMode === 'supervised') {
      raisePermission(card, 'open pull request', 'gh pr create --fill --base main');
      return;
    } else {
      logAudit({ actor: 'projection-plugin', kind: 'permission', text: 'Auto-approved (full access): open pull request (' + card.id + ')', detail: 'gh pr create', status: 'ok' });
    }
  }

  patchCard(card.id, { progress: np });

  if (np >= 100) {
    if (card.col === 'authoring') {
      moveCard(card.id, 'review', { status: 'waiting', progress: 100 });
      logEvent('spec.authored', card.id, 'turn.quiescent · ' + card.id + ' · specification drafted, ready for review');
      logAudit({ actor: card.id, kind: 'spec', text: card.id + ' moved to review', detail: 'authoring complete', status: 'ok' });
      notify('review', card.id + ' is ready for a review panel', 'review');
    } else if (card.col === 'implementing') {
      const diff = { added: 30 + Math.floor(Math.random() * 120), removed: Math.floor(Math.random() * 40), files: 1 + Math.floor(Math.random() * 6) };
      moveCard(card.id, 'diff', { status: 'done', progress: 100, needsHuman: false, diff });
      logEvent('diff.finalised', card.id, 'diff.finalised · ' + card.id + ' · +' + diff.added + ' −' + diff.removed + ' across ' + diff.files + ' files');
      logAudit({ actor: card.id, kind: 'session', text: card.id + ' produced a diff for review', detail: '+' + diff.added + ' −' + diff.removed, status: 'ok' });
      notify('diff', card.id + ' produced a diff — review the change', 'board');
    }
  } else {
    const phrases = {
      implementing: ['editing source', 'running typecheck', 'running checks', 'writing tests', 'reading repo context'],
      authoring: ['drafting acceptance criteria', 'grounding in source', 'updating data model', 'refining tasks'],
    };
    logEvent('session.busy', card.id, 'session.busy · ' + card.id + ' · ' + pick(phrases[card.col]) + ' (' + np + '%)');
  }
}

function start() { if (!timer) timer = setInterval(tick, 2600); }
function stop() { if (timer) { clearInterval(timer); timer = null; } }

function acceptDiff(id) {
  const s = store.get();
  const card = s.cards.find((c) => c.id === id);
  moveCard(id, 'merged', { status: 'done' });
  logEvent('pr.merged', id, 'pr.merged · ' + id + ' · squash-merged into main');
  logAudit({ actor: 'marco.f', kind: 'approval', text: 'Reviewer approved & merged ' + id, detail: card ? card.title : '', status: 'ok' });
  notify('merge', id + ' merged into main', 'board');
}

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

const SEED = { specs: SPECS, cards: CARDS, events: EVENTS, audit: AUDIT, notifs: NOTIFS, projections: PROJECTIONS };
function setEmpty(on) {
  if (on) {
    store.set({ emptyDemo: true, permission: null, specs: [], cards: [], events: [], audit: [], notifs: [], projections: [], view: 'library' });
    stop();
  } else {
    store.set({ emptyDemo: false, specs: SEED.specs, cards: SEED.cards, events: SEED.events, audit: SEED.audit, notifs: SEED.notifs, projections: SEED.projections });
    start();
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

export const engine = { start, stop, tick, raisePermission, resolvePermission, acceptDiff, logEvent, logAudit, notify, markNotifsRead, moveCard, patchCard, applyTheme, setEmpty, COL_ORDER };
