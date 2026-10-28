#!/usr/bin/env node
// test/scope-overlay-test.js — the band scope's Phase 3 overlay
// (docs/scope-improvements-plan.md items 7-10): passband from mode + filter
// (lib/scope-overlay.js), the band plan (edges, privileges, dials), their
// geometry in lib/scope-view.js, and main.js's wiring.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const O = require('../lib/scope-overlay');
const V = require('../lib/scope-view');
const A = require('../lib/scope-axis');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('Passband');
test('USB with a reported width: dial+100 .. dial+100+width, reported', () => {
  assert.deepStrictEqual(O.passbandFor({ mode: 'USB', widthHz: 2700 }), { loOffsetHz: 100, hiOffsetHz: 2800, reported: true, kind: 'ssb' });
});
test('LSB is mirrored', () => {
  assert.deepStrictEqual(O.passbandFor({ mode: 'LSB', widthHz: 2400 }), { loOffsetHz: -2500, hiOffsetHz: -100, reported: true, kind: 'ssb' });
});
test('CW is centred on the dial', () => {
  const p = O.passbandFor({ mode: 'CW', widthHz: 400 });
  assert.strictEqual(p.loOffsetHz, -200); assert.strictEqual(p.hiOffsetHz, 200);
});
test('AM and FM are symmetric', () => {
  const am = O.passbandFor({ mode: 'AM', widthHz: 6000 });
  assert.strictEqual(am.loOffsetHz, -3000); assert.strictEqual(am.hiOffsetHz, 3000);
  const fm = O.passbandFor({ mode: 'FM' });
  assert.strictEqual(fm.hiOffsetHz - fm.loOffsetHz, 12000); assert.strictEqual(fm.loOffsetHz, -6000);
});
test('no reported width: the mode\'s nominal width, reported false', () => {
  const cases = { USB: 2400, LSB: 2400, CW: 500, DIGU: 3000, PKTUSB: 3000, 'USB-D': 3000, AM: 6000, FM: 12000 };
  for (const [mode, w] of Object.entries(cases)) {
    const p = O.passbandFor({ mode, widthHz: 0 });
    assert.strictEqual(p.reported, false, mode);
    assert.strictEqual(p.hiOffsetHz - p.loOffsetHz, w, mode);
  }
});
test('the Flex slice\'s own edges win, as given (LSB negative)', () => {
  assert.deepStrictEqual(O.passbandFor({ mode: 'LSB', widthHz: 2400, flexLo: -2800, flexHi: -100 }), { loOffsetHz: -2800, hiOffsetHz: -100, reported: true, kind: 'ssb' });
  // Partial/NaN edges fall back to the width.
  assert.strictEqual(O.passbandFor({ mode: 'USB', widthHz: 2400, flexLo: NaN, flexHi: 2500 }).loOffsetHz, 100);
});
test('an unknown mode draws no passband', () => {
  assert.strictEqual(O.passbandFor({ mode: '', widthHz: 2400 }), null);
  assert.strictEqual(O.passbandFor({ mode: 'VFO-A' }), null);
});
test('passbandHz adds the dial', () => {
  assert.deepStrictEqual(V.passbandHz({ loOffsetHz: 100, hiOffsetHz: 2800, reported: true, kind: 'ssb' }, 14200000),
    { loHz: 14200100, hiHz: 14202800, reported: true, kind: 'ssb' });
  assert.strictEqual(V.passbandHz(null, 14200000), null);
  assert.strictEqual(V.passbandHz({ loOffsetHz: 100, hiOffsetHz: 2800 }, 0), null);
});

console.log('Band plan');
test('20 m General: edges, allowed ranges in kHz → Hz, class label', () => {
  const p = O.bandPlanFor(14074000, { licenseClass: 'us_general' });
  assert.strictEqual(p.band, '20m');
  assert.strictEqual(p.loHz, 14000000); assert.strictEqual(p.hiHz, 14350000);
  assert.strictEqual(p.classLabel, 'General');
  assert.deepStrictEqual(p.allowed, [{ loHz: 14025000, hiHz: 14150000, kind: 'cw_digi' }, { loHz: 14225000, hiHz: 14350000, kind: 'phone' }]);
});
test('no licence class: band edges only (allowed null)', () => {
  const p = O.bandPlanFor(14074000, { licenseClass: 'none' });
  assert.strictEqual(p.allowed, null); assert.strictEqual(p.classLabel, null);
  assert.strictEqual(O.bandPlanFor(14074000, {}).allowed, null);
});
test('a dial in no band has no plan', () => {
  assert.strictEqual(O.bandPlanFor(15000000, { licenseClass: 'us_extra' }), null);
});
test('dials: the band\'s entries from every table, sorted', () => {
  const p = O.bandPlanFor(14074000, { dials: { FT8: { '20m': 14074 }, FT4: { '20m': 14080 }, JTTY: O.JTTY_DIALS, PSK: O.PSK_DIALS } });
  assert.deepStrictEqual(p.dials.map((d) => d.label + d.hz), ['PSK14070000', 'FT814074000', 'FT414080000', 'JTTY14090000']);
});
test('JTTY/PSK dial copies match the JTCAT window\'s tables', () => {
  const src = read('renderer/jtcat-popout.js');
  const grab = (name) => {
    const i = src.indexOf('var ' + name + ' = {');
    const body = src.slice(src.indexOf('{', i), src.indexOf('};', i) + 1);
    return Function('return ' + body)();
  };
  assert.deepStrictEqual(grab('JTTY_BAND_FREQS'), O.JTTY_DIALS);
  assert.deepStrictEqual(grab('PSK_BAND_FREQS'), O.PSK_DIALS);
});

console.log('Geometry');
const axis20 = A.scopeAxis({ centerHz: 14150000, spanHz: 400000, anchor: 'center' });   // 13.95 .. 14.35
test('outside the band is dimmed, clipped to the window', () => {
  const g = V.bandPlanGeometry(O.bandPlanFor(14150000, {}), axis20, 1000);
  assert.strictEqual(g.dim.length, 1, 'only the low side is in the window');
  assert.ok(Math.abs(g.dim[0].x0) < 1e-9);
  assert.ok(Math.abs(g.dim[0].x1 - 50 * 999 / 400 * 1) < 2, 'band edge 14.000 at 12.5% of the width');
  assert.strictEqual(g.hatch.length, 0, 'no class, no hatch');
});
test('outside privileges is hatched (inside the band only) and the class labelled', () => {
  const plan = O.bandPlanFor(14150000, { licenseClass: 'us_general' });
  const g = V.bandPlanGeometry(plan, axis20, 1000);
  // Gaps: 14.000-14.025 and 14.150-14.225.
  assert.strictEqual(g.hatch.length, 2);
  assert.strictEqual(g.segs.length, 2);
  assert.deepStrictEqual(g.segs.map((s) => s.kind), ['cw_digi', 'phone']);
  assert.strictEqual(g.classLabel, 'General');
  assert.ok(g.hatch.every((h) => h.x0 >= g.dim[0].x1 - 1e-6), 'never hatches outside the band');
});
test('privileges off: no hatch, no segments', () => {
  const g = V.bandPlanGeometry(O.bandPlanFor(14150000, { licenseClass: 'us_general' }), axis20, 1000, { privileges: false });
  assert.strictEqual(g.hatch.length, 0); assert.strictEqual(g.segs.length, 0);
  assert.strictEqual(g.dim.length, 1, 'band edges still shown');
});
test('a window wholly inside an allowed segment: nothing hatched or dimmed', () => {
  const ax = A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'center' });
  const g = V.bandPlanGeometry(O.bandPlanFor(14074000, { licenseClass: 'us_extra' }), ax, 850);
  assert.strictEqual(g.dim.length, 0); assert.strictEqual(g.hatch.length, 0); assert.strictEqual(g.segs.length, 1);
});
test('dial ticks only inside the window', () => {
  const ax = A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'center' });
  const g = V.bandPlanGeometry(O.bandPlanFor(14074000, { dials: { FT8: { '20m': 14074 }, FT4: { '20m': 14080 } } }), ax, 850);
  assert.deepStrictEqual(g.dials.map((d) => d.label), ['FT8']);
});
test('passband waterfall markers: two thin edges, never a fill; none when off-window', () => {
  const ax = A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'center' });
  const m = V.passbandMarkers({ loOffsetHz: 100, hiOffsetHz: 2800, reported: true }, 14074000, ax);
  assert.strictEqual(m.length, 2); assert.ok(m.every((x) => Array.isArray(x.color) && x.pos > 0.5 && x.pos < 1));
  assert.strictEqual(V.passbandMarkers({ loOffsetHz: 100, hiOffsetHz: 2800 }, 14200000, ax).length, 0);
});
test('split TX marker: hzToX inside / null outside', () => {
  const ax = A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'center' });
  assert.ok(V.hzToX(ax, 14076000, 850) > 425);
  assert.strictEqual(V.hzToX(ax, 14095000, 850), null);
});

// A recording 2D context: drawOverlay must run on every shape without throwing.
function fakeCtx(w, h) {
  const calls = [];
  const ctx = { canvas: { width: w, height: h }, calls };
  for (const k of ['fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'rect', 'clip', 'save', 'restore', 'fillText', 'setLineDash', 'closePath'])
    ctx[k] = (...a) => calls.push([k, ...a]);
  ctx.measureText = (t) => ({ width: String(t).length * 6 });
  ctx.createLinearGradient = () => ({ addColorStop() {} });
  return ctx;
}
test('drawOverlay: reported passband filled, nominal dashed + "nominal" label, TX labelled, dial flagged', () => {
  const ax = A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'center' });
  const plan = O.bandPlanFor(14074000, { licenseClass: 'us_general' });
  let c = fakeCtx(850, 200);
  V.drawOverlay(c, { axis: ax, dialHz: 14074000, passband: O.passbandFor({ mode: 'USB', widthHz: 2400 }), txHz: 14076000, bandPlan: plan });
  const texts = c.calls.filter((x) => x[0] === 'fillText').map((x) => x[1]);
  assert.ok(texts.includes('TX'), 'TX label'); assert.ok(texts.includes('14.074'), 'dial flag'); assert.ok(!texts.includes('nominal'));
  c = fakeCtx(850, 200);
  V.drawOverlay(c, { axis: ax, dialHz: 14074000, passband: O.passbandFor({ mode: 'USB' }), bandPlan: plan });
  assert.ok(c.calls.some((x) => x[0] === 'setLineDash'), 'dashed outline');
  assert.ok(c.calls.some((x) => x[0] === 'fillText' && x[1] === 'nominal'));
  c = fakeCtx(850, 40);
  V.drawOverlay(c, { axis: ax, dialHz: 14074000, passband: O.passbandFor({ mode: 'USB' }), bandPlan: plan, labels: false, flag: false });
  assert.strictEqual(c.calls.filter((x) => x[0] === 'fillText').length, 0, 'a strip draws no labels');
});

console.log('Wiring');
test('main: both scope-state payloads carry the overlay; sync hooks are in place', () => {
  const m = read('main.js');
  assert.strictEqual((m.match(/levelScale: scopeLevelScale\(\),\r?\n\s+\.\.\.scopeOverlay\(\),/g) || []).length, 2, 'local + remote payloads');
  assert.ok(/function scopeOverlay\(\) \{[\s\S]*?passbandFor\(\{ mode: _currentMode, widthHz: _currentFilterWidth/.test(m), 'passband from mode + width');
  assert.ok(/txHz: _currentSplit && _currentFreqOther > 0 \? _currentFreqOther : null/.test(m), 'TX only while split');
  assert.ok(/licenseClass: settings\.licenseClass/.test(m), 'band plan from the licence class');
  const brs = m.slice(m.indexOf('function broadcastRigState() {'), m.indexOf('function broadcastRigState() {') + 400);
  assert.ok(/scopeOverlaySync\(\)/.test(brs), 'broadcastRigState syncs the overlay');
  const nf = m.slice(m.indexOf('function yaesuScopeNoteFrequency(hz) {'), m.indexOf('function yaesuScopeNoteFrequency(hz) {') + 200);
  assert.ok(/scopeOverlaySync\(\)/.test(nf), 'a band change syncs it');
  assert.ok(/kv\.filter_lo !== undefined \|\| kv\.filter_hi !== undefined\) scopeOverlaySync\(\)/.test(m), 'Flex filter edges sync it');
});
test('surfaces draw the overlay through lib/scope-view.js', () => {
  assert.ok(/overlay: \{ passband: state\.passband, txHz: state\.txHz, bandPlan: state\.bandPlan, privileges: showPrivileges \}/.test(read('renderer/scope-popout.js')), 'pop-out');
  assert.ok(/id="sc-privileges"/.test(read('renderer/scope-popout.html')), 'pop-out switch');
  assert.ok(/overlay: \{ passband: st\.passband, txHz: st\.txHz, bandPlan: st\.bandPlan, privileges: scopePrivileges/.test(read('renderer/remote.js')), 'web');
  assert.ok(/id="scope-phone-privileges"/.test(read('renderer/remote.html')), 'web switch');
  assert.ok(/ScopeView\.drawOverlay\(ctx, \{[^}]*labels: false/.test(read('renderer/jtcat-popout.js')), 'JTCAT strip, no labels');
  assert.ok(/lsGet\('scope-privileges', '1'\) !== '0'/.test(read('renderer/scope-popout.js')), 'privileges on by default');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
