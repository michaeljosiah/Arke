import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, nativeTheme, protocol, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { startCoordinator, type RunningCoordinator } from "@arke/coordinator";
import { NotificationRouter, type RouterEvent } from "./notifications.js";

// The client's theme store has no persistence yet (SPEC-022) — every boot starts in its hardcoded
// default, 'light' (packages/client/src/store.ts). Match that here so the titlebar/background never
// mismatch the very first paint; the renderer syncs arke:native-theme on mount and on every toggle
// (packages/client/src/root.tsx), so this only needs to be right for the instant before that fires.
nativeTheme.themeSource = "light";

// Arke desktop shell — Electron main process (SPEC-022). Embeds the coordinator IN-PROCESS on a neutral
// userData root (no managed harness / no `.arke/` under the app bundle until a real project opens),
// renders the built @arke/client over a first-party `app://` protocol, and bridges only a narrow set of
// native affordances. All real operations flow over the WebSocket to the coordinator (NFR-1/7).

const CLIENT_SCHEME = "app";
const router = new NotificationRouter();
let coordinator: RunningCoordinator | undefined;
let attached = false; // true when pointed at an external coordinator (we don't stop it)
let win: BrowserWindow | undefined;

/** Where the built client lives: bundled under resources when packaged, else the workspace `dist`. */
function clientDistDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "client")
    : join(__dirname, "..", "..", "..", "packages", "client", "dist");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// A strict CSP (SPEC-022): only first-party `app:` assets + `data:` (inline SVG/fonts), inline styles
// (the client uses element-level React styles), and a WebSocket/HTTP connection to the LOCAL coordinator.
const CSP =
  "default-src 'self' app:; " +
  "script-src 'self' app:; " +
  "style-src 'self' app: 'unsafe-inline'; " +
  "font-src 'self' app: data:; " +
  "img-src 'self' app: data:; " +
  "connect-src 'self' app: ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*";

/** Serve the built client from `dist` over `app://`, confined to that dir, index.html for the app root. */
function registerClientProtocol(): void {
  const root = clientDistDir();
  protocol.handle(CLIENT_SCHEME, async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const filePath = normalize(join(root, rel));
    // Confine to the client dist — never serve a file outside it via a crafted `..` path.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return new Response("forbidden", { status: 403 });
    }
    const ext = filePath.slice(filePath.lastIndexOf("."));
    const isHtml = ext === ".html";
    try {
      const data = await readFile(filePath);
      const headers: Record<string, string> = { "content-type": MIME[ext] ?? "application/octet-stream" };
      if (isHtml) headers["Content-Security-Policy"] = CSP;
      return new Response(data, { headers });
    } catch {
      // The client is store-routed (no URL routes), but fall back to index.html so a stray deep path
      // still loads the app rather than 404ing.
      const data = await readFile(join(root, "index.html"));
      return new Response(data, { headers: { "content-type": "text/html; charset=utf-8", "Content-Security-Policy": CSP } });
    }
  });
}

/** Start (or attach to) the coordinator and return its ws:// URL (SPEC-022). */
async function ensureCoordinator(): Promise<string> {
  const external = process.env.ARKE_COORDINATOR_URL;
  if (external) {
    attached = true; // an external coordinator (e.g. `arke up`) — we connect but never stop it
    return external;
  }
  coordinator = await startCoordinator({
    root: app.getPath("userData"), // neutral default-context root — no harness, no stray .arke/
    manageHarness: true, // real projects opened at runtime get their managed harness (SPEC-016)
  });
  return coordinator.url;
}

let opencodeWarm: ChildProcess | undefined;

/**
 * Pre-warm the opencode harness at launch (SPEC-022 follow-up). Spawns `opencode serve` in the
 * background so, by the time the user opens a project, the binary/runtime is hot AND a MISSING install
 * is surfaced here (not on first project open). Non-blocking — the window + loading screen show
 * immediately while this warms in the background. Never fatal: a missing binary or a port already in use
 * just logs (the client's harness-reachability gate then guides the user). Owned by the desktop and
 * killed on quit; skipped in attach mode (an external coordinator already owns opencode).
 */
function startOpencodeWarm(): void {
  if (attached || opencodeWarm) return;
  try {
    // `shell: true` so Windows resolves the `opencode.cmd` shim on PATH (mirrors the coordinator's own
    // harness spawn). Serves the neutral userData root; ignore its stdio — the client sees the harness
    // over the coordinator, not this process.
    opencodeWarm = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {
      cwd: app.getPath("userData"),
      stdio: "ignore",
      shell: true,
      windowsHide: true,
    });
    opencodeWarm.on("error", (err) => console.error("[arke] could not start opencode (is it installed?):", err.message));
    opencodeWarm.on("exit", () => { opencodeWarm = undefined; });
  } catch (err) {
    console.error("[arke] opencode warm-start failed:", err instanceof Error ? err.message : err);
  }
}

function stopOpencodeWarm(): void {
  try {
    opencodeWarm?.kill();
  } catch {
    /* already gone */
  }
  opencodeWarm = undefined;
}

function buildMenu(): void {
  // A deliberately minimal menu (no File / View / Window clutter). Project actions live in the app's own
  // UI, not a native menu. macOS REQUIRES an application menu for Quit + the standard Edit shortcuts
  // (copy / paste / select-all), so it keeps a lean [App, Edit]; Windows/Linux get no menu bar at all in
  // production. Developer builds add a small View menu (reload + devtools) for ergonomics.
  const dev = !app.isPackaged;
  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: "View",
    submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
  };
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, ...(dev ? [viewMenu] : [])]),
    );
    return;
  }
  Menu.setApplicationMenu(dev ? Menu.buildFromTemplate([viewMenu]) : null);
}

/** The Arke window/taskbar icon: bundled at `resources/icon.png` when packaged, else the build source. */
function windowIcon(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(__dirname, "..", "build-resources", "icon.png");
}

async function createWindow(coordinatorUrl: string): Promise<void> {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    icon: windowIcon(), // macOS uses the app-bundle icon; Windows/Linux use this
    // Matches the client's default (light) theme so the window chrome never flashes the wrong
    // color during load; root.tsx re-syncs both if the renderer ends up in a different theme.
    backgroundColor: "#FFFFFF",
    // On Windows: hide the native titlebar and paint the window control buttons (close/min/max)
    // with an overlay that matches the app's background — fixes the white-titlebar-in-dark-mode
    // issue (and the mirror case: a dark titlebar under light-theme content). The renderer adds
    // -webkit-app-region:drag to its TopBar so the window is still draggable; height=56 matches
    // the TopBar height declared in shell.tsx.
    ...(process.platform === "win32" && {
      titleBarStyle: "hidden" as const,
      titleBarOverlay: {
        color: "#FFFFFF",       // var(--background) light
        symbolColor: "#525252", // var(--neutral-600)
        height: 56,             // TopBar height
      },
    }),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Injected into the sandboxed preload's process.argv, so the client reads these lazily (the
      // coordinator URL + the app version shown in Settings › About).
      additionalArguments: [
        `--arke-coordinator-url=${coordinatorUrl}`,
        `--arke-app-version=${app.getVersion()}`,
        `--arke-platform=${process.platform}`,
      ],
    },
  });
  // Deny any attempt to open external/remote content in a new window (NFR-5).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) void shell.openExternal(url); // hand real links to the OS browser
    return { action: "deny" };
  });
  win.once("ready-to-show", () => win?.show());
  await win.loadURL(`${CLIENT_SCHEME}://arke/index.html`);
}

/** Wire the native affordances (SPEC-022): folder dialog, notifications, work-in-flight quit gate. */
function wireIpc(): void {
  // Sync native titlebar overlay colour when the in-app theme toggle fires.
  ipcMain.on("arke:native-theme", (_e, theme: "dark" | "light") => {
    nativeTheme.themeSource = theme;
    if (process.platform === "win32" && win) {
      win.setTitleBarOverlay({
        color: theme === "dark" ? "#0A0A0A" : "#FFFFFF",
        symbolColor: theme === "dark" ? "#A1A1A1" : "#525252",
      });
    }
  });

  ipcMain.handle("arke:open-project-dialog", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.on("arke:notify", (_e, event: RouterEvent) => {
    const n = router.onEvent(event);
    if (!n || !Notification.isSupported()) return;
    const toast = new Notification({ title: n.title, body: n.body });
    toast.on("click", () => {
      win?.show();
      win?.focus();
      win?.webContents.send("arke:menu", `navigate:${n.view}`);
    });
    toast.show();
  });

  // Settings › About: report the last known update state, run a manual check, and apply a ready update.
  ipcMain.handle("arke:update-status", () => lastUpdate);
  ipcMain.handle("arke:update-check", async () => {
    if (!app.isPackaged) return (lastUpdate = { state: "dev" }); // no feed in a dev run
    manualCheck = true; // this check came from About — let its button, not the native modal, be the surface
    broadcastUpdate({ state: "checking" });
    try {
      await autoUpdater.checkForUpdates(); // the events above drive the real state transitions
    } catch (err) {
      manualCheck = false;
      broadcastUpdate({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return lastUpdate;
  });
  ipcMain.handle("arke:update-restart", async () => {
    if (lastUpdate.state !== "downloaded") return lastUpdate; // nothing staged to apply
    // Applying tears down the embedded coordinator + managed harness, so honour the SAME work-in-flight
    // gate the native auto-apply path enforces (maybeApplyUpdate / gracefulQuit) — the About button must
    // not interrupt a running task/review/decision without the same warning.
    if (workInFlight()) {
      const { response } = await dialog.showMessageBox(win!, {
        type: "warning",
        buttons: ["Restart anyway", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: "Arke has work in flight",
        detail: "A task or review is still running, or a decision is waiting. Restart to update anyway?",
      });
      if (response === 1) return lastUpdate; // cancelled — leave the staged update in place
    }
    await applyUpdateAndRestart(); // drains the coordinator + harness, then quitAndInstall
    return { state: "downloaded" } as UpdateStatus;
  });
}

/** Whether any embedded-coordinator work is in flight (attached mode can't be interrupted by our quit). */
function workInFlight(): boolean {
  try {
    return !attached && !!coordinator && coordinator.workInFlight();
  } catch {
    return true; // fail-safe: if we can't answer, treat as busy (SPEC-022)
  }
}

// ---- auto-update (SPEC-022, electron-updater) ----------------------------------
// An update may DOWNLOAD in the background any time, but applying it restarts the app — which tears
// down the embedded coordinator + managed harness — so in managed mode the APPLY is deferred until no
// work is in flight (attach mode is exempt: the external coordinator survives the restart). Signatures
// are verified by electron-updater before an update is ever offered.
let updateReady = false;
let updatePrompting = false;

// The last known updater state, mirrored to the renderer so Settings › About can show it and drive a
// manual "Check for updates". Never carries anything sensitive — just a coarse lifecycle state.
export interface UpdateStatus {
  state: "idle" | "dev" | "checking" | "available" | "downloading" | "downloaded" | "none" | "error";
  version?: string;
  percent?: number;
  message?: string;
}
let lastUpdate: UpdateStatus = { state: "idle" };
// True while a check that the user kicked off from Settings › About is in flight. If it results in a
// download, the About "Restart to update" button is the surface — we suppress the native modal so a single
// user intent isn't answered by two overlapping prompts. Cleared when the check concludes.
let manualCheck = false;

function broadcastUpdate(s: UpdateStatus): void {
  lastUpdate = s;
  win?.webContents.send("arke:update", s);
}

async function applyUpdateAndRestart(): Promise<void> {
  quitting = true; // let the before-quit handler pass through to the updater's restart
  stopOpencodeWarm();
  try {
    if (!attached) await coordinator?.stop(); // drain the trace + stop the harness first (SPEC-015)
  } finally {
    autoUpdater.quitAndInstall(false, true);
  }
}

async function maybeApplyUpdate(): Promise<void> {
  if (!updateReady || updatePrompting || !win) return;
  if (workInFlight()) return; // defer: re-checked on the interval / when work finishes
  updatePrompting = true;
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    buttons: ["Restart & update", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: "A new version of Arke is ready",
    detail: "Restart to apply the update. Your work is saved.",
  });
  updatePrompting = false;
  if (response === 0) await applyUpdateAndRestart();
}

function setupAutoUpdate(): void {
  if (!app.isPackaged) { lastUpdate = { state: "dev" }; return; } // dev runs never self-update
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // we control the apply (defer while busy)
  autoUpdater.on("checking-for-update", () => broadcastUpdate({ state: "checking" }));
  autoUpdater.on("update-available", (info) => broadcastUpdate({ state: "available", version: info?.version }));
  autoUpdater.on("update-not-available", () => { manualCheck = false; broadcastUpdate({ state: "none" }); });
  autoUpdater.on("download-progress", (p) => broadcastUpdate({ state: "downloading", percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on("update-downloaded", (info) => {
    updateReady = true;
    broadcastUpdate({ state: "downloaded", version: info?.version });
    // A background download prompts natively; one the user kicked off from About does NOT — the About
    // "Restart to update" button is already the surface. The 60s interval still re-offers it later if
    // it's left unapplied, so a manually-surfaced update is never silently forgotten.
    const fromAbout = manualCheck;
    manualCheck = false;
    if (!fromAbout) void maybeApplyUpdate();
  });
  autoUpdater.on("error", (err) => { manualCheck = false; broadcastUpdate({ state: "error", message: err?.message ?? String(err) }); });
  void autoUpdater.checkForUpdates().catch(() => undefined);
  // Catch an update that was deferred while busy: prompt once work goes quiescent.
  const timer = setInterval(() => void maybeApplyUpdate(), 60_000);
  timer.unref?.();
}

let quitting = false;
async function gracefulQuit(): Promise<void> {
  if (quitting) return;
  if (workInFlight()) {
    const { response } = await dialog.showMessageBox(win!, {
      type: "warning",
      buttons: ["Quit anyway", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Arke has work in flight",
      detail: "A task or review is still running, or a decision is waiting. Quit anyway?",
    });
    if (response === 1) return; // cancelled
  }
  quitting = true;
  stopOpencodeWarm(); // kill the pre-warmed harness we started
  try {
    if (!attached) await coordinator?.stop(); // transitive Trace.drain + harness stop (SPEC-015)
  } finally {
    app.exit(0);
  }
}

async function main(): Promise<void> {
  // Single-instance: a second launch focuses the existing window rather than starting a second app.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  // `app://` must be privileged (standard + secure) BEFORE ready so fetch/ESM/relative assets behave.
  protocol.registerSchemesAsPrivileged([
    { scheme: CLIENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  await app.whenReady();
  registerClientProtocol();
  wireIpc();
  buildMenu();

  let coordinatorUrl: string;
  try {
    coordinatorUrl = await ensureCoordinator();
  } catch (err) {
    dialog.showErrorBox("Arke could not start", `The coordinator failed to start:\n\n${err instanceof Error ? err.message : String(err)}`);
    app.exit(1);
    return;
  }
  await createWindow(coordinatorUrl);
  // Pre-warm opencode in the background NOW (the window + loading screen are already up), so it starts
  // during the launch loading screen without blocking the UI (SPEC-022 follow-up).
  startOpencodeWarm();
  setupAutoUpdate();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && coordinatorUrl) void createWindow(coordinatorUrl);
  });
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    void gracefulQuit();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") void gracefulQuit();
  });
}

void main();
