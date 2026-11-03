#!/usr/bin/env node
'use strict';
// A QSO just logged clears the C / G / D badges on decodes already drawn
// (level_death 2026-10-31: "the G stays after I log them"). Two causes: the
// live roster update read qsoData.grid (records carry GRIDSQUARE), so the grid
// stayed "new" on every later decode; and rows already drawn never re-checked.
// Run: node test/jtcat-worked-update-test.js

const fs = require('fs');
const path = require('path');
const DecodeRow = require('../lib/decode-row');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ok  ' + msg); } else { fail++; console.log('  FAIL ' + msg); } }
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('clearWorkedFlags');
{
  const decodes = [
    { call: 'K1ABC', grid: 'FN42', entity: 'United States', newCall: true, newGrid: true, newDxcc: false },
    { call: 'W9XYZ', grid: 'FN42', newCall: true, newGrid: true },
    { call: 'EA8ZZ', grid: 'IL18', entity: 'Canary Islands', newCall: true, newGrid: true, newDxcc: true, band: '20m' },
    { call: 'EA8YY', entity: 'Canary Islands', newDxcc: true, band: '40m' },
  ];
  const n = DecodeRow.clearWorkedFlags(decodes, { call: 'k1abc', grid: 'FN42aa', entity: 'Canary Islands', band: '20m' });
  ok(decodes[0].newCall === false && decodes[0].newGrid === false, 'the logged call and its grid are no longer new');
  ok(decodes[1].newCall === true && decodes[1].newGrid === false, 'another call in that grid keeps C, loses G');
  ok(decodes[2].newDxcc === false && decodes[2].newCall === true, 'the entity is no longer a new DXCC on that band');
  ok(decodes[3].newDxcc === true, 'the same entity on another band is still new');
  ok(n === 4, 'returns how many flags it cleared');
  ok(DecodeRow.clearWorkedFlags(null, { call: 'K1ABC' }) === 0, 'no decodes is fine');
}

console.log('main.js wiring');
{
  const main = read('main.js');
  ok(/const grid = \(qsoData\.gridsquare \|\| qsoData\.grid \|\| ''\)/.test(main), 'the live roster update reads GRIDSQUARE');
  ok((main.match(/jtcatWorkedUpdate\(\{ call, grid/g) || []).length === 2, 'both live-add sites (saved QSO, WSJT-X bridge) push the update');
  const fn = main.slice(main.indexOf('function jtcatWorkedUpdate('), main.indexOf('async function qrzStationInfo('));
  ok(fn.includes("send('jtcat-worked-update'") && fn.includes('sendJtcatWorkedUpdate(w)'), 'to the JTCAT window and ECHOCAT');
}

console.log('surfaces');
{
  ok(read('lib/echocat-protocol.js').includes("'jtcat-worked-update': { dir: Dir.S2C"), 'registered in the ECHOCAT protocol');
  ok(read('lib/remote-bridge.js').includes("'jtcat-worked-update': same('jtcat-worked-update')"), 'a laptop driving a shack forwards it to its window');
  ok(read('preload-jtcat-popout.js').includes('onJtcatWorkedUpdate'), 'JTCAT window preload exposes it');
  const pop = read('renderer/jtcat-popout.js');
  ok(/onJtcatWorkedUpdate\(function\(w\) \{[\s\S]*?clearWorkedFlags[\s\S]*?rebuildBandActivity\(\)/.test(pop), 'JTCAT window clears the flags and redraws Band Activity');
  ok(/jp-badge-call" data-call=/.test(pop) && /jp-badge-grid" data-grid=/.test(pop), 'its badges name what they flag');
  const web = read('renderer/remote.js');
  ok(/case 'jtcat-worked-update':\s*ft8HandleWorkedUpdate\(msg\)/.test(web), 'ECHOCAT Web handles it');
  ok(/ft8-badge-call" data-call=/.test(web) && /ft8-badge-grid" data-grid=/.test(web), 'web badges name what they flag');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
