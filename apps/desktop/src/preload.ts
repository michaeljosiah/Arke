import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// The narrow, enumerated native bridge (SPEC-022) — nothing here returns a credential or an arbitrary
// host capability. This is the ONLY surface the sandboxed renderer can reach the main process through;
// all real operations still flow over the WebSocket to the coordinator.

/** Read a `--key=value` argument main passes via `webPreferences.additionalArguments` (available in the
 *  sandboxed preload's `process.argv` before the renderer's client code runs). */
function argValue(prefix: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : undefined;
}

const arke = {
  /** The coordinator's actual bound `ws://` URL (possibly ephemeral) — the client reads this lazily. */
  coordinator: { url: argValue("--arke-coordinator-url=") ?? "" },
  /** The running app version (from the desktop package.json) shown in Settings › About. */
  app: { version: argValue("--arke-app-version=") ?? "" },
  /** The host platform string (`"win32"` | `"darwin"` | `"linux"`); used by the renderer to adjust layout. */
  platform: argValue("--arke-platform=") ?? "",
  /** Tell the main process to sync the native titlebar/overlay colour with the app's current theme. */
  setNativeTheme: (theme: "dark" | "light"): void => ipcRenderer.send("arke:native-theme", theme),
  /** Open a native folder dialog; resolves to the picked absolute path, or null if cancelled. */
  openProjectDialog: (): Promise<string | null> => ipcRenderer.invoke("arke:open-project-dialog"),
  /** Forward a normalised domain event to main's NotificationRouter (which de-dups + shows OS toasts). */
  notify: (event: unknown): void => ipcRenderer.send("arke:notify", event),
  /** Subscribe to application-menu actions (Open project…, New specification, Reload). */
  onMenu: (cb: (action: string) => void): void => {
    ipcRenderer.on("arke:menu", (_e, action: string) => cb(action));
  },
  /** electron-updater surface for Settings › About: current state, a manual check, and apply-and-restart.
   *  Nothing here downloads or applies without user intent beyond the automatic background check. */
  updates: {
    status: (): Promise<unknown> => ipcRenderer.invoke("arke:update-status"),
    check: (): Promise<unknown> => ipcRenderer.invoke("arke:update-check"),
    restart: (): Promise<unknown> => ipcRenderer.invoke("arke:update-restart"),
    /** Subscribe to update-state pushes; returns an unsubscribe so the renderer can remove the listener
     *  on unmount (the Settings screen mounts/unmounts on navigation — without this, listeners stack). */
    onStatus: (cb: (s: unknown) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, s: unknown) => cb(s);
      ipcRenderer.on("arke:update", handler);
      return () => ipcRenderer.removeListener("arke:update", handler);
    },
  },
};

contextBridge.exposeInMainWorld("arke", arke);

export type ArkeBridge = typeof arke;
