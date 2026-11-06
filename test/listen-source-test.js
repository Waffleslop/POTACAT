#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * Who you hear: the radio, or the SDR where the radio cannot go (Casey
 * 2026-10-30: "I may be making a QSO on HF via my Flex, then want to check
 * weather on NOAA ... I should only hear NOAA from the SDR, and when I go
 * back to a freq my Flex can reach, I should only hear my Flex.").
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/listen-source');
const { RIG_MODELS } = require('../lib/rig-models');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const FLEX = RIG_MODELS['FLEX-8400/8600'].rxHz;
const V4 = L.sdrReach({ kind: 'rtl_tcp', tunerType: 6, directSampling: 'off' });

console.log('Reach');
check('the 8600 receives 30 kHz to 54 MHz; an RTL-SDR V4 (R828D) 500 kHz to 1.7 GHz; a Kiwi HF', () => {
  assert.deepStrictEqual(FLEX, [[30e3, 54e6]]);
  assert.ok(L.covers(FLEX, 14.25e6) && L.covers(FLEX, 50.1e6) && !L.covers(FLEX, 162.475e6));
  assert.ok(L.covers(V4, 162.475e6) && L.covers(V4, 147.51e6) && L.covers(V4, 14.25e6));
  assert.ok(L.covers(L.sdrReach({ kind: 'kiwisdr' }), 7.2e6) && !L.covers(L.sdrReach({ kind: 'kiwisdr' }), 162e6));
});
check('an R820T hears from 24 MHz unless direct sampling is on; an unknown tuner gets the assumed range; a WebSDR has none', () => {
  assert.ok(!L.covers(L.sdrReach({ kind: 'rtl_tcp', tunerType: 5, directSampling: 'off' }), 7e6));
  assert.ok(L.covers(L.sdrReach({ kind: 'rtl_tcp', tunerType: 5, directSampling: 'q' }), 7e6));
  assert.deepStrictEqual(L.sdrReach({ kind: 'rtl_tcp', tunerType: null }), L.RTL_TCP_ASSUMED);
  assert.strictEqual(L.sdrReach({ kind: 'websdr' }), null);
  assert.ok(!L.covers(null, 7e6));
});
check('every model with a receive range covers every band it lists', () => {
  const { BANDS } = require('../lib/bands');
  for (const [name, m] of Object.entries(RIG_MODELS)) {
    if (!Array.isArray(m.rxHz)) continue;
    for (const r of m.rxHz) assert.ok(r[0] < r[1], name);
    for (const b of m.bands || []) { const e = BANDS[b]; if (e) assert.ok(L.covers(m.rxHz, e.lower * 1e6 + 1), `${name} lists ${b} but its receive range misses it`); }
  }
});

console.log('The decision (Casey\'s table)');
const sdr = { connected: true, reach: V4, manual: false };
check('14.250: the Flex, SDR connected or not', () => {
  assert.strictEqual(L.decide(14.25e6, FLEX, sdr).source, 'rig');
  assert.strictEqual(L.decide(14.25e6, FLEX, null).source, 'rig');
});
check('162.475 and 147.510: the SDR, because the Flex cannot go there', () => {
  assert.deepStrictEqual(L.decide(162.475e6, FLEX, sdr), { source: 'sdr', reason: 'out-of-rig-reach' });
  assert.strictEqual(L.decide(147.51e6, FLEX, sdr).source, 'sdr');
});
check('back to 14.250: the Flex again', () => {
  assert.strictEqual(L.decide(14.25e6, FLEX, sdr).source, 'rig');
});
check('450 MHz with no SDR, or an SDR that cannot hear it: refused with a reason', () => {
  assert.deepStrictEqual(L.decide(450e6, FLEX, null), { source: 'none', reason: 'rig-only' });
  assert.deepStrictEqual(L.decide(450e6, FLEX, { connected: true, reach: [[0, 30e6]], manual: false }), { source: 'none', reason: 'neither' });
  assert.deepStrictEqual(L.decide(450e6, null, null), { source: 'none', reason: 'no-rig' });
});
check('the operator\'s own choice of the SDR stays wherever the dial goes (local QRM on HF)', () => {
  assert.deepStrictEqual(L.decide(14.25e6, FLEX, { ...sdr, manual: true }), { source: 'sdr', reason: 'chosen' });
});
check('an SDR whose greeting has not named the tuner yet is trusted off the rig\'s range', () => {
  assert.strictEqual(L.decide(162.475e6, FLEX, { connected: true, reach: null, manual: false }).source, 'sdr');
});
check('the refusal names the frequency, the radio and the way out', () => {
  const r = L.refusal(450e6, L.decide(450e6, FLEX, null), 'FLEX-8400/8600');
  assert.ok(/450 MHz/.test(r) && /FLEX-8400\/8600/.test(r) && /WebSDR/.test(r), r);
  assert.ok(/cannot receive it either/.test(L.refusal(450e6, { source: 'none', reason: 'neither' }, 'the radio', 'pi')));
  assert.strictEqual(L.fmtMhz(162475000), '162.475 MHz');
  assert.strictEqual(L.fmtMhz(14250000), '14.25 MHz');
});

console.log('Wiring');
const main = readSrc(path.join(ROOT, 'main.js'));
const app = readSrc(path.join(ROOT, 'renderer/app.js'));
const vfo = readSrc(path.join(ROOT, 'renderer/vfo-popout.html'));
const preload = readSrc(path.join(ROOT, 'preload.js'));
check('tuneRadio asks the arbiter before anything moves; only the radio case carries on', () => {
  const i = main.indexOf("const who = listenSdrArbitrate(freqHz, mode, origin);");
  const j = main.indexOf('// Auto-tune KiwiSDR WebSDR to follow');
  const k = main.indexOf('cat.tune(tuneFreqHz, mode,');
  assert.ok(i > 0 && i < j && j < k);
  assert.ok(/if \(who !== 'rig'\) return;/.test(main));
});
check('the SDR speaks only while live; its idle connection is kept', () => {
  assert.ok(/kiwiClient\.on\('audio', \(pcmFloat, sampleRate\) => \{\s+if \(!listenSdr\.live\) return;/.test(main));
  const idle = /function kiwiGoIdle\(why\) \{[\s\S]*?\n\}/.exec(main)[0];
  assert.ok(!/disconnect\(\)/.test(idle), 'idle never disconnects');
  assert.ok(/sendCatFrequency\(_currentFreqHz\)/.test(idle), 'the readouts return to the radio');
});
check('while the SDR holds a frequency the radio cannot reach, the radio\'s dial is tracked, not shown, and the status says what you hear', () => {
  assert.ok(/function sdrHoldsDial\(\) \{ return !!\(listenSdr\.live && listenSdr\.auto\); \}/.test(main));
  assert.ok(/if \(sdrHoldsDial\(\) && hz !== listenSdr\.hz\) \{ _currentFreqHz = hz; return; \}/.test(main));
  assert.ok(/if \(!\(sdrHoldsDial\(\) && hz === listenSdr\.hz\)\) _currentFreqHz = hz;/.test(main));
  assert.ok(/freq: displayFreqHz\(\) \|\| 0,/.test(main));
  assert.ok(/undefined : \(displayFreqHz\(\) \|\| 0\);/.test(main));
  assert.ok(/undefined : \(displayMode\(\) \|\| ''\);/.test(main));
});
check('a Flex pan is never asked to centre on the SDR\'s frequency', () => {
  assert.ok(/if \(sdrHoldsDial\(\) && hz === listenSdr\.hz && yaesuScopeState\.source !== 'sdr'\) \{ hz = _currentFreqHz;/.test(main), 'the gate lives in yaesuScopeNoteFrequency');
});
// GitHub #117 (df1vb IC-7100 + WebSDR): a CHOSEN SDR is live with
// listenSdr.hz never set; keyed on live alone, every readout froze.
check('an SDR the operator chose follows the dial: the readouts show the radio', () => {
  const src = main.slice(main.indexOf('function sdrHoldsDial()'), main.indexOf('function displayMode()'));
  const fns = src + main.slice(main.indexOf('function displayMode()'), main.indexOf('\n', main.indexOf('function displayMode()')));
  const run = (live, auto, hz) => new Function('listenSdr', '_currentFreqHz', '_currentMode',
    fns + '\nreturn [displayFreqHz(), displayMode()];')({ live, auto, hz, mode: 'FM' }, 14285000, 'USB');
  assert.deepStrictEqual(run(true, false, 0), [14285000, 'USB'], 'chosen SDR: the dial');
  assert.deepStrictEqual(run(true, true, 162550000), [162550000, 'FM'], 'SDR took over: what you hear');
  assert.deepStrictEqual(run(false, false, 0), [14285000, 'USB'], 'no SDR: the dial');
});
check('PTT is refused while the SDR is live for a frequency the radio cannot reach', () => {
  assert.ok(/if \(state && listenSdr\.live && listenSdr\.auto\) \{[\s\S]{0,600}return;\s+\}/.test(main));
});
check('an operator\'s own SDR pick goes live at once; an automatic one waits for the arbiter', () => {
  assert.ok(/if \(kiwiManual\) kiwiGoLive\(false\);\s+else \{ broadcastKiwiStatus\(false, \{ available: true \}\); listenSdrResume\(\); \}/.test(main));
  assert.ok(/\{ host: rawHost, port: rawPort, password, auto \}/.test(main));
});
check('the main window learns the SDR\'s reach, and Landmarks shows what it can hear', () => {
  assert.ok(/onKiwiStatus: \(cb\) => ipcRenderer\.on\('kiwi-status'/.test(preload));
  assert.ok(/setTimeout\(kiwiStatusHint, 500\)/.test(main));
  assert.ok(/function lmkViaSdr\(lm\)/.test(app) && /ok: L\.receivable\(lm, rigBandsList\) \|\| viaSdr, viaSdr/.test(app));
  assert.ok(/class="lmk-sdr"/.test(app));
  assert.ok(/<script src="\.\.\/lib\/listen-source\.js"><\/script>/.test(readSrc(path.join(ROOT, 'renderer/index.html'))));
});
check('one volume knob: the VFO monitor volume drives the SDR audio too', () => {
  assert.ok(/kiwiVolume = monitorVolume;\s+if \(kiwiGainNode\) kiwiGainNode\.gain\.value = kiwiVolume;/.test(vfo));
  // The SDR card's own slider is shown only while VOL is off screen (#118,
  // test/vfo-sdr-volume-test.js) and moves the same value.
  assert.ok(/function syncSdrVolumeRow\(\)/.test(vfo));
});

// ── A radio known only by its bands (no published rxHz) ──────────────────────
const RigBands = require('../lib/rig-bands');
const { BANDS } = require('../lib/bands');
const rangesFor = (model) => (RigBands.bandsForRig(null, model, RIG_MODELS[model]) || [])
  .map((b) => BANDS[b]).filter(Boolean).map((e) => [e.lower * 1e6, e.upper * 1e6]);
check('FTX-1 (HF + 2 m + 70 cm, no published range) reaches NOAA weather 162.45 MHz and marine 156.8 MHz', () => {
  assert.ok(!RIG_MODELS['FTX-1 Field'].rxHz, 'premise: no published range');
  const reach = L.generalCoverage(rangesFor('FTX-1 Field'));
  assert.ok(L.covers(reach, 162.45e6) && L.covers(reach, 156.8e6));
  assert.strictEqual(L.decide(162.45e6, reach, null).source, 'rig');
});
check('an HF + 6 m radio still hands a 2 m click to the SDR', () => {
  const reach = L.generalCoverage([[1.8e6, 2e6], [14e6, 14.35e6], [50e6, 54e6]]);
  assert.ok(!L.covers(reach, 146.52e6));
  assert.strictEqual(L.decide(146.52e6, reach, sdr).source, 'sdr');
});
check('an HF radio hears WWV on 10 MHz between its bands', () => {
  assert.ok(L.covers(L.generalCoverage([[7e6, 7.3e6], [14e6, 14.35e6]]), 10e6));
});
check('no bands known: generalCoverage says nothing (main then never refuses)', () => {
  assert.strictEqual(L.generalCoverage([]), null);
  assert.strictEqual(L.generalCoverage(null), null);
});
check('main uses it for a rig known only by its bands; a published range still wins', () => {
  const at = main.indexOf('function rigReachNow()');
  const body = main.slice(at, main.indexOf('\n}', at));
  assert.ok(/if \(model && Array\.isArray\(model\.rxHz\) && model\.rxHz\.length\) return model\.rxHz;/.test(body));
  assert.ok(/return ListenSource\.generalCoverage\(out\) \|\| \[\[0, Infinity\]\];/.test(body));
});
check('main has BANDS in scope (hoogskev 11-01: the loop threw a ReferenceError, so every rig fell to the catch)', () => {
  assert.ok(/const \{[^}]*BANDS[^}]*\} = require\('\.\/lib\/bands'\)/.test(main), 'BANDS imported from lib/bands');
  // Run the loop body as main does, with the real table: an FTX-1's bands reach 70 cm.
  const { BANDS } = require('../lib/bands');
  const out = [];
  for (const b of ['160m', '20m', '6m', '2m', '70cm']) { const e = BANDS[b]; if (e) out.push([Math.round(e.lower * 1e6), Math.round(e.upper * 1e6)]); }
  const reach = L.generalCoverage(out);
  assert.ok(L.covers(reach, 162.55e6), 'NOAA between 2 m and 70 cm');
  assert.ok(!L.covers(reach, 1.2e9), 'not above the top band');
});

check('the VFO knob and wheel never step from an unknown dial of 0 (hoogskev 0.017.200)', () => {
  const vfo = readSrc(path.join(ROOT, 'renderer/vfo-popout.html'));
  assert.strictEqual((vfo.match(/if \(vfoLocked \|\| !currentFreqHz\) return;/g) || []).length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
