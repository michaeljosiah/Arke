// SpecOne Orchestrator — root router: shell + screen routing + overlays + tweaks.
(function () {
  const e = React.createElement;
  const use = window.SO_use;
  const store = window.SO_Store;
  const eng = window.SO_engine;
  const Shell = window.SO_Shell;

  const SCREENS = {
    library: () => window.SO_Library,
    cockpit: () => window.SO_Cockpit,
    review: () => window.SO_Review,
    generation: () => window.SO_Generation,
    board: () => window.SO_Board,
    session: () => window.SO_Session,
    diff: () => window.SO_Diff,
    projections: () => window.SO_Projections,
    integrations: () => window.SO_Integrations,
    audit: () => window.SO_Audit,
    notifications: () => window.SO_Notifications,
    agents: () => window.SO_Agents,
    harnesses: () => window.SO_Harnesses,
    settings: () => window.SO_Settings,
  };

  const CRUMBS = {
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

  function Root() {
    const s = use();
    const hasProject = !!s.project;

    React.useEffect(() => { eng.applyTheme(); }, [s.theme, s.density, s.accent]);
    React.useEffect(() => { if (hasProject) eng.start(); else eng.stop(); }, [hasProject]);

    const Tweaks = window.SO_Tweaks;

    // pre-shell setup flows
    if (s.view === 'init') {
      return e(React.Fragment, null,
        e('div', { style: { height: '100%', background: 'var(--background)', display: 'flex', flexDirection: 'column' } },
          e('div', { style: { flex: 1, minHeight: 0 } }, e(window.SO_Init, { key: s.entryFolder ? s.entryFolder.path : 'new' }))),
        e(Tweaks, null));
    }
    if (s.view === 'picker' || !hasProject) {
      return e(React.Fragment, null, e(window.SO_Picker, null), e(Tweaks, null));
    }

    const Screen = (SCREENS[s.view] && SCREENS[s.view]()) || window.SO_Library;
    const crumbs = [s.project.name, ...(CRUMBS[s.view] || [s.view])];

    return e(React.Fragment, null,
      e(Shell, { crumbs }, e(Screen, null), e(window.SO_PermissionOverlay, null)),
      e(Tweaks, null));
  }

  window.SO_Root = Root;
})();
