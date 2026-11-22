#!/usr/bin/env node
'use strict';
// The APRS window's "Show the last" choice, age fading and Clear (Casey
// 2026-11-20: "give me a button to clear spots on APRS if that's customary.
// or at least hide old spots as they age out").
//
//  - "Show the last" 15 min / 30 min / 1 hour (default) / 3 hours / 6 hours,
//    saved per profile (settings.aprsShowLastMin), for the list and the map.
//    The window's store keeps 6 hours (the largest choice) and at most
//    WINDOW_MAX_ROWS stations; the view filters by the choice.
//  - A station older than half the window is drawn fainter, in two steps,
//    never below a readable alpha. The heard-by-my-radio ring keeps full colour.
//  - Clear forgets the window's own stations and the "Heard by my radio" count.
//    It sends nothing to main: APRS-IS, listening and the ECHOCAT store
//    (lib/aprs-echocat.js, its own store in main) carry on untouched.
//
// Pure: lib/aprs-stations.js, lib/aprs-window-state.js. Glue checked as text:
// renderer/aprs-popout.js, renderer/aprs-popout.html, preload-aprs-popout.js, main.js.
// Run: node test/aprs-show-last-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/aprs-stations');
const W = require('../lib/aprs-window-state');
const E = require('../lib/aprs-echocat');
const P = require('../lib/aprs-parser');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const MIN = 60 * 1000;
const HOME = { lat: 41.5, lon: -72.5 };

function windowStore() {
  let t = 10_000_000_000;
  const s = S.createStore({ home: HOME, now: () => t, maxAgeMs: S.WINDOW_MAX_AGE_MS, maxRows: S.WINDOW_MAX_ROWS });
  s.tick = (ms) => { t += ms; };
  s.now = () => t;
  return s;
}
const pos = (call, lat, lon) => ({ type: 'position', from: call, lat, lon, symbolTable: '/', symbol: '-', raw: call + '>APRS:x', path: [] });

console.log('APRS window: show the last, age fading, Clear');

// ── the choice ──────────────────────────────────────────────────────────────
test('choices: 15 min, 30 min, 1 hour, 3 hours, 6 hours; 1 hour is the default (the old fixed hour)', () => {
  assert.deepStrictEqual(W.showLastOptions().map((o) => o.label), ['15 min', '30 min', '1 hour', '3 hours', '6 hours']);
  assert.deepStrictEqual(W.showLastOptions().map((o) => o.min), [15, 30, 60, 180, 360]);
  assert.strictEqual(W.DEFAULT_SHOW_LAST_MIN, 60);
});

test('a saved choice reads back; anything else is the 1 hour default', () => {
  for (const m of [15, 30, 60, 180, 360]) assert.strictEqual(W.normShowLast(m), m);
  assert.strictEqual(W.normShowLast('180'), 180);
  for (const bad of [undefined, null, '', 0, -15, 45, 720, 'x', NaN]) assert.strictEqual(W.normShowLast(bad), 60, String(bad));
});

test('the store keeps the largest choice (6 hours); the default store (ECHOCAT) still keeps one hour', () => {
  assert.strictEqual(S.WINDOW_MAX_AGE_MS, 360 * MIN);
  assert.strictEqual(S.WINDOW_MAX_AGE_MS, Math.max(...W.showLastOptions().map((o) => o.min)) * MIN);
  assert.strictEqual(S.MAX_AGE_MS, 60 * MIN);
});

// ── the window filter, each choice ──────────────────────────────────────────
test('each choice shows only the stations heard within it (list and map read the same rows)', () => {
  const s = windowStore();
  // Ages 5, 20, 45, 120, 300 minutes: heard oldest first.
  const ages = [300, 120, 45, 20, 5];
  let prev = 300;
  for (const a of ages) { s.tick((prev - a) * MIN); prev = a; s.add(pos('A' + a, 41.6, -72.4)); }
  s.tick(5 * MIN);
  const want = { 15: ['A5'], 30: ['A20', 'A5'], 60: ['A20', 'A45', 'A5'], 180: ['A120', 'A20', 'A45', 'A5'], 360: ['A120', 'A20', 'A300', 'A45', 'A5'] };
  for (const o of W.showLastOptions()) {
    const got = s.list({ withinMs: o.min * MIN, sort: 'call' }).map((r) => r.label);
    assert.deepStrictEqual(got, want[o.min], o.label);
  }
  assert.strictEqual(s.size, 5, 'nothing was dropped: a wider choice shows what the store already holds');
});

test('a station older than 6 hours leaves the store at the prune', () => {
  const s = windowStore();
  s.add(pos('OLD', 41.6, -72.4));
  s.tick(359 * MIN); s.add(pos('NEW', 41.6, -72.4));
  assert.deepStrictEqual(s.prune(), []);
  s.tick(2 * MIN);
  assert.deepStrictEqual(s.prune(), ['OLD']);
  assert.strictEqual(s.size, 1);
});

// ── the cap ─────────────────────────────────────────────────────────────────
test('the window store holds at most WINDOW_MAX_ROWS stations; the oldest goes first', () => {
  assert.ok(S.WINDOW_MAX_ROWS >= 5000 && S.WINDOW_MAX_ROWS <= 20000, String(S.WINDOW_MAX_ROWS));
  let t = 1_000_000;
  const s = S.createStore({ home: HOME, now: () => t, maxAgeMs: S.WINDOW_MAX_AGE_MS, maxRows: 3 });
  for (const c of ['A', 'B', 'C']) { t += 1000; s.add(pos(c, 41.6, -72.4)); }
  t += 1000; s.add(pos('A', 41.6, -72.4)); // A heard again: B is now the oldest
  t += 1000; s.add(pos('D', 41.6, -72.4));
  assert.strictEqual(s.size, 3);
  assert.deepStrictEqual(s.list({ sort: 'call' }).map((r) => r.label), ['A', 'C', 'D']);
  // An update to a station already held never evicts.
  t += 1000; s.add(pos('C', 41.7, -72.4));
  assert.deepStrictEqual(s.list({ sort: 'call' }).map((r) => r.label), ['A', 'C', 'D']);
  const big = windowStore();
  for (let i = 0; i < S.WINDOW_MAX_ROWS + 50; i++) { big.tick(10); big.add(pos('N' + i, 41.6, -72.4)); }
  assert.strictEqual(big.size, S.WINDOW_MAX_ROWS);
  assert.strictEqual(big.get('N0'), null);
  assert.ok(big.get('N' + (S.WINDOW_MAX_ROWS + 49)));
});

// ── fading ──────────────────────────────────────────────────────────────────
test('fading: full under half the window, then two fainter steps, never below readable', () => {
  for (const o of W.showLastOptions()) {
    const w = o.min * MIN;
    assert.strictEqual(W.ageFade(0, o.min).step, 0, o.label);
    assert.strictEqual(W.ageFade(w * 0.5 - 1000, o.min).step, 0, o.label + ' just under half');
    assert.strictEqual(W.ageFade(w * 0.5, o.min).step, 1, o.label + ' at half');
    assert.strictEqual(W.ageFade(w * 0.75 - 1000, o.min).step, 1, o.label);
    assert.strictEqual(W.ageFade(w * 0.75, o.min).step, 2, o.label + ' at three quarters');
    assert.strictEqual(W.ageFade(w, o.min).step, 2, o.label);
  }
  const a = [0, 1, 2].map((st) => W.FADE_ALPHA[st]);
  assert.strictEqual(a[0], 1);
  assert.ok(a[1] < 1 && a[2] < a[1], a.join());
  assert.ok(a[2] >= 0.5, 'the faintest step stays readable: ' + a[2]);
  assert.strictEqual(W.ageFade(40 * MIN, 60).alpha, W.FADE_ALPHA[1]);
  assert.strictEqual(W.ageFade(-5, 60).step, 0, 'a clock step backwards is new, not old');
  assert.strictEqual(W.ageFade(10 * MIN, 'junk').step, 0, 'a bad window is the 1 hour default');
});

test('fading glue: the map fades the icon only (heard-by-my-radio ring and label at full); list rows get old / older', () => {
  const js = read('renderer/aprs-popout.js');
  const ds = js.slice(js.indexOf('function drawStation('), js.indexOf('function drawCluster('));
  assert.ok(/W\.ageFade\(/.test(js), 'the window uses W.ageFade');
  const ring = ds.indexOf('theme.rf');
  assert.ok(ring > 0, 'the ring is drawn');
  // The icon is stamped at the faded alpha; the alpha is put back before the ring.
  assert.ok(/globalAlpha = alpha \* fade/.test(ds), 'icon at alpha * fade');
  assert.ok(ds.lastIndexOf('ctx.globalAlpha = alpha;', ring) > ds.indexOf('globalAlpha = alpha * fade'), 'ring at full alpha');
  assert.ok(/' old'|" old"|aprs-st-old|\bold\b/.test(js.slice(js.indexOf('function rowHtml('), js.indexOf('function pad('))), 'rows carry an age class');
  const css = read('renderer/aprs-popout.css');
  assert.ok(/\.aprs-st\.old /.test(css) && /\.aprs-st\.older /.test(css), 'old and older row styles');
  assert.ok(!/\.aprs-st\.old[^{]*\{[^}]*box-shadow/.test(css), 'the row fade never touches the heard-by-my-radio ring');
});

// ── the controls in the page ────────────────────────────────────────────────
test('the Stations header has "Show the last" beside "Within", and a plain-text Clear with a title', () => {
  const html = read('renderer/aprs-popout.html');
  const sec = html.slice(html.indexOf('<section class="aprs-stations"'), html.indexOf('</section>', html.indexOf('<section class="aprs-stations"')));
  assert.ok(/id="aprs-show-last"/.test(sec), 'the select');
  assert.ok(/Show the last/.test(sec), 'its label');
  assert.ok(sec.indexOf('aprs-show-last') > sec.indexOf('aprs-range') - 400, 'beside Within');
  const btn = (sec.match(/<button[^>]*id="aprs-clear"[^>]*>[^<]*<\/button>/) || [''])[0];
  assert.ok(btn, 'the Clear button');
  assert.ok(/>Clear<\/button>/.test(btn), 'plain text "Clear"');
  const title = (btn.match(/title="([^"]+)"/) || [])[1] || '';
  assert.ok(/Heard by my radio/.test(title), 'the title says the card count resets: ' + title);
  assert.ok(/APRS-IS/.test(title) && /listening/i.test(title), 'and that the feed and listening carry on');
  assert.ok(/phone|ECHOCAT/i.test(title), 'and that phones keep their own list');
});

// ── Clear ───────────────────────────────────────────────────────────────────
test('Clear empties the view and the Heard by my radio count; new packets fill it again', () => {
  const s = windowStore();
  s.add(pos('W1AW-9', 41.6, -72.4));
  s.add(Object.assign(pos('N2XYZ', 41.7, -72.3), { rf: { kind: 'direct', digi: '' } }));
  assert.strictEqual(s.list({ withinMs: 60 * MIN }).length, 2);
  s.clear();
  assert.strictEqual(s.size, 0);
  assert.strictEqual(s.list({ withinMs: 60 * MIN }).length, 0);
  s.add(pos('K3SBP-9', 41.6, -72.4));
  assert.deepStrictEqual(s.list({}).map((r) => r.label), ['K3SBP-9']);
});

test('Clear glue: local to the window (store, heard count, map state); it sends nothing to main and never asks', () => {
  const js = read('renderer/aprs-popout.js');
  const i = js.indexOf('function clearStations(');
  assert.ok(i > 0, 'clearStations exists');
  const body = js.slice(i, js.indexOf('\n  }\n', i));
  for (const must of ['store.clear()', 'heardKeys.clear()', 'lastHeardKey = null', 'rebuild()']) assert.ok(body.includes(must), must);
  assert.ok(!/window\.api\./.test(body), 'no IPC: APRS-IS, listening and ECHOCAT are untouched');
  assert.ok(!/confirm\(/.test(body), 'no confirm dialog');
  assert.ok(/\$\('aprs-clear'\)\.addEventListener\('click', clearStations\)/.test(js), 'the button calls it');
});

test('ECHOCAT: its own store in main, an hour\'s memory, untouched by the window', () => {
  // lib/aprs-echocat.js builds its own store; the default age stays one hour.
  const src = read('lib/aprs-echocat.js');
  assert.ok(/Stations\.createStore\(\{ now, maxAgeMs: d\.maxAgeMs, home: null \}\)/.test(src), 'its store, as before');
  let t = 1_000_000;
  const c = E.createController({ now: () => t, timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} } });
  c.packets([P.parse('N2XYZ>APRS:=4030.00N/07400.00W-Home')]);
  assert.strictEqual(c.size, 1);
  t += 59 * MIN; c.packets([]);
  assert.strictEqual(c.size, 1, 'kept at 59 min');
  t += 2 * MIN; c.packets([]);
  assert.strictEqual(c.size, 0, 'gone after an hour, as before');
  // A window store cleared beside it changes nothing there.
  const w = windowStore();
  c.packets([P.parse('N2XYZ>APRS:=4030.00N/07400.00W-Home')]);
  w.add(pos('N2XYZ', 40.5, -74));
  w.clear();
  assert.strictEqual(c.size, 1);
});

// ── saved per profile, survives a restart ───────────────────────────────────
test('the choice is saved (settings.aprsShowLastMin, per profile) and sent back at the next start', () => {
  const main = read('main.js');
  const g = main.slice(main.indexOf('const GLOBAL_KEYS = new Set(['), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS = new Set([')));
  assert.ok(!g.includes('aprsShowLastMin'), 'not a global key: it lives in the profile');
  const h = main.indexOf("ipcMain.on('aprs-set-show-last'");
  assert.ok(h > 0, 'main saves it');
  const hb = main.slice(h, main.indexOf('});', h));
  assert.ok(/settings\.aprsShowLastMin = AprsWindowState\.normShowLast\(/.test(hb), 'normalised');
  assert.ok(/saveSettings\(settings\)/.test(hb), 'saved');
  const init = main.slice(main.indexOf("aprsSend('aprs-init'"), main.indexOf('\n', main.indexOf("aprsSend('aprs-init'")));
  assert.ok(/showLastMin: AprsWindowState\.normShowLast\(settings\.aprsShowLastMin\)/.test(init), 'aprs-init carries the saved choice');
  assert.ok(/setShowLast: \(min\) => ipcRenderer\.send\('aprs-set-show-last', min\)/.test(read('preload-aprs-popout.js')), 'preload');
  const js = read('renderer/aprs-popout.js');
  assert.ok(/showLastMin = W\.normShowLast\(d\.showLastMin\)/.test(js), 'the window applies the saved choice on init');
  assert.ok(/window\.api\.setShowLast\(/.test(js), 'the window saves a new choice');
  assert.ok(/createStore\(\{ maxAgeMs: AprsStations\.WINDOW_MAX_AGE_MS, maxRows: AprsStations\.WINDOW_MAX_ROWS \}\)/.test(js), 'the window store keeps 6 hours, capped');
  assert.ok(/withinMs: showLastMin \* 60000/.test(js), 'the list (and the map, from it) is filtered by the choice');
  // A restart: what was saved is what init sends.
  const saved = { aprsShowLastMin: W.normShowLast('180') };
  assert.strictEqual(W.normShowLast(JSON.parse(JSON.stringify(saved)).aprsShowLastMin), 180);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
