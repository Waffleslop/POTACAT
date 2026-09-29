#!/usr/bin/env node
'use strict';
// LZ3AW round 10 (TS-480, CW Key Port on COM4, ECHOCAT Web, 400 km from the
// radio), 2026-09-29, on 1.10.26:
//   1. "SWR meter doesn't read below 1.3:1, when it is 1:1, not showing."
//   2. "Power meter ... not so dynamic - sometimes takes longer to visualise."
//   3. "Paddle ... still errors occur during manipulation, especially with
//      the dots."
//   4. "Big visualization delay, when turn SPLIT ON and switching VFOs."
// Run: node test/lz3aw-round10-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RigController } = require('../lib/rig-controller');
const { RIG_MODELS } = require('../lib/rig-models');
const { CwKeyPlayout } = require('../lib/cw-key-playout');
const { RemoteServer } = require('../lib/remote-server');
const P = require('../lib/echocat-protocol');
const { EventEmitter } = require('events');

let passed = 0, failed = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const TS480 = RIG_MODELS['TS-480'];

function ts480() {
  const writes = [];
  const codec = new KenwoodCodec(TS480, (d) => writes.push(String(d)));
  return { codec, writes };
}
// A 37-char IF; body (onData strips ';'): P10 VFO at 30, P12 split at 32.
function ifFrame(vfoB, split) {
  // Same published layout as rig-test's kenwoodIf (P2 '0000', P15 '0').
  const body = 'IF' + '00014074000' + '0000' + '+00000' + '0' + '0' + '0' + '00' + '0' + '2' + (vfoB ? '1' : '0') + '0' + (split ? '1' : '0') + '0' + '00' + '0';
  assert.strictEqual(body.length, 37);
  return body + ';';
}

// A fake clock + timers for the playout.
function fakeClock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + Math.max(0, ms) }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const h = timers[0];
        if (!h || h.at > end) break;
        timers.shift(); t = h.at; h.fn();
      }
      t = end;
    },
  };
}

console.log('LZ3AW round 10');

// ---- 1. SWR at a perfect match -------------------------------------------
test('SWR 1:1 reads 1.0, not "no reading" (every display blanks wire 0)', () => {
  const { codec } = ts480();
  const seen = [];
  codec.on('swr', (v) => seen.push(v));
  codec.onData('RM10000;');
  codec.onData('RM10001;');
  for (const v of seen) {
    assert.ok(v > 0, `wire ${v} is blanked by the web, desktop and JTCAT meters`);
    assert.strictEqual((1 + v / 60).toFixed(1), '1.0');
  }
  codec.onData('RM10003;');
  assert.strictEqual((1 + seen[seen.length - 1] / 60).toFixed(1), '1.5', 'the calibrated points are unchanged');
});

test('a rig that also polls the TX meters on receive keeps 0 there (no fake 1.0:1 while listening)', () => {
  const model = Object.values(RIG_MODELS).find((m) => m && m.pollTxMetersAlways);
  assert.ok(model, 'fixture: a pollTxMetersAlways model');
  const c = new KenwoodCodec(model, () => {});
  const seen = [];
  c.on('swr', (v) => seen.push(v));
  c.onData(`RM${model.rmSwr}0000;`);
  assert.strictEqual(seen[seen.length - 1], 0);
});

// ---- 2. Wattmeter cadence -------------------------------------------------
function withFakeIntervals(fn) {
  const real = { setInterval, clearInterval, setTimeout, clearTimeout, now: Date.now };
  let t = 5_000_000;
  const timers = [];
  global.setInterval = (cb, ms) => { const h = { cb, ms, next: t + ms, every: true }; timers.push(h); return h; };
  global.clearInterval = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  Date.now = () => t;
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((h) => h.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      t = due.next; due.next += due.ms; due.cb();
    }
    t = end;
  };
  try { fn(advance); } finally { Object.assign(global, { setInterval: real.setInterval, clearInterval: real.clearInterval }); Date.now = real.now; }
}

test('while transmitting the TS-480 wattmeter is read every 300 ms (was once a second)', () => {
  withFakeIntervals((advance) => {
    const transport = new EventEmitter();
    transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
    const writes = [];
    const r = new RigController(TS480, transport, new KenwoodCodec(TS480, (d) => writes.push(String(d))));
    r.connected = true; r._target = { path: 'COM5' }; r._lastReadOkMs = Date.now();
    r._startPolling();
    r._transmitting = true;
    const before = writes.filter((w) => w === 'SM0;').length;
    advance(3000);
    const n = writes.filter((w) => w === 'SM0;').length - before;
    assert.ok(n >= 9 && n <= 11, `${n} wattmeter reads in 3 s of TX`);
    r._transmitting = false;
    const idle = writes.filter((w) => w === 'SM0;').length;
    advance(3000);
    // On receive SM0; is the S-meter, once a second from the main tick.
    assert.ok(writes.filter((w) => w === 'SM0;').length - idle <= 3, 'no fast reads on receive');
    r._stopPolling();
    assert.strictEqual(r._txMeterTimer, null, 'stopped with polling');
  });
});

test('paddle CW on a key port no longer pauses CAT polling (the meters went blank)', () => {
  const main = R('main.js');
  const fnSrc = main.slice(main.indexOf('function paddleKeysOnKeyPortOnly('), main.indexOf('function paddleKeysOnKeyPortOnly(') + 900);
  // eslint-disable-next-line no-new-func
  const paddleKeysOnKeyPortOnly = new Function(fnSrc.slice(0, fnSrc.indexOf('\n}') + 2) + '; return paddleKeysOnKeyPortOnly;')();
  assert.strictEqual(paddleKeysOnKeyPortOnly({ keyPortOpen: true, protocol: 'kenwood', paddleKey: 'ta', taKeying: false }), true, 'TS-480 + COM4');
  assert.strictEqual(paddleKeysOnKeyPortOnly({ keyPortOpen: false, protocol: 'kenwood', paddleKey: 'ta' }), false, 'no key port');
  assert.strictEqual(paddleKeysOnKeyPortOnly({ keyPortOpen: true, protocol: 'kenwood', paddleKey: 'ta', taKeying: true }), false, 'TA keys over CAT');
  assert.strictEqual(paddleKeysOnKeyPortOnly({ keyPortOpen: true, protocol: 'civ', paddleKey: 'txrx' }), false, 'Icom CI-V PTT is on the CAT port');
  assert.strictEqual(paddleKeysOnKeyPortOnly({ keyPortOpen: true, rigctld: true }), true, 'rigctld keys the port');
  const at = main.indexOf('const _keyPortOnly = paddleKeysOnKeyPortOnly({');
  assert.ok(at > 0 && /if \(_keyPortOnly\) \{[\s\S]{0,200}\} else if \(down\) \{\s*if \(_cwPollResumeTimer\)[\s\S]{0,120}cat\.pausePolling\(\);/.test(main.slice(at, at + 1200)),
    'the pause runs only when keying uses the CAT port');
});

// ---- 4. Split / VFO -------------------------------------------------------
test('split on from VFO A transmits on B; from VFO B it transmits on A (FT1 did nothing on B)', () => {
  const { codec, writes } = ts480();
  codec.setSplit(true);
  assert.strictEqual(writes[0], 'FT1;');
  const b = ts480();
  b.codec._rxVfo = 'B';
  b.codec.setSplit(true);
  assert.strictEqual(b.writes[0], 'FT0;', 'split on VFO B = transmit on A');
  b.codec.setSplit(false);
  assert.ok(b.writes.includes('FT1;'), 'split off on VFO B = transmit on B');
});

test('switching VFOs in split keeps split, like the radio\'s own A/B key', () => {
  const { codec, writes } = ts480();
  codec.setSplit(true);
  writes.length = 0;
  codec.setVfo('B');
  assert.deepStrictEqual(writes.slice(0, 2), ['FR1;', 'FT0;'], 'RX B, TX stays the other VFO');
  writes.length = 0;
  codec.setVfo('A');
  assert.deepStrictEqual(writes.slice(0, 2), ['FR0;', 'FT1;']);
});

test('outside split the transmit VFO follows the receive VFO', () => {
  const { codec, writes } = ts480();
  codec.setVfo('B');
  assert.deepStrictEqual(writes.slice(0, 2), ['FR1;', 'FT1;']);
});

test('the readback right behind the command confirms at once (no held-then-flipped state)', () => {
  const { codec } = ts480();
  const ev = [];
  codec.on('split', (v) => ev.push(['split', v]));
  codec.on('vfo', (v) => ev.push(['vfo', v]));
  codec.setSplit(true);
  codec.onData(ifFrame(false, true));   // the radio: RX A, split
  codec.setVfo('B');
  codec.onData(ifFrame(true, true));    // RX B, still split
  assert.deepStrictEqual(ev, [['vfo', 'A'], ['split', true], ['vfo', 'B'], ['split', true]]);
});

test('Yaesu keeps its own VS/ST commands', () => {
  const y = Object.entries(RIG_MODELS).find(([, m]) => m && m.brand === 'Yaesu' && m.protocol === 'kenwood');
  assert.ok(y, 'fixture: a Yaesu CAT model');
  const writes = [];
  const c = new KenwoodCodec(y[1], (d) => writes.push(String(d)));
  c.setSplit(true);
  assert.ok(!writes.some((w) => /^FT/.test(w)), `Yaesu wrote ${writes.join(' ')}`);
});

// ---- 3. Paddle: the shack replays the client's own keyer -----------------
test('playout: elements arriving with network jitter key the radio at their exact spacing', () => {
  const clk = fakeClock();
  const edges = [];
  const p = new CwKeyPlayout({ output: (e) => edges.push([e.down, clk.now()]), now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, bufferMs: 120 });
  // "S" then "T" at 25 WPM (48 ms dit): client times, and arrival jitter.
  const dit = 48;
  const els = [[0, dit], [96, dit], [192, dit], [288 + 96, 144]];
  const jitter = [0, 70, 5, 90];
  let sent = 0;
  for (let i = 0; i < els.length; i++) {
    const arrive = 1000 + els[i][0] + jitter[i];
    clk.advance(arrive - clk.now());
    p.push({ at: 50_000 + els[i][0], down: true, ms: els[i][1] });
    sent++;
  }
  clk.advance(2000);
  assert.strictEqual(edges.length, 8, `4 elements, 8 edges: ${JSON.stringify(edges)}`);
  const t0 = edges[0][1];
  for (let i = 0; i < els.length; i++) {
    assert.deepStrictEqual(edges[2 * i], [true, t0 + els[i][0]], `element ${i} start`);
    assert.deepStrictEqual(edges[2 * i + 1], [false, t0 + els[i][0] + els[i][1]], `element ${i} end`);
  }
  assert.strictEqual(t0, 1000 + 120, 'a fixed 120 ms behind the first arrival');
  assert.strictEqual(sent, 4);
});

test('playout: a message later than the buffer slides the streak, never merges or drops elements', () => {
  const clk = fakeClock();
  const edges = [];
  const logs = [];
  const p = new CwKeyPlayout({ output: (e) => edges.push([e.down, clk.now()]), now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, bufferMs: 100, log: (l) => logs.push(l) });
  p.push({ at: 0, down: true, ms: 40 });
  clk.advance(80 + 250);                 // the second element is 250 ms late
  p.push({ at: 80, down: true, ms: 40 });
  p.push({ at: 160, down: true, ms: 40 });
  clk.advance(1000);
  const downs = edges.filter((e) => e[0]).map((e) => e[1]);
  const ups = edges.filter((e) => !e[0]).map((e) => e[1]);
  assert.strictEqual(downs.length, 3, 'all three elements');
  for (let i = 0; i < 3; i++) assert.strictEqual(ups[i] - downs[i], 40, 'lengths kept');
  assert.strictEqual(downs[2] - downs[1], 80, 'the rest of the streak keeps its spacing');
  assert.ok(p.bufferMs > 100, 'the buffer grew for later streaks');
  clk.advance(3000);
  p.push({ at: 5000, down: true, ms: 40 });   // new streak: the late count is reported
  assert.ok(logs.some((l) => /arrived late over the network/.test(l)), logs.join(' | '));
});

test('playout: straight key follows its edges, a missing key-up is forced after maxDownMs', () => {
  const clk = fakeClock();
  const edges = [];
  const p = new CwKeyPlayout({ output: (e) => edges.push([e.down, clk.now()]), now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, bufferMs: 100, maxDownMs: 3000 });
  p.push({ at: 0, down: true });
  clk.advance(200);
  p.push({ at: 200, down: false });
  clk.advance(500);
  assert.deepStrictEqual(edges, [[true, 1100], [false, 1300]]);
  p.push({ at: 700, down: true });        // client time tracks real time
  assert.strictEqual(p.straightDown, true);
  clk.advance(4000);
  assert.strictEqual(edges[edges.length - 1][0], false, 'forced up');
  assert.strictEqual(p.straightDown, false);
});

test('playout: cancel drops what was queued after it; stop keys up at once', () => {
  const clk = fakeClock();
  const edges = [];
  const p = new CwKeyPlayout({ output: (e) => edges.push(e.down), now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, bufferMs: 100 });
  p.push({ at: 0, down: true, ms: 40 });
  p.push({ at: 80, down: true, ms: 40 });
  p.push({ at: 60, down: false, cancel: true });
  clk.advance(1000);
  assert.deepStrictEqual(edges, [true, false], 'the element after the cancel never keyed');
  clk.advance(2000);                      // a new streak, 3 s after the first
  p.push({ at: 3000, down: true, ms: 120 });
  clk.advance(110);
  assert.deepStrictEqual(edges.slice(-1), [true]);
  p.stop();
  assert.deepStrictEqual(edges.slice(-1), [false], 'stop keys up');
  assert.strictEqual(p.busy, false);
});

function server() {
  const rs = new RemoteServer();
  const ev = [];
  rs.setCwKeyerOutput(({ down }) => ev.push(down));
  rs.setCwEnabled(true);
  rs._cwKeyer.setWpm(40); // 30 ms dits
  const ws = { readyState: 1, _authenticated: true, send() {}, _clientCapabilities: [] };
  rs._client = ws;
  return { rs, ev, send: (m) => rs._handleMessage(ws, m), downs: () => ev.filter(Boolean).length };
}

test('the old path: a dit tap whose release is delayed by jitter sends TWO dits', async () => {
  const s = server();
  s.send({ type: 'paddle', contact: 'dit', state: 1 });
  await sleep(100);                       // released at ~10 ms, delivered at 100 ms
  s.send({ type: 'paddle', contact: 'dit', state: 0 });
  await sleep(150);
  assert.strictEqual(s.downs(), 2, `the shack keyer sent ${s.downs()} dits for one tap`);
  s.rs._destroyCwKeyer();
});

test('the new path: the same tap, sent as the client keyer\'s element, is ONE dit', async () => {
  const s = server();
  s.send({ type: 'cw-key', at: 1000, down: true, ms: 30 });
  await sleep(100);                       // whatever the network does next
  await sleep(250);
  assert.strictEqual(s.downs(), 1);
  assert.strictEqual(s.ev[s.ev.length - 1], false, 'and keyed up');
  s.rs._destroyCwKeyer();
});

test('server: presses refused while paddle keying cannot reach the radio, key-ups never', async () => {
  const s = server();
  s.rs._cwPaddleAvailable = false;
  s.send({ type: 'cw-key', at: 0, down: true, ms: 30 });
  await sleep(200);
  assert.strictEqual(s.downs(), 0);
  s.rs._cwPaddleAvailable = true;
  s.send({ type: 'cw-key', at: 0, down: true });           // straight key down
  await sleep(160);
  assert.strictEqual(s.downs(), 1);
  s.rs._cwPaddleAvailable = false;
  s.send({ type: 'cw-key', at: 200, down: false });        // its up still lands
  await sleep(200);
  assert.strictEqual(s.ev[s.ev.length - 1], false);
  s.rs._destroyCwKeyer();
});

test('server: a straight key held with no keepalive is released by the watchdog; STOP and disconnect release', async () => {
  const s = server();
  s.send({ type: 'cw-key', at: 0, down: true });
  await sleep(1800);
  assert.strictEqual(s.ev[s.ev.length - 1], false, 'watchdog released it');
  s.send({ type: 'cw-key', at: 5000, down: true, ms: 500 });
  await sleep(150);
  s.send({ type: 'cw-stop' });
  assert.strictEqual(s.ev[s.ev.length - 1], false, 'STOP');
  s.send({ type: 'cw-key', at: 9000, down: true, ms: 500 });
  await sleep(150);
  s.rs._onClientDisconnected();
  assert.strictEqual(s.ev[s.ev.length - 1], false, 'disconnect');
  s.rs._destroyCwKeyer();
});

test('protocol + capability: cw-key is registered and advertised', () => {
  const d = P.MESSAGES['cw-key'];
  assert.ok(d && d.dir === P.Dir.C2S && d.feature === 'cw');
  for (const k of ['at', 'down', 'ms', 'cancel', 'hold']) assert.ok(d.fields[k] && d.fields[k].required === false, k);
  assert.ok(/capabilities: \[[^\]]*'cw-key-stream'/.test(R('lib/remote-server.js')));
});

test('web: the page sends its keyer\'s elements (ideal times) and stops forwarding contacts', () => {
  const web = R('renderer/remote.js');
  assert.ok(/cwKeyStreamOk = ws\._serverCapabilities\.indexOf\('cw-key-stream'\) !== -1;/.test(web));
  const fn = web.slice(web.indexOf('function sendCwKeyStream('), web.indexOf('function sendCwKeyStream(') + 1400);
  assert.ok(/info\.continued && cwStreamNextAt\) \? cwStreamNextAt : now/.test(fn), 'a continued element starts exactly one space after the last');
  assert.ok(/cwStreamNextAt = at \+ durMs \+/.test(fn));
  assert.ok(/startElement\(!currentIsDit, true\)/.test(web) && /startElement\(currentIsDit, true\)/.test(web), 'continuations are marked');
  const sp = web.slice(web.indexOf('function sendPaddle('), web.indexOf('function sendPaddle(') + 1500);
  assert.ok(/ws\.readyState === WebSocket\.OPEN && !cwKeyStreamOk\) \{\s*if \(state && !_paddleRttSentAt\)/.test(sp), 'no paddle contacts in stream mode');
  const rel = web.slice(web.indexOf('function releaseAllPaddles('), web.indexOf('function releaseAllPaddles(') + 1400);
  assert.ok(/if \(cwKeyStreamOk\) \{ try \{ localCwKeyer\.stop\(\); \}/.test(rel), 'STOP / unavailable stop the page keyer too');
});

test('web: the local keyer, run for real, produces the element stream the shack replays', () => {
  const web = R('renderer/remote.js');
  const src = web.slice(web.indexOf('  function createLocalCwKeyer(onKey) {'), web.indexOf('  // Phone-side sidetone is driven by the local keyer'));
  // eslint-disable-next-line no-new-func
  const create = new Function(src + '; return createLocalCwKeyer;')();
  const calls = [];
  const k = create((down, ms, info) => calls.push({ down, ms, info }));
  k.setWpm(25);
  k.paddleDit(true);
  assert.strictEqual(calls[0].ms, 48);
  assert.strictEqual(calls[0].info.continued, false, 'first element of a streak');
  k.stop();
  assert.ok(calls.some((c) => c.down === false && c.info && c.info.cancel), 'stop sends a cancelling key-up');
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (e.stack || e.message)); }
  }
  console.log(`\nLZ3AW round 10: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
