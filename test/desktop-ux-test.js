// Small desktop UX items (2026-09-18):
//   - Hunt in activator mode shows the spots TABLE, not whichever exclusive
//     view (SWL/HF Nets, RBN, DXCC, Contests) was open before (Casey).
//   - QSO-logged chime: optional sound on every logged QSO, from every log
//     path, off by default (N2FSM).
// Renderer code cannot be require()'d; these are source-text guards.
// Run: node test/desktop-ux-test.js

'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
const app = R('renderer/app.js'), html = R('renderer/index.html'), main = R('main.js'), preload = R('preload.js');

test('Hunt: an exclusive view is switched to the table before the split opens; map is left alone', () => {
  const fn = app.slice(app.indexOf('function applyActivatorSpotsLayout'), app.indexOf('function applyActivatorSpotsLayout') + 700);
  assert.ok(/if \(currentView !== 'table' && currentView !== 'map'\) setView\('table'\);/.test(fn));
  assert.ok(fn.indexOf("setView('table')") < fn.indexOf("classList.add('activator-spots-on')"), 'view fixed before the layout is applied');
});

test('chime: main emits qso-logged from saveQsoRecord, the one log choke point', () => {
  const fn = main.slice(main.indexOf('async function saveQsoRecord'), main.indexOf('async function saveQsoRecord') + 20000);
  // #1041 added origin, fromDevice and dupe to the payload (test/qso-sounds-test.js).
  assert.ok(/win\.webContents\.send\("qso-logged", \{\s+callsign: qsoData\.callsign, band: qsoData\.band, mode: qsoData\.mode, logAs: logAs \? logAs\.call : "",/.test(fn));
  assert.strictEqual((main.match(/send\("qso-logged"/g) || []).length, 1, 'exactly one emitter');
  assert.ok(/onQsoLogged: \(cb\) => ipcRenderer\.on\('qso-logged'/.test(preload));
});

// #1041: the chime is no longer off by default. An operator who picked one of
// the four flavours keeps it as the contact sound; 'off' (and anything else)
// is the coin, switched by Settings > Sounds > "Contact logged sound"
// (test/qso-sounds-test.js). The select moved to the Sounds pane, Coin first.
test('chime: four synthesized flavours, persisted as settings.qsoChime, Play button', () => {
  assert.ok(/let qsoChime = 'off';/.test(app));
  assert.ok(/qsoChime = settings\.qsoChime \|\| 'off';/.test(app), 'loaded with the other settings');
  assert.ok(/qsoChime: setQsoChime \? setQsoChime\.value : 'off',/.test(app), 'saved with the other settings');
  assert.ok(/window\.api\.onQsoLogged\(\(q\) => \{ try \{ onContactLogged\(q\); \} catch \{\} \}\)/.test(app));
  assert.ok(/if \(r\.sound\.chime\) playQsoChime\(r\.sound\.chime\);/.test(app), 'a picked flavour still plays through playQsoChime');
  // The four flavours live in lib/chime-sounds.js since 2026-11-24 (shared with the JTCAT chimes);
  // playQsoChime plays them through it, into the transmit-guarded output (#1041), and the select offers those four.
  const sounds = require('../lib/chime-sounds');
  assert.deepStrictEqual(sounds.QSO_SOUNDS.map((s) => s.id), ['soft', 'twotone', 'bell', 'morse-r']);
  for (const s of sounds.QSO_SOUNDS) {
    assert.ok(sounds.notesOf(s.id).length > 0, s.id);
    assert.ok(html.includes('<option value="' + s.id + '">' + s.label + '</option>'), 'the select offers ' + s.label);
  }
  const chimeFn = app.slice(app.indexOf('function playQsoChime'), app.indexOf('function playQsoChime') + 600);
  assert.ok(chimeFn.includes('PotacatSounds.playChime(') && chimeFn.includes('ChimeSounds.play(ctx, id, out)'), 'the chime goes through the guarded output');
  assert.ok(/id="set-qso-chime"/.test(html) && /id="set-qso-chime-play"/.test(html), 'Play beside the select (replaced Test, 2026-11-24)');
  assert.ok(/<option value="coin">Coin<\/option>/.test(html.slice(html.indexOf('id="set-qso-chime"'), html.indexOf('id="set-qso-chime"') + 300)), 'Coin is the first option');
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

test('More menu: the directory item is called "Directory" (Casey 2026-11-25)', () => {
  const m = html.match(/<button class="view-menu-item" id="view-directory-btn"[^>]*>([^<]*)<\/button>/);
  assert.ok(m, 'the More menu directory button exists');
  assert.strictEqual(m[1], 'Directory');
  assert.ok(!/SWL\/HF Net Directory/.test(html), 'the old name is gone from the window, settings help included');
  assert.ok(html.includes('(More &gt; Directory)'), 'the settings help points at the new name');
});

console.log(`\nDesktop UX: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
