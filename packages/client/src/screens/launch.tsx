// Arke — launch/splash screen (ported from "Arke Launch Screen Light.html")
// Light design by default; honours .dark on <html>.
import React from 'react';
import '../styles/launch.css';

const e = React.createElement;

export function LaunchScreen({ onDone }: { onDone: () => void }) {
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // In the desktop shell the loading screen is held for at least 5s while opencode pre-warms in the
  // background (SPEC-022); a plain browser keeps the shorter splash. Browser-safe: `window.arke` is only
  // present inside Electron.
  const desktop = typeof window !== 'undefined' && !!(window as unknown as { arke?: unknown }).arke;

  React.useEffect(() => {
    const delay = desktop ? 5000 : reduced ? 0 : 2200;
    const t = setTimeout(onDone, delay);
    return () => clearTimeout(t);
  }, [onDone, reduced, desktop]);

  return e('div', { className: 'arke-launch-stage', 'data-screen-label': 'Arke launch screen' },
    e('div', { className: 'arke-launch-grid' }),
    e('div', { className: 'arke-launch-glow' }),
    e('div', { className: 'arke-launch-scan' }),
    e('div', { className: 'arke-launch-noise' }),

    e('div', { className: 'arke-launch-content' },
      e('div', { className: 'arke-launch-wordmark' },
        e('span', { className: 'arke-launch-slashes' }, '//'),
        e('span', { className: 'arke-launch-name' },
          e('span', null, 'A'),
          e('span', null, 'r'),
          e('span', null, 'k'),
          e('span', null, 'e'),
        ),
        e('span', { className: 'arke-launch-sweep' }),
      ),
      e('div', { className: 'arke-launch-rule' }),
      e('div', { className: 'arke-launch-tag' }, 'Specification orchestrator'),
    ),

    e('div', { className: 'arke-launch-probe' },
      e('span', { className: 'arke-launch-dot' }),
      e('span', null, 'probing harness'),
      e('span', { className: 'arke-launch-ell' }),
    ),
    e('div', { className: 'arke-launch-bar' }),

    e('div', { className: 'arke-launch-vignette' }),
  );
}
