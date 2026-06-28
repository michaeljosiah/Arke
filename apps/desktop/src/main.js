// Arke desktop shell — Electron main process (skeleton).
//
// Packaging plan (PRD §8.6, D16): because the coordinator is already a Node process, it
// runs inside Electron's main process with no extra runtime, and Electron serves the same
// React client the browser uses. The result is one signed app — nothing separate to
// install — which also gives IT a managed artifact to distribute. Tauri is the lighter
// alternative (Node coordinator as a sidecar) at the cost of a Rust dependency.
//
// This file documents the intended wiring; it is inert until `electron` is installed and
// the client build + coordinator entry are referenced. See apps/desktop/package.json.

// import { app, BrowserWindow } from "electron";
// import { startCoordinator } from "@arke/coordinator"; // embed in-process
//
// async function main() {
//   await startCoordinator();                 // WebSocket on 127.0.0.1
//   await app.whenReady();
//   const win = new BrowserWindow({ width: 1440, height: 900 });
//   win.loadFile("../../packages/client/dist/index.html"); // built client
// }
// main();

export {};
