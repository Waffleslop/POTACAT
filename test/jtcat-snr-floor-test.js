#!/usr/bin/env node
'use strict';
/**
 * Hunt's signal floor (a POTACAT user 2026-10-27): don't automatically call a
 * CQ weaker than the station can work, optionally per band.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../lib/jtcat-snr-floor');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('Reading the settings');
check('blank or off = no floor; a number is clamped to -30..+20', () => {
  assert.strictEqual(F.parseDefault(''), null);
  assert.strictEqual(F.parseDefault('off'), null);
  assert.strictEqual(F.parseDefault('-20'), -20);
  assert.strictEqual(F.parseDefault('-20 dB'), -20);
  assert.strictEqual(F.parseDefault('-45'), -30);
  assert.strictEqual(F.parseDefault('abc'), null);
});
check('by band reads the ways people write it, and names what it could not read', () => {
  const r = F.parseByBand('20m -18, 6M: -12; 40m=-22 dB\n2m -5, nonsense');
  assert.deepStrictEqual(r.map, { '20m': -18, '6m': -12, '40m': -22, '2m': -5 });
  assert.deepStrictEqual(r.bad, ['nonsense']);
  assert.strictEqual(F.formatByBand(r.map), '20m -18, 6m -12, 40m -22, 2m -5');
});

console.log('The rule');
const s = { jtcatHuntMinDb: '-20', jtcatHuntMinDbByBand: '6m -12' };
check('a band of its own wins; any other band uses the default', () => {
  assert.strictEqual(F.floorFor(s, '6m'), -12);
  assert.strictEqual(F.floorFor(s, '20m'), -20);
  assert.strictEqual(F.floorFor({ jtcatHuntMinDbByBand: '6m -12' }, '20m'), null, 'no default: other bands are free');
});
check('at or above the floor is called; below is not; no reading is not held against a station', () => {
  assert.strictEqual(F.passes(-20, -20), true);
  assert.strictEqual(F.passes(-21, -20), false);
  assert.strictEqual(F.passes(-5, null), true);
  assert.strictEqual(F.passes(undefined, -20), true);
});

console.log('Wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
check('the floor is in the ONE workable check Hunt, fallback, mode hop and Run share', () => {
  const fn = main.slice(main.indexOf('function jtcatWorkableCallers('), main.indexOf('function jtcatRunWorkableCount('));
  assert.ok(/const floor = JtcatSnrFloor\.floorFor\(settings, dupeBandMode\.band\);/.test(fn));
  assert.ok(/if \(!JtcatSnrFloor\.passes\(d\.db, floor\)\) \{ belowFloor\+\+; return false; \}/.test(fn));
});
check('Hunt says why it stayed quiet', () => {
  assert.ok(/\[JTCAT Hunt\] Not calling \$\{candidates\.belowFloor\} CQ/.test(main));
});
check('the window and a remote shack carry both settings', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'lib/remote-bridge.js'), 'utf8');
  assert.ok(/jtcatHuntMinDb: 'string'/.test(bridge) && /jtcatHuntMinDbByBand: 'string'/.test(bridge));
  const html = fs.readFileSync(path.join(ROOT, 'renderer/jtcat-popout.html'), 'utf8');
  assert.ok(/id="jp-hunt-min-db"/.test(html) && /id="jp-hunt-min-db-band"/.test(html));
  assert.ok(/<script src="\.\.\/lib\/jtcat-snr-floor\.js"><\/script>/.test(html));
  const pop = fs.readFileSync(path.join(ROOT, 'renderer/jtcat-popout.js'), 'utf8');
  assert.ok(/saveSettings\(\{ jtcatHuntMinDb:/.test(pop) && /saveSettings\(\{ jtcatHuntMinDbByBand: text \}\)/.test(pop));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
