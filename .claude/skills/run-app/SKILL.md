---
name: run-app
description: >-
  Launch and drive the Arke client (the React + Vite browser UI) to see a change
  working in the real app, not just tests. Use whenever asked to run, start, serve,
  or screenshot the app, or to confirm a UI change works end-to-end — board cards,
  the authoring cockpit, review panels, overlays (permission, drift), settings.
  Covers the exact install/launch quirks in this repo (dangling vite bin, blocked
  Electron binary) and how to drive the browser with Playwright and reach live-only
  screens without a running coordinator.
---

# Running the Arke app

Arke is an npm-workspace monorepo. The user-facing app is the **client**
(`packages/client`) — a React 19 + Vite SPA. It talks to a local **coordinator**
over a WebSocket (`ws://127.0.0.1:4319`) and renders real delivery state from that
stream; there is **no mock/demo fallback** (SPEC-003), so with no coordinator the
board is empty and the launch screen shows "Can't reach the coordinator". That is
expected — you can still drive every screen by injecting store state (see
[Reaching live-only screens](#reaching-live-only-screens)).

"Run the app" here means: start the Vite dev server, drive a headless Chromium
against it, and **look at the screenshot**. A blank frame is a failure to launch.

## 1. Install (once per fresh container)

Dependencies may be missing or the `vite` bin may be a **dangling symlink**
(`node_modules/.bin/vite -> ../vite/bin/vite.js` with no `vite` package). Install —
but the `electron` postinstall downloads a binary that the agent proxy **blocks with
403**, failing the whole install. Skip it (you only need the browser client, not the
desktop shell):

```bash
cd /home/user/Arke
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
```

Verify vite actually landed: `ls node_modules/vite/bin/vite.js`.

> Do **not** commit the resulting `package-lock.json` churn — skipping the Electron
> binary reshuffles `peer:` flags in the lockfile. Revert it: `git checkout
> package-lock.json`.

## 2. Launch the dev server

`npm run dev` **fails**: it runs `vite` from the workspace dir where the bin isn't on
PATH (`sh: 1: vite: not found`). Invoke the root-installed bin directly, pointed at
the client:

```bash
cd /home/user/Arke
nohup node_modules/.bin/vite --config packages/client/vite.config.ts \
  --host 127.0.0.1 --port 5173 packages/client > /tmp/vite-dev.log 2>&1 &
echo $! > /tmp/vite-dev.pid
# Poll the port — don't sleep. First compile is fast (~200ms) but be safe:
timeout 40 bash -c 'until curl -sf http://127.0.0.1:5173 >/dev/null 2>&1; do sleep 1; done' \
  && echo "SERVER UP" || { echo "NOT UP"; cat /tmp/vite-dev.log; }
```

Stop it before relaunching (or the next run hits `EADDRINUSE`):

```bash
kill $(cat /tmp/vite-dev.pid) 2>/dev/null || pkill -f vite
```

## 3. Drive it with Playwright

`chromium-cli` is **not** installed. Chromium **is** (Playwright browsers live at
`/opt/pw-browsers`), but the `playwright` npm module usually isn't. Install the
lightweight core somewhere outside the repo (keep it out of the workspace tree so it
doesn't perturb the lockfile) and drive with it:

```bash
cd "$SCRATCHPAD"   # e.g. your session scratchpad dir
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright-core
```

Chromium executable: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (the
`chromium-1194` version dir may bump — glob `/opt/pw-browsers/chromium-*/chrome-linux/chrome`
if the pinned path is gone). Launch with `--no-sandbox`.

A ready-to-copy driver skeleton is in
[`scripts/drive.mjs`](scripts/drive.mjs) — it navigates, waits out the splash,
optionally injects board state, screenshots, and prints non-WebSocket console
errors. It resolves `playwright-core` from the **current working directory** (ESM
bare imports otherwise resolve from the script's own location, and the script lives
in the repo while `playwright-core` lives in your scratchpad). So run it *from* the
dir where you installed `playwright-core`, pointing `OUT` at where screenshots
should land:

```bash
cd "$SCRATCHPAD"   # the dir with node_modules/playwright-core
OUT="$SCRATCHPAD" node /home/user/Arke/.claude/skills/run-app/scripts/drive.mjs
```

Edit the `INJECT` block in the script for what you're testing.

### Gotchas that recur

- **Splash screen.** The launch/splash animation holds for **2200ms** in the browser
  before `booting` flips and the picker renders. `waitForTimeout(2800)` after `goto`,
  or `wait-for` the element you need.
- **WebSocket errors are expected.** With no coordinator you'll see repeated
  `ws://127.0.0.1:4319 … ERR_CONNECTION_REFUSED`. Filter those out before judging
  success — `errors.filter(e => !/WebSocket|ERR_CONNECTION_REFUSED/.test(e))`.
- **React controlled inputs.** Use Playwright `fill`/`type`, never `el.value = …` —
  the latter doesn't fire React's onChange.

## Reaching live-only screens

The board, cockpit, session detail, and overlays only render with a coordinator
snapshot. To drive them without one, inject state into the **same store singleton**
the app uses. Vite serves the source module at `/src/store.ts`, so a dynamic
`import()` from the page returns that exact instance:

```js
await page.evaluate(async () => {
  const { store } = await import('/src/store.ts');
  store.set({
    project: { name: 'demo-project' },        // any truthy project leaves the picker
    view: 'board',                            // target screen key (see SCREENS in root.tsx)
    live: true,
    connectedProject: { projectId: 'demo', name: 'demo-project', path: '/demo', harness: 'OpenCode', endpoint: null },
    cards: [/* LiveCard shape from live.ts — one card per spec, keyed by specId */],
  });
});
```

`store.set(patch)` shallow-merges. Card shape lives in `packages/client/src/live.ts`
(`LiveCard`); column keys and the screen registry are in
`packages/client/src/root.tsx`. Conformance UI (SPEC-039) needs a card with
`status:'delivered'`, `conformanceState:'drifted'`, and a `conformanceResolutions`
array of `{ requirement, resolution }` (resolution `undefined` = unresolved). The
"delivered" column is the **rightmost** — scroll the board horizontally, or
screenshot after the drift panel opens (it overlays center-screen).

## One representative smoke

Launch → inject a delivered/drifted card → click its red "Drifted (N)" badge → the
drift panel opens with the violation list → screenshot. If the panel renders and
`console --errors` (minus WebSocket noise) is clean, the app is running.
