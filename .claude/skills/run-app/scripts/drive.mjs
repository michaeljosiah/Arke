// Drive the Arke client in headless Chromium. Prereqs (see ../SKILL.md):
//   - Vite dev server up on 127.0.0.1:5173
//   - playwright-core installed where node can resolve it from CWD:
//       cd <dir-with-node_modules> && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright-core
// Run from that same dir:  OUT=<screenshot-dir> node /path/to/this/drive.mjs
// (This script may live in the repo while playwright-core lives elsewhere — a bare
//  `import` would resolve from the script's location, so we resolve from CWD instead.)
import { createRequire } from 'node:module';
import { globSync } from 'node:fs';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('playwright-core');

// Resolve the Chromium binary — the version dir bumps over time, so glob for it.
const EXEC =
  globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome').sort().pop() ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL = 'http://127.0.0.1:5173';
const OUT = process.env.OUT || '.'; // where screenshots land

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2800); // wait out the 2200ms splash

// ---- INJECT: state to reach live-only screens without a coordinator (edit me) ----
await page.evaluate(async () => {
  const { store } = await import('/src/store.ts');
  const mk = (id, title, cs, res) => ({
    id, specId: id, title, col: 'delivered', status: 'delivered',
    harness: 'OpenCode', model: 'claude-opus-4-8', needsHuman: false, progress: 100,
    sessions: [], conformanceState: cs, conformanceResolutions: res,
  });
  store.set({
    project: { name: 'demo-project' },
    view: 'board',
    live: true,
    connectedProject: { projectId: 'demo', name: 'demo-project', path: '/demo', harness: 'OpenCode', endpoint: null },
    cards: [
      mk('payment-handler-v2', 'Payment Handler v2', 'drifted', [
        { requirement: 'file src/payments/handler.ts must exist', resolution: undefined, evidence: [{ file: 'src/payments/handler.ts', line: 1 }] },
        { requirement: 'function processPayment must be defined', resolution: undefined },
      ]),
      mk('auth-service', 'Auth Service', 'conformant', []),
    ],
  });
});
await page.waitForTimeout(500);
// ---- /INJECT ----

await page.screenshot({ path: `${OUT}/board.png` });

// Example interaction: open the drift panel via the board badge.
const drifted = page.locator('button', { hasText: 'Drifted' }).first();
if (await drifted.count()) {
  await drifted.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/drift-panel.png` });
}

await browser.close();

const real = errors.filter((e) => !/WebSocket|ERR_CONNECTION_REFUSED/.test(e));
console.log('=== non-WebSocket console/page errors ===');
console.log(real.length ? real.join('\n') : '(none)');
