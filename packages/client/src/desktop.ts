import { store } from './store';
import { openProjectLive } from './live';

// Browser-safe Electron-shell glue (SPEC-022). Everything here no-ops when `window.arke` is absent
// (a plain browser), so it ships in the single client build without a desktop-specific fork.

interface ArkeBridge {
  openProjectDialog?: () => Promise<string | null>;
  onMenu?: (cb: (action: string) => void) => void;
  notify?: (event: unknown) => void;
}

function bridge(): ArkeBridge | undefined {
  return (globalThis as { arke?: ArkeBridge }).arke;
}

/**
 * Wire the native application-menu actions + notification-click navigation to the store (SPEC-022).
 * Call once on boot. In a browser (no `window.arke`) this returns immediately.
 */
export function initDesktopBridge(): void {
  const b = bridge();
  if (!b?.onMenu) return;
  b.onMenu(async (action: string) => {
    if (action.startsWith('navigate:')) {
      // From a notification click — focus the relevant screen.
      store.set({ view: action.slice('navigate:'.length) });
      return;
    }
    if (action === 'open-project') {
      const path = await b.openProjectDialog?.();
      if (path) await openProjectLive({ path }); // the coordinator canonicalises/validates the path
      return;
    }
    if (action === 'new-spec') {
      // The library screen hosts the New-specification affordance.
      store.set({ view: 'library' });
    }
  });
}
