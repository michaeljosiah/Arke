import React from 'react';
import { store, useStore, engine } from './store';
import { startLive } from './live';
import { Shell } from './shell';
import { Picker, Initialisation, Library } from './screens/picker-init-library';
import { Cockpit } from './screens/cockpit';
import { Review, Generation } from './screens/review-generation';
import { Board, Session, DiffReview, PermissionOverlay } from './screens/board-session-diff-permission';
import { Audit, Projections, Agents, Notifications } from './screens/audit-projections-roster-notifications';
import { Harnesses, Settings } from './screens/harnesses-settings';
import { Integrations } from './screens/config';
import { LaunchScreen } from './screens/launch';
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
  integrations: Integrations,
  audit: Audit,
  notifications: Notifications,
  agents: Agents,
  harnesses: Harnesses,
  settings: Settings,
};

const CRUMBS: Record<string, string[]> = {
  library: ['Specifications'],
  cockpit: ['SPEC-014', 'Authoring cockpit'],
  review: ['SPEC-014', 'Review panel'],
  generation: ['SPEC-014', 'Generation'],
  board: ['Delivery board'],
  session: ['Delivery board', 'Session'],
  diff: ['Delivery board', 'Diff review'],
  projections: ['Record sync'],
  integrations: ['Integrations'],
  audit: ['Audit & activity'],
  notifications: ['Notifications'],
  agents: ['Agent roster'],
  harnesses: ['Harnesses & models'],
  settings: ['Settings'],
};

function ScreenContent({ view }: { view: string }) {
  const Comp = SCREENS[view];
  if (!Comp) {
    return e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' } }, `Unknown screen: ${view}`);
  }
  return e(Comp, null);
}

export function Root() {
  const s = useStore();
  const { view } = s;
  const [booting, setBooting] = React.useState(true);

  // Apply theme on change
  React.useEffect(() => { engine.applyTheme(); }, [s.theme, s.density, s.accent]);

  // Attempt a live coordinator link once on boot. If a coordinator is up, its snapshot
  // takes over the board (live mode); otherwise the app stays on mock data (SPEC-003).
  React.useEffect(() => { startLive(); }, []);

  // Start the live event engine once a project is open
  React.useEffect(() => {
    if (s.project) { engine.start(); } else { engine.stop(); }
    return () => engine.stop();
  }, [s.project]);

  const handleLaunchDone = React.useCallback(() => setBooting(false), []);

  // Show launch screen on first boot
  if (booting) {
    return e(LaunchScreen, { onDone: handleLaunchDone });
  }

  if (view === 'picker' || !s.project) {
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
  const crumbs = [s.project.name, ...(CRUMBS[view] || [view])];

  return e(React.Fragment, null,
    e(Shell, { crumbs },
      e(ScreenContent, { view }),
      e(PermissionOverlay, null)),
    e(Tweaks, null));
}
