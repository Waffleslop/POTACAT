#!/usr/bin/env node
'use strict';
// APRS phase 7: one manual beacon over the radio (lib/aprs-rf-beacon.js).
// The packet per band (phase 5's builder, our tocall, the path per band), the
// hard per-transmission cap from the packet length and baud, and the run
// itself against a fake shim and a fake Dire Wolf: one key-down per beacon,
// the cap unkeys on its own, an error or a closed window unkeys at once, and
// every keying outside a beacon is refused and logged. All offline.
// Run: node test/aprs-rf-beacon-test.js

const assert = require('assert');
const R = require('../lib/aprs-rf-beacon');
const AprsBeacon = require('../lib/aprs-beacon');
const AprsParser = require('../lib/aprs-parser');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

console.log('APRS beacon over the radio: packet, cap and the run');

// ── the packet ──────────────────────────────────────────────────────────────
const pkt = (o) => R.buildRfBeacon({ settingsCall: 'K3SBP', band: '30m', lat: 40.5123, lon: -75.0456, symbol: 'house', comment: 'POTACAT', approx: true, ...(o || {}) });

test('path per band: WIDE1-1,WIDE2-1 on 2 m; WIDE1-1 on 30 m', () => {
  assert.deepStrictEqual(R.PATHS['2m'], ['WIDE1-1', 'WIDE2-1']);
  assert.deepStrictEqual(R.PATHS['30m'], ['WIDE1-1']);
  assert.strictEqual(pkt({ band: '2m' }).packet, 'K3SBP>APZPCT,WIDE1-1,WIDE2-1:!4030.  N/07502.  W-POTACAT');
  assert.strictEqual(pkt().packet, 'K3SBP>APZPCT,WIDE1-1:!4030.  N/07502.  W-POTACAT');
});

test('our tocall, and phase 5\'s information field unchanged (symbol, comment, approximate position by default)', () => {
  const rf = pkt({ symbol: 'car', comment: 'Mobile' });
  const is = AprsBeacon.buildBeacon({ settingsCall: 'K3SBP', lat: 40.5123, lon: -75.0456, symbol: 'car', comment: 'Mobile', approx: true });
  assert.strictEqual(rf.packet.split(':').slice(1).join(':'), is.packet.split(':').slice(1).join(':'));
  assert.ok(rf.packet.indexOf('>' + AprsBeacon.TOCALL + ',') > 0);
  const p = AprsParser.parse(rf.packet);
  assert.strictEqual(p.type, 'position');
  assert.strictEqual(p.ambiguity, 2);
  assert.strictEqual(p.symbolTable + p.symbol, '/>');
  assert.ok(!/TCPIP/.test(rf.packet), 'never an internet path on the air');
});

test('the source is the station\'s own call (not the internet -10): its SSID if the Settings call has one', () => {
  assert.strictEqual(pkt().source, 'K3SBP');
  assert.strictEqual(pkt({ settingsCall: 'k3sbp-9' }).source, 'K3SBP-9');
  assert.strictEqual(pkt({ settingsCall: 'K3SBP-16' }).source, 'K3SBP', 'SSIDs stop at 15');
  assert.strictEqual(pkt({ settingsCall: 'K3SBP-0' }).source, 'K3SBP');
});

test('refusals come from the phase 5 builder: no call, placeholder, no position', () => {
  assert.strictEqual(pkt({ settingsCall: '' }).reason, 'no-call');
  assert.strictEqual(pkt({ settingsCall: 'N0CALL' }).reason, 'placeholder');
  assert.strictEqual(pkt({ settingsCall: 'PCAT4821' }).reason, 'placeholder');
  assert.strictEqual(pkt({ lat: null, lon: null }).reason, 'position');
  assert.strictEqual(pkt({ band: '6m' }).reason, 'no-band');
});

test('the AGW request: from, to, the digipeaters and the information field', () => {
  const a = R.agwRequest(pkt({ band: '2m' }));
  assert.deepStrictEqual(a, { callFrom: 'K3SBP', callTo: 'APZPCT', via: ['WIDE1-1', 'WIDE2-1'], info: '!4030.  N/07502.  W-POTACAT' });
});

test('the AGW V frame: 1 byte digipeater count, 10 bytes per digipeater, then the info; PID F0', () => {
  const f = R.encodeAgwUnproto(R.agwRequest(pkt({ band: '2m' })));
  assert.strictEqual(String.fromCharCode(f[4]), 'V');
  assert.strictEqual(f[6], 0xf0);
  assert.strictEqual(f.toString('latin1', 8, 13), 'K3SBP');
  assert.strictEqual(f.toString('latin1', 18, 24), 'APZPCT');
  const data = f.subarray(36);
  assert.strictEqual(f.readUInt32LE(28), data.length);
  assert.strictEqual(data[0], 2);
  assert.strictEqual(data.toString('latin1', 1, 8), 'WIDE1-1');
  assert.strictEqual(data[8], 0);
  assert.strictEqual(data.toString('latin1', 11, 18), 'WIDE2-1');
  assert.strictEqual(data.toString('latin1', 21), '!4030.  N/07502.  W-POTACAT');
});

// ── the cap ─────────────────────────────────────────────────────────────────
test('the cap from packet length, baud, TXDELAY, TXTAIL and the unkey hold: about 2 s on 2 m, under 6 s on 30 m', () => {
  const t = { txDelayMs: 500, txTailMs: 200, drainMs: 250 };
  const two = R.capFor({ band: '2m', packet: pkt({ band: '2m' }).packet, ...t });
  assert.strictEqual(two.airMs, 1436);
  assert.strictEqual(two.capMs, 2100);
  const hf = R.capFor({ band: '30m', packet: pkt().packet, ...t });
  assert.strictEqual(hf.airMs, 2668);
  assert.strictEqual(hf.capMs, 3600);
  // The longest comment on 30 m still fits under 6 s.
  const long = R.capFor({ band: '30m', packet: pkt({ comment: 'x'.repeat(43) }).packet, ...t });
  assert.ok(long.capMs > 4500 && long.capMs <= 6000, String(long.capMs));
});

test('the cap never exceeds the stuck-TX ceiling for the kind (lib/tx-limit.js)', () => {
  const TxLimit = require('../lib/tx-limit');
  for (const band of ['2m', '30m']) {
    const worst = R.capFor({ band, packet: pkt({ band, comment: 'x'.repeat(43) }).packet, txDelayMs: 1000, txTailMs: 500, drainMs: 250 });
    assert.ok(worst.capMs < TxLimit.limitMsFor(R.TX_KIND[band]), band + ' ' + worst.capMs);
  }
  assert.strictEqual(R.TX_KIND['2m'], 'aprs2m');
  assert.strictEqual(R.TX_KIND['30m'], 'aprs30m');
});

// ── the run, with a fake shim and a fake Dire Wolf ──────────────────────────
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
    pending: () => timers.size,
  };
}

function harness(o = {}) {
  const tm = fakeTimers();
  const log = [];
  const calls = [];
  const radio = { keyed: false, owner: 'none' };
  let onPtt = null;
  let modem = null;
  const gateOk = { ok: true };
  const deps = {
    now: tm.now, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
    log: (s) => log.push(s),
    begin: () => { calls.push('begin'); if (o.beginFails) return false; radio.owner = 'aprs'; return true; },
    end: () => { calls.push('end'); radio.owner = 'none'; },
    startShim: async (fn) => { calls.push('shim'); if (o.shimWait) await o.shimWait; onPtt = fn; if (o.shimWait) calls.push('shim-up'); return 4551; },
    stopShim: () => { calls.push('shim-stop'); onPtt = null; },
    startModem: async ({ shimPort }) => {
      calls.push('modem:' + shimPort);
      if (o.modemFails) throw new Error('Dire Wolf did not start');
      modem = { sent: [], killed: false, exitCb: null,
        send(req) { this.sent.push(req); return !o.sendFails; },
        kill() { this.killed = true; calls.push('modem-kill'); },
        onExit(cb) { this.exitCb = cb; },
      };
      return modem;
    },
    restoreListen: () => calls.push('listen'),
    mayKey: () => (o.gate ? o.gate() : gateOk),
    key: () => { calls.push('key'); if (o.keyFails) return false; radio.keyed = true; if (o.keyThrows) throw new Error('lane gone'); return true; },
    unkey: ({ now }) => { calls.push(now ? 'unkey-now' : 'unkey'); if (now) { radio.keyed = false; return Promise.resolve(); } return new Promise((r) => tm.setTimer(() => { radio.keyed = false; r(); }, 250)); },
    onState: () => {},
    // The radio's own transmit readback (Flex interlock, a CAT rig's TX poll).
    txProof: () => (o.proof || { canConfirm: true, minMs: 0 }),
  };
  const run = R.createRfBeacon(deps);
  // The fake radio reports TRANSMITTING once keyed, unless the test says it refuses or stays silent.
  const ptt = (on) => {
    if (!onPtt) return 'no-shim';
    const res = onPtt(on);
    if (on && res === true && o.readback !== false) run.noteRadioTx(true);
    return res;
  };
  return { run, tm, log, calls, radio, ptt, get modem() { return modem; } };
}
const start = async (h, capMs = 2100) => {
  const p = h.run.send({ packet: pkt({ band: '2m' }), capMs, requestTimeoutMs: 75000 });
  await new Promise((r) => setImmediate(r));
  return { p }; // wrapped: awaiting a bare promise here would wait for the whole beacon
};

test('a beacon: the radio is taken, shim and transmit modem start, one frame is handed over', async () => {
  const h = harness();
  const { p } = await start(h);
  assert.deepStrictEqual(h.calls.slice(0, 3), ['begin', 'shim', 'modem:4551']);
  assert.strictEqual(h.modem.sent.length, 1);
  assert.strictEqual(h.modem.sent[0].callFrom, 'K3SBP');
  assert.strictEqual(h.run.state().phase, 'waiting');
  // Dire Wolf found the channel clear and asks for PTT; then lets go.
  assert.strictEqual(h.ptt(true), true);
  assert.strictEqual(h.radio.keyed, true);
  assert.strictEqual(h.run.state().phase, 'keyed');
  assert.strictEqual(h.ptt(false), true);
  await h.tm.advance(300);
  const res = await p;
  assert.strictEqual(res.ok, true);
  assert.strictEqual(h.radio.keyed, false);
  assert.ok(h.modem.killed, 'the transmit modem is gone');
  assert.ok(h.calls.indexOf('shim-stop') > 0 && h.calls.indexOf('end') > 0 && h.calls[h.calls.length - 1] === 'listen', h.calls.join(','));
  assert.strictEqual(h.run.state().phase, 'idle');
  assert.strictEqual(h.tm.pending(), 0, 'no timer left behind');
});

test('stopped while the shim is still starting: the shim that comes up late is closed too', async () => {
  let open;
  const h = harness({ shimWait: new Promise((r) => { open = r; }) });
  const p = h.run.send({ packet: pkt({ band: '2m' }), capMs: 2100, requestTimeoutMs: 75000 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.run.abort('window closed'), true);
  const res = await p;
  assert.strictEqual(res.reason, 'aborted');
  open();
  await h.tm.advance(10);
  const up = h.calls.indexOf('shim-up');
  assert.ok(up > 0, h.calls.join(','));
  assert.ok(h.calls.indexOf('shim-stop', up) > up, 'the late shim is stopped: ' + h.calls.join(','));
  assert.ok(!h.calls.some((c) => c.startsWith('modem:')), 'no modem after an abort');
});

test('a key-down that throws after the radio keyed still unkeys at once', async () => {
  const h = harness({ keyThrows: true });
  const { p } = await start(h);
  assert.strictEqual(h.ptt(true), false);
  const res = await p;
  assert.strictEqual(res.ok, false);
  assert.ok(h.calls.includes('unkey-now'), h.calls.join(','));
  assert.strictEqual(h.radio.keyed, false, 'the radio is back on receive');
});

test('the cap fires: POTACAT unkeys on its own, at once, and the beacon ends', async () => {
  const h = harness();
  const { p } = await start(h, 2100);
  h.ptt(true);
  await h.tm.advance(2099);
  assert.strictEqual(h.radio.keyed, true, 'not before the cap');
  await h.tm.advance(1);
  assert.strictEqual(h.radio.keyed, false, 'unkeyed at the cap');
  assert.ok(h.calls.includes('unkey-now'));
  const res = await p;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'cap');
  assert.ok(h.log.some((l) => /2\.1 s/.test(l) && /unkeyed/i.test(l)), h.log.join(' | '));
  assert.ok(h.modem.killed);
});

test('the cap runs through the unkey hold: a slow release is cut at the cap', async () => {
  const h = harness();
  const { p } = await start(h, 1000);
  h.ptt(true);
  await h.tm.advance(900);
  h.ptt(false);            // the graceful release takes 250 ms in this fake
  await h.tm.advance(100); // the cap (1000 ms) comes first
  assert.ok(h.calls.includes('unkey-now'));
  assert.strictEqual((await p).reason, 'cap');
});

test('the modem stops while keyed: unkey at once, error reported', async () => {
  const h = harness();
  const { p } = await start(h);
  h.ptt(true);
  h.modem.exitCb(1);
  assert.strictEqual(h.radio.keyed, false);
  assert.ok(h.calls.includes('unkey-now'));
  const res = await p;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'error');
});

test('the APRS window closes while keyed: unkey at once', async () => {
  const h = harness();
  const { p } = await start(h);
  h.ptt(true);
  h.run.abort('the APRS window closed');
  assert.strictEqual(h.radio.keyed, false);
  const res = await p;
  assert.strictEqual(res.reason, 'aborted');
  assert.ok(/window closed/.test(res.sentence));
  assert.ok(h.log.some((l) => /window closed/.test(l)));
});

test('the gate refuses at the key-down (dial moved, callsign...): not keyed, logged, beacon ends', async () => {
  const h = harness({ gate: () => ({ ok: false, reason: 'dial', sentence: 'The radio is on 7.1710 MHz, not the APRS frequency 10.1476 MHz.' }) });
  const { p } = await start(h);
  assert.strictEqual(h.ptt(true), false);
  assert.strictEqual(h.radio.keyed, false);
  assert.ok(!h.calls.includes('key'));
  assert.ok(h.log.some((l) => /refused/.test(l) && /7\.1710/.test(l)));
  const res = await p;
  assert.strictEqual(res.reason, 'dial');
});

test('one beacon, one key-down: a second key request in the same beacon is refused and logged', async () => {
  const h = harness();
  const { p } = await start(h);
  h.ptt(true); h.ptt(false);
  await h.tm.advance(100);  // inside the unkey hold
  assert.strictEqual(h.ptt(true), false);
  assert.ok(h.log.some((l) => /refused/.test(l)));
  await h.tm.advance(300);
  assert.strictEqual((await p).ok, true);
});

test('keying outside a beacon is refused and logged', async () => {
  const h = harness();
  assert.strictEqual(h.run.onShimPtt(true), false);
  assert.ok(h.log.some((l) => /refused/.test(l) && /no beacon/i.test(l)), h.log.join(' | '));
  assert.ok(!h.calls.includes('key'));
});

test('the radio refuses the key-down: the beacon ends, nothing keyed', async () => {
  const h = harness({ keyFails: true });
  const { p } = await start(h);
  assert.strictEqual(h.ptt(true), false);
  const res = await p;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'ptt-refused');
  assert.ok(h.calls.includes('listen'));
});

test('the channel never clears: no key-down, the beacon ends after the request time', async () => {
  const h = harness();
  const { p } = await start(h);
  await h.tm.advance(75000);
  const res = await p;
  assert.strictEqual(res.reason, 'no-clear-channel');
  assert.ok(!h.calls.includes('key'));
  assert.ok(h.modem.killed);
});

test('the transmit modem does not start: the radio is let go and listening comes back', async () => {
  const h = harness({ modemFails: true });
  const res = await (await start(h)).p;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'error');
  assert.ok(h.calls.includes('end') && h.calls.includes('shim-stop') && h.calls.includes('listen'));
});

test('the radio cannot be taken: nothing starts', async () => {
  const h = harness({ beginFails: true });
  const res = await (await start(h)).p;
  assert.strictEqual(res.reason, 'owner');
  assert.deepStrictEqual(h.calls, ['begin']);
});

test('a second press while one is in flight is refused', async () => {
  const h = harness();
  const { p } = await start(h);
  const second = await h.run.send({ packet: pkt({ band: '2m' }), capMs: 2100 });
  assert.strictEqual(second.reason, 'busy');
  h.run.abort('test over');
  await p;
});

// ── sent only when the radio keyed (2026-11-19, 8600M on 10.1476 MHz) ───────
// The radio refused ("The transmitter is not ready", "Interlock is preventing
// transmission", interlock NOT_READY, 0.0 W out), yet the app logged "sent
// over the radio" and showed "Last radio beacon 1 min ago".

test('the radio refuses (interlock NOT_READY): not sent, unkeyed at once, the radio\'s reason in plain words', async () => {
  const h = harness({ readback: false });
  const { p } = await start(h);
  assert.strictEqual(h.ptt(true), true, 'POTACAT asked for PTT');
  h.run.noteRadioRefusal({ message: 'Interlock is preventing transmission', interlockState: 'NOT_READY' });
  const res = await p;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not-keyed');
  assert.strictEqual(res.sentence, 'The radio refused to transmit: Interlock is preventing transmission (not ready on this band).');
  assert.ok(h.calls.includes('unkey-now'), h.calls.join(','));
  assert.strictEqual(h.radio.keyed, false);
  assert.ok(h.log.some((l) => /refused to transmit/.test(l)), h.log.join(' | '));
});

test('the radio never reports transmit and gives no reason: not sent', async () => {
  const h = harness({ readback: false });
  const { p } = await start(h);
  h.ptt(true);
  await h.tm.advance(1500);
  h.ptt(false);
  await h.tm.advance(300);
  const res = await p;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not-keyed');
  assert.strictEqual(res.sentence, 'The radio never went to transmit, so nothing was sent.');
});

test('the radio reported transmit: sent, and confirmed', async () => {
  const h = harness();
  const { p } = await start(h);
  h.ptt(true);
  await h.tm.advance(1500);
  h.ptt(false);
  await h.tm.advance(300);
  const res = await p;
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.confirmed, true);
});

test('a refusal after the radio already transmitted (the unkey\'s own reply) does not undo the beacon', async () => {
  const h = harness();
  const { p } = await start(h);
  h.ptt(true);
  h.ptt(false);
  h.run.noteRadioRefusal({ message: 'The transmitter is not ready' });
  await h.tm.advance(300);
  assert.strictEqual((await p).confirmed, true);
});

test('a radio with no transmit readback: keyed, but not counted as sent', async () => {
  const h = harness({ readback: false, proof: { canConfirm: false, minMs: 0 } });
  const { p } = await start(h);
  h.ptt(true); await h.tm.advance(1500); h.ptt(false); await h.tm.advance(300);
  const res = await p;
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.confirmed, false);
  assert.ok(/cannot be confirmed/.test(res.sentence), res.sentence);
});

test('an over shorter than the rig\'s TX poll: no readback is "not confirmed", not "refused"', async () => {
  const h = harness({ readback: false, proof: { canConfirm: true, minMs: 1800 } });
  const { p } = await start(h);
  h.ptt(true); await h.tm.advance(900); h.ptt(false); await h.tm.advance(300);
  const res = await p;
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.confirmed, false);
});

test('refusalSentence: the radio\'s words first, the interlock state in plain words', () => {
  assert.strictEqual(R.refusalSentence({ message: 'Interlock is preventing transmission', interlockState: 'NOT_READY' }), 'The radio refused to transmit: Interlock is preventing transmission (not ready on this band).');
  assert.strictEqual(R.refusalSentence({ message: 'The transmitter is not ready.' }), 'The radio refused to transmit: The transmitter is not ready.');
  assert.strictEqual(R.refusalSentence({ interlockState: 'NOT_READY' }), 'The radio refused to transmit: it is not ready on this band.');
  assert.strictEqual(R.refusalSentence({ interlockState: 'NOT_READY', interlockReason: 'AMP:TG' }), 'The radio refused to transmit: AMP:TG (not ready on this band).');
  assert.strictEqual(R.refusalSentence({}), 'The radio refused to transmit, so nothing was sent.');
});

test('txProofFor: a Flex interlock confirms at once; a CAT TX poll needs an over longer than its poll; none cannot confirm', () => {
  assert.deepStrictEqual(R.txProofFor({ flexInterlock: 'READY' }), { canConfirm: true, minMs: 0 });
  assert.deepStrictEqual(R.txProofFor({ catReadsPtt: true, catPollMs: 1000 }), { canConfirm: true, minMs: 1800 });
  assert.deepStrictEqual(R.txProofFor({ catReadsPtt: true, catPollMs: 500 }), { canConfirm: true, minMs: 1050 });
  assert.deepStrictEqual(R.txProofFor({}), { canConfirm: false, minMs: 0 });
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
