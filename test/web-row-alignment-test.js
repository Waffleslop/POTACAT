'use strict';
// ECHOCAT Web / JTCAT row alignment (2026-10-22 user reports after 1.13.0):
// 1. FT4 rows showed "+10.9874995727539" — the native decoder's float SNR
//    reached the screen unrounded (only the FT8 path rounded), and the long
//    number pushed the row's other columns out of line.
// 2. Spot-table rows with a CW speed put the speed in a SECOND grid cell, so
//    every later column, the S/H/L buttons included, moved one track right.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

const worker = read('lib/ft8-worker.js');

test('every decode-result the worker posts goes through wholeDb', () => {
  const posts = worker.match(/type: 'decode-result', id: msg\.id, results[^}]*}/g) || [];
  assert.strictEqual(posts.length, 3, 'FT8, FT2 and FT4 post sites');
  for (const p of posts) assert.ok(/results: wholeDb\(results\)/.test(p), 'unrounded post: ' + p);
});

test('wholeDb rounds the dB, keeps everything else, and keeps native array props', () => {
  const src = worker.slice(worker.indexOf('function wholeDb('), worker.indexOf('function fixSNR('));
  const wholeDb = new Function(src + '; return wholeDb;')();
  const raw = [{ db: 10.9874995727539, dt: -0.2, df: 233, text: 'KF6JXM KF8FTQ EN74' }, { db: -12.5, dt: 0.1, df: 900, text: 'CQ X' }, { db: -3, text: 'Y' }];
  raw.passes = 3; raw.outOfTime = true;
  const out = wholeDb(raw);
  assert.deepStrictEqual(out.map(r => r.db), [11, -12, -3]);
  assert.strictEqual(out[0].dt, -0.2);
  assert.strictEqual(out[0].text, 'KF6JXM KF8FTQ EN74');
  assert.strictEqual(out.passes, 3);
  assert.strictEqual(out.outOfTime, true);
  assert.strictEqual(raw[0].db, 10.9874995727539, 'input not mutated');
  assert.strictEqual(wholeDb(null), null);
});

// The rows are built by lib/decode-row.js and lib/spot-row.js (the pages are
// held to that by test/layout-alignment-test.js, which also renders them).
const DecodeRow = require('../lib/decode-row');
const SpotRow = require('../lib/spot-row');

test('the rows themselves round too (a laptop can show an older shack\'s decodes)', () => {
  const html = DecodeRow.webRowInner({ db: 10.9874995727539, dt: -0.2, df: 232.73 }, 'KF6JXM KF8FTQ EN74');
  assert.ok(html.startsWith('<span class="ft8-db">+11</span><span class="ft8-dt">-0.2</span><span class="ft8-df">233</span>'), html);
  const pop = DecodeRow.popoutRowInner({ db: -24.4, dt: null, df: 980.5 }, { time: '12:30:45', text: 'X' });
  assert.ok(pop.includes('<span class="jp-db">-24</span><span class="jp-dt"></span><span class="jp-df">981</span>'), pop);
});

test('the CW speed is inside the Mode cell, never a grid cell of its own', () => {
  const v = { age: '1m', distUnit: 'mi' };
  const show = { freq: true, mode: true, log: true };
  const order = ['freq', 'mode', 'log'];
  const cw = SpotRow.spotRowHtml({ callsign: 'W2XYZ', frequency: '14062.5', mode: 'CW', wpm: 22, wpmFrom: 'skimmer', source: 'pota' }, v, { colOrder: order, colShow: show });
  assert.ok(/<span class="spot-mode">CW <span class="spot-wpm"[^>]*>22<\/span><\/span><button/.test(cw), cw);
  const ft8 = SpotRow.spotRowHtml({ callsign: 'N3QQ', frequency: '14074.0', mode: 'FT8', wpm: 18, source: 'pota' }, v, { colOrder: order, colShow: show });
  assert.ok(!/spot-wpm/.test(ft8), 'a speed on a non-CW spot is not shown');
});

console.log(`\nweb row alignment: ${passed} passed`);
