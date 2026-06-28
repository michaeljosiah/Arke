// SpecOne Orchestrator — Tweaks panel (bridged to the shared store).
(function () {
  const e = React.createElement;
  const use = window.SO_use;
  const store = window.SO_Store;
  const { TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakRow } = window;

  const ACCENTS = [
    { key: 'mono', label: 'Mono', swatch: 'linear-gradient(135deg,#171717 50%,#fafafa 50%)' },
    { key: 'indigo', label: 'Indigo', swatch: '#4F46E5' },
    { key: 'teal', label: 'Teal', swatch: '#0E7490' },
    { key: 'green', label: 'Green', swatch: '#15803D' },
    { key: 'amber', label: 'Amber', swatch: '#B45309' },
  ];

  function AccentSwatches() {
    const accent = use((s) => s.accent);
    return e(TweakRow, { label: 'Accent (re-skin)' },
      e('div', { style: { display: 'flex', gap: 6 } },
        ACCENTS.map((a) => e('button', { key: a.key, title: a.label, onClick: () => store.set({ accent: a.key }),
          style: { flex: 1, height: 26, borderRadius: 6, cursor: 'pointer', background: a.swatch, border: 'none', boxShadow: accent === a.key ? '0 0 0 2px rgba(0,0,0,.85)' : '0 0 0 .5px rgba(0,0,0,.2)' } }))));
  }

  function Tweaks() {
    const s = use();
    const set = (patch) => store.set(patch);
    const eng = window.SO_engine;
    return e(TweaksPanel, { title: 'Tweaks' },
      e(TweakSection, { label: 'Appearance' }),
      e(TweakRadio, { label: 'Theme', value: s.theme, options: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], onChange: (v) => set({ theme: v }) }),
      e(TweakRadio, { label: 'Density', value: s.density, options: [{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }], onChange: (v) => set({ density: v }) }),
      e(TweakRadio, { label: 'Window', value: s.chrome, options: [{ value: 'desktop', label: 'Desktop' }, { value: 'plain', label: 'Browser' }], onChange: (v) => set({ chrome: v }) }),
      e(AccentSwatches, null),
      e(TweakSection, { label: 'Governance' }),
      e(TweakRadio, { label: 'Runtime', value: s.runtimeMode, options: [{ value: 'supervised', label: 'Supervised' }, { value: 'full-access', label: 'Full access' }], onChange: (v) => set({ runtimeMode: v }) }),
      e(TweakToggle, { label: 'Live event stream', value: s.liveStream, onChange: (v) => set({ liveStream: v }) }),
      e(TweakSection, { label: 'Demo' }),
      e(TweakToggle, { label: 'Empty project (no data)', value: s.emptyDemo, onChange: (v) => eng.setEmpty(v) }),
    );
  }

  window.SO_Tweaks = Tweaks;
})();
