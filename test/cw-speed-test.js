'use strict';
// CW speed on spots that carry none (POTA/SOTA/WWFF), from skimmer readings.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { CwSpeedCache, wpmFromComment } = require('../lib/cw-speed');
const { RbnClient } = require('../lib/rbn');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const T0 = Date.UTC(2026, 9, 19, 15);

test('a POTA CW spot takes the skimmed speed of the same station and frequency', () => {
  const c = new CwSpeedCache();
  c.note('k1abc', '14061.4', 22, T0);
  const [s] = c.fillSpots([{ source: 'pota', callsign: 'K1ABC', frequency: '14062', mode: 'CW' }], T0 + 60000);
  assert.strictEqual(s.wpm, 22);
  assert.strictEqual(s.wpmFrom, 'skimmer');
});
test('never: another band, another frequency, stale, not CW, or a spot that has a speed', () => {
  const c = new CwSpeedCache();
  c.note('K1ABC', '7031', 18, T0);
  const out = c.fillSpots([
    { callsign: 'K1ABC', frequency: '14062', mode: 'CW' },
    { callsign: 'K1ABC', frequency: '7036', mode: 'CW' },
    { callsign: 'K1ABC', frequency: '7031', mode: 'SSB' },
    { callsign: 'K1ABC', frequency: '7031', mode: 'CW', wpm: 25 },
  ], T0);
  assert.deepStrictEqual(out.map((s) => s.wpm || null), [null, null, null, 25]);
  assert.strictEqual(c.lookup('K1ABC', '7031', T0 + 16 * 60000), null, '15 min limit');
});
test('the newest reading wins; source arrays are never mutated', () => {
  const c = new CwSpeedCache();
  c.note('K1ABC', '14062', 18, T0);
  c.note('K1ABC', '14062.5', 26, T0 + 1000);
  const src = [{ callsign: 'K1ABC', frequency: '14062', mode: 'CW' }];
  const out = c.fillSpots(src, T0 + 2000);
  assert.strictEqual(out[0].wpm, 26);
  assert.strictEqual(src[0].wpm, undefined);
});
test('bounded: oldest calls are forgotten; nonsense speeds are ignored', () => {
  const c = new CwSpeedCache({ maxCalls: 2 });
  c.note('A1A', 14000, 20, T0); c.note('B1B', 14000, 20, T0); c.note('C1C', 14000, 20, T0);
  assert.strictEqual(c.lookup('A1A', 14000, T0), null);
  c.note('D1D', 14000, 300, T0);
  assert.strictEqual(c.lookup('D1D', 14000, T0), null);
  assert.strictEqual(wpmFromComment('CW 18 dB 22 WPM CQ'), 22);
});
test('RBN reports every CW speed, including stations it does not show', () => {
  const rbn = new RbnClient();
  rbn._filterCallsigns = new Set(['K3SBP']);
  const speeds = [], spots = [];
  rbn.on('cw-speed', (r) => speeds.push(r));
  rbn.on('spot', (s) => spots.push(s));
  rbn._markHealthy = () => {};
  rbn._parseSpotLine('DX de W3LPL-#:   14061.4  K1ABC        CW    18 dB  22 WPM  CQ      1503Z');
  rbn._parseSpotLine('DX de W3LPL-#:   14074.0  K1ABC        FT8   -12 dB         CQ      1503Z');
  assert.deepStrictEqual(speeds, [{ callsign: 'K1ABC', freqKhz: 14061.4, wpm: 22 }]);
  assert.strictEqual(spots.length, 0, 'the filter still hides K1ABC');
});
test('wired: RBN, CW Spots and cluster feed the cache; merged spots are filled; web shows it', () => {
  const main = R('main.js');
  assert.ok(/rbn\.on\('cw-speed', \(r\) => cwSpeeds\.note\(/.test(main));
  assert.ok(/cwSpeeds\.fillSpots\(dedupeCrossSource\(raw\)\)/.test(main));
  assert.strictEqual((main.match(/cwSpeeds\.note\(spot\.callsign, spot\.frequency, spot\.wpm\)/g) || []).length, 2);
  assert.ok(/class="spot-wpm"/.test(R('renderer/remote.js')));
});

console.log(`\nCW speed: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
