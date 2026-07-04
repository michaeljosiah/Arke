import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { startCoordinator, type RunningCoordinator } from "@arke/coordinator";
import { NotificationRouter, type RouterEvent } from "./notifications.js";

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

function buildMenu(): void {
  const send = (action: string) => win?.webContents.send("arke:menu", action);
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open project…", accelerator: "CmdOrCtrl+O", click: () => send("open-project") },
        { label: "New specification", accelerator: "CmdOrCtrl+N", click: () => send("new-spec") },
        { type: "separator" as const },
        process.platform === "darwin" ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => win?.webContents.reload() },
        // Dev-tools only in a non-packaged (development) build (SPEC-022).
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(coordinatorUrl: string): Promise<void> {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Injected into the sandboxed preload's process.argv, so the client reads the bound URL lazily.
      additionalArguments: [`--arke-coordinator-url=${coordinatorUrl}`],
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

async function applyUpdateAndRestart(): Promise<void> {
  quitting = true; // let the before-quit handler pass through to the updater's restart
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
  if (!app.isPackaged) return; // dev runs never self-update
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // we control the apply (defer while busy)
  autoUpdater.on("update-downloaded", () => { updateReady = true; void maybeApplyUpdate(); });
  autoUpdater.on("error", (err) => console.error("[arke] auto-update error:", err?.message ?? err));
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
