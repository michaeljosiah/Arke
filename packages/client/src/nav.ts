import { store } from './store';

/**
 * SPEC-023/025: open a folded card's session detail. A specification card folds N sessions, so pick the
 * target — the sole session directly (diff view when it's `done`/in the diff column, else session view),
 * or a picker when there is more than one. A card with no session opens the session-detail placeholder.
 *
 * Shared by the delivery board and the Overview's repository panel so multi-session navigation behaves
 * identically in both (SPEC-025) rather than each screen inventing its own rule.
 */
export function openCard(c: any): void {
  const ss = c.sessions || [];
  if (ss.length > 1) {
    store.set({ sessionPicker: { specId: c.id, title: c.title, col: c.col, sessions: ss } });
    return;
  }
  const sole = ss[0];
  store.set({ activeCard: c.id, activeSession: sole?.sessionId ?? null, view: c.col === 'diff' ? 'diff' : 'session' });
}

/**
 * SPEC-025: open the card for a specification id (used by the repository panel's rows, which are keyed on
 * specId). Falls back to the delivery board when no card exists for the spec yet.
 */
export function openSpec(specId: string): void {
  const card = (store.get() as any).cards?.find((c: any) => c.specId === specId || c.id === specId);
  if (card) openCard(card);
  else store.set({ view: 'board' });
}

/**
 * SPEC-025: route a just-opened project into the shell. A `method-ready` project lands on the Overview
 * dashboard; anything not yet ready routes to the scaffold (`init`) screen (which, on completion, routes
 * to the cockpit — unchanged). Shared by the picker, recents, clone/create, and the desktop menu bridge
 * so every open path lands consistently rather than each site reinventing the destination.
 */
export function routeOpenedProject(name: string, state: string | null): void {
  store.set({ project: { name, specs: 0 }, entryPath: '.', view: state === 'method-ready' ? 'dashboard' : 'init' });
}
