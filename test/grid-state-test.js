#!/usr/bin/env node
'use strict';
// A decode's state from its grid (lib/grid-state.js + assets/geo/grid-states.json)
// and the Hunt: Wanted states rule. Run: node test/grid-state-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const GS = require('../lib/grid-state');
const WR = require('../lib/worked-roster');
const { matchesHuntFilter } = require('../lib/jtcat-state-machine');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const TABLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'geo', 'grid-states.json'), 'utf8'));

test('the table names every US state and Canadian province; the big ones have CERTAIN grids', () => {
  const all = new Set();
  const certain = new Set();
  for (const codes of Object.values(TABLE)) { codes.forEach((c) => all.add(c)); if (codes.length === 1) certain.add(codes[0]); }
  const want = WR.US_STATES.map((s) => s.code).concat(WR.CA_PROVINCES.map((s) => s.code));
  assert.deepStrictEqual(want.filter((c) => !all.has(c)), [], 'absent from the table');
  assert.ok(all.has('DC'), 'DC is in the table (counts as MD in the roster)');
  // A 4-character grid is 2 x 1 degrees: a small or narrow state (NJ, CT,
  // TN, IN...) never fills one alone, so those are always straddlers and
  // QRZ or the all-wanted rule decides. The large ones must be certain.
  for (const c of ['TX', 'CA', 'AK', 'MT', 'NY', 'PA', 'ON', 'QC', 'BC', 'HI']) assert.ok(certain.has(c), 'no certain grid for ' + c);
  assert.ok(certain.size >= 40, 'certain states: ' + certain.size);
  for (const [g, codes] of Object.entries(TABLE)) {
    assert.ok(/^[A-R]{2}\d{2}$/.test(g), g);
    assert.deepStrictEqual(codes, [...new Set(codes)].sort(), g + ' sorted, unique');
  }
});

test('known grids: straddlers and certain ones', () => {
  assert.deepStrictEqual(GS.statesForGrid('FN20'), { states: ['NJ', 'NY', 'PA'], certain: false, known: true });
  assert.deepStrictEqual(GS.statesForGrid('fn20xa'), { states: ['NJ', 'NY', 'PA'], certain: false, known: true }, 'six-character grid, lower case');
  assert.deepStrictEqual(GS.statesForGrid('EM12'), { states: ['TX'], certain: true, known: true });
  assert.deepStrictEqual(GS.statesForGrid('BL11'), { states: ['HI'], certain: true, known: true });
  assert.deepStrictEqual(GS.statesForGrid('BP51'), { states: ['AK'], certain: true, known: true });
  assert.deepStrictEqual(GS.statesForGrid('JN48'), { states: [], certain: false, known: false }, 'Germany');
  assert.deepStrictEqual(GS.statesForGrid('RR73'), { states: [], certain: false, known: false });
  assert.deepStrictEqual(GS.statesForGrid(''), { states: [], certain: false, known: false });
  assert.ok(GS.statesForGrid('CN88').states.includes('BC') && GS.statesForGrid('CN88').states.includes('WA'), 'Vancouver / Bellingham');
});

test('stateForDecode: grid first, the entity filters the candidates, QRZ settles a straddle or stands in', () => {
  // certain from the grid
  assert.deepStrictEqual(GS.stateForDecode({ grid: 'EM12', entity: 'United States' }), { code: 'TX', candidates: ['TX'], certain: true, source: 'grid' });
  // straddler, unresolved
  const s = GS.stateForDecode({ grid: 'FN20', entity: 'United States' });
  assert.deepStrictEqual([s.code, s.certain, s.source], ['NJ/NY/PA', false, 'grid']);
  // straddler + QRZ names one of them
  assert.deepStrictEqual(GS.stateForDecode({ grid: 'FN20', qrzState: 'nj', entity: 'United States' }), { code: 'NJ', candidates: ['NJ'], certain: true, source: 'grid+qrz' });
  // straddler + QRZ names a state the grid cannot be: the grid wins (portable)
  const t = GS.stateForDecode({ grid: 'FN20', qrzState: 'TX', entity: 'United States' });
  assert.deepStrictEqual([t.code, t.certain], ['NJ/NY/PA', false]);
  // border grid: the entity picks the country's side
  assert.deepStrictEqual(GS.stateForDecode({ grid: 'CN88', entity: 'Canada' }).code, 'BC');
  assert.deepStrictEqual(GS.stateForDecode({ grid: 'CN88', entity: 'United States' }).code, 'WA');
  // a US call in a foreign grid is not in a state, whatever QRZ says
  assert.strictEqual(GS.stateForDecode({ grid: 'JN48', qrzState: 'NJ', entity: 'United States' }), null);
  // no grid: QRZ stands in, uncertain
  assert.deepStrictEqual(GS.stateForDecode({ qrzState: 'NJ', entity: 'United States' }), { code: 'NJ', candidates: ['NJ'], certain: false, source: 'qrz' });
  // QRZ state that is not a state of that entity is ignored
  assert.strictEqual(GS.stateForDecode({ qrzState: 'ON', entity: 'United States' }), null);
  // not a tracked entity
  assert.strictEqual(GS.stateForDecode({ grid: 'FN20', qrzState: 'NJ', entity: 'Japan' }), null);
  assert.strictEqual(GS.stateForDecode({ grid: 'FN20', entity: '' }), null);
  // Alaska / Hawaii entities
  assert.strictEqual(GS.stateForDecode({ grid: 'BP51', entity: 'Alaska' }).code, 'AK');
  assert.strictEqual(GS.stateForDecode({ grid: 'BL11', entity: 'Hawaii' }).code, 'HI');
});

test('huntMayAnswer: certain wanted yes; straddle only when every state is wanted; QRZ guess never', () => {
  const wanted = new Set(['NJ', 'NY', 'PA']);
  const isWanted = (c) => wanted.has(c);
  assert.strictEqual(GS.huntMayAnswer(GS.stateForDecode({ grid: 'FN20', entity: 'United States' }), isWanted), true, 'all three wanted');
  wanted.delete('PA');
  assert.strictEqual(GS.huntMayAnswer(GS.stateForDecode({ grid: 'FN20', entity: 'United States' }), isWanted), false, 'PA worked: a guess');
  assert.strictEqual(GS.huntMayAnswer(GS.stateForDecode({ grid: 'FN20', qrzState: 'NJ', entity: 'United States' }), isWanted), true, 'QRZ settled it to NJ');
  assert.strictEqual(GS.huntMayAnswer(GS.stateForDecode({ qrzState: 'NJ', entity: 'United States' }), isWanted), false, 'QRZ alone is a badge, not a reply');
  assert.strictEqual(GS.huntMayAnswer(null, isWanted), false);
  assert.strictEqual(GS.huntMayAnswer(GS.stateForDecode({ grid: 'EM12', entity: 'United States' }), isWanted), false, 'TX not wanted');
});

test('matchesHuntFilter wanted-state: a CQ with stateWanted, nothing else', () => {
  assert.strictEqual(matchesHuntFilter('CQ K2ABC FN20', 'wanted-state', { stateWanted: true }), true);
  assert.strictEqual(matchesHuntFilter('CQ K2ABC FN20', 'wanted-state', { stateWanted: false }), false);
  assert.strictEqual(matchesHuntFilter('CQ K2ABC FN20', 'wanted-state'), false);
  assert.strictEqual(matchesHuntFilter('W1AW K2ABC FN20', 'wanted-state', { stateWanted: true }), false, 'never a non-CQ');
});

test('wiring: both decode sites enrich, Hunt reads the same rule, both surfaces offer the option and draw the badge, assets ship', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.strictEqual((main.match(/^\s+workedOverlayEnrichDecode\(r, uc, currentBand, /gm) || []).length, 2, 'single- and multi-slice decode sites');
  assert.ok(/GridState\.huntMayAnswer\(d\.state, /.test(main));
  assert.ok(/stateWanted,\s*\n\s*\}\);/.test(main), 'stateWanted reaches matchesHuntFilter');
  assert.ok(main.includes("require('./lib/grid-state')"));
  assert.ok(/qrz\.cached\(call\)/.test(main), 'cache first');
  const popHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html'), 'utf8');
  const popJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'), 'utf8');
  const remHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.html'), 'utf8');
  const remJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8');
  assert.ok(popHtml.includes('<option value="wanted-state"') && remHtml.includes('<option value="wanted-state"'));
  assert.ok(popHtml.includes('.jp-badge-state') && popJs.includes('jp-badge-state') && popJs.includes('d.wantedState'));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.css'), 'utf8').includes('.ft8-badge-state') && remJs.includes('ft8-badge-state') && remJs.includes('d.wantedState'));
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(app.includes('function spotWantedStates(') && app.includes('ref-state-pill'));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('assets/geo/**/*'), 'geo assets are packaged');
  for (const f of ['countries.json', 'states.json', 'grid-states.json', 'LICENSE']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'geo', f)), f);
  const states = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'geo', 'states.json'), 'utf8'));
  const codes = new Set(states.features.map((f) => f.properties.cc + '-' + f.properties.code));
  for (const s of WR.US_STATES) assert.ok(codes.has('US-' + s.code), 'polygon for ' + s.code);
  for (const s of WR.CA_PROVINCES) assert.ok(codes.has('CA-' + s.code), 'polygon for ' + s.code);
  const total = ['countries.json', 'states.json', 'grid-states.json'].reduce((n, f) => n + fs.statSync(path.join(__dirname, '..', 'assets', 'geo', f)).size, 0);
  assert.ok(total < 600 * 1024, 'geo assets stay small: ' + total);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
