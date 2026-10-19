'use strict';
// The PSKReporter map keeps its reports PER BAND, so a busy band can never
// evict another band's reports (K3SBP 2026-10-19: "40m reports but not 20m"
// while 104 stations were hearing him on 20m — one shared cap of 500 plus a
// 15-minute poll window meant evicted 20m reports never came back).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const i = main.indexOf("pskrMap.on('spot', (raw) => {");
const block = main.slice(i, i + 4000);
assert.ok(/const PSKR_MAP_PER_BAND_CAP = 500;/.test(main));
assert.ok(/const sameBand = pskrMapSpots\.filter\(\(s\) => s\.band === spot\.band\);/.test(block), 'counted per band');
assert.ok(!/pskrMapSpots\.slice\(-500\)/.test(block), 'no shared cap across bands');

// The rule itself, as main applies it.
const CAP = 3;
let spots = [];
function add(spot) {
  const idx = spots.findIndex((s) => s.receiver === spot.receiver && s.band === spot.band);
  if (idx !== -1) spots.splice(idx, 1);
  spots.push(spot);
  const sameBand = spots.filter((s) => s.band === spot.band);
  if (sameBand.length > CAP) {
    const drop = new Set(sameBand.slice(0, sameBand.length - CAP));
    spots = spots.filter((s) => !drop.has(s));
  }
}
for (let n = 0; n < 3; n++) add({ receiver: 'R20-' + n, band: '20m' });
for (let n = 0; n < 50; n++) add({ receiver: 'R40-' + n, band: '40m' });
assert.strictEqual(spots.filter((s) => s.band === '20m').length, 3, 'a busy 40m session leaves 20m alone');
assert.strictEqual(spots.filter((s) => s.band === '40m').length, CAP, 'and 40m keeps its newest');
assert.deepStrictEqual(spots.filter((s) => s.band === '40m').map((s) => s.receiver), ['R40-47', 'R40-48', 'R40-49']);
console.log('  ok  PSKR map reports are capped per band');
console.log('\nPSKR map band cap: 1 passed, 0 failed');
