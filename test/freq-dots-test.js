'use strict';
// Frequencies written the VFO way on every surface an operator reads
// (Casey 2026-11-11, both apps): MHz.kHz.tens-of-Hz, dots, never a comma.
// Run: node test/freq-dots-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const F = require('../lib/freq-dots');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('lib/freq-dots.js');
test('Casey\'s examples', () => {
  assert.strictEqual(F.khzMhz(7100.5), '7.100.50 MHz');
  assert.strictEqual(F.fromKhz(14074), '14.074.00');
  assert.strictEqual(F.khzMhz(162550), '162.550.00 MHz');
  assert.strictEqual(F.khzMhz(462562.5), '462.562.50 MHz');
});
test('the phone\'s two decimals: tens of hertz, rounded', () => {
  assert.strictEqual(F.fromKhz(14074.004), '14.074.00');
  assert.strictEqual(F.fromKhz(14074.006), '14.074.01');
  assert.strictEqual(F.fromKhz(7047.5), '7.047.50');
  assert.strictEqual(F.fromKhz(14095.6), '14.095.60');
  assert.strictEqual(F.fromKhz(14999.999), '15.000.00', 'a carry rolls into the MHz');
});
test('below 1 MHz and above 1 GHz', () => {
  assert.strictEqual(F.fromKhz(475), '0.475.00');
  assert.strictEqual(F.fromKhz(136), '0.136.00');
  assert.strictEqual(F.fromKhz(1296174), '1296.174.00');
});
test('Hz and MHz inputs, numbers or strings', () => {
  assert.strictEqual(F.fromHz(14074000), '14.074.00');
  assert.strictEqual(F.hzMhz('7074000'), '7.074.00 MHz');
  assert.strictEqual(F.fromMhz('14.074'), '14.074.00');
  assert.strictEqual(F.mhzMhz(146.94), '146.940.00 MHz');
  assert.strictEqual(F.fromKhz('14285.0'), '14.285.00');
});
test('nothing to show stays empty (no "0.000.00", no NaN)', () => {
  for (const v of [null, undefined, '', 0, -5, 'abc', NaN, Infinity]) {
    assert.strictEqual(F.fromKhz(v), '', String(v));
    assert.strictEqual(F.khzMhz(v), '', String(v));
    assert.strictEqual(F.fromHz(v), '', String(v));
    assert.strictEqual(F.fromMhz(v), '', String(v));
  }
});
test('never a comma, whatever the locale', () => {
  for (const k of [136, 7074, 14074.5, 144174, 1296174]) assert.ok(!/,/.test(F.khzMhz(k)), String(k));
});

console.log('The surfaces use it');
test('the spot rows (ECHOCAT Web, layout-tested) write the VFO way', () => {
  const SR = require('../lib/spot-row');
  assert.strictEqual(SR.formatSpotFreq('14074.0'), '14.074.00');
  assert.strictEqual(SR.formatSpotFreq('1296174.0'), '1296.174.00');
  assert.ok(SR.SPOT_COL_WIDTHS.freq >= 100, 'the freq track is wide enough for 1296.174.00');
});
test('Channels and the SDR refusal write the VFO way', () => {
  assert.strictEqual(require('../lib/channels').formatMhz(162550), '162.550.00 MHz');
  assert.ok(/^7\.074\.00 MHz is outside/.test(require('../lib/listen-source').refusal(7074000, { reason: 'neither' }, 'the radio', 'SDR')));
});
test('every page that calls FreqDots loads lib/freq-dots.js first', () => {
  const pages = {
    'renderer/index.html': ['renderer/app.js', 'renderer/channels-view.js'],
    'renderer/vfo-popout.html': ['renderer/vfo-popout.html'],
  };
  for (const p of ['prop', 'actmap', 'cluster', 'spots', 'map', 'scope', 'bandspread', 'js8call', 'atu-wizard', 'jtcat', 'log', 'qso', 'sstv', 'winlink']) {
    pages[`renderer/${p}-popout.html`] = [`renderer/${p}-popout.js`];
  }
  for (const [page, scripts] of Object.entries(pages)) {
    const html = readSrc(path.join(ROOT, page));
    for (const s of scripts) assert.ok(/FreqDots\./.test(readSrc(path.join(ROOT, s))), `${s} uses FreqDots`);
    const at = html.indexOf('<script src="../lib/freq-dots.js"></script>');
    assert.ok(at > 0, `${page} loads lib/freq-dots.js`);
    const own = html.search(/<script src="(?!popout-theme-boot|popout-theme-bootstrap)[^"]+-popout\.js"|<script src="app\.js"/);
    if (own > 0) assert.ok(at < own, `${page} loads lib/freq-dots.js before its own script`);
  }
  const web = readSrc(path.join(ROOT, 'renderer/remote.html'));
  assert.ok(web.indexOf('<!-- freq-dots-js -->') >= 0 && web.indexOf('<!-- freq-dots-js -->') < web.indexOf('<!-- spot-row-js -->'), 'ECHOCAT Web inlines it before the spot rows');
  assert.ok(/\['freq-dots-js', 'freq-dots\.js'\]/.test(readSrc(path.join(ROOT, 'lib/remote-server.js'))), 'remote-server inlines it');
  assert.ok(/FreqDots\./.test(readSrc(path.join(ROOT, 'renderer/remote.js'))), 'remote.js uses it');
});
test('the desktop spot table and RBN table write the VFO way, and the header has no "(kHz)"', () => {
  const app = readSrc(path.join(ROOT, 'renderer/app.js'));
  assert.ok(/freqLink\.textContent = FreqDots\.fromKhz\(s\.frequency\)/.test(app));
  assert.ok(/freqTd\.textContent = FreqDots\.fromKhz\(s\.frequency\)/.test(app));
  assert.ok(!/label: 'Freq \(kHz\)'/.test(app));
  // Only the two shortwave tables keep "(kHz)" (the next test).
  assert.strictEqual((readSrc(path.join(ROOT, 'renderer/index.html')).match(/Freq \(kHz\)<\/th>/g) || []).length, 2);
});
test('shortwave broadcast stays in kHz: the one exception (Casey 2026-11-12)', () => {
  // Schedules, broadcasters and listeners all quote kHz (9610, not 9.610.00 MHz).
  const html = readSrc(path.join(ROOT, 'renderer/index.html'));
  for (const body of ['id="dirv-swl-body"', 'id="dir-swl-body"']) {
    const i = html.indexOf(body);
    assert.ok(i > 0, body);
    assert.ok(/Freq \(kHz\)<\/th>/.test(html.slice(i - 1500, i)), 'the header above ' + body + ' says kHz');
  }
  const app = readSrc(path.join(ROOT, 'renderer/app.js'));
  for (const fn of ['function renderDirvSwl(', 'function renderSwlTable(']) {
    const i = app.indexOf(fn);
    assert.ok(i > 0, fn);
    const body = app.slice(i, app.indexOf('\nfunction ', i + 10));
    assert.ok(!/FreqDots\./.test(body), fn + ' does not dot its frequencies');
    assert.ok(/-freq-col">\$\{entry\.frequency \|\| ''\}<\/td>/.test(body), fn + ' cell is the kHz value');
    assert.ok(/value: entry\.frequency \? `\$\{entry\.frequency\} kHz` : ''/.test(body), fn + ' hover card says kHz');
  }
  assert.ok(/\(s\.frequency \|\| '\?'\) \+ ' kHz<\/span>'/.test(readSrc(path.join(ROOT, 'renderer/remote.js'))), 'ECHOCAT Web SWL card says kHz');
});

console.log(`\nfreq-dots: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
