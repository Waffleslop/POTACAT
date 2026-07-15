// Verifies the Mercury Settings section: the fieldset renders with all controls,
// and enabling + filling it and clicking Save persists the keys to the profile
// settings file (and reveals the "Mercury HF Data" menu item). No rig needed.
// Run: node scripts/shot-mercury-settings.mjs
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as fs from 'node:fs';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const OUT = path.join(APP_DIR, 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

const UD = path.join(OUT, 'ud-mercury-settings');
fs.rmSync(UD, { recursive: true, force: true });
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({
  remotePort: 7399, firstRun: false, grid: 'FN20jb', myCallsign: 'K3SBP',
  enablePota: false, enableRbn: false, enablePskrMap: false, watchlist: '',
}, null, 2));

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
const readEffective = () => {
  const g = JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf8'));
  const p = path.join(UD, 'profiles', 'K3SBP', 'settings.json');
  return fs.existsSync(p) ? { ...g, ...JSON.parse(fs.readFileSync(p, 'utf8')) } : g;
};

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

// Open Settings and confirm the Mercury section exists with its controls.
await main.evaluate(() => document.getElementById('settings-btn')?.click());
await new Promise((r) => setTimeout(r, 800));
const controls = await main.evaluate(() => ['set-mercury-enable', 'set-mercury-path', 'mercury-path-browse', 'set-mercury-sound', 'set-mercury-in', 'set-mercury-out', 'set-mercury-bw', 'set-mercury-txgain', 'set-mercury-listen'].map((id) => !!document.getElementById(id)));
check('all Mercury settings controls present', controls.every(Boolean), controls.join(','));

// Install instructions + clickable (data-external) download link are present.
const install = await main.evaluate(() => {
  const cfg = document.getElementById('mercury-config');
  const txt = cfg ? cfg.textContent : '';
  const link = cfg ? cfg.querySelector('a[data-external][href*="Rhizomatica/mercury"]') : null;
  return { hasWin: /Windows:/.test(txt), hasLinux: /Linux:/.test(txt), hasCliNote: /mercury\.exe/.test(txt), link: link ? link.href : null };
});
check('install instructions cover Windows + Linux + the CLI binary', install.hasWin && install.hasLinux && install.hasCliNote);
check('download link is a clickable external link to the Mercury releases', !!install.link && /Rhizomatica\/mercury\/releases/.test(install.link), install.link);

// Sub-panel hidden until Enable is checked; reveals on check.
let hiddenBefore = await main.evaluate(() => document.getElementById('mercury-config').classList.contains('hidden'));
check('config sub-panel hidden while disabled', hiddenBefore === true);

// Fill the form and Save.
await main.evaluate(() => {
  document.getElementById('set-mercury-enable').checked = true;
  document.getElementById('set-mercury-enable').dispatchEvent(new Event('change'));
  document.getElementById('set-mercury-path').value = 'C:\\Mercury\\mercury.exe';
  document.getElementById('set-mercury-sound').value = 'wasapi';
  document.getElementById('set-mercury-in').value = 'DAX Audio RX 1';
  document.getElementById('set-mercury-out').value = 'DAX Audio TX';
  document.getElementById('set-mercury-bw').value = '500';
  document.getElementById('set-mercury-txgain').value = '-4.5';
  document.getElementById('set-mercury-listen').checked = true;
});
const revealed = await main.evaluate(() => !document.getElementById('mercury-config').classList.contains('hidden'));
check('sub-panel reveals when Enable is checked', revealed === true);

await main.evaluate(() => document.getElementById('settings-save')?.click());
await new Promise((r) => setTimeout(r, 1500));

const saved = readEffective();
check('enableMercury persisted', saved.enableMercury === true);
check('mercuryPath persisted', saved.mercuryPath === 'C:\\Mercury\\mercury.exe', saved.mercuryPath);
check('mercurySoundSystem persisted', saved.mercurySoundSystem === 'wasapi', saved.mercurySoundSystem);
check('input/output devices persisted', saved.mercuryInputDevice === 'DAX Audio RX 1' && saved.mercuryOutputDevice === 'DAX Audio TX');
check('bandwidth persisted (number)', saved.mercuryBw === 500, String(saved.mercuryBw));
check('tx gain persisted', saved.mercuryTxGainDb === -4.5, String(saved.mercuryTxGainDb));
check('listen persisted', saved.mercuryListen === true);

// The "Mercury HF Data" menu item should now be revealed.
const btnVisible = await main.evaluate(() => { const b = document.getElementById('view-mercury-btn'); return b ? !b.classList.contains('hidden') : false; });
check('Mercury menu item shown after enabling', btnVisible === true);

await app.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
