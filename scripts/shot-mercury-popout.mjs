// Phase 5 smoke test: open the Mercury chat/file popout and drive its display
// path by injecting main→renderer events (no real Mercury needed). Verifies the
// window renders, reflects TNC/ARQ state, shows RX chat, and enables the
// composer only inside a session. Run: node scripts/shot-mercury-popout.mjs
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as fs from 'node:fs';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const OUT = path.join(APP_DIR, 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

const UD = path.join(OUT, 'ud-mercury-popout');
fs.rmSync(UD, { recursive: true, force: true });
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({
  remotePort: 7399, firstRun: false, grid: 'FN20jb', myCallsign: 'K3SBP',
  enablePota: false, enableRbn: false, enablePskrMap: false, watchlist: '',
  enableMercury: true, mercuryPath: path.join(UD, 'nope-mercury'), mercuryBw: 2300,
}, null, 2));

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

const app = await electron.launch({
  executablePath: bin,
  args: ['--no-sandbox', path.join(APP_DIR, 'scripts', 'mercury-phase1-entry.js')],
  cwd: APP_DIR, env: { ...process.env, POTACAT_TEST_UD: UD }, timeout: 60_000,
});

let main = null;
for (let i = 0; i < 40 && !main; i++) { main = app.windows().find((w) => w.url().includes('index.html')) || null; if (!main) await new Promise((r) => setTimeout(r, 500)); }
if (!main) { console.log('NO MAIN WINDOW'); await app.close(); process.exit(1); }
await main.waitForLoadState('domcontentloaded').catch(() => {});
await new Promise((r) => setTimeout(r, 3500));

await main.evaluate(() => window.api.mercuryPopoutOpen());
let pop = null;
for (let i = 0; i < 30 && !pop; i++) { pop = app.windows().find((w) => w.url().includes('mercury-popout.html')) || null; if (!pop) await new Promise((r) => setTimeout(r, 400)); }
if (!pop) { console.log('NO POPOUT'); await app.close(); process.exit(1); }
await pop.waitForLoadState('domcontentloaded').catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

// Helper: push an event into the popout window from the MAIN process.
async function inject(channel, payload) {
  await app.evaluate(({ BrowserWindow }, { channel, payload }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('mercury-popout.html'));
    if (w) w.webContents.send(channel, payload);
  }, { channel, payload });
  await new Promise((r) => setTimeout(r, 150));
}
const read = () => pop.evaluate(() => ({
  mycall: document.getElementById('mq-mycall').textContent,
  state: document.getElementById('mq-state').textContent,
  connectDisabled: document.getElementById('mq-connect').disabled,
  txDisabled: document.getElementById('mq-tx').disabled,
  sendDisabled: document.getElementById('mq-send').disabled,
  transcript: document.getElementById('mq-transcript').textContent,
  ptt: document.getElementById('mq-ptt').textContent,
}));

// 1. Initial render — my call from settings; no binary → offline; composer locked.
let s = await read();
check('mycall shown from settings', s.mycall === 'K3SBP', s.mycall);
check('state offline when modem not running', s.state === 'offline', s.state);
check('composer disabled when offline', s.txDisabled && s.sendDisabled);
await pop.screenshot({ path: path.join(OUT, 'mercury-popout-offline.png') });

// 2. Modem reachable (TNC connected) → idle, Connect enabled, still no session.
await inject('mercury-status', { connected: true, host: '127.0.0.1', port: 8300 });
s = await read();
check('state idle when TNC connected', s.state === 'idle', s.state);
check('Connect enabled when idle', s.connectDisabled === false);
check('composer still locked (no ARQ session)', s.txDisabled);

// 3. ARQ session established → connected, composer unlocked, banner in transcript.
await inject('mercury-session', { state: 'connected', source: 'K3SBP', dest: 'W4MPT', bandwidth: 2300 });
s = await read();
check('state connected on ARQ session', s.state === 'connected', s.state);
check('composer unlocked in session', !s.txDisabled && !s.sendDisabled);
check('transcript shows the connect banner', /Connected: K3SBP/.test(s.transcript), s.transcript.slice(-80));

// 4. Inbound chat + PTT indicator.
await inject('mercury-chat', { dir: 'rx', who: 'W4MPT', text: 'hello from the bunker' });
await inject('mercury-link', { ptt: true });
s = await read();
check('RX chat appears in transcript', /W4MPT.*hello from the bunker/s.test(s.transcript), s.transcript.slice(-80));
check('PTT indicator flips to TX', s.ptt === 'TX', s.ptt);
await pop.screenshot({ path: path.join(OUT, 'mercury-popout-session.png') });

// 5. Compose + Send clears the box (proves doSend ran while connected).
await pop.evaluate(() => { document.getElementById('mq-tx').value = 'roger 73'; });
await pop.click('#mq-send');
const cleared = await pop.evaluate(() => document.getElementById('mq-tx').value);
check('Send clears the composer', cleared === '', JSON.stringify(cleared));

// 6. Session ends → composer re-locks.
await inject('mercury-session', { state: 'disconnected' });
s = await read();
check('composer re-locks after link ends', s.txDisabled, 'state=' + s.state);

await app.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
