// Small desktop UX items (2026-09-18):
//   - Hunt in activator mode shows the spots TABLE, not whichever exclusive
//     view (SWL/HF Nets, RBN, DXCC, Contests) was open before (Casey).
//   - QSO-logged chime: optional sound on every logged QSO, from every log
//     path, off by default (N2FSM).
// Renderer code cannot be require()'d; these are source-text guards.
// Run: node test/desktop-ux-test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const app = R('renderer/app.js'), html = R('renderer/index.html'), main = R('main.js'), preload = R('preload.js');

test('Hunt: an exclusive view is switched to the table before the split opens; map is left alone', () => {
  const fn = app.slice(app.indexOf('function applyActivatorSpotsLayout'), app.indexOf('function applyActivatorSpotsLayout') + 700);
  assert.ok(/if \(currentView !== 'table' && currentView !== 'map'\) setView\('table'\);/.test(fn));
  assert.ok(fn.indexOf("setView('table')") < fn.indexOf("classList.add('activator-spots-on')"), 'view fixed before the layout is applied');
});

test('chime: main emits qso-logged from saveQsoRecord, the one log choke point', () => {
  const fn = main.slice(main.indexOf('async function saveQsoRecord'), main.indexOf('async function saveQsoRecord') + 20000);
  assert.ok(/win\.webContents\.send\("qso-logged", \{ callsign: qsoData\.callsign, band: qsoData\.band, mode: qsoData\.mode \}\);/.test(fn));
  assert.strictEqual((main.match(/send\("qso-logged"/g) || []).length, 1, 'exactly one emitter');
  assert.ok(/onQsoLogged: \(cb\) => ipcRenderer\.on\('qso-logged'/.test(preload));
});

test('chime: off by default, four synthesized flavours, persisted as settings.qsoChime, Test button', () => {
  assert.ok(/let qsoChime = 'off';/.test(app));
  assert.ok(/qsoChime = settings\.qsoChime \|\| 'off';/.test(app), 'loaded with the other settings');
  assert.ok(/qsoChime: setQsoChime \? setQsoChime\.value : 'off',/.test(app), 'saved with the other settings');
  assert.ok(/window\.api\.onQsoLogged\(\(\) => \{ try \{ playQsoChime\(qsoChime\); \} catch \{\} \}\)/.test(app));
  for (const k of ["case 'soft':", "case 'twotone':", "case 'bell':", "case 'morse-r':"]) assert.ok(app.includes(k), k);
  assert.ok(/id="set-qso-chime"/.test(html) && /id="set-qso-chime-test"/.test(html));
  assert.ok(/<option value="off">Off<\/option>/.test(html.slice(html.indexOf('id="set-qso-chime"'), html.indexOf('id="set-qso-chime"') + 300)), 'Off is the first option');
  assert.ok(!/new Audio\(/.test(app.slice(app.indexOf('function playQsoChime'), app.indexOf('function playQsoChime') + 1500)), 'synthesized, no audio asset');
});


// K3SBP 2026-09-23: the Propagation view showed "14m" under every receiver
// three hours after the last transmission. Ages are text painted at render
// time and the view only re-rendered when NEW spots arrived, so once
// PSKReporter had nothing new it froze — and spots long past the max-age
// filter stayed on the map. Both surfaces tick while showing.
test('Propagation: main-window view re-renders on a clock, not only on new spots', () => {
  assert.ok(/setInterval\(tickRbnAges, 30000\)/.test(app), 'no age tick in the main window');
  const fn = app.slice(app.indexOf('function tickRbnAges'), app.indexOf('function tickRbnAges') + 900);
  assert.ok(/currentView === 'rbn' \|\| activatorRbnVisible/.test(fn), 'the tick must be gated on the view showing');
  assert.ok(/renderRbnTable\(\)/.test(fn), 'the table (the "seen" column) must re-render');
  assert.ok(/popupOpen/.test(fn) && /renderRbnMarkers\(\)/.test(fn), 'markers re-render unless an open popup would be torn down for nothing');
});

test('Propagation: the pop-out ticks the same way', () => {
  const pp = R('renderer/prop-popout.js');
  assert.ok(/setInterval\(tickAges, 30000\)/.test(pp), 'no age tick in the pop-out');
  const fn = pp.slice(pp.indexOf('function tickAges'), pp.indexOf('function tickAges') + 600);
  assert.ok(/renderTable\(\)/.test(fn) && /renderMarkers\(\)/.test(fn));
});

test('Propagation: main prunes a day-old PSKReporter report instead of keeping it for the session', () => {
  const at = main.indexOf("pskrMap.on('pollDone'");
  const body = main.slice(at, at + 900);
  assert.ok(/24 \* 3600 \* 1000/.test(body) && /pskrMapSpots = pskrMapSpots\.filter/.test(body), 'no prune on pollDone');
  assert.ok(/if \(pskrMapSpots\.length !== before\) sendPskrMapSpots\(\);/.test(body), 'a prune must re-push, or the clients keep the pruned rows');
});

console.log(`\nDesktop UX: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
