#!/usr/bin/env node
'use strict';
// APRS 30 m beacon: the transmit passband stays inside 10.150 MHz.
//
// 2026-11-19, FLEX-8600M: the 30 m beacon (10.1476 MHz DIGU, tones 1600/1800
// Hz) was refused with interlock OUT_OF_BAND. The radio's TX filter was
// 100-3100 Hz, so the transmit passband's top edge was 10.1507 MHz, past the
// 30 m band edge. For a 30 m beacon on a Flex POTACAT now narrows the TX
// filter to 1400-2000 Hz before anything can key and puts the operator's
// filter back on every way out. 2 m is unchanged; a radio POTACAT cannot set
// a TX passband on is left alone with one log line.
// Run: node test/aprs-30m-tx-passband-test.js

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = require('../lib/aprs-rf-beacon');
const F = require('../lib/flex-tx-filter');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

console.log('APRS 30 m beacon: the transmit passband');

const DIAL_30M = 10147600;
const BAND_TOP_30M = 10150000;
// A real 8600M v4.2.20 transmit status (GUI capture 2026-11-17, trimmed).
const TX_STATUS = 'S766257AA|transmit freq=14.100000 rfpower=69 tunepower=4 tx_slice_mode=USB hwalc_enabled=0 inhibit=0 dax=0 speech_processor_level=1 lo=100 hi=3100 tx_filter_changes_allowed=1 tx_antenna=ANT1 pitch=600 max_internal_pa_power=100';

// ── the numbers ─────────────────────────────────────────────────────────────
test('the cause: a 100-3100 Hz TX filter on 10.1476 MHz reaches past 10.150 MHz', () => {
  assert.ok(DIAL_30M + 3100 > BAND_TOP_30M);
});

test('the 30 m passband 1400-2000 Hz holds both tones and its top edge is inside 10.150 MHz with margin', () => {
  const t = R.TX_PASSBAND['30m'];
  assert.deepStrictEqual({ ...t }, { lo: 1400, hi: 2000 });
  assert.ok(t.lo < 1600 - 150 && t.hi > 1800 + 150, 'the tones and their 300 baud keying sidebands pass');
  assert.strictEqual(DIAL_30M + t.hi, 10149600);
  assert.ok(BAND_TOP_30M - (DIAL_30M + t.hi) >= 300, 'at least 300 Hz inside the band edge');
  assert.strictEqual(R.TX_PASSBAND['2m'], undefined, '2 m has no passband plan');
});

// ── the plan ────────────────────────────────────────────────────────────────
test('planTxPassband: a 30 m beacon on a Flex narrows, saving the operator\'s filter', () => {
  const p = R.planTxPassband({ band: '30m', flex: { connected: true, filter: { lo: 100, hi: 3100 }, allowed: true } });
  assert.deepStrictEqual(p, { action: 'narrow', saved: { lo: 100, hi: 3100 }, target: { lo: 1400, hi: 2000 } });
});

test('planTxPassband: 2 m does nothing, Flex or not', () => {
  assert.deepStrictEqual(R.planTxPassband({ band: '2m', flex: { connected: true, filter: { lo: 100, hi: 3100 }, allowed: true } }), { action: 'none' });
  assert.deepStrictEqual(R.planTxPassband({ band: '2m', flex: null }), { action: 'none' });
});

test('planTxPassband: a radio without TX passband control changes nothing and says it may refuse 30 m', () => {
  const p = R.planTxPassband({ band: '30m', flex: null });
  assert.strictEqual(p.action, 'unsupported');
  assert.ok(/may refuse 30 m/.test(p.log) && /wide/.test(p.log), p.log);
});

test('planTxPassband: a Flex that has not reported its filter, or does not allow changes, is left alone', () => {
  assert.strictEqual(R.planTxPassband({ band: '30m', flex: { connected: true, filter: null, allowed: true } }).action, 'unsupported');
  assert.strictEqual(R.planTxPassband({ band: '30m', flex: { connected: true, filter: { lo: 100, hi: null }, allowed: true } }).action, 'unsupported');
  const no = R.planTxPassband({ band: '30m', flex: { connected: true, filter: { lo: 100, hi: 3100 }, allowed: false } });
  assert.strictEqual(no.action, 'unsupported');
  assert.ok(/tx_filter_changes_allowed=0/.test(no.log), no.log);
});

// ── the Flex commands ───────────────────────────────────────────────────────
test('parseTxFilter reads lo=/hi=/tx_filter_changes_allowed= from a real 8600M transmit status', () => {
  const body = TX_STATUS.replace(/^.*?\|transmit /, '');
  const t = F.parseTxFilter(body);
  assert.deepStrictEqual(t.filter, { lo: 100, hi: 3100 });
  assert.strictEqual(t.allowed, true);
  assert.strictEqual(F.parseTxFilter('rfpower=5').filter, null);
});

test('txFilterCommands: one `transmit set filter_low=` / `filter_high=` per edge, never another command', () => {
  assert.deepStrictEqual(F.txFilterCommands({ lo: 100, hi: 3100 }, { lo: 1400, hi: 2000 }), ['transmit set filter_low=1400', 'transmit set filter_high=2000']);
  assert.deepStrictEqual(F.txFilterCommands({ lo: 1400, hi: 2000 }, { lo: 100, hi: 3100 }), ['transmit set filter_low=100', 'transmit set filter_high=3100']);
  // A new low at or above the current high: the high edge moves first (the radio keeps low 50 Hz under high).
  assert.deepStrictEqual(F.txFilterCommands({ lo: 100, hi: 1000 }, { lo: 1400, hi: 2000 }), ['transmit set filter_high=2000', 'transmit set filter_low=1400']);
  assert.deepStrictEqual(F.txFilterCommands({ lo: 1400, hi: 2000 }, { lo: 1400, hi: 2000 }), []);
  assert.deepStrictEqual(F.txFilterCommands({ lo: 1400, hi: 2000 }, { lo: 1400, hi: 2000 }, { force: true }), ['transmit set filter_low=1400', 'transmit set filter_high=2000']);
});

test('SmartSdrClient tracks the TX filter from transmit status and sets it edge by edge', () => {
  const { SmartSdrClient } = require('../lib/smartsdr');
  const c = new SmartSdrClient();
  c._handleLine(TX_STATUS);
  assert.deepStrictEqual(c.txFilter, { lo: 100, hi: 3100 });
  assert.strictEqual(c.txFilterChangesAllowed, true);
  c._handleLine('S766257AA|transmit hi=2000'); // a delta line keeps the other edge
  assert.deepStrictEqual(c.txFilter, { lo: 100, hi: 2000 });
  c._handleLine('S766257AA|transmit band 7 band_name=30 rfpower=70 lo=1 hi=2'); // per-band memory, not live
  assert.deepStrictEqual(c.txFilter, { lo: 100, hi: 2000 });
  const sent = [];
  c._send = (s) => { sent.push(s); return 1; };
  c.connected = true;
  c._handleLine(TX_STATUS);
  c.setTxFilter(1400, 2000);
  assert.deepStrictEqual(sent, ['transmit set filter_low=1400', 'transmit set filter_high=2000']);
  assert.ok(!sent.some((s) => /atu/.test(s)));
});

test('SmartSdrAudio (the bound station connection) tracks and sets the TX filter the same way', () => {
  const { SmartSdrAudio } = require('../lib/smartsdr-audio');
  const a = new SmartSdrAudio();
  a._handleLine(TX_STATUS);
  assert.deepStrictEqual(a.txFilter, { lo: 100, hi: 3100 });
  const sent = [];
  a._sock = {}; a._connected = true;
  a._send = (s) => { sent.push(s); return 1; };
  a.setTxFilter(1400, 2000);
  assert.deepStrictEqual(sent, ['transmit set filter_low=1400', 'transmit set filter_high=2000']);
});

// ── the run, against a fake Flex ────────────────────────────────────────────
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

/**
 * A fake radio: a Flex station (TX filter, commands it was sent) or, with
 * o.noFlex, a radio POTACAT cannot set a TX passband on. narrowTx/restoreTx
 * do what main's glue does: planTxPassband, then the Flex commands.
 */
function harness(o = {}) {
  const tm = fakeTimers();
  const log = [];
  const order = [];
  const flex = o.noFlex ? null : { filter: { lo: 100, hi: 3100 }, allowed: true, sent: [] };
  const flexSet = (to, opts = {}) => {
    const cmds = F.txFilterCommands(opts.from || flex.filter, to, opts);
    for (const c of cmds) { flex.sent.push(c); order.push(c); }
    flex.filter = { ...to };
  };
  const radio = { keyed: false };
  let onPtt = null, modem = null;
  const deps = {
    now: tm.now, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
    log: (s) => log.push(s),
    begin: () => { order.push('begin'); return true; },
    end: () => { order.push('end'); },
    startShim: async (fn) => { onPtt = fn; return 4551; },
    stopShim: () => { onPtt = null; },
    startModem: async () => {
      if (o.modemFails) throw new Error('Dire Wolf did not start');
      modem = { sent: [], send(req) { this.sent.push(req); return true; }, kill() {}, onExit(cb) { this.exitCb = cb; } };
      return modem;
    },
    restoreListen: () => {},
    mayKey: () => ({ ok: true }),
    key: () => { order.push('key'); radio.keyed = true; if (o.keyThrows) throw new Error('lane gone'); return true; },
    unkey: ({ now }) => { order.push('unkey'); if (now) { radio.keyed = false; return Promise.resolve(); } return new Promise((r) => tm.setTimer(() => { radio.keyed = false; r(); }, 250)); },
    onState: () => {},
    txProof: () => ({ canConfirm: true, minMs: 0 }),
    narrowTx: (band) => {
      const plan = R.planTxPassband({ band, flex: flex ? { connected: true, filter: flex.filter, allowed: flex.allowed } : null });
      if (plan.action === 'unsupported') { log.push(plan.log); return null; }
      if (plan.action !== 'narrow') return null;
      flexSet(plan.target);
      return plan.saved;
    },
    txReady: async () => true,
    restoreTx: (saved) => { flexSet(saved, { from: R.TX_PASSBAND['30m'], force: true }); },
  };
  const run = R.createRfBeacon(deps);
  const ptt = (on) => { const res = onPtt(on); if (on && res === true && o.readback !== false) run.noteRadioTx(true); return res; };
  return { run, tm, log, order, flex, radio, ptt, get modem() { return modem; } };
}
const pkt = (band) => R.buildRfBeacon({ settingsCall: 'K3SBP', band, lat: 40.5123, lon: -75.0456, symbol: 'house', comment: 'POTACAT', approx: true });
async function start(h, band = '30m') {
  const p = h.run.send({ packet: pkt(band), capMs: 3600, requestTimeoutMs: 75000 });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { p };
}
const NARROW = ['transmit set filter_low=1400', 'transmit set filter_high=2000'];
const BACK = ['transmit set filter_low=100', 'transmit set filter_high=3100'];

test('30 m sent: the narrow filter is set before the key-down and the saved filter comes back after the unkey', async () => {
  const h = harness();
  const { p } = await start(h);
  h.ptt(true);
  await h.tm.advance(2000);
  h.ptt(false);
  await h.tm.advance(300);
  const res = await p;
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.confirmed, true);
  assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
  const i = (s) => h.order.indexOf(s);
  assert.ok(i(NARROW[1]) < i('key'), h.order.join(','));
  assert.ok(h.order.lastIndexOf('unkey') < h.order.lastIndexOf(BACK[0]) && h.order.lastIndexOf(BACK[1]) < i('end'), h.order.join(','));
  assert.deepStrictEqual(h.flex.filter, { lo: 100, hi: 3100 });
});

test('30 m refused by the radio (OUT_OF_BAND): the saved filter comes back', async () => {
  const h = harness({ readback: false });
  const { p } = await start(h);
  h.ptt(true);
  h.run.noteRadioRefusal({ message: 'Interlock is preventing transmission', interlockState: 'NOT_READY', interlockReason: 'OUT_OF_BAND' });
  const res = await p;
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
  assert.deepStrictEqual(h.flex.filter, { lo: 100, hi: 3100 });
});

test('30 m error (the key-down throws): unkeyed and the saved filter comes back', async () => {
  const h = harness({ keyThrows: true });
  const { p } = await start(h);
  h.ptt(true);
  const res = await p;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(h.radio.keyed, false);
  assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
});

test('30 m error before keying (the modem does not start): the saved filter comes back', async () => {
  const h = harness({ modemFails: true });
  const res = await h.run.send({ packet: pkt('30m'), capMs: 3600 });
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
});

test('30 m timeouts and stops: the channel never clears, the cap, an abort; the filter comes back every time', async () => {
  const a = harness();
  let { p } = await start(a);
  await a.tm.advance(75000);
  assert.strictEqual((await p).reason, 'no-clear-channel');
  assert.deepStrictEqual(a.flex.sent, [...NARROW, ...BACK]);

  const b = harness();
  ({ p } = await start(b));
  b.ptt(true);
  await b.tm.advance(3600);
  assert.strictEqual((await p).reason, 'cap');
  assert.deepStrictEqual(b.flex.sent, [...NARROW, ...BACK]);

  const c = harness();
  ({ p } = await start(c));
  c.run.abort('the APRS window closed');
  assert.strictEqual((await p).reason, 'aborted');
  assert.deepStrictEqual(c.flex.sent, [...NARROW, ...BACK]);
});

test('2 m does not touch the filter', async () => {
  const h = harness();
  const { p } = await start(h, '2m');
  h.ptt(true); await h.tm.advance(1500); h.ptt(false); await h.tm.advance(300);
  assert.strictEqual((await p).ok, true);
  assert.deepStrictEqual(h.flex.sent, []);
  assert.deepStrictEqual(h.flex.filter, { lo: 100, hi: 3100 });
  assert.ok(!h.log.some((l) => /passband|filter/.test(l)), h.log.join(' | '));
});

test('a radio without TX passband control: nothing changes, one log line, the beacon still goes (the radio decides)', async () => {
  const h = harness({ noFlex: true });
  const { p } = await start(h);
  h.ptt(true); await h.tm.advance(2000); h.ptt(false); await h.tm.advance(300);
  assert.strictEqual((await p).ok, true);
  assert.strictEqual(h.log.filter((l) => /may refuse 30 m/.test(l)).length, 1, h.log.join(' | '));
  assert.ok(!h.order.some((s) => /transmit set/.test(s)));
});

// ── main wiring (source) ────────────────────────────────────────────────────
test('main wires narrowTx/txReady/restoreTx into the runner, never refuses by band, never sends atu clear', () => {
  const src = readSrc(path.join(__dirname, '..', 'main.js'));
  const runner = src.slice(src.indexOf('function aprsRfRunner()'), src.indexOf('function killArdop()'));
  assert.ok(/narrowTx: aprsRfNarrowTx/.test(runner) && /txReady: aprsRfTxReady/.test(runner) && /restoreTx: aprsRfRestoreTx/.test(runner), runner);
  const glue = src.slice(src.indexOf('function aprsRfFlexTxConn()'), src.indexOf('function aprsRfOtherTx()'));
  assert.ok(/planTxPassband/.test(glue), 'the plan comes from lib/aprs-rf-beacon.js');
  assert.ok(/setTxFilter\(saved\.lo, saved\.hi, \{ from, force: true \}\)/.test(glue), 'the put-back sends both edges');
  assert.ok(!/atu clear/.test(glue));
  assert.ok(!/return false/.test(glue.slice(glue.indexOf('function aprsRfNarrowTx'), glue.indexOf('function aprsRfTxReady'))), 'narrowing never refuses the beacon');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
