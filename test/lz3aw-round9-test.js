#!/usr/bin/env node
'use strict';
// LZ3AW round 9 (on 1.10.25): "Paddle on WEB - now, when apply dot or dash i
// hear one of them and the radio stucks on TX continuously, transmitting dots
// or dashes, but without local side tone. I need to press STOP button to
// terminate. After this, the paddle doesn't work, POTACAT needs to be
// restarted."
//
// The chain: the first paddle press of a session starts the lazy open of the
// CW Key Port; the Kenwood branch saw "not open yet" and marked the paddle
// unavailable (Windows) mid-press. The server then dropped the release and
// every hold, the watchdog kept re-arming from the keyer's own key events,
// and the keyer's 10 s streak cap was reset on every element, so nothing but
// STOP ended it. The page, told "unavailable", silenced its own sidetone and
// never sent a release; the flag stayed off for the session.
// Run: node test/lz3aw-round9-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const { IambicKeyer } = require('../lib/keyer');

let passed = 0, failed = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

function server() {
  const rs = new RemoteServer();
  const ev = [];
  rs.setCwKeyerOutput(({ down }) => ev.push(down));
  rs.setCwEnabled(true);
  rs._cwKeyer.setWpm(40); // 30 ms dits keep the cases short
  const ws = { readyState: 1, _authenticated: true, send() {}, _clientCapabilities: [] };
  rs._client = ws;
  return { rs, ev, send: (m) => rs._handleMessage(ws, m), downs: () => ev.filter(Boolean).length };
}

console.log('LZ3AW round 9');

test('paddle marked unavailable mid-press: keying stops at once, holds cannot revive it', async () => {
  const s = server();
  s.send({ type: 'paddle', contact: 'dit', state: 1 });
  await sleep(10);
  s.rs.setCwPaddleAvailable(false, 'txrx-ptt-only');
  const at = s.downs();
  for (let i = 0; i < 5; i++) { await sleep(100); s.send({ type: 'paddle', contact: 'dit', state: 1, hold: true }); }
  assert.strictEqual(s.downs(), at, 'no key-down after the paddle was marked unavailable');
  assert.strictEqual(s.ev[s.ev.length - 1], false, 'the radio was keyed up');
  s.rs.setCwEnabled(false);
});

test('a release is never refused, even while the paddle is unavailable', async () => {
  const s = server();
  s.send({ type: 'paddle', contact: 'dah', state: 1 });
  await sleep(5);
  s.rs._cwPaddleAvailable = false; // flag flipped without the release helper
  s.send({ type: 'paddle', contact: 'dah', state: 0 });
  await sleep(250);
  const n = s.downs();
  await sleep(300);
  assert.strictEqual(s.downs(), n, 'the dah did not repeat after its release');
  s.send({ type: 'paddle', contact: 'dit', state: 1 });
  await sleep(100);
  assert.strictEqual(s.downs(), n, 'a PRESS is still refused while unavailable');
  s.rs.setCwEnabled(false);
});

test('STOP ends a stuck paddle and the next press works', async () => {
  const s = server();
  s.send({ type: 'paddle', contact: 'dit', state: 1 });
  await sleep(300);
  s.send({ type: 'cw-stop' });
  const n = s.downs();
  await sleep(200);
  assert.strictEqual(s.downs(), n, 'nothing keys after STOP');
  s.send({ type: 'paddle', contact: 'dah', state: 1 });
  await sleep(20);
  s.send({ type: 'paddle', contact: 'dah', state: 0 });
  await sleep(300);
  assert.strictEqual(s.downs(), n + 1, 'a fresh press after STOP sends one element');
  s.rs.setCwEnabled(false);
});

test("the keyer's streak cap spans the streak: a stuck contact stops at 10 s", async () => {
  const k = new IambicKeyer();
  k.setWpm(50);
  const orig = global.setTimeout;
  let longMs = null;
  // Shrink the 10 s cap so the case runs quickly; everything else is real.
  global.setTimeout = (fn, ms, ...a) => orig(fn, ms === 10000 ? (longMs = 600) : ms, ...a);
  try {
    let downs = 0;
    k.on('key', (e) => { if (e.down) downs++; });
    k.paddleDit(true); // never released
    await sleep(900);
    const n = downs;
    await sleep(200);
    assert.ok(longMs !== null, 'the streak cap was armed');
    assert.strictEqual(downs, n, `keying stopped at the cap (still keying: ${downs} > ${n})`);
    assert.ok(n > 3, 'it did key before the cap');
  } finally {
    global.setTimeout = orig;
    k.stop();
  }
});

test('a configured CW Key Port that is still opening does not mark the paddle unavailable', () => {
  const main = R('main.js');
  const at = main.indexOf('const _keyPortPaddlePossible');
  const decl = main.slice(at, main.indexOf(';', at) + 1);
  assert.ok(/!!settings\.cwKeyPort/.test(decl), 'a configured key port counts');
  assert.ok(!/process\.platform !== 'win32';/.test(decl), 'Windows is no longer excluded outright');
  assert.ok(/_cwKeyPortIoctlLatched/.test(decl), 'only a latched, pin-rejecting Windows driver is excluded');
});

test('the web page always sends a release and resets its paddle state', () => {
  const web = R('renderer/remote.js');
  assert.ok(/if \(!cwPaddleAvailable && state\) return;/.test(web), 'sendPaddle gates presses only');
  const fn = web.slice(web.indexOf('function releaseAllPaddles('), web.indexOf('function sendPaddle('));
  assert.ok(/_stopPaddleHold\(contact\)/.test(fn), 'hold keepalives stop');
  assert.ok(/ditDown = false; else dahDown = false;/.test(fn), 'contact state resets (else every later press is a no-op)');
  assert.ok(/state: 0/.test(fn), 'a release is sent for a contact that was down');
  const avail = web.slice(web.indexOf("case 'cw-paddle-available':"), web.indexOf("case 'cw-state':"));
  assert.ok(/__echocatReleasePaddles\(true\)/.test(avail), 'unavailable releases server-side too');
  const stop = web.slice(web.indexOf("getElementById('cw-text-stop')"), web.indexOf("getElementById('cw-text-stop')") + 900);
  assert.ok(/__echocatReleasePaddles\(false\)/.test(stop), 'STOP clears the page paddle state');
  assert.ok(/window\.__echocatReleasePaddles = releaseAllPaddles;/.test(web), 'published so both callers reach it');
});

// "Also, on WEB - big visualization delay, when turn SPLIT ON and switching
// VFOs (the radio execute the commands immediately)."
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');
function ifFrame({ vfo = '0', split = '0' } = {}) {
  // 38 chars incl. ';' — the layout pinned in test/rig-test.js kenwoodIf().
  return 'IF' + '00014074000' + '0000' + '+00000' + '0' + '0' + '0' + '00' + '0' + '2'
    + vfo + '0' + split + '0' + '00' + '0' + ';';
}
function ts480() {
  const writes = [];
  const codec = new KenwoodCodec(RIG_MODELS['TS-480'], (d) => writes.push(String(d)));
  const ev = { vfo: [], split: [] };
  codec.on('vfo', (v) => ev.vfo.push(v));
  codec.on('split', (v) => ev.split.push(v));
  return { codec, writes, ev };
}

test('split ON reads the result back at once, including the TX-side VFO', () => {
  const { codec, writes } = ts480();
  codec.setSplit(true);
  const after = writes.slice(writes.findIndex((w) => /^SP|^FT|^FR/.test(w)) + 1);
  assert.ok(after.includes('IF;'), `IF; queued right behind the command: ${JSON.stringify(writes)}`);
  assert.ok(after.includes('FA;') && after.includes('FB;'), 'both VFO frequencies read now, not two cycles later');
});

test('an IF; queued before the split command cannot flip the display back', () => {
  const { codec, ev } = ts480();
  codec.setSplit(true);
  codec.onData(ifFrame({ split: '0' })); // the reply to the poll's earlier IF;
  assert.deepStrictEqual(ev.split, [], 'the stale "split off" was not emitted');
  codec.onData(ifFrame({ split: '1' })); // the reply to our own IF;
  assert.deepStrictEqual(ev.split, [true], 'the confirming reply was');
  codec.onData(ifFrame({ split: '0' })); // the radio really turned it off later
  assert.deepStrictEqual(ev.split, [true, false], 'after confirmation readbacks are trusted again');
});

test('switching to VFO B: the stale IF; is ignored and FB is read immediately', () => {
  const { codec, writes, ev } = ts480();
  codec.setVfo('B');
  assert.ok(writes.includes('FB;'), 'VFO B frequency read right away');
  codec.onData(ifFrame({ vfo: '0' }));
  assert.deepStrictEqual(ev.vfo, [], 'stale "VFO A" ignored');
  codec.getFrequency();
  assert.strictEqual(writes[writes.length - 1], 'FB;', 'and the poll still reads VFO B');
  codec.onData(ifFrame({ vfo: '1' }));
  assert.deepStrictEqual(ev.vfo, ['B']);
});

test('a command the radio refused is corrected once the window passes', () => {
  const { codec, ev } = ts480();
  codec.setSplit(true);
  codec._pendingSplit.at -= 2000; // 2 s later
  codec.onData(ifFrame({ split: '0' }));
  assert.deepStrictEqual(ev.split, [false], 'after 1.5 s the radio readback wins');
});

// TX meter: "no change". LZ3AW measured his TS-480 against a steady carrier
// (2026-09-28): SM 2 = 5 W, 7 = 25 W, 11 = 50 W, 14 = 100 W — hamlib's
// linear raw/20 read those as 10, 35, 55 and 70 W.
test('TS-480 wattmeter reads his measured watts at every measured point', () => {
  const { smPowerFromCal } = require('../lib/codecs/kenwood-codec');
  const cal = RIG_MODELS['TS-480'].smTxPowerCal;
  const want = { 0: 0, 2: 5, 7: 25, 11: 50, 14: 100 };
  for (const [raw, w] of Object.entries(want)) {
    assert.strictEqual(smPowerFromCal(Number(raw), cal, 100), w, `SM=${raw} -> ${w} W`);
  }
  assert.strictEqual(smPowerFromCal(9, cal, 100), 38, 'between points it interpolates');
  assert.strictEqual(smPowerFromCal(20, cal, 100), 100, 'never above the rated 100 W');
});

test('the codec uses the calibration on a real SM reply, and says so in the log', () => {
  const { codec } = ts480();
  const watts = [], logs = [];
  codec.on('powerMeter', (w) => watts.push(w));
  codec.on('log', (l) => logs.push(l));
  codec.getPowerMeter();
  codec.onData('SM00014;');
  assert.deepStrictEqual(watts, [100], `100 W carrier reads 100 W (got ${watts})`);
  assert.ok(logs.some((l) => /SM=14 of 20 -> 100 W \(calibrated\)/.test(l)), logs.join(' | '));
});

// "Can we calibrate the other meters (S-meter, SWR and ALC) in this way?"
test('SWR and ALC log their raw reading next to the displayed value, once per change', () => {
  const { codec } = ts480();
  const logs = [], swr = [], alc = [];
  codec.on('log', (l) => logs.push(l));
  codec.on('swr', (v) => swr.push(v));
  codec.on('alc', (v) => alc.push(v));
  codec.onData('RM10005;');
  codec.onData('RM10005;');
  codec.onData('RM30010;');
  assert.deepStrictEqual(swr, [60, 60], 'SWR still reaches the meters (raw 5 = 2.0:1 on his radio)');
  assert.deepStrictEqual(alc, [85]);
  assert.strictEqual(logs.filter((l) => /SWR meter raw RM1=5 of 30 -> 2\.0:1 \(calibrated\)/.test(l)).length, 1, logs.join(' | '));
  assert.ok(logs.some((l) => /ALC meter raw RM3=10 of 30 -> 33% of the bar/.test(l)), logs.join(' | '));
});

// LZ3AW 2026-09-28, against the radio's own ARCP-480 readout.
test("TS-480 S-meter reads his radio's S-units at every measured point (S9 is raw 11, not 15)", () => {
  const { codec } = ts480();
  const seen = [];
  codec.on('smeter', (v) => seen.push(v));
  const label = (v) => (v <= 120 ? `S${Math.round((v * 9) / 120)}` : `S9+${Math.round(((v - 120) * 60) / 135)}`);
  const pairs = [[0, 'S0'], [3, 'S1'], [5, 'S3'], [7, 'S5'], [9, 'S7'], [11, 'S9'], [14, 'S9+20'], [17, 'S9+40'], [20, 'S9+60']];
  for (const [raw, want] of pairs) {
    codec.onData(`SM0${String(raw).padStart(4, '0')};`);
    assert.strictEqual(label(seen[seen.length - 1]), want, `SM ${raw} should read ${want}`);
  }
  codec.onData('SM00030;');
  assert.strictEqual(seen[seen.length - 1], 255, 'beyond S9+60 stays at full scale');
});

test('TS-480 SWR reads his measured ratios (the bar is not linear)', () => {
  const { codec } = ts480();
  const seen = [];
  codec.on('swr', (v) => seen.push(v));
  for (const [raw, ratio] of [[1, 1.0], [3, 1.5], [5, 2.0]]) {
    codec.onData(`RM1${String(raw).padStart(4, '0')};`);
    // A perfect match is sent as wire 1 (1.02:1, shown as 1.0) because every
    // display blanks wire 0 as "no reading" (LZ3AW 9/29).
    assert.strictEqual((1 + seen[seen.length - 1] / 60).toFixed(1), ratio.toFixed(1), `RM1 ${raw} should read ${ratio}:1`);
  }
  codec.onData('RM10006;');
  const at6 = 1 + seen[seen.length - 1] / 60;
  codec.onData('RM10007;');
  const at7 = 1 + seen[seen.length - 1] / 60;
  assert.ok(at6 > 2.5 && at6 < 3.0 && at7 > 3.0 && at7 < 3.5, `6 and 7 straddle his ~3:1 (${at6}, ${at7})`);
  codec.onData('RM10030;');
  assert.strictEqual(seen[seen.length - 1], 255, 'capped at the meter full scale');
});

test('the brand default is untouched for Kenwood models without a measured table', () => {
  const { KenwoodCodec: KC } = require('../lib/codecs/kenwood-codec');
  const c = new KC({ brand: 'Kenwood', protocol: 'kenwood', caps: {}, cw: {} }, () => {});
  let sm = null, swr = null;
  c.on('smeter', (v) => { sm = v; });
  c.on('swr', (v) => { swr = v; });
  c.onData('SM0015;');
  c.onData('RM10015;');
  assert.strictEqual(sm, 120, 'S9 = 15 default');
  assert.strictEqual(swr, 60, 'linear default');
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (e.stack || e.message)); }
  }
  console.log(`\nLZ3AW round 9: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
