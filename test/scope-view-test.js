#!/usr/bin/env node
// test/scope-view-test.js — lib/scope-view.js (the band scope's shared
// geometry + trace painter) and the synced tuning step's wiring.
// Plan: docs/scope-improvements-plan.md Phase 0 + Decision 2.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/scope-view');
const A = require('../lib/scope-axis');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function isNice(step) {
  const p = Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
  const m = Math.round(step / p);
  return [1, 2, 5].includes(m) && Math.abs(step - m * p) < 1e-6 * p;
}

// Widths: a phone portrait scope (~320 CSS px), a narrow pop-out, a desktop
// pop-out, a wide monitor at 2x DPR.
const WIDTHS = [240, 320, 480, 850, 1280, 1920, 3840];
const SPANS = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 1600000];
const CENTRES = [1840000, 7074000, 14074000, 14285500, 28074000, 50313000, 144174000];

console.log('Scope view — frequency ticks');

test('niceStep returns 1/2/5 x 10^n at or above its input', () => {
  for (const x of [0.3, 1, 1.01, 1.9, 2, 2.1, 4.99, 5, 7, 9.99, 10, 33, 470, 1234, 99999]) {
    const s = V.niceStep(x);
    assert.ok(isNice(s), `${x} → ${s}`);
    assert.ok(s >= x - 1e-9, `${x} → ${s} is below`);
    assert.ok(s < x * 2.6, `${x} → ${s} is not the smallest`);
  }
});

test('ticks land on round numbers, labels never overlap, every span at every width', () => {
  for (const c of CENTRES) for (const s of SPANS) for (const w of WIDTHS) {
    const axis = A.scopeAxis({ centerHz: c, spanHz: s, anchor: 'center' });
    const t = V.frequencyTicks(axis, w);
    const where = `centre ${c} span ${s} width ${w}`;
    assert.ok(isNice(t.stepHz), `${where}: step ${t.stepHz}`);
    assert.ok(t.major.length >= 1, `${where}: no labelled tick`);
    for (const m of t.major) {
      assert.strictEqual(m.hz % t.stepHz, 0, `${where}: ${m.hz} not on the step`);
      assert.ok(m.x >= -0.01 && m.x <= w, `${where}: x ${m.x} off the canvas`);
      assert.strictEqual(Math.round(Number(m.label) * 1e6), m.hz, `${where}: label ${m.label} is not ${m.hz}`);
    }
    for (let i = 1; i < t.major.length; i++) {
      const gap = t.major[i].x - t.major[i - 1].x;
      const widest = Math.max(t.major[i].label.length, t.major[i - 1].label.length) * V.CHAR_PX;
      assert.ok(gap >= 70 - 1e-6, `${where}: labels ${gap.toFixed(1)} px apart`);
      assert.ok(gap >= widest + 1, `${where}: labels overlap (${gap.toFixed(1)} px for ${widest} px of text)`);
    }
    for (const m of t.minor) assert.ok(m.hz % t.stepHz !== 0, `${where}: minor ${m.hz} is a major`);
  }
});

test('labels carry the decimals the step needs, no more', () => {
  const axis = (span) => A.scopeAxis({ centerHz: 14074000, spanHz: span, anchor: 'center' });
  const big = V.frequencyTicks(axis(200000), 850);
  assert.ok(big.major.every((m) => /^1[34]\.\d{3}$/.test(m.label)), big.major.map((m) => m.label).join(' '));
  const small = V.frequencyTicks(axis(2000), 1920);
  assert.ok(small.stepHz < 1000, 'a 2 kHz span on a wide screen steps below 1 kHz');
  assert.ok(small.major.every((m) => m.label.split('.')[1].length > 3), small.major.map((m) => m.label).join(' '));
});

test('an empty axis or a too-narrow canvas gives no ticks', () => {
  assert.deepStrictEqual(V.frequencyTicks(A.scopeAxis({ centerHz: 0, spanHz: 0 }), 850).major, []);
  assert.deepStrictEqual(V.frequencyTicks(A.scopeAxis({ centerHz: 14074000, spanHz: 10000 }), 1).major, []);
});

console.log('Scope view — level ticks');

test('a calibrated scale gets labelled lines on round dB values', () => {
  for (const sc of [{ unit: 'dBm', min: -130, max: -40 }, { unit: 'dBm', min: -100, max: 0 }, { unit: 'dB', min: 0, max: 60 }]) {
    for (const h of [40, 80, 160, 400, 900]) {
      const t = V.levelTicks(sc, h);
      assert.ok(isNice(t.stepDb), `${JSON.stringify(sc)} h ${h}: step ${t.stepDb}`);
      for (const l of t.lines) {
        assert.ok(Math.abs(l.value / t.stepDb - Math.round(l.value / t.stepDb)) < 1e-9, `${l.value} off the step`);
        assert.ok(l.y > 0 && l.y < h, 'inside the canvas');
        assert.strictEqual(l.label, String(l.value));
      }
      for (let i = 1; i < t.lines.length; i++) assert.ok(t.lines[i].y - t.lines[i - 1].y >= 18 - 1e-6, 'at least 18 px apart');
    }
  }
});

test('an uncalibrated source gets grid lines and never a number', () => {
  for (const sc of [null, { unit: null }, { unit: 'dBm' }, { unit: 'dBm', min: 0, max: 0 }]) {
    const t = V.levelTicks(sc, 200);
    assert.strictEqual(t.lines.length, 3);
    assert.ok(t.lines.every((l) => l.value === null && l.label === null));
  }
});

console.log('Scope view — the one painter');

// A minimal recording 2D context: enough to run drawTrace and see what it drew.
function fakeCtx(w, h) {
  const ops = [];
  const ctx = {
    canvas: { width: w, height: h }, ops,
    fillRect: (...a) => ops.push(['fillRect', ...a]),
    beginPath: () => ops.push(['beginPath']), moveTo: (x, y) => ops.push(['moveTo', x, y]), lineTo: (x, y) => ops.push(['lineTo', x, y]),
    stroke: () => ops.push(['stroke', ctx.strokeStyle]), fill: () => ops.push(['fill']), closePath: () => {},
    fillText: (t) => ops.push(['fillText', t, ctx.fillStyle]),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  return ctx;
}

test('draws the trace, the dial, and peak hold only when asked', () => {
  const axis = A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'center' });
  const bins = new Uint8Array(850).fill(40); bins[425] = 250;
  const peak = new Float32Array(850).fill(60);
  const ctx = fakeCtx(850, 200);
  V.drawTrace(ctx, { bins, peak }, { w: 850, h: 200, dpr: 1, axis, dialHz: 14074000, spanHz: 10000, anchor: 'center', peakHold: false });
  const strokes = ctx.ops.filter((o) => o[0] === 'stroke').map((o) => o[1]);
  assert.ok(strokes.includes('#4fc3f7'), 'trace line');
  assert.ok(strokes.includes('#e94560'), 'dial marker');
  assert.ok(!strokes.includes('rgba(240,165,0,0.55)'), 'no peak line when off');
  const ctx2 = fakeCtx(850, 200);
  V.drawTrace(ctx2, { bins, peak }, { w: 850, h: 200, dpr: 1, axis, dialHz: 14074000, peakHold: true });
  assert.ok(ctx2.ops.some((o) => o[0] === 'stroke' && o[1] === 'rgba(240,165,0,0.55)'), 'peak line when on');
});

test('any bin count (the web gets 256), and no dial off the window', () => {
  const axis = A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'center', bins: 256 });
  const ctx = fakeCtx(320, 80);
  V.drawTrace(ctx, { bins: new Uint8Array(256).fill(100), peak: null }, { w: 320, h: 80, axis, dialHz: 14090000 });
  const strokes = ctx.ops.filter((o) => o[0] === 'stroke').map((o) => o[1]);
  assert.ok(strokes.includes('#4fc3f7'));
  assert.ok(!strokes.includes('#e94560'), 'dial outside the span is not drawn');
});

test('the "axis assumed" notice: FIX/CURSOR only, and a page can turn it off', () => {
  const axis = A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'fix' });
  const on = fakeCtx(850, 200);
  V.drawTrace(on, { bins: null }, { axis, spanHz: 10000, anchor: 'fix' });
  assert.ok(on.ops.some((o) => o[0] === 'fillText' && /FIX mode/.test(o[1])));
  const off = fakeCtx(850, 200);
  V.drawTrace(off, { bins: null }, { axis, spanHz: 10000, anchor: 'fix', notice: false });
  assert.ok(!off.ops.some((o) => o[0] === 'fillText'));
  const centre = fakeCtx(850, 200);
  V.drawTrace(centre, { bins: null }, { axis: A.scopeAxis({ centerHz: 14074000, spanHz: 10000 }), spanHz: 10000, anchor: 'center' });
  assert.ok(!centre.ops.some((o) => o[0] === 'fillText'));
});

console.log('Scope view — every surface draws with it');

test('the pop-out and ECHOCAT Web call ScopeView.drawTrace, and keep no trace loop of their own', () => {
  const pop = read('renderer/scope-popout.js');
  const html = read('renderer/scope-popout.html');
  const web = read('renderer/remote.js');
  const page = read('renderer/remote.html');
  const server = read('lib/remote-server.js');
  assert.ok(/ScopeView\.drawTrace\(/.test(pop), 'pop-out');
  assert.ok(html.indexOf('../lib/scope-view.js') > html.indexOf('../lib/scope-axis.js') && html.indexOf('../lib/scope-view.js') < html.indexOf('scope-popout.js"'), 'pop-out loads it before its own script');
  assert.ok(/window\.ScopeView\.drawTrace\(/.test(web), 'web');
  assert.ok(page.includes('<!-- scope-view-js -->'), 'web page marker');
  assert.ok(server.includes("['scope-view-js', 'scope-view.js']"), 'remote-server inlines it');
  assert.ok(!/createLinearGradient/.test(pop), 'pop-out has no trace painter of its own');
  const fn = web.slice(web.indexOf('function scopeDrawTrace('), web.indexOf('function scopeDrawAll('));
  assert.ok(!/lineTo/.test(fn), 'web scopeDrawTrace has no loop of its own');
});

console.log('Scope view — levels: scale, window, averaging, readout (Phases 1-2)');

const S = require('../lib/sdr-scope');

test('the level window with the top at full scale IS the old Floor, value for value', () => {
  const bins = new Uint8Array(850);
  for (let i = 0; i < bins.length; i++) bins[i] = (i * 37 + (i >> 3) * 11) % 256;
  for (const f of [0, 1, 5, 20, 37, 100, 150, 200]) {
    assert.deepStrictEqual(Array.from(V.applyRange(bins, f, 255)), Array.from(A.applyFloor(bins, f)), `floor ${f}`);
  }
  assert.strictEqual(V.applyRange(bins, 0, 255), bins, 'full range hands the frame through untouched');
});

test('the window is clamped, moved and zoomed without leaving 0..255 or getting thinner than MIN_RANGE', () => {
  assert.deepStrictEqual(V.clampRange(-20, 400), { lo: 0, hi: 255 });
  assert.deepStrictEqual(V.clampRange(250, 251), { lo: 255 - V.MIN_RANGE, hi: 255 });
  assert.deepStrictEqual(V.clampRange(100, 105), { lo: 100, hi: 100 + V.MIN_RANGE });
  assert.deepStrictEqual(V.shiftRange({ lo: 50, hi: 150 }, 30), { lo: 80, hi: 180 });
  assert.deepStrictEqual(V.shiftRange({ lo: 50, hi: 150 }, 500), { lo: 155, hi: 255 }, 'stops at the top, width kept');
  assert.deepStrictEqual(V.shiftRange({ lo: 50, hi: 150 }, -500), { lo: 0, hi: 100 }, 'stops at the bottom, width kept');
  const wide = V.zoomRange({ lo: 100, hi: 150 }, 2);
  assert.strictEqual(wide.hi - wide.lo, 100);
  assert.deepStrictEqual(V.zoomRange({ lo: 0, hi: 255 }, 2), { lo: 0, hi: 255 });
  const thin = V.zoomRange({ lo: 100, hi: 120 }, 0.1);
  assert.strictEqual(thin.hi - thin.lo, V.MIN_RANGE);
});

test('the displayed scale follows the window; an uncalibrated source never gets numbers', () => {
  const flex = { unit: 'dBm', min: -130, max: -40 };
  const d = V.displayScale(flex, 51, 204);
  assert.strictEqual(d.unit, 'dBm');
  assert.ok(Math.abs(d.min - (-130 + 51 / 255 * 90)) < 1e-9 && Math.abs(d.max - (-130 + 204 / 255 * 90)) < 1e-9);
  assert.deepStrictEqual(V.displayScale(flex, 0, 255), { unit: 'dBm', min: -130, max: -40 });
  for (const sc of [null, { unit: null, min: 0, max: 255 }]) assert.strictEqual(V.displayScale(sc, 20, 200).unit, null);
  assert.strictEqual(V.dbAtLevel({ unit: null, min: 0, max: 255 }, 100), null);
});

test('level lines for every unit: dBm, the radio\'s scale and dB over noise are labelled; none is not', () => {
  for (const sc of [{ unit: 'dBm', min: -130, max: -40 }, { unit: 'radio', min: -80, max: 0 }, S.levelScale()]) {
    const t = V.levelTicks(sc, 134);
    assert.ok(t.lines.length >= 2, sc.unit);
    assert.ok(t.lines.every((l) => l.label !== null && Number.isFinite(l.value)), sc.unit);
  }
  assert.ok(V.levelTicks({ unit: null, min: 0, max: 255 }, 134).lines.every((l) => l.label === null));
  assert.strictEqual(V.unitLabel('dBm'), 'dBm');
  assert.strictEqual(V.unitLabel('radio'), 'dB (radio)');
  assert.strictEqual(V.unitLabel('dB'), 'dB over noise');
  assert.strictEqual(V.unitLabel(null), '');
});

test('the SDR scale is its real mapping: 60 dB over the tracked floor, level 0 at -3 dB', () => {
  assert.deepStrictEqual(S.levelScale(), { unit: 'dB', min: -3, max: 57 });
  const power = new Float64Array(400).fill(1);   // 0 dB everywhere: the floor
  power[200] = 1000;                              // one bin 30 dB above it
  const lv = S.toLevels(power, {});
  assert.strictEqual(lv[200], Math.round(33 / 60 * 255));
  assert.ok(Math.abs(V.dbAtLevel(S.levelScale(), lv[200]) - 30) < 0.2, 'reads back as 30 dB over noise');
  assert.strictEqual(V.dbAtLevel(S.levelScale(), lv[10]), 0 - 3 + Math.round(3 / 60 * 255) * 60 / 255);
});

test('averaging: the four choices, and Light is exactly the old trace smoothing', () => {
  assert.deepStrictEqual(V.AVERAGING, { off: 1, light: 0.55, medium: 0.3, heavy: 0.15 });
  const acc = new Float32Array([10, 200, 50]);
  const old = Array.from(acc).map((s, i) => s * 0.45 + [100, 0, 50][i] * 0.55);
  V.smoothInto(acc, [100, 0, 50], V.AVERAGING.light);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(acc[i] - old[i]) < 1e-4);
  const off = new Float32Array([10, 20]);
  V.smoothInto(off, [99, 1], V.AVERAGING.off);
  assert.deepStrictEqual(Array.from(off), [99, 1], 'Off shows each frame as it comes');
  const heavy = new Float32Array([0]);
  V.smoothInto(heavy, [100], V.AVERAGING.heavy);
  assert.ok(Math.abs(heavy[0] - 15) < 1e-4);
});

test('peak hold: Slow is the old 0.6 per frame, Hold never decays, Fast falls faster', () => {
  assert.deepStrictEqual(V.PEAK_DECAY, { fast: 3, slow: 0.6, hold: 0 });
  const p = new Float32Array([200]);
  V.peakInto(p, [10], V.PEAK_DECAY.slow);
  assert.ok(Math.abs(p[0] - 199.4) < 1e-4);
  const h = new Float32Array([200]);
  for (let i = 0; i < 1000; i++) V.peakInto(h, [10], V.PEAK_DECAY.hold);
  assert.strictEqual(h[0], 200);
  const f = new Float32Array([200]);
  V.peakInto(f, [10], V.PEAK_DECAY.fast);
  assert.strictEqual(f[0], 197);
  V.peakInto(f, [250], V.PEAK_DECAY.fast);
  assert.strictEqual(f[0], 250, 'a new peak replaces it at once');
});

test('the cursor readout: precision for the span, a level only when the source has one', () => {
  const flex = { unit: 'dBm', min: -130, max: -40 };
  assert.strictEqual(V.formatReadout(14074153, 108, flex, 10000), '14.07415 MHz · -92 dBm');
  assert.strictEqual(V.formatReadout(14074153, 108, flex, 200000), '14.0742 MHz · -92 dBm');
  assert.strictEqual(V.formatReadout(14074153, 140, S.levelScale(), 200000), '14.0742 MHz · +30 dB over noise');
  assert.strictEqual(V.formatReadout(7074000, 102, { unit: 'radio', min: -80, max: 0 }, 50000), '7.07400 MHz · -48 dB (radio scale)');
  assert.strictEqual(V.formatReadout(14074153, 108, { unit: null, min: 0, max: 255 }, 10000), '14.07415 MHz');
  assert.strictEqual(V.formatReadout(14074153, null, flex, 10000), '14.07415 MHz');
  assert.strictEqual(V.formatReadout(0, 108, flex, 10000), '');
  assert.strictEqual(V.levelAt(new Uint8Array([1, 2, 3, 4, 5]), 0.5), 3);
  assert.strictEqual(V.levelAt(null, 0.5), null);
});

test('S-units: S9 at -73 dBm, 6 dB a unit, dBm scales only, never crowded', () => {
  const marks = V.sUnitMarks({ unit: 'dBm', min: -130, max: -10 }, 400);
  const s9 = marks.find((m) => m.label === 'S9');
  assert.ok(s9 && s9.dbm === -73);
  assert.ok(marks.find((m) => m.label === 'S1').dbm === -121);
  assert.ok(marks.find((m) => m.label === '+20').dbm === -53);
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i].y - marks[i - 1].y >= 12);
  assert.deepStrictEqual(V.sUnitMarks({ unit: 'dB', min: -3, max: 57 }, 400), []);
  assert.deepStrictEqual(V.sUnitMarks({ unit: null }, 400), []);
});

test('the trace gutter labels a calibrated scale and stays silent for an uncalibrated one', () => {
  const axis = A.scopeAxis({ centerHz: 14074000, spanHz: 200000, anchor: 'pan' });
  const bins = new Uint8Array(850).fill(60);
  const on = fakeCtx(850, 140);
  V.drawTrace(on, { bins }, { w: 850, h: 140, axis, dialHz: 14074000, scale: { unit: 'dBm', min: -130, max: -40 }, gutter: true, sUnits: true });
  const texts = on.ops.filter((o) => o[0] === 'fillText').map((o) => o[1]);
  assert.ok(texts.includes('dBm'), 'unit caption');
  assert.ok(texts.includes('-60') && texts.includes('-100'), texts.join(' '));
  assert.ok(texts.includes('S9'), 'S-units when asked');
  const off = fakeCtx(850, 140);
  V.drawTrace(off, { bins }, { w: 850, h: 140, axis, dialHz: 14074000, scale: { unit: null, min: 0, max: 255 }, gutter: true, sUnits: true });
  assert.ok(!off.ops.some((o) => o[0] === 'fillText'), 'no numbers, no caption, no S-units');
});

test('the frequency strip: round labels, the dial in red, "axis assumed" when the edges are guessed', () => {
  const known = fakeCtx(850, 20);
  V.drawFreqScale(known, { w: 850, h: 20, axis: A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'center' }), dialHz: 14074000 });
  const kt = known.ops.filter((o) => o[0] === 'fillText');
  assert.ok(kt.some((o) => o[1] === '14.074' && o[2] === '#e94560'), 'dial label in red');
  assert.ok(kt.some((o) => /^14\.07[0-9]+$/.test(o[1]) && o[2] !== '#e94560'), 'round labels');
  assert.ok(!kt.some((o) => o[1] === 'axis assumed'));
  const guessed = fakeCtx(850, 20);
  V.drawFreqScale(guessed, { w: 850, h: 20, axis: A.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'fix' }), dialHz: 14074000 });
  assert.ok(guessed.ops.some((o) => o[0] === 'fillText' && o[1] === 'axis assumed'));
  const none = fakeCtx(850, 20);
  V.drawFreqScale(none, { w: 850, h: 20, axis: A.scopeAxis({ centerHz: 0, spanHz: 0 }) });
  assert.deepStrictEqual(none.ops.filter((o) => o[0] === 'fillText').map((o) => o[1]), ['—']);
});

test('main: scope-state carries levelScale from the source, and dbmMin/dbmMax stay for the phone', () => {
  const m = read('main.js');
  const fn = m.slice(m.indexOf('function scopeLevelScale('), m.indexOf('\n}', m.indexOf('function scopeLevelScale(')));
  assert.ok(/s\.kind === 1\) return \{ unit: null/.test(fn), 'synthetic = uncalibrated');
  assert.ok(/s\.source === 'flex'/.test(fn) && /unit: 'dBm', min: c\.dbmMin, max: c\.dbmMax/.test(fn), 'Flex = dBm from the pan');
  assert.ok(/s\.source === 'sdr'\) return SdrScope\.levelScale\(\)/.test(fn), 'SDR = its real mapping');
  const local = m.slice(m.indexOf('function yaesuScopeStatePayload('), m.indexOf('\n}', m.indexOf('function yaesuScopeStatePayload(')));
  const remote = m.slice(m.indexOf('function yaesuScopeRemotePayload('), m.indexOf('\n}', m.indexOf('function yaesuScopeRemotePayload(')));
  assert.ok(/levelScale: scopeLevelScale\(\)/.test(local), 'the pop-out and JTCAT window get it');
  assert.ok(/levelScale: scopeLevelScale\(\)/.test(remote), 'ECHOCAT devices get it');
  assert.ok(/\.\.\.scopeCalibration\(\)/.test(remote), 'dbmMin/dbmMax kept on the wire');
});

test('surfaces: one level window, the old floor keys kept, the strip everywhere', () => {
  const pop = read('renderer/scope-popout.js');
  const popHtml = read('renderer/scope-popout.html');
  const web = read('renderer/remote.js');
  const webHtml = read('renderer/remote.html');
  const jt = read('renderer/jtcat-popout.js');
  const jtHtml = read('renderer/jtcat-popout.html');
  assert.ok(/lsGet\('scope-floor', 0\)/.test(pop) && /lsSet\('scope-floor', range\.lo\)/.test(pop), 'pop-out: the floor key is the bottom');
  assert.ok(/V\.applyRange\(raw, range\.lo, range\.hi\)/.test(pop) && /V\.displayScale\(state\.levelScale/.test(pop), 'pop-out: window + scale');
  assert.ok(/ScopeView\.drawFreqScale\(/.test(pop) && popHtml.includes('id="sc-freq"') && !popHtml.includes('sc-ax-lo'), 'pop-out: strip replaces the lo/centre/hi text');
  assert.ok(!/applyFloor/.test(pop), 'pop-out: no second floor path');
  assert.ok(/scopeLsGet\('echocat-scope-floor', 0\)/.test(web) && /scopeLsSet\('echocat-scope-floor', scopeRange\.lo\)/.test(web), 'web: the floor key is the bottom');
  assert.ok(/window\.ScopeView\.drawFreqScale\(/.test(web) && webHtml.includes('id="scope-phone-freq"') && webHtml.includes('id="ft8-bs-freq"'), 'web: both strips');
  assert.ok(!webHtml.includes('scope-phone-ax-lo') && !webHtml.includes('ft8-bs-lo'), 'web: lo/centre/hi text gone');
  assert.ok(/gutter: sf\.full/.test(web), 'web: gutter on the Scope tab only');
  assert.ok(/window\.ScopeView\.drawFreqScale\(/.test(jt) && jtHtml.includes('id="jp-bs-freq"') && jtHtml.includes('../lib/scope-view.js'), 'JTCAT strip: frequency scale');
  assert.ok(/applyFloor\(f\.bins, wfFloor\)/.test(jt), 'JTCAT strip keeps the shared JTCAT floor');
});

console.log('Tuning step — one value for the VFO window, the scope and every device');

test('main: one writer, refuses unknown steps, persists, pushes both windows and devices', () => {
  const m = read('main.js');
  assert.ok(/'tuneStepHz',/.test(m.slice(m.indexOf('const GLOBAL_KEYS'), m.indexOf(']);', m.indexOf('const GLOBAL_KEYS')))), 'GLOBAL_KEY');
  const fn = m.slice(m.indexOf('function applyTuneStep('), m.indexOf('\n}', m.indexOf('function applyTuneStep(')));
  assert.ok(/TUNE_STEPS_HZ\.includes\(v\)\) return false/.test(fn), 'refuses a step not in the list');
  assert.ok(/saveSettings\(settings\)/.test(fn), 'persists');
  assert.ok(/vfoPopoutWin, scopePopoutWin/.test(fn) && /'tune-step', v/.test(fn), 'both windows');
  assert.ok(/broadcastTuneStep\(v\)/.test(fn), 'every device');
  assert.ok(/ipcMain\.on\('tune-step-set', \(_e, hz\) => \{ applyTuneStep\(hz, 'desktop'\); \}\)/.test(m), 'desktop IPC');
  assert.ok(/ipcMain\.handle\('tune-step-get'/.test(m), 'windows read it at open');
  assert.ok(/remoteServer\.on\('set-tune-step', \(\{ hz \}\) => \{ applyTuneStep\(hz, 'remote'\); \}\)/.test(m), 'device sets go through the same writer');
  assert.ok(/broadcastTuneStep\(currentTuneStepHz\(\)\)/.test(m), 'hydrated at connect and after a refusal');
  assert.ok(/const TUNE_STEPS_HZ = \[10, 50, 100, 500, 1000, 5000, 10000, 25000\]/.test(m));
});

test('the VFO window list is main\'s list, and its select reports and follows', () => {
  const m = read('main.js');
  const v = read('renderer/vfo-popout.html');
  const listMain = m.match(/const TUNE_STEPS_HZ = \[([^\]]+)\]/)[1].split(',').map((x) => Number(x.trim()));
  const block = v.slice(v.indexOf('const STEPS = ['), v.indexOf('];', v.indexOf('const STEPS = [')));
  const listVfo = [...block.matchAll(/hz: (\d+)/g)].map((x) => Number(x[1]));
  assert.deepStrictEqual(listVfo, listMain);
  assert.ok(/window\.api\.setTuneStep\(STEPS\[stepIdx\]\.hz\)/.test(v), 'a change is sent');
  assert.ok(/window\.api\.onTuneStep\(applyStepHz\)/.test(v) && /tuneStepGet\(\)\.then\(applyStepHz\)/.test(v), 'follows and starts from the setting');
  for (const p of ['preload-vfo-popout.js', 'preload-scope-popout.js']) {
    const s = read(p);
    assert.ok(/tuneStepGet: \(\) => ipcRenderer\.invoke\('tune-step-get'\)/.test(s) && /'tune-step-set'/.test(s) && /on\('tune-step'/.test(s), p);
  }
  assert.ok(/window\.api\.onTuneStep\(/.test(read('renderer/scope-popout.js')), 'scope pop-out holds it');
});

test('ECHOCAT: guest refused, capability, protocol rows, web client stores it', () => {
  const s = read('lib/remote-server.js');
  const c = s.slice(s.indexOf("case 'set-tune-step':"), s.indexOf('break;', s.indexOf("this.emit('set-tune-step'")));
  assert.ok(/_guestLocked\(ws\)\) \{ this\.emit\('tune-step-refused'\); break; \}/.test(c), 'Guest Pass refused');
  assert.ok(/'tune-step'/.test(s.slice(s.indexOf('capabilities: ['), s.indexOf(']', s.indexOf('capabilities: [')))), 'hello capability');
  assert.ok(/type: 'tune-step', hz: v/.test(s), 'S2C shape');
  const P = require('../lib/echocat-protocol');
  const table = P.MESSAGES || P.messages || P.PROTOCOL || P;
  const src = read('lib/echocat-protocol.js');
  assert.ok(/'set-tune-step': \{ dir: Dir\.C2S/.test(src) && /'tune-step': \{ dir: Dir\.S2C/.test(src), 'protocol rows');
  assert.ok(table, 'protocol module loads');
  assert.ok(/case 'tune-step':/.test(read('renderer/remote.js')), 'web client handles it');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
