import React from 'react';
import { store, useStore, engine } from './store';
import { Shell } from './shell';
import { Picker, Initialisation, Library } from './screens/picker-init-library';
import { Cockpit } from './screens/cockpit';
import { Review, Generation } from './screens/review-generation';
import { Board, Session, DiffReview, PermissionOverlay } from './screens/board-session-diff-permission';
import { Audit, Projections, Agents, Notifications } from './screens/audit-projections-roster-notifications';
import { Harnesses, Settings } from './screens/harnesses-settings';
import { Tweaks } from './tweaks';

const e = React.createElement;

const SCREENS: Record<string, React.ComponentType<any>> = {
  library: Library,
  cockpit: Cockpit,
  review: Review,
  generation: Generation,
  board: Board,
  session: Session,
  diff: DiffReview,
  projections: Projections,
  audit: Audit,
  notifications: Notifications,
  agents: Agents,
  harnesses: Harnesses,
  settings: Settings,
};

const CRUMBS: Record<string, string[]> = {
  library: ['Library'],
  cockpit: ['Author', 'Cockpit'],
  review: ['Author', 'Review'],
  generation: ['Author', 'Generation'],
  board: ['Execute', 'Board'],
  session: ['Execute', 'Session'],
  diff: ['Execute', 'Diff'],
  projections: ['Observe', 'Projections'],
  audit: ['Observe', 'Audit'],
  notifications: ['Observe', 'Notifications'],
  agents: ['System', 'Agents'],
  harnesses: ['System', 'Harnesses'],
  settings: ['System', 'Settings'],
};

function ScreenContent({ view }: { view: string }) {
  const Comp = SCREENS[view];
  if (!Comp) {
    return e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' } }, `Unknown screen: ${view}`);
  }
  return e(Comp, null);
}

export function Root() {
  const { view, pendingPermission } = useStore();

  // Start the live event engine on mount
  React.useEffect(() => {
    engine.start();
    return () => engine.stop();
  }, []);

  if (view === 'picker') {
    return e(React.Fragment, null,
      e(Picker, null),
      e(Tweaks, null));
  }

  if (view === 'init') {
    return e(React.Fragment, null,
      e(Initialisation, null),
      e(Tweaks, null));
  }

  // Shell view — all navigable screens
  const crumbs = CRUMBS[view] ?? [];

  return e(React.Fragment, null,
    e(Shell, { crumbs },
      e(ScreenContent, { view })),
    pendingPermission ? e(PermissionOverlay, null) : null,
    e(Tweaks, null));
}
