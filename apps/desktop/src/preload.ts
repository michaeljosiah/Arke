import { contextBridge, ipcRenderer } from "electron";

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
  /** Open a native folder dialog; resolves to the picked absolute path, or null if cancelled. */
  openProjectDialog: (): Promise<string | null> => ipcRenderer.invoke("arke:open-project-dialog"),
  /** Forward a normalised domain event to main's NotificationRouter (which de-dups + shows OS toasts). */
  notify: (event: unknown): void => ipcRenderer.send("arke:notify", event),
  /** Subscribe to application-menu actions (Open project…, New specification, Reload). */
  onMenu: (cb: (action: string) => void): void => {
    ipcRenderer.on("arke:menu", (_e, action: string) => cb(action));
  },
};

contextBridge.exposeInMainWorld("arke", arke);

export type ArkeBridge = typeof arke;
