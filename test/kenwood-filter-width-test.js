#!/usr/bin/env node
'use strict';
/**
 * Kenwood TS-590S/SG and TS-890S filter width (found 2026-11-01 by the
 * website session's check against Kenwood's own command guides; no owner
 * report yet). POTACAT sent FW in every mode:
 *   - TS-590S/SG guide p. 12: "The FW command cannot be used in SSB or AM
 *     mode. Use the SH and SL commands." SSB/FM: SH high cut, SL low cut;
 *     SSB-DATA: SH = shift, SL = width (p. 24).
 *   - TS-890S guide: FW is FM normal/narrow only (p. 34); SH0nnn high cut by
 *     ID (p. 60); SL0nn low cut, or the width in CW/FSK/PSK (p. 61).
 * The TS-480 rule (high cut over the operator's low cut) is unchanged.
 *
 * Run: node test/kenwood-filter-width-test.js
 */
const assert = require('assert');
const { RIG_MODELS } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

/** A codec in `mode` (as the radio reports it), DATA as POTACAT last set it. */
function codec(model, mode, { data = false } = {}) {
  const out = [];
  const c = new KenwoodCodec(RIG_MODELS[model], (d) => out.push(d));
  const ev = { passband: null, logs: [] };
  c.on('passband', (p) => { ev.passband = p; });
  c.on('log', (l) => ev.logs.push(l));
  c.setMode(data ? 'DIGU' : (mode === 'USB' || mode === 'LSB' ? mode : mode), 14200000);
  c.lastMode = mode;
  out.length = 0;
  return { c, out, ev };
}
const width = (model, mode, hz, opts) => { const k = codec(model, mode, opts); k.c.setFilterWidth(hz); return k; };

// ── TS-590S/SG ──────────────────────────────────────────────────────────────
test('TS-590SG SSB: never FW; a high cut over the low cut (SH 2 digits)', () => {
  const k = width('TS-590S/SG', 'USB', 2400);
  assert.ok(!k.out.some((x) => x.startsWith('FW')), k.out.join(''));
  assert.ok(k.out.includes('SH09;'), k.out.join(''));   // assumed 300 low + 2400 -> 2800 = index 9
});
test('TS-590SG SSB with the real low cut read back: SL02 (100 Hz) + 2400 -> first high cut at or above 2500 = SH08 (2600)', () => {
  const k = codec('TS-590S/SG', 'USB');
  k.c.onData('SL02;');
  k.out.length = 0;
  k.c.setFilterWidth(2400);
  assert.deepStrictEqual(k.out, ['SH08;']);
  assert.strictEqual(k.ev.passband, 2500);   // the achieved width, reported as it is
});
test('TS-590SG AM uses the AM tables (high 2500/3000/4000/5000)', () => {
  const k = codec('TS-590S/SG', 'AM');
  k.c.onData('SL00;');
  k.out.length = 0;
  k.c.setFilterWidth(4000);
  assert.deepStrictEqual(k.out, ['SH02;']);
});
test('TS-590SG SSB-DATA: the width is SL by index (SL13 = 2500), never SH (the shift)', () => {
  const k = width('TS-590S/SG', 'USB', 2500, { data: true });
  assert.deepStrictEqual(k.out, ['SL13;']);
  assert.strictEqual(k.ev.passband, 2500);
});
test('TS-590SG CW keeps FW in Hz, snapped to the radio\'s widths', () => {
  assert.deepStrictEqual(width('TS-590S/SG', 'CW', 500).out, ['FW0500;']);
  assert.deepStrictEqual(width('TS-590S/SG', 'CW', 700).out, ['FW0600;']);
});
test('TS-590SG reads DATA back on the slow poll (DA;), and a DA reply moves the width rule', () => {
  const k = codec('TS-590S/SG', 'USB');
  k.c.getDataMode();
  assert.deepStrictEqual(k.out, ['DA;']);
  k.c.onData('DA1;');
  k.out.length = 0;
  k.c.setFilterWidth(2500);
  assert.deepStrictEqual(k.out, ['SL13;']);
});
test('TS-590SG SSB-DATA readback: SL is the width; SH (shift) is not a width', () => {
  const k = codec('TS-590S/SG', 'USB', { data: true });
  k.c.onData('SH05;');
  assert.strictEqual(k.ev.passband, null);
  k.c.onData('SL12;');
  assert.strictEqual(k.ev.passband, 2000);
});

// ── TS-890S ─────────────────────────────────────────────────────────────────
test('TS-890S SSB: SH0nnn by ID (018 = 2400 Hz) over the low cut, never FW', () => {
  const k = codec('TS-890S', 'USB');
  k.c.onData('SL000;');                     // low cut 0 Hz
  k.out.length = 0;
  k.c.setFilterWidth(2400);
  assert.deepStrictEqual(k.out, ['SH0018;']);
  assert.strictEqual(k.ev.passband, 2400);
});
test('TS-890S SSB readback: SH0024 over SL003 = 3000 - 200 = 2800', () => {
  const k = codec('TS-890S', 'USB');
  k.c.onData('SL003;');
  k.c.onData('SH0024;');
  assert.strictEqual(k.ev.passband, 2800);
});
test('TS-890S CW: the width is SL0nn (SL010 = 500 Hz, the guide\'s own example)', () => {
  const k = width('TS-890S', 'CW', 500);
  assert.deepStrictEqual(k.out, ['SL010;']);
  assert.strictEqual(k.ev.passband, 500);
});
test('TS-890S FSK: SL0nn from the FSK column (300 Hz = 01)', () => {
  assert.deepStrictEqual(width('TS-890S', 'RTTY', 300).out, ['SL001;']);
});
test('TS-890S AM uses its own tables (013 = 5.0 kHz)', () => {
  const k = codec('TS-890S', 'AM');
  k.c.onData('SL000;');
  k.out.length = 0;
  k.c.setFilterWidth(5000);
  assert.deepStrictEqual(k.out, ['SH0013;']);
});
test('TS-890S SSB-DATA: nothing is sent (its filter type is a radio menu), said once in the log', () => {
  const k = width('TS-890S', 'USB', 2500, { data: true });
  assert.deepStrictEqual(k.out, []);
  k.c.setFilterWidth(2000);
  assert.strictEqual(k.ev.logs.filter((l) => /DATA width to the radio/.test(l)).length, 1);
});
test('TS-890S reads its passband with SH0; / SL0;, and CW with SL0; only', () => {
  const ssb = codec('TS-890S', 'USB');
  ssb.c.getFilter();
  assert.deepStrictEqual(ssb.out, ['SL0;', 'SH0;']);
  const cw = codec('TS-890S', 'CW');
  cw.c.getFilter();
  assert.deepStrictEqual(cw.out, ['SL0;']);
});
test('TS-890S table length matches the guide (SSB high IDs 000-027, low 00-21, CW 00-18)', () => {
  const sf = RIG_MODELS['TS-890S'].slopeFilters;
  assert.strictEqual(sf.high.length, 28);
  assert.strictEqual(sf.high[18], 2400);
  assert.strictEqual(sf.low.length, 22);
  assert.strictEqual(sf.widths.CW.length, 19);
  assert.strictEqual(sf.widths.CW[10], 500);
});

// ── unchanged ───────────────────────────────────────────────────────────────
test('TS-480 is unchanged: SSB high cut SHnn, CW through FW slots', () => {
  const k = codec('TS-480', 'USB');
  k.c.onData('SL03;');                       // 200 Hz
  k.out.length = 0;
  k.c.setFilterWidth(2400);
  assert.deepStrictEqual(k.out, ['SH08;']);  // 2600
  assert.strictEqual(width('TS-480', 'CW', 500).out[0], 'FW0500;');
});
test('a rig with no slope tables never polls DA', () => {
  const k = codec('TS-2000', 'USB');
  k.c.getDataMode();
  assert.deepStrictEqual(k.out, []);
});

test('TS-890S reads its meter with SM; and answers four digits, S9 = 35 (guide p. 61)', () => {
  const model = RIG_MODELS['TS-890S'];
  assert.strictEqual(model.smQuery, 'SM;');
  const out = [];
  const c = new KenwoodCodec(model, (d) => out.push(String(d)));
  c.getSmeter();
  assert.ok(out.includes('SM;'), `sent ${out.join(' ')}`);
  let s = null;
  c.on('smeter', (v) => { s = v; });
  c.onData('SM0035;');
  assert.strictEqual(s, 120, 'S9 on the 0-70 scale is S9 on the wire scale');
  c.onData('SM0070;');
  assert.strictEqual(s, 240);
});

console.log(`\nKenwood filter width: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
