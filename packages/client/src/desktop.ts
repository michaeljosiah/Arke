import { store } from './store';
import { openProjectLive } from './live';
import { routeOpenedProject } from './nav';

// Browser-safe Electron-shell glue (SPEC-022). Everything here no-ops when `window.arke` is absent
// (a plain browser), so it ships in the single client build without a desktop-specific fork.

export interface DesktopUpdateStatus {
  state: 'idle' | 'dev' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error';
  version?: string;
  percent?: number;
  message?: string;
}

interface ArkeBridge {
  openProjectDialog?: () => Promise<string | null>;
  onMenu?: (cb: (action: string) => void) => void;
  notify?: (event: unknown) => void;
  app?: { version?: string };
  updates?: {
    status: () => Promise<DesktopUpdateStatus>;
    check: () => Promise<DesktopUpdateStatus>;
    restart: () => Promise<DesktopUpdateStatus>;
    /** Returns an unsubscribe function so callers can remove the listener on unmount. */
    onStatus: (cb: (s: DesktopUpdateStatus) => void) => () => void;
  };
}

function bridge(): ArkeBridge | undefined {
  return (globalThis as { arke?: ArkeBridge }).arke;
}

/** True inside the Electron shell (the native bridge is present); false in a plain browser. */
export function isDesktop(): boolean {
  return !!bridge();
}

/** The running desktop app version, or undefined in a browser. */
export function desktopVersion(): string | undefined {
  return bridge()?.app?.version || undefined;
}

/** The electron-updater surface (Settings › About), or undefined in a browser / when unavailable. */
export function desktopUpdates(): ArkeBridge['updates'] | undefined {
  return bridge()?.updates;
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
      if (path) {
        // The coordinator canonicalises/validates the path; route into the project on success (SPEC-025)
        // so the native "Open project…" menu lands on the Overview like the in-app picker does.
        const res: any = await openProjectLive({ path });
        if (res?.ok) routeOpenedProject(res.result.name, res.result.state);
      }
      return;
    }
    if (action === 'new-spec') {
      // The library screen hosts the New-specification affordance.
      store.set({ view: 'library' });
    }
  });
}
