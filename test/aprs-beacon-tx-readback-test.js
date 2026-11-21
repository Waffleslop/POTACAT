#!/usr/bin/env node
'use strict';
// #856 (NA4DQ, IC-7300, 1.14.7, Discord "APRS TX Bug"): the APRS radio beacon
// keyed the radio for about 5 s, then said "The radio never went to transmit,
// so nothing was sent." RigController.setTransmit() sets POTACAT's own TX
// state at key-down, and the radio's CI-V answer "transmitting" (1C 00 01) was
// passed on as 'ptt' only when that state CHANGED, so the beacon's check never
// heard it. Every readback is now 'ptt-readback', and main feeds the beacon
// from that. Here a real CI-V codec under a real RigController answers TX
// while POTACAT holds PTT, with the beacon runner wired the way main wires it.
// Run: node test/aprs-beacon-tx-readback-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { getModel } = require('../lib/rig-models');
const R = require('../lib/aprs-rf-beacon');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

function fakeTimers() {
  let t = 0, id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { id++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h) => { timers.delete(h); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [k, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
        if (!next) break;
        timers.delete(next[0]); t = next[1].at; next[1].fn();
        await Promise.resolve();
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

/** An IC-7300 over CI-V: a RigController with a real codec; `answer(on)` is the radio's 1C 00 reply. */
function ic7300() {
  const writes = [];
  const t = new EventEmitter(); t.connect = () => {}; t.disconnect = () => {}; t.write = (b) => writes.push(Buffer.from(b).toString('hex'));
  const codec = new CivCodec(getModel('IC-7300'), (b) => t.write(b));
  const rc = new RigController(getModel('IC-7300'), t, codec);
  rc.connected = true;
  const answer = (on) => codec.onData(Buffer.from(`fefee0941c00${on ? '01' : '00'}fd`, 'hex'));
  return { rc, codec, writes, answer };
}

/** The beacon runner with main's deps for keying and proof, on that controller. */
function beaconOn(rig, { wire = 'ptt-readback' } = {}) {
  const tm = fakeTimers();
  const log = [];
  let onPtt = null;
  const deps = {
    now: tm.now, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
    log: (s) => log.push(s),
    begin: () => true, end: () => {},
    startShim: async (fn) => { onPtt = fn; return 4551; }, stopShim: () => {},
    startModem: async () => ({ send: () => true, kill() {}, onExit() {} }),
    restoreListen: () => {},
    mayKey: () => ({ ok: true }),
    key: () => { rig.rc.setTransmit(true); return true; },
    unkey: () => { rig.rc.setTransmit(false); return Promise.resolve(); },
    onState: () => {},
    // main's aprsRfTxProof for a CAT radio that has answered a TX readback (pollIntervalMs 1000).
    txProof: () => R.txProofFor({ catReadsPtt: rig.rc._codecTxSeenAt > 0, catPollMs: 1000 }),
  };
  const run = R.createRfBeacon(deps);
  // main.js: controller.on(<event>, (on) => { if (on && controller === cat) aprsRfNoteRadioTx(); })
  rig.rc.on(wire, (on) => { if (on && run.inFlight()) run.noteRadioTx(true); });
  return { run, tm, log, ptt: (on) => onPtt(on) };
}

async function beaconWhereRadioAnswersTx(wire) {
  const rig = ic7300();
  rig.answer(false); // the radio has answered a readback before: it can confirm TX
  const b = beaconOn(rig, { wire });
  const p = b.run.send({ packet: R.buildRfBeacon({ settingsCall: 'NA4DQ', band: '30m', lat: 36.02, lon: -89.37, symbol: 'house', comment: 'TEST', approx: true }), capMs: 4600, requestTimeoutMs: 75000 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(b.ptt(true), true, 'Dire Wolf asked for PTT and POTACAT keyed');
  assert.ok(rig.writes.includes('fefe94e01c0001fd'), 'CI-V key-down sent');
  // The radio's poll answers "transmitting" while POTACAT holds PTT.
  await b.tm.advance(1000); rig.answer(true);
  await b.tm.advance(1000); rig.answer(true);
  await b.tm.advance(1400); // about 3.4 s on air, inside the 4.6 s cap, as in his log
  b.ptt(false);
  await b.tm.advance(300);
  return { res: await p, log: b.log };
}

console.log('APRS radio beacon hears the radio\'s TX readback while POTACAT holds PTT (#856)');

test('RigController: a TX readback while POTACAT already holds PTT is a ptt-readback, not a ptt change', async () => {
  const rig = ic7300();
  const changes = [], readbacks = [];
  rig.rc.on('ptt', (on) => changes.push(on));
  rig.rc.on('ptt-readback', (on) => readbacks.push(on));
  rig.rc.setTransmit(true);
  rig.answer(true);
  rig.answer(true);
  assert.deepStrictEqual(changes, [], 'POTACAT\'s own TX state did not change, so no ptt');
  assert.deepStrictEqual(readbacks, [true, true], 'every readback, as the radio said it');
  rig.rc.setTransmit(false);
  rig.answer(false);
  assert.deepStrictEqual(readbacks, [true, true, false]);
});

test('the IC-7300 answers TX while keyed: the beacon is sent and confirmed', async () => {
  const { res } = await beaconWhereRadioAnswersTx('ptt-readback');
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.confirmed, true);
});

test('the old wiring (ptt, state changes only) is the bug: the same radio was "nothing was sent"', async () => {
  const { res, log } = await beaconWhereRadioAnswersTx('ptt');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.sentence, 'The radio never went to transmit, so nothing was sent.');
  assert.ok(log.some((l) => /never reported transmit/.test(l)));
});

test('a radio that answers RX the whole time is still "nothing was sent"', async () => {
  const rig = ic7300();
  rig.answer(false);
  const b = beaconOn(rig);
  const p = b.run.send({ packet: R.buildRfBeacon({ settingsCall: 'NA4DQ', band: '30m', lat: 36.02, lon: -89.37, symbol: 'house', comment: 'TEST', approx: true }), capMs: 4600, requestTimeoutMs: 75000 });
  await new Promise((r) => setImmediate(r));
  b.ptt(true);
  await b.tm.advance(1000); rig.answer(false);
  await b.tm.advance(1000); rig.answer(false);
  await b.tm.advance(1000);
  b.ptt(false);
  await b.tm.advance(300);
  const res = await p;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not-keyed');
});

test('main feeds the beacon from every readback', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/controller\.on\('ptt-readback', \(on\) => \{ if \(on && controller === cat\) aprsRfNoteRadioTx\(\); \}\);/.test(main));
  assert.ok(!/controller\.on\('ptt', \(on\) => \{ if \(on && controller === cat\) aprsRfNoteRadioTx\(\); \}\);/.test(main), 'not the change-only event');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
