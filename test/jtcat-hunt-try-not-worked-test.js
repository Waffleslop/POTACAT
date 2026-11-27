'use strict';
// #1119: a station Hunt picks is not marked worked for the session at the
// pick. Only a completed QSO marks it; a try that gives up goes through the
// timed skip ("Skip a call for N min after a QSO gives up") and comes back
// when that runs out. Run: node test/jtcat-hunt-try-not-worked-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const HuntFilters = require('../lib/jtcat-hunt-filters');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const huntAt = main.indexOf('// --- Auto-CQ Response ---');
const pickAt = main.indexOf('const best = ranked[0];', huntAt);
const pick = main.slice(pickAt, main.indexOf('// Field Day:', pickAt));

test('the Hunt pick does not mark the station for the session', () => {
  assert.ok(huntAt > 0 && pickAt > huntAt);
  assert.match(pick, /if \(best\) \{/);
  assert.doesNotMatch(pick, /jtcatSessionMark\(/);
  assert.match(pick, /jtcatHuntStatusWorking\(best\.call\)/);
});

test('a completed QSO still marks the station (both owners)', () => {
  assert.match(main, /if \(popoutJtcatQso && popoutJtcatQso\.phase === 'done'\) \{[\s\S]{0,700}?if \(popoutJtcatQso\.call\) jtcatSessionMark\(popoutJtcatQso\.call\);/);
  assert.match(main, /if \(remoteJtcatQso && remoteJtcatQso\.phase === 'done'\) \{[\s\S]{0,700}?if \(remoteJtcatQso\.call\) jtcatSessionMark\(remoteJtcatQso\.call\);/);
});

test('a give-up notes the timed skip, which Hunt\'s CQ filter applies', () => {
  assert.match(main, /jtcatAutoSkip\.note\(qso\.call, bm\.band, bm\.mode\);/);
  assert.match(main, /if \(jtcatAutoSkip\.has\(d\.call, dupeBandMode\.band, dupeBandMode\.mode, skipMin\)\) \{ reasons\.skipped\+\+; return false; \}/);
});

test('the timed skip runs out, so the station can be called again', () => {
  const s = new HuntFilters.AutoSkip();
  const t0 = 1_000_000;
  s.note('K4POT', '20M', 'FT8', t0);
  assert.strictEqual(s.has('K4POT', '20M', 'FT8', 30, t0 + 29 * 60000), true);
  assert.strictEqual(s.has('K4POT', '20M', 'FT8', 30, t0 + 30 * 60000), false);
  assert.strictEqual(s.has('K4POT', '40M', 'FT8', 30, t0 + 60000), false, 'per band');
});

console.log(`jtcat-hunt-try-not-worked: ${passed} passed`);
