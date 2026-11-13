#!/usr/bin/env node
'use strict';
// GitHub #184: a 6 W Hermes Lite behind deskHPSDR / Zeus, on POTACAT's TCP
// Kenwood CAT path (lib/cat.js CatClient). Full power (W) was 6, the slider
// ran 0-6 W, and the TCP client wrote the watts straight out: PC006 for 6 W,
// which those programs read as 6 % drive. The serial codec already scaled;
// the TCP client did not. The slider values and commands below are the
// reporter's own session log (v1.14.1).
// Run: node test/kenwood-pc-power-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { pcPowerConfig, encodePcPower, decodePcPower } = require('../lib/kenwood-pc-power');
const { decideBandPowerReapply, READBACK_GRACE_MS } = require('../lib/band-power-reapply');
const { applyFullPower } = require('../lib/rig-full-power');
const { getModel, RIG_MODELS } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { CatClient } = require('../lib/cat');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { pass++; console.log('  ok  ' + name); },
        (e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }));
      return;
    }
    pass++; console.log('  ok  ' + name);
  } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// The reporter's rig: generic Kenwood over TCP (no model picked), Full power 6 W.
const zeusModel = () => applyFullPower(getModel(null, 'kenwood'), { fullPowerW: 6 });
// What the TCP client used to send for any watts value.
const oldTcp = (w) => `PC${String(Math.max(0, Math.min(100, Math.round(w)))).padStart(3, '0')};`;

// From the log: rig-control set-tx-power=<v>, and the PC the client wrote.
const LOGGED = [
  { w: 5.6, before: 'PC006;', after: 'PC093;' },
  { w: 3.2, before: 'PC003;', after: 'PC053;' },
  { w: 1,   before: 'PC001;', after: 'PC017;' },
  { w: 0,   before: 'PC000;', after: 'PC000;' },
  { w: 0.7, before: 'PC001;', after: 'PC012;' },
  { w: 6,   before: 'PC006;', after: 'PC100;' },
];

test('the logged commands are what the old TCP client built (PC006 for 6 W, PC001 for 0.7 W)', () => {
  for (const r of LOGGED) assert.strictEqual(oldTcp(r.w), r.before, String(r.w));
});

test('6 W Full power: each logged slider value is that share of full drive', () => {
  const cfg = pcPowerConfig(zeusModel());
  for (const r of LOGGED) assert.strictEqual(encodePcPower(r.w, cfg).cmd, r.after, String(r.w));
  assert.strictEqual(encodePcPower(6, cfg).watts, 6);
  assert.strictEqual(encodePcPower(5.6, cfg).watts, 5.6);
});

test('6 W Full power: never above full drive, whatever is asked (82 W, 100 W)', () => {
  const cfg = pcPowerConfig(zeusModel());
  for (const w of [6.01, 82, 100, 1e6]) assert.strictEqual(encodePcPower(w, cfg).cmd, 'PC100;', String(w));
});

test('the TCP client and the serial Kenwood codec send the same command for the same model', () => {
  const model = zeusModel();
  const cfg = pcPowerConfig(model);
  for (const w of [0, 0.1, 0.7, 1, 2.5, 3.2, 5.6, 6, 9]) {
    const writes = [];
    new KenwoodCodec(model, (d) => writes.push(String(d))).setTxPower(w);
    assert.strictEqual(encodePcPower(w, cfg).cmd, writes[0], String(w));
  }
});

test('readback on the same scale: PC100 is 6 W, PC050 is 3 W', () => {
  const cfg = pcPowerConfig(zeusModel());
  assert.strictEqual(decodePcPower('100', cfg), 6);
  assert.strictEqual(decodePcPower('050', cfg), 3);
});

test('no Full power set: every 100 W model sends exactly what the TCP client always sent', () => {
  const models = [getModel(null, 'kenwood'), getModel(null, 'flex'), RIG_MODELS['TS-2000'], RIG_MODELS['K4/K4D'], null];
  for (const m of models) {
    const cfg = pcPowerConfig(m);
    for (let w = -5; w <= 120; w += 0.25) assert.strictEqual(encodePcPower(w, cfg).cmd, oldTcp(w), `${m && m.brand} ${w}`);
    assert.strictEqual(decodePcPower('050', cfg), 50);
    assert.strictEqual(decodePcPower('050H', cfg), 50, 'leading digits, as parseInt read them');
    assert.strictEqual(decodePcPower('?', cfg), null);
  }
});

test('not a number: nothing is sent', () => {
  for (const v of [NaN, 'abc', undefined, null, '']) assert.strictEqual(encodePcPower(v, pcPowerConfig(null)), null, String(v));
});

// CatClient itself, with the model main.js hands it.
function client(model) {
  const c = new CatClient();
  const writes = [];
  c._write = (d) => writes.push(String(d));
  c.connected = true;
  if (model !== undefined) c.setPowerModel(model);
  return { c, writes };
}

test('CatClient: 6 W on the 6 W radio writes PC100, and a PC100 answer reads 6 W', () => {
  const { c, writes } = client(zeusModel());
  c.setTxPower(6);
  assert.deepStrictEqual(writes, ['PC100;']);
  let got = null;
  c.on('power', (w) => { got = w; });
  c._onData(Buffer.from('PC100;'));
  assert.strictEqual(got, 6);
});

test('CatClient: a plain Kenwood reads PC050 back as 50 W, as before', () => {
  const { c } = client(getModel(null, 'kenwood'));
  let got = null;
  c.on('power', (w) => { got = w; });
  c._onData(Buffer.from('PC050;'));
  assert.strictEqual(got, 50);
});

test('CatClient: a plain Kenwood (no model handed over) still writes whole watts', () => {
  const { c, writes } = client(undefined);
  c.setTxPower(50.4);
  assert.deepStrictEqual(writes, ['PC050;']);
});

test('CatClient: the last level inside the 150 ms window is sent, not dropped (the logged slide to 0 W)', () => {
  const { c, writes } = client(zeusModel());
  // Logged: 5.6 sent, 3.2 dropped 82 ms later, 1 sent, 0 dropped 84 ms later.
  c.setTxPower(1);
  c.setTxPower(3.2);
  c.setTxPower(0);
  assert.deepStrictEqual(writes, ['PC017;']);
  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      assert.deepStrictEqual(writes, ['PC017;', 'PC000;'], 'one more PC, the latest level');
      c.disconnect();
      resolve();
    } catch (e) { reject(e); }
  }, 250));
});

test('CatClient: disconnect drops a level still waiting', () => {
  const { c, writes } = client(zeusModel());
  c.setTxPower(1);
  c.setTxPower(6);
  c.disconnect();
  return new Promise((resolve, reject) => setTimeout(() => {
    try { assert.deepStrictEqual(writes, ['PC017;']); resolve(); } catch (e) { reject(e); }
  }, 250));
});

// Band change: send the level again only where the radio cannot report it.
const base = { prevBand: '20m', band: '40m', watts: 6, readsBack: false, linkAgeMs: 60000, rigType: 'kenwood' };

test('band change on a radio that never reported its power: the level is sent again', () => {
  const d = decideBandPowerReapply(base);
  assert.strictEqual(d.resend, true);
  assert.strictEqual(d.watts, 6);
});

test('band change: left alone where the radio reports power, or nothing was set, or no band change', () => {
  assert.strictEqual(decideBandPowerReapply({ ...base, readsBack: true }).resend, false);
  assert.strictEqual(decideBandPowerReapply({ ...base, watts: 0 }).resend, false);
  assert.strictEqual(decideBandPowerReapply({ ...base, band: '20m' }).resend, false);
  assert.strictEqual(decideBandPowerReapply({ ...base, prevBand: null }).resend, false);
  assert.strictEqual(decideBandPowerReapply({ ...base, band: null }).resend, false);
  assert.strictEqual(decideBandPowerReapply({ ...base, rigType: 'flex' }).resend, false);
  assert.strictEqual(decideBandPowerReapply({ ...base, transmitting: true }).resend, false);
});

test('band change in the first seconds of a link: too soon to call the radio silent', () => {
  assert.strictEqual(decideBandPowerReapply({ ...base, linkAgeMs: 3000 }).resend, false);
  assert.strictEqual(decideBandPowerReapply({ ...base, linkAgeMs: READBACK_GRACE_MS }).resend, true);
  assert.ok(READBACK_GRACE_MS > 10000, 'more than two 5 s PC polls');
});

// main.js glue.
const main = readSrc(path.join(__dirname, '..', 'main.js'));

test('main.js: the TCP CatClient gets the active model (Full power included)', () => {
  const i = main.indexOf('cat = new CatClient();');
  assert.ok(i > 0);
  const j = main.indexOf('cat.connect(target);', i);
  assert.ok(/cat\.setPowerModel\(rigModel\);/.test(main.slice(i, j)));
  assert.ok(/const rigModel = getActiveRigModel\(\);/.test(main.slice(i - 1500, i)), 'the model with Full power applied');
});

test('main.js: every dial report passes the band rule, and a power readback marks the link', () => {
  const f = main.indexOf('function sendCatFrequency(hz)');
  assert.ok(/bandPowerFollowDial\(hz\)/.test(main.slice(f, f + 2500)));
  const p = main.indexOf('function sendCatPower(watts)');
  assert.ok(/_powerReadbackThisLink = true;/.test(main.slice(p, p + 1500)));
  assert.ok(/decideBandPowerReapply\(\{/.test(main));
  assert.ok(/gatedSetTxPower\(w, \{ rigType \}\)/.test(main), 'through the pass gate');
});

test('main.js: the level put back is the one POTACAT sent on this link, never the last radio\'s', () => {
  assert.ok(/watts: _bandPowerSetW,/.test(main), 'not _currentTxPower');
  const g = main.indexOf('function gatedSetTxPower(');
  assert.ok(/_bandPowerSetW = Number\(actual\) \|\| 0;/.test(main.slice(g, g + 2500)));
  const c = main.indexOf("healActiveRigNow('connect');");
  assert.ok(/_bandPowerSetW = 0;/.test(main.slice(c - 400, c)), 'cleared on every connect');
});

Promise.all(pending).then(() => {
  console.log(`\nkenwood-pc-power: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
