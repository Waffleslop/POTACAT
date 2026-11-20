#!/usr/bin/env node
'use strict';
// APRS 30 m beacon: the transmit passband stays inside 10.150 MHz.
//
// 2026-11-19, FLEX-8600M: the 30 m beacon (10.1476 MHz DIGU, tones 1600/1800
// Hz) was refused with interlock OUT_OF_BAND. The radio's TX filter was
// 100-3100 Hz, so the transmit passband's top edge was 10.1507 MHz, past the
// 30 m band edge. For a 30 m beacon on a Flex POTACAT now narrows the TX
// filter to 1400-2000 Hz before anything can key (one command, both edges,
// as FlexLib's _SetTXFilter sends it), keys only on a zero reply, and puts
// the operator's filter back on every way out. 2 m is unchanged; a radio
// POTACAT cannot set a TX passband on is left alone with one log line.
// Run: node test/aprs-30m-tx-passband-test.js

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = require('../lib/aprs-rf-beacon');
const F = require('../lib/flex-tx-filter');
const G = require('../lib/aprs-rf-gate');

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
  assert.ok(F.validTxFilter(t), 'within FlexLib\'s limits');
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

test('planTxPassband: a Flex that has not reported its filter, does not allow changes, or reports one FlexLib would not accept, is left alone', () => {
  assert.strictEqual(R.planTxPassband({ band: '30m', flex: { connected: true, filter: null, allowed: true } }).action, 'unsupported');
  assert.strictEqual(R.planTxPassband({ band: '30m', flex: { connected: true, filter: { lo: 100, hi: null }, allowed: true } }).action, 'unsupported');
  const no = R.planTxPassband({ band: '30m', flex: { connected: true, filter: { lo: 100, hi: 3100 }, allowed: false } });
  assert.strictEqual(no.action, 'unsupported');
  assert.ok(/tx_filter_changes_allowed=0/.test(no.log), no.log);
  const odd = R.planTxPassband({ band: '30m', flex: { connected: true, filter: { lo: 100, hi: 120 }, allowed: true } });
  assert.strictEqual(odd.action, 'unsupported', 'a saved filter that could not be sent back is never replaced');
});

// ── the Flex command ────────────────────────────────────────────────────────
test('parseTxFilter reads lo=/hi=/tx_filter_changes_allowed= from a real 8600M transmit status', () => {
  const body = TX_STATUS.replace(/^.*?\|transmit /, '');
  const t = F.parseTxFilter(body);
  assert.deepStrictEqual(t.filter, { lo: 100, hi: 3100 });
  assert.strictEqual(t.allowed, true);
  assert.strictEqual(F.parseTxFilter('rfpower=5').filter, null);
});

test('txFilterCommand: ONE command with both edges (FlexLib _SetTXFilter), within FlexLib\'s limits or not at all', () => {
  assert.strictEqual(F.txFilterCommand({ lo: 1400, hi: 2000 }), 'transmit set filter_low=1400 filter_high=2000');
  assert.strictEqual(F.txFilterCommand({ lo: 100, hi: 3100 }), 'transmit set filter_low=100 filter_high=3100');
  assert.strictEqual(F.txFilterCommand({ lo: 0, hi: 10000 }), 'transmit set filter_low=0 filter_high=10000');
  assert.strictEqual(F.txFilterCommand({ lo: 1000, hi: 1050 }), 'transmit set filter_low=1000 filter_high=1050');
  assert.strictEqual(F.txFilterCommand({ lo: -1, hi: 2000 }), null, 'low below 0');
  assert.strictEqual(F.txFilterCommand({ lo: 100, hi: 10001 }), null, 'high above 10000');
  assert.strictEqual(F.txFilterCommand({ lo: 1000, hi: 1049 }), null, 'narrower than 50 Hz');
  assert.strictEqual(F.txFilterCommand({ lo: 2000, hi: 1400 }), null, 'low at or above high');
  assert.strictEqual(F.txFilterCommand({ lo: null, hi: 2000 }), null);
  assert.strictEqual(F.txFilterCommand({ lo: 100.5, hi: 2000 }), null, 'whole Hz only');
});

test('SmartSdrClient tracks the TX filter and sets it in one command; a zero reply is ok, non-zero is refused', async () => {
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
  c._sock = { write: (s) => sent.push(s.trim()) };
  c.connected = true;
  let p = c.setTxFilter({ lo: 1400, hi: 2000 });
  assert.deepStrictEqual(sent.map((s) => s.replace(/^C\d+\|/, '')), ['transmit set filter_low=1400 filter_high=2000']);
  c._handleLine(sent[0].replace(/^C(\d+)\|.*/, 'R$1|0|'));
  assert.deepStrictEqual(await p, { ok: true, cmd: 'transmit set filter_low=1400 filter_high=2000', status: 0 });
  p = c.setTxFilter({ lo: 100, hi: 3100 });
  c._handleLine(sent[1].replace(/^C(\d+)\|.*/, 'R$1|50000016|'));
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'refused');
  assert.strictEqual(r.status, 0x50000016);
  assert.deepStrictEqual(await c.setTxFilter({ lo: 1000, hi: 1020 }), { ok: false, cmd: null, reason: 'invalid' });
  assert.strictEqual(sent.length, 2, 'an invalid filter is never sent');
  assert.ok(!sent.some((s) => /atu/.test(s)));
});

test('SmartSdrAudio (the bound station connection) tracks and sets the TX filter the same way', async () => {
  const { SmartSdrAudio } = require('../lib/smartsdr-audio');
  const a = new SmartSdrAudio();
  a._handleLine(TX_STATUS);
  assert.deepStrictEqual(a.txFilter, { lo: 100, hi: 3100 });
  const sent = [];
  a._sock = { write: (s) => sent.push(s.trim()) }; a._connected = true;
  let p = a.setTxFilter({ lo: 1400, hi: 2000 });
  assert.deepStrictEqual(sent.map((s) => s.replace(/^C\d+\|/, '')), ['transmit set filter_low=1400 filter_high=2000']);
  a._handleLine(sent[0].replace(/^C(\d+)\|.*/, 'R$1|0|'));
  assert.strictEqual((await p).ok, true);
  p = a.setTxFilter({ lo: 100, hi: 3100 });
  a._handleLine(sent[1].replace(/^C(\d+)\|.*/, 'R$1|50000016|'));
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'refused');
  assert.strictEqual((await a.setTxFilter({ lo: 1400, hi: 1400 })).reason, 'invalid');
  assert.strictEqual(sent.length, 2);
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
 * A fake radio: a Flex station (TX filter, the commands it was sent, its
 * reply) or, with o.noFlex, a radio POTACAT cannot set a TX passband on.
 * narrowTx/restoreTx do what main's glue does: planTxPassband, then one
 * command and the radio's reply. o.reply (to the narrow set): 0 (default),
 * a non-zero status, or 'none'. o.filter / o.allowed: the station's state.
 * flex.seen is every filter the radio actually took, in order.
 */
function harness(o = {}) {
  const tm = fakeTimers();
  const log = [];
  const order = [];
  const flex = o.noFlex ? null : { filter: o.filter || { lo: 100, hi: 3100 }, allowed: o.allowed !== undefined ? o.allowed : true, sent: [], seen: [],
    // The radio's interlock: OUT_OF_BAND on the wide filter (on-air 2026-11-19); READY once it takes the narrow one, unless o.stays.
    interlock: o.interlock || { state: 'NOT_READY', reason: 'OUT_OF_BAND' } };
  const flexSet = async (to) => {
    const cmd = F.txFilterCommand(to);
    if (!cmd) return { ok: false, cmd: null, reason: 'invalid' };
    flex.sent.push(cmd); order.push(cmd);
    const reply = flex.sent.length === 1 && o.reply !== undefined ? o.reply : 0;
    if (reply === 'none') return { ok: false, cmd, reason: 'no-reply' };
    if (reply !== 0) return { ok: false, cmd, status: reply, reason: 'refused' };
    flex.filter = { ...to }; flex.seen.push({ ...to });
    if (!o.stays && to.lo === 1400 && to.hi === 2000) flex.interlock = { state: 'READY', reason: '' };
    return { ok: true, cmd, status: 0 };
  };
  const radio = { keyed: false };
  let onPtt = null, modem = null;
  const deps = {
    now: tm.now, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
    log: (s) => log.push(s),
    begin: () => { order.push('begin'); return true; },
    end: () => { order.push('end'); },
    startShim: async (fn) => { order.push('shim'); onPtt = fn; return 4551; },
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
      return flexSet(plan.target).then((res) => ({ saved: plan.saved, ok: res.ok, reason: res.reason, reply: res.status != null ? 'reply 0x' + res.status.toString(16) : res.reason }));
    },
    restoreTx: (saved) => flexSet(saved),
    txInterlock: () => { if (!flex) return null; order.push('interlock:' + flex.interlock.state); return { ...flex.interlock }; },
  };
  const run = R.createRfBeacon(deps);
  const ptt = (on) => { if (!onPtt) return 'no-shim'; const res = onPtt(on); if (on && res === true && o.readback !== false) run.noteRadioTx(true); return res; };
  return { run, tm, log, order, flex, radio, ptt, get modem() { return modem; } };
}
const pkt = (band) => R.buildRfBeacon({ settingsCall: 'K3SBP', band, lat: 40.5123, lon: -75.0456, symbol: 'house', comment: 'POTACAT', approx: true });
async function start(h, band = '30m') {
  const p = h.run.send({ packet: pkt(band), capMs: 3600, requestTimeoutMs: 75000 });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { p };
}
const NARROW = ['transmit set filter_low=1400 filter_high=2000'];
const BACK = ['transmit set filter_low=100 filter_high=3100'];
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test('30 m sent: the narrow filter is taken before the key-down and the saved filter comes back after the unkey', async () => {
  const h = harness();
  const { p } = await start(h);
  h.ptt(true);
  await h.tm.advance(2000);
  h.ptt(false);
  await h.tm.advance(300);
  const res = await p;
  await settle();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.confirmed, true);
  assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
  const i = (s) => h.order.indexOf(s);
  assert.ok(i(NARROW[0]) < i('shim') && i(NARROW[0]) < i('key'), h.order.join(','));
  assert.ok(h.order.lastIndexOf('unkey') < h.order.lastIndexOf(BACK[0]) && h.order.lastIndexOf(BACK[0]) < i('end'), h.order.join(','));
  assert.deepStrictEqual(h.flex.filter, { lo: 100, hi: 3100 });
});

test('30 m refused by the radio (OUT_OF_BAND): the saved filter comes back', async () => {
  const h = harness({ readback: false });
  const { p } = await start(h);
  h.ptt(true);
  h.run.noteRadioRefusal({ message: 'Interlock is preventing transmission', interlockState: 'NOT_READY', interlockReason: 'OUT_OF_BAND' });
  const res = await p;
  await settle();
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
  assert.deepStrictEqual(h.flex.filter, { lo: 100, hi: 3100 });
});

test('30 m error (the key-down throws): unkeyed and the saved filter comes back', async () => {
  const h = harness({ keyThrows: true });
  const { p } = await start(h);
  h.ptt(true);
  const res = await p;
  await settle();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(h.radio.keyed, false);
  assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
});

test('30 m error before keying (the modem does not start): the saved filter comes back', async () => {
  const h = harness({ modemFails: true });
  const res = await h.run.send({ packet: pkt('30m'), capMs: 3600 });
  await settle();
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
});

test('30 m timeouts and stops: the channel never clears, the cap, an abort; the filter comes back every time', async () => {
  const a = harness();
  let { p } = await start(a);
  await a.tm.advance(75000);
  assert.strictEqual((await p).reason, 'no-clear-channel');
  await settle();
  assert.deepStrictEqual(a.flex.sent, [...NARROW, ...BACK]);

  const b = harness();
  ({ p } = await start(b));
  b.ptt(true);
  await b.tm.advance(3600);
  assert.strictEqual((await p).reason, 'cap');
  await settle();
  assert.deepStrictEqual(b.flex.sent, [...NARROW, ...BACK]);

  const c = harness();
  ({ p } = await start(c));
  c.run.abort('the APRS window closed');
  assert.strictEqual((await p).reason, 'aborted');
  await settle();
  assert.deepStrictEqual(c.flex.sent, [...NARROW, ...BACK]);
});

test('30 m, the radio answers the narrow set with a non-zero reply: never keyed, nothing put back (nothing changed), the reply logged', async () => {
  const h = harness({ reply: 0x50000016 });
  const res = await h.run.send({ packet: pkt('30m'), capMs: 3600 });
  await settle();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'tx-filter');
  assert.ok(!h.order.includes('key') && !h.order.includes('shim'), h.order.join(','));
  assert.deepStrictEqual(h.flex.sent, NARROW, 'no put-back');
  assert.deepStrictEqual(h.flex.filter, { lo: 100, hi: 3100 });
  assert.ok(h.log.some((l) => /reply 0x50000016/.test(l) && /not keyed/.test(l)), h.log.join(' | '));
});

test('30 m, no reply to the narrow set: never keyed, and the saved filter is sent back in case it did change', async () => {
  const h = harness({ reply: 'none' });
  const res = await h.run.send({ packet: pkt('30m'), capMs: 3600 });
  await settle();
  assert.strictEqual(res.ok, false);
  assert.ok(!h.order.includes('key'));
  assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
});

test('the put-back is one command: a saved filter above or below 1400-2000 never passes through low >= high', async () => {
  for (const saved of [{ lo: 2100, hi: 2800 }, { lo: 200, hi: 1300 }]) {
    const h = harness({ filter: saved });
    const { p } = await start(h);
    h.ptt(true); await h.tm.advance(2000); h.ptt(false); await h.tm.advance(300);
    await p; await settle();
    assert.deepStrictEqual(h.flex.sent, [NARROW[0], `transmit set filter_low=${saved.lo} filter_high=${saved.hi}`]);
    assert.deepStrictEqual(h.flex.seen, [{ lo: 1400, hi: 2000 }, saved], 'the radio only ever holds a whole filter');
    assert.ok(h.flex.seen.every((f) => f.hi - f.lo >= 50));
  }
});

test('tx_filter_changes_allowed=0: no filter command, one log line, keyed as before', async () => {
  const h = harness({ allowed: false });
  const { p } = await start(h);
  h.ptt(true); await h.tm.advance(2000); h.ptt(false); await h.tm.advance(300);
  assert.strictEqual((await p).ok, true);
  assert.ok(h.order.includes('key'));
  assert.deepStrictEqual(h.flex.sent, []);
  assert.strictEqual(h.log.filter((l) => /tx_filter_changes_allowed=0/.test(l)).length, 1, h.log.join(' | '));
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

// ── the gate and the radio's OUT_OF_BAND reading (on-air 2026-11-19) ─────────
// The 8600M reads interlock NOT_READY OUT_OF_BAND at 100-3100 Hz on 10.1476
// before any key-down, so the gate disabled the button and the narrow filter
// never went out.
const gateReady = (o) => ({
  remote: false, windowOpen: true, listenOn: true, listenState: 'listening', band: '30m',
  settingsCall: 'K3SBP', aprsHz: 10147600, dialHz: 10147600, dialMode: 'DIGU',
  radioOwner: 'none', pttKeyed: false, otherTx: '', swrTripped: false, modemFound: true, inFlight: false,
  txInterlock: 'NOT_READY', txInterlockReason: 'OUT_OF_BAND', txNarrow: { lo: 1400, hi: 2000 },
  ...(o || {}),
});
const fits = (dialHz, mode) => G.narrowFits({ band: '30m', dialHz, mode, filter: { lo: 1400, hi: 2000 } });

test('narrowFits, from the live dial and mode: fits on 10.1476 DIGU/USB (top 10.1496 MHz), not past either band edge', () => {
  assert.deepStrictEqual(fits(10147600, 'DIGU'), { fits: true, loHz: 10149000, hiHz: 10149600 });
  assert.strictEqual(fits(10147600, 'USB').fits, true);
  assert.strictEqual(fits(10148000, 'DIGU').fits, true, 'top edge exactly 10.150 MHz');
  assert.strictEqual(fits(10148100, 'DIGU').fits, false, 'top edge 10.1501 MHz');
  assert.strictEqual(fits(10098600, 'DIGU').fits, true, 'bottom edge exactly 10.100 MHz');
  assert.strictEqual(fits(10098500, 'DIGU').fits, false, 'bottom edge 10.0999 MHz');
  assert.strictEqual(fits(10151900, 'DIGL').fits, false, 'lower sideband: dial - 2000 .. dial - 1400 = 10.1499-10.1505 MHz');
  assert.strictEqual(fits(10151400, 'DIGL').fits, true, 'lower sideband: 10.1494-10.1500 MHz');
  assert.strictEqual(fits(10147600, 'FM').fits, false, 'not a sideband mode');
  assert.strictEqual(fits(0, 'DIGU').fits, false);
  assert.strictEqual(G.narrowFits({ band: '2m', dialHz: 144390000, mode: 'FM', filter: { lo: 1400, hi: 2000 } }).fits, false);
});

test('the gate: OUT_OF_BAND that the narrow filter will clear (30 m Flex, fits on the live dial and mode) enables the button', () => {
  assert.strictEqual(G.readiness(gateReady()), null);
  assert.strictEqual(G.readiness(gateReady({ txInterlock: 'READY', txInterlockReason: '' })), null);
});

test('the gate: OUT_OF_BAND still refuses with the radio reason when the narrow passband would not fit, there is no narrow filter, or the reason is another', () => {
  const sentence = 'The radio is not ready to transmit on this band: its interlock is preventing transmission (OUT_OF_BAND).';
  const off = G.readiness(gateReady({ dialHz: 10148100, aprsHz: 10148100 }));
  assert.strictEqual(off.reason, 'radio-not-ready');
  assert.strictEqual(off.sentence, sentence);
  assert.strictEqual(G.readiness(gateReady({ dialMode: 'FM' })).reason, 'radio-not-ready');
  assert.strictEqual(G.readiness(gateReady({ txNarrow: null })).sentence, sentence, 'no narrow filter: not a Flex, changes not allowed, 2 m');
  assert.strictEqual(G.readiness(gateReady({ txInterlockReason: 'AMP:TG' })).reason, 'radio-not-ready');
  assert.strictEqual(G.readiness(gateReady({ txInterlockReason: '' })).reason, 'radio-not-ready');
  // The key-down itself never makes the exception.
  assert.strictEqual(G.mayKey(gateReady({ inFlight: true, radioOwner: 'aprs' })).reason, 'radio-not-ready');
});

test('order: the narrow filter first, then the radio interlock is judged, then the key-down', async () => {
  const h = harness();
  const { p } = await start(h);
  h.ptt(true); await h.tm.advance(2000); h.ptt(false); await h.tm.advance(300);
  assert.strictEqual((await p).ok, true);
  await settle();
  const i = (s) => h.order.indexOf(s);
  assert.ok(i(NARROW[0]) >= 0 && i(NARROW[0]) < i('interlock:READY') && i('interlock:READY') < i('shim') && i('shim') < i('key'), h.order.join(','));
  assert.ok(!h.order.slice(0, i(NARROW[0])).some((s) => /^interlock/.test(s)), 'the interlock is not judged before the narrow filter');
});

test('the interlock takes a moment to read READY after the narrow filter: the beacon waits for it', async () => {
  const h = harness({ stays: true });
  const { p } = await start(h);
  assert.ok(!h.order.includes('shim'));
  h.flex.interlock = { state: 'READY', reason: '' };
  await h.tm.advance(100);
  await settle();
  assert.ok(h.order.includes('shim'), h.order.join(','));
  h.ptt(true); await h.tm.advance(2000); h.ptt(false); await h.tm.advance(300);
  assert.strictEqual((await p).ok, true);
});

test('still NOT_READY after the narrow filter (OUT_OF_BAND or any reason): never keyed, the filter put back in one command, the radio reason', async () => {
  for (const reason of ['OUT_OF_BAND', 'AMP:TG']) {
    const h = harness({ stays: true, interlock: { state: 'NOT_READY', reason } });
    const { p } = await start(h);
    await h.tm.advance(R.INTERLOCK_WAIT_MS);
    const res = await p;
    await settle();
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'not-keyed');
    assert.strictEqual(res.sentence, R.refusalSentence({ interlockState: 'NOT_READY', interlockReason: reason }));
    assert.ok(!h.order.includes('key') && !h.order.includes('shim'), h.order.join(','));
    assert.deepStrictEqual(h.flex.sent, [...NARROW, ...BACK]);
    assert.deepStrictEqual(h.flex.filter, { lo: 100, hi: 3100 });
  }
});

// ── confirming the put-back (on-air 2026-11-20) ─────────────────────────────
// The put-back got R11|0|, but the cached transmit status still read
// lo=1400 hi=2000 until the next mode change, and the interlock went back to
// OUT_OF_BAND 120 ms after it. The cached block is never the proof.
function confirmRig(o = {}) {
  const tm = fakeTimers();
  const radio = { statusSeq: 7, filter: { lo: 1400, hi: 2000 }, interlockState: 'READY', interlockReason: '' };
  const p = R.confirmTxRestore({
    saved: { lo: 100, hi: 3100 }, sinceSeq: 7, outOfBandExpected: true, interlockAtStart: 'READY',
    ...o, read: () => ({ ...radio }), setTimer: tm.setTimer, now: tm.now,
  });
  return { tm, radio, p };
}

test('the put-back is confirmed by the interlock going back to OUT_OF_BAND 120 ms later (the saved filter is out of band on 10.1476)', async () => {
  const c = confirmRig();
  await c.tm.advance(100);
  c.radio.interlockState = 'NOT_READY'; c.radio.interlockReason = 'OUT_OF_BAND';
  await c.tm.advance(100);
  assert.deepStrictEqual(await c.p, { confirmed: true, by: 'interlock OUT_OF_BAND' });
});

test('the put-back is confirmed by a fresh transmit status (newer than the re-subscribe) that reads the saved filter', async () => {
  const c = confirmRig({ outOfBandExpected: false });
  await c.tm.advance(100);
  c.radio.statusSeq = 8; c.radio.filter = { lo: 100, hi: 3100 };
  await c.tm.advance(100);
  assert.deepStrictEqual(await c.p, { confirmed: true, by: 'fresh transmit status' });
});

test('never from the stale cached block: the cached lo/hi alone, even when it reads the saved filter, confirms nothing; a warning after 2 s', async () => {
  const stale = confirmRig({ outOfBandExpected: false });
  await stale.tm.advance(2100);
  assert.deepStrictEqual(await stale.p, { confirmed: false }, 'cached 1400-2000, no fresh line');
  const cachedRight = confirmRig({ outOfBandExpected: false });
  cachedRight.radio.filter = { lo: 100, hi: 3100 }; // the cache, not a line after the re-subscribe
  await cachedRight.tm.advance(2100);
  assert.deepStrictEqual(await cachedRight.p, { confirmed: false });
  const freshButWrong = confirmRig({ outOfBandExpected: false });
  freshButWrong.radio.statusSeq = 8; // a fresh line that still reads 1400-2000
  await freshButWrong.tm.advance(2100);
  assert.deepStrictEqual(await freshButWrong.p, { confirmed: false });
});

test('the interlock confirms only when the saved filter is out of band and the interlock was not already NOT_READY', async () => {
  const notExpected = confirmRig({ outOfBandExpected: false });
  notExpected.radio.interlockState = 'NOT_READY'; notExpected.radio.interlockReason = 'OUT_OF_BAND';
  await notExpected.tm.advance(2100);
  assert.deepStrictEqual(await notExpected.p, { confirmed: false });
  const already = confirmRig({ interlockAtStart: 'NOT_READY' }); // the beacon was refused with OUT_OF_BAND still read
  already.radio.interlockState = 'NOT_READY'; already.radio.interlockReason = 'OUT_OF_BAND';
  await already.tm.advance(2100);
  assert.deepStrictEqual(await already.p, { confirmed: false });
  const otherReason = confirmRig();
  otherReason.radio.interlockState = 'NOT_READY'; otherReason.radio.interlockReason = 'AMP:TG';
  await otherReason.tm.advance(2100);
  assert.deepStrictEqual(await otherReason.p, { confirmed: false });
});

test('SmartSdrClient and SmartSdrAudio: refreshTxStatus re-subscribes (sub tx all) and returns the lo/hi line count, which only lo/hi lines advance', () => {
  const { SmartSdrClient } = require('../lib/smartsdr');
  const { SmartSdrAudio } = require('../lib/smartsdr-audio');
  const c = new SmartSdrClient();
  const sent = [];
  c._send = (s) => { sent.push(s); return 1; };
  c.connected = true;
  c._handleLine(TX_STATUS);
  assert.strictEqual(c.txFilterSeq, 1);
  c._handleLine('S766257AA|transmit rfpower=5');
  assert.strictEqual(c.txFilterSeq, 1, 'a line without lo/hi does not count');
  assert.strictEqual(c.refreshTxStatus(), 1);
  assert.deepStrictEqual(sent, ['sub tx all']);
  c._handleLine(TX_STATUS);
  assert.strictEqual(c.txFilterSeq, 2);
  const a = new SmartSdrAudio();
  const aSent = [];
  a._sock = {}; a._connected = true;
  a._send = (s) => { aSent.push(s); return 1; };
  a._handleLine(TX_STATUS);
  assert.strictEqual(a.refreshTxStatus(), 1);
  assert.deepStrictEqual(aSent, ['sub tx all']);
});

// ── main wiring (source) ────────────────────────────────────────────────────
test('main wires narrowTx/restoreTx into the runner, sends whole filters, never refuses by band, never sends atu clear', () => {
  const src = readSrc(path.join(__dirname, '..', 'main.js'));
  const runner = src.slice(src.indexOf('function aprsRfRunner()'), src.indexOf('function killArdop()'));
  assert.ok(/narrowTx: aprsRfNarrowTx/.test(runner) && /restoreTx: aprsRfRestoreTx/.test(runner) && /txInterlock: aprsRfTxInterlock/.test(runner), runner);
  const gate = src.slice(src.indexOf('function aprsRfGateState()'), src.indexOf('function aprsRfDevReadiness()'));
  assert.ok(/txNarrow: /.test(gate) && /dialMode: _currentMode/.test(gate), 'the gate sees the narrow filter and the live mode');
  // The put-back is confirmed from the radio (a fresh status or the interlock), never the cached block, and logs which.
  const conf = src.slice(src.indexOf('function aprsRfConfirmRestore('), src.indexOf('function aprsRfOtherTx()'));
  assert.ok(/refreshTxStatus\(\)/.test(conf) && /confirmTxRestore\(/.test(conf) && /\$\{c\.by\}/.test(conf) && /warning:/.test(conf), conf);
  const restore = src.slice(src.indexOf('function aprsRfRestoreTx('), src.indexOf('function aprsRfConfirmRestore('));
  assert.ok(/aprsRfConfirmRestore\(conn, saved, interlockAtStart\)/.test(restore));
  assert.ok(!/txFilter\.lo|txFilter\.hi/.test(restore + conf), 'no check on the cached lo/hi');
  // Listening is receive only: the listen start never reads the interlock or the TX filter.
  const at = src.indexOf('function aprsSpawnDirewolf(');
  assert.ok(at > 0 && !/interlock|txNarrow|setTxFilter/.test(src.slice(at, at + 4000)));
  const glue = src.slice(src.indexOf('function aprsRfFlexTxConn()'), src.indexOf('function aprsRfOtherTx()'));
  assert.ok(/planTxPassband/.test(glue), 'the plan comes from lib/aprs-rf-beacon.js');
  assert.ok(/setTxFilter\(target\)/.test(glue) && /setTxFilter\(saved\)/.test(glue), 'one whole filter each way');
  assert.ok(!/atu clear/.test(glue));
  assert.ok(!/return false/.test(glue), 'the glue never refuses the beacon by band');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
