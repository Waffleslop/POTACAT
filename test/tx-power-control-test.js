#!/usr/bin/env node
'use strict';
// Can POTACAT set this radio's TX power? The one rule (lib/tx-power-control.js),
// per radio and per transport, and what the RF-sense Tune does when it cannot.
// N5XHI, FT-857D through flrig, 2026-11-24: "power 100 W -> 10W ... radio
// confirms 100 W" while the radio sent at its own setting.
// Run: node test/tx-power-control-test.js
const assert = require('assert');
const T = require('../lib/tx-power-control');
const { RIG_MODELS, getModel } = require('../lib/rig-models');
const { flrigModel } = require('../lib/codecs/flrig-codec');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('TX power control rule');

// What main.js gives the rule for a rig: its picked model's own row, the caps
// it runs with, and how it is reached.
function ctxFor(modelName, catTarget, live = {}) {
  const row = modelName ? getModel(modelName, null) : null;
  const transport = T.transportOf(catTarget);
  let caps = row && row.caps;
  if (transport === 'flrig') caps = flrigModel(row || RIG_MODELS.flrig).caps;
  if (transport === 'rigctld' && !row) caps = { txpower: true };
  return {
    transport, modelName: modelName || '',
    ownRowTxpower: row && row.caps ? row.caps.txpower : null,
    ownRowProtocol: row ? row.protocol : null,
    capsTxpower: caps ? caps.txpower : null,
    hamlibRigId: catTarget && catTarget.rigId,
    ...live,
  };
}
const SERIAL = { type: 'serial', path: 'COM3' };
const FLRIG = { type: 'flrig', host: '127.0.0.1', port: 12345 };
const no = (c, why) => { const r = T.canSetTxPower(c); assert.strictEqual(r.canSet, false, JSON.stringify(c)); if (why) assert.strictEqual(r.why, why); return r; };
const yes = (c) => { const r = T.canSetTxPower(c); assert.strictEqual(r.canSet, true, JSON.stringify(c)); return r; };

test('legacy Yaesu CAT (FT-817/818, FT-857, FT-897) on a direct serial link: no', () => {
  for (const m of ['FT-817/818', 'FT-857', 'FT-897']) no(ctxFor(m, SERIAL), 'radio-has-no-power-command');
  assert.strictEqual(T.canSetTxPower(ctxFor('FT-857', SERIAL)).radio, 'ft857');
});
test('every rig-models row on the legacy Yaesu protocol is a known radio, and every known radio row says txpower false', () => {
  for (const [name, m] of Object.entries(RIG_MODELS)) if (m.protocol === 'yaesu-legacy') assert.ok(T.knownByName(name), name);
  for (const k of T.KNOWN_RADIOS) for (const n of k.names) assert.strictEqual(RIG_MODELS[n] && RIG_MODELS[n].caps.txpower, false, n);
  no({ transport: 'direct', ownRowProtocol: 'yaesu-legacy' });
});
test('those radios through flrig: no, by the picked model or by flrig\'s own transceiver name', () => {
  for (const m of ['FT-817/818', 'FT-857', 'FT-897']) no(ctxFor(m, FLRIG));
  for (const x of ['FT-817', 'FT-817BB', 'FT-818ND', 'FT-857D', 'FT-897D', 'FT857D']) no(ctxFor('', FLRIG, { flrigXcvr: x }), 'radio-has-no-power-command');
  assert.strictEqual(T.canSetTxPower(ctxFor('', FLRIG, { flrigXcvr: 'FT-857D' })).radio, 'ft857');
});
test('those radios through rigctld: no, by Hamlib model number (1020, 1022, 1023, 1041, 1043)', () => {
  for (const id of [1020, 1022, 1023, 1041, 1043]) no(ctxFor('', { type: 'rigctld', rigId: id }), 'radio-has-no-power-command');
  no(ctxFor('', { type: 'rigctldnet', host: 'pi', port: 4532 }, { hamlibRigId: 1022 }));
  no(ctxFor('FT-857', { type: 'rigctld', rigId: 1022 }));
});
test('the IC-706MKII and IC-706MKIIG: no, direct, through flrig and through rigctld (3010, 3011)', () => {
  for (const m of ['IC-706MKII', 'IC-706MKIIG']) {
    no(ctxFor(m, { type: 'icom', path: 'COM4' }));
    no(ctxFor(m, FLRIG));
  }
  no(ctxFor('', FLRIG, { flrigXcvr: 'IC-706MKIIG' }));
  no(ctxFor('', { type: 'rigctld', rigId: 3010 }));
  no(ctxFor('', { type: 'rigctld', rigId: 3011 }));
});
test('DXLab Commander: no, whatever radio it holds', () => {
  no(ctxFor('IC-7300', { type: 'dxlab-commander', host: '127.0.0.1', port: 52002 }), 'commander');
  no(ctxFor('', { type: 'dxlab-commander' }), 'commander');
});
test('any radio whose caps say no power control: no', () => {
  for (const m of ['QMX', 'QDX', '(tr)uSDX']) no(ctxFor(m, SERIAL));
  no({ transport: 'direct', capsTxpower: false }, 'no-power-control');
  // ... and a program in front of it does not add a power command
  no(ctxFor('QMX', FLRIG));
});
test('a Hamlib backend whose dump_caps lists no RFPOWER under Set level: no', () => {
  no(ctxFor('', { type: 'rigctld', rigId: 9999 }, { hamlibSetsRfpower: false }), 'hamlib-no-rfpower');
});
test('unknown backends are not guessed: flrig and rigctld radios keep power control', () => {
  yes(ctxFor('', FLRIG));
  yes(ctxFor('', FLRIG, { flrigXcvr: 'IC-7300' }));
  yes(ctxFor('IC-7300', FLRIG, { flrigXcvr: 'IC-7300' }));
  yes(ctxFor('', FLRIG, { flrigXcvr: 'FT-891' }));
  yes(ctxFor('', { type: 'rigctld', rigId: 3073 }));
  yes(ctxFor('', { type: 'rigctld', rigId: 3073 }, { hamlibSetsRfpower: null }));
  yes(ctxFor('', { type: 'rigctld', rigId: 3073 }, { hamlibSetsRfpower: true }));
  yes(ctxFor('Xiegu G90', { type: 'rigctld', rigId: 3088 }));
  // the IC-706 names do not catch other Icoms, nor the FT names other Yaesus
  yes(ctxFor('', FLRIG, { flrigXcvr: 'IC-7060' }));
  yes(ctxFor('', FLRIG, { flrigXcvr: 'FT-8900' }));
});
test('radios POTACAT sets the power of: yes', () => {
  for (const m of ['IC-7300', 'FT-891', 'FT-710', 'FTDX10', 'TS-590SG']) if (RIG_MODELS[m]) yes(ctxFor(m, SERIAL));
  yes({ transport: 'direct', capsTxpower: true });
  yes({});
});
test('transportOf', () => {
  assert.strictEqual(T.transportOf({ type: 'flrig' }), 'flrig');
  assert.strictEqual(T.transportOf({ type: 'rigctld' }), 'rigctld');
  assert.strictEqual(T.transportOf({ type: 'rigctldnet' }), 'rigctld');
  assert.strictEqual(T.transportOf({ type: 'dxlab-commander' }), 'commander');
  assert.strictEqual(T.transportOf({ type: 'serial' }), 'direct');
  assert.strictEqual(T.transportOf(null), 'none');
});

console.log('The question');
const FT857 = T.canSetTxPower(ctxFor('FT-857', SERIAL));
const FT897 = T.canSetTxPower(ctxFor('FT-897', SERIAL));
test('two buttons, Tune now and Cancel; Cancel is the default and the close button', () => {
  const d = T.confirmDialog(FT857);
  assert.deepStrictEqual(d.buttons, ['Tune now', 'Cancel']);
  assert.strictEqual(d.defaultId, 1);
  assert.strictEqual(d.cancelId, 1);
});
test('it says: AM, the radio\'s own power, POTACAT cannot turn it down, turn RF POWER down first', () => {
  const d = T.confirmDialog(FT857);
  const all = d.message + '\n' + d.detail;
  assert.strictEqual(d.message, "POTACAT cannot turn this radio's power down.");
  assert.ok(/goes out in AM at the radio's own power setting/.test(all));
  assert.ok(/Turn RF POWER down on the radio first/.test(all));
  assert.ok(/asks this once for this radio/.test(all));
});
test('the 25 W figure is said for the FT-857 only: no figure for a radio that was not checked', () => {
  assert.ok(/up to 25 W on HF for an FT-857/.test(T.confirmDetail(FT857)));
  for (const c of [FT897, T.canSetTxPower(ctxFor('FT-817/818', SERIAL)), T.canSetTxPower(ctxFor('IC-706MKIIG', SERIAL)), T.canSetTxPower(ctxFor('QMX', SERIAL)), T.canSetTxPower(ctxFor('', { type: 'dxlab-commander' }))]) {
    assert.ok(!/\d\s*W/.test(T.confirmDetail(c)), T.confirmDetail(c));
  }
});
test('only the Tune now button tunes: Cancel, a closed dialog and anything else do not', () => {
  assert.strictEqual(T.answerIsTune(0), true);
  for (const r of [1, -1, undefined, null, '0', true]) assert.strictEqual(T.answerIsTune(r), false, String(r));
});
test('the device question carries the same words and labels', () => {
  const a = T.remoteAsk(FT857, { id: 'r1', name: 'Shack 857' });
  assert.strictEqual(a.type, 'tune-own-power-ask');
  assert.strictEqual(a.rigId, 'r1');
  assert.strictEqual(a.tuneLabel, 'Tune now');
  assert.strictEqual(a.cancelLabel, 'Cancel');
  assert.ok(a.text.startsWith(T.CONFIRM_MESSAGE) && a.text.includes('up to 25 W on HF for an FT-857'));
});
test('no emoji and no exclamation in any wording', () => {
  const all = [T.CONFIRM_TITLE, T.CONFIRM_MESSAGE, T.confirmDetail(FT857), T.REMOTE_REFUSAL, T.NO_WINDOW_LINE, T.CANCELLED_LINE, T.MODAL_LINE, T.FIELD_NOTE, T.SETTINGS_HELP, T.CONFIRMED_NOTE].join('\n');
  assert.ok(!/[\u{1F000}-\u{1FFFF}☀-➿]/u.test(all));
});

console.log('The remembered answer');
test('asked once per rig: remembered per rig id, and forgotten on request', () => {
  let map;
  assert.strictEqual(T.isConfirmed(map, 'r1', FT857), false);
  map = T.remember(map, 'r1', FT857, 1000, 'desktop');
  assert.strictEqual(T.isConfirmed(map, 'r1', FT857), true);
  assert.strictEqual(T.isConfirmed(map, 'r2', FT857), false, 'another rig is asked for itself');
  assert.strictEqual(T.isConfirmed(T.forget(map, 'r1'), 'r1', FT857), false);
  assert.strictEqual(T.isConfirmed({ r1: true }, 'r1', FT857), false, 'only an entry this module wrote counts');
});
test('a rig re-pointed at another radio is asked again', () => {
  const map = T.remember(null, 'r1', T.canSetTxPower(ctxFor('FT-817/818', SERIAL)), 1000, 'desktop');
  assert.strictEqual(T.isConfirmed(map, 'r1', FT857), false);
});

console.log('The gate');
const g = (s) => T.tuneGate({ catConnected: true, ...s });
test('a radio POTACAT sets the power of: the tune runs with its power steps, whoever pressed', () => {
  for (const s of [{}, { remote: true }, { remote: true, guest: true }, { confirmed: true }]) {
    assert.deepStrictEqual(g({ canSet: true, ...s }), { action: 'run', ownPower: false, remember: false });
  }
});
test('no power control, first press on the desktop: ask', () => {
  assert.deepStrictEqual(g({ canSet: false }), { action: 'ask-desktop', ownPower: true, remember: false });
});
test('no power control, confirmed: run with no power steps, from the desktop and from a device', () => {
  assert.deepStrictEqual(g({ canSet: false, confirmed: true }), { action: 'run', ownPower: true, remember: false });
  assert.deepStrictEqual(g({ canSet: false, confirmed: true, remote: true }), { action: 'run', ownPower: true, remember: false });
});
test('no power control, not confirmed, from a device that cannot ask: refused', () => {
  assert.strictEqual(g({ canSet: false, remote: true }).action, 'refuse-remote');
});
test('... from a device that can ask: the question goes to it, and only its Tune now tunes', () => {
  assert.strictEqual(g({ canSet: false, remote: true, clientCanAsk: true }).action, 'ask-remote');
  assert.deepStrictEqual(g({ canSet: false, remote: true, clientCanAsk: true, clientSaidTune: true }), { action: 'run', ownPower: true, remember: true });
});
test('a Guest Pass never answers the owner\'s question', () => {
  assert.strictEqual(g({ canSet: false, remote: true, guest: true, clientCanAsk: true, clientSaidTune: true }).action, 'refuse-remote');
});
test('no radio link: nothing to ask about (the tune says "CAT not connected" and sends nothing)', () => {
  assert.deepStrictEqual(T.tuneGate({ canSet: false, catConnected: false }), { action: 'run', ownPower: true, remember: false });
});
test('the refusal says why and what to do, and is not about the band', () => {
  assert.ok(/Confirm it once on the POTACAT desktop at the shack/.test(T.REMOTE_REFUSAL));
  assert.ok(/own power setting/.test(T.REMOTE_REFUSAL));
  assert.ok(!/band|licen/i.test(T.REMOTE_REFUSAL));
});

console.log('The rigctld codec says what Hamlib can set');
test('dump_caps "Set level" without RFPOWER: canSetRfPower() is false; with it: true; before the dump: null', () => {
  const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
  const feed = (line) => {
    const c = new RigctldCodec({ brand: 'Hamlib', protocol: 'rigctld', caps: {}, maxPower: 100 }, () => {});
    assert.strictEqual(c.canSetRfPower(), null, 'nothing said yet');
    c.probeCaps();
    c.onData('Caps dump for model: 1022\n' + line + '\nRPRT 0\n');
    return c.canSetRfPower();
  };
  assert.strictEqual(feed('Set level: BAND_SELECT(0..16/1) '), false);
  assert.strictEqual(feed('Set level: '), false);
  assert.strictEqual(feed('Set level: PREAMP(0..20/10) RFPOWER(0.000000..1.000000/0.003922) KEYSPD(6..48/1)'), true);
  assert.strictEqual(feed('Get level: RFPOWER(0.019608..1.000000/0.003922)'), null, 'a Get level line says nothing about setting');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
