// LZ3AW round 12 (1.11.0, 2026-09-30), TS-480 on serial, CW paddle on a DTR
// key port (COM4), ECHOCAT Web.
//
//   1  "SPLIT & VFO still show with big delay". His bug report's raw probes:
//      FR1; answers FR1; FT1; FB00014065000; (AI2 announces the change) but the
//      poll kept asking FA; for 2 s. FR/FT came from custom CAT buttons
//      (sendRaw), which bypass setVfo, and the codec ignored the radio's
//      FR/FT announcements; only IF; moved it, and IF; is polled rarely.
//   2  "S-meter still moves on TX and sometimes sticks, POTACAT needs a
//      restart". The TS-480 holds SM replies while keyed and answers in
//      bursts; questions timed out while their replies still came, so every
//      later reply paired with the wrong question and kept doing so. Replies
//      are now read by the TX state the controller reports.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}

function rig480() {
  const TS480 = RIG_MODELS['TS-480'];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new KenwoodCodec(TS480, (d) => writes.push(String(d)));
  const rig = new RigController(TS480, transport, codec);
  rig.connected = true;
  rig._target = { path: 'COM1' };
  rig._lastReadOkMs = Date.now();
  return { rig, codec, writes };
}

console.log('=== #1 split and VFO follow the radio ===');

test('the radio announcing FR1 moves POTACAT to VFO B at once, and the poll reads FB', () => {
  const { codec, writes } = rig480();
  const vfo = [], freq = [];
  codec.on('vfo', (v) => vfo.push(v));
  codec.on('frequency', (hz) => freq.push(hz));
  codec.onData('FR1;FT1;FB00014065000;');
  assert.deepStrictEqual(vfo, ['B']);
  assert.ok(writes.includes('FB;'), 'reads the new VFO at once: ' + writes.join(' '));
  assert.deepStrictEqual(freq, [14065000], 'FB is now the dial');
  codec.onData('FA00018091800;');
  assert.deepStrictEqual(freq, [14065000], 'VFO A no longer overwrites the dial');
});

test('FT different from FR is split on, same is split off', () => {
  const { codec } = rig480();
  const split = [];
  codec.on('split', (s) => split.push(s));
  codec.onData('FR0;FT1;');
  assert.deepStrictEqual(split, [true]);
  codec.onData('FT0;');
  assert.deepStrictEqual(split, [true, false]);
  codec.onData('FR1;FT1;');
  assert.deepStrictEqual(split, [true, false], 'B receive, B transmit: still simplex');
});

test('a custom CAT button sending FR/FT reads the result back (radios without auto-information)', () => {
  const { codec, writes } = rig480();
  codec.sendRaw('FR1;');
  assert.deepStrictEqual(writes.slice(-2), ['FR1;', 'IF;']);
  codec.sendRaw('PC050;');
  assert.strictEqual(writes[writes.length - 1], 'PC050;', 'other raw commands are untouched');
});

console.log('=== #2 S-meter and power bar by TX state ===');

test('the controller tells the codec when it is keyed, including key-port CW', () => {
  const { rig, codec } = rig480();
  assert.strictEqual(codec._txHint, false);
  rig.noteTransmitting(2000);                 // what the paddle on COM4 does
  assert.strictEqual(codec._txHint, true);
  rig._cancelCwHold(); rig._transmitting = false; rig.emit('ptt', false);
  assert.strictEqual(codec._txHint, false);
  rig.setTransmit(true);
  assert.strictEqual(codec._txHint, true);
});

test('a burst of late replies while keyed never shows as the S-meter, and receive recovers without a restart', () => {
  const { rig, codec } = rig480();
  const s = [], w = [];
  codec.on('smeter', (v) => s.push(v));
  codec.on('powerMeter', (x) => w.push(x));
  codec.getSmeter();                          // an S question just before key-down
  rig.noteTransmitting(2000); codec._smSettleUntil = 0;
  for (let i = 0; i < 4; i++) codec.getPowerMeter();
  codec._smAsked.forEach((q) => { q.at -= 5000; }); // all timed out: the old pairing lost its place
  codec.onData('SM00014;SM00013;SM00011;SM00010;SM00009;'); // the radio answers in a burst
  assert.strictEqual(s.length, 0, 'no S9+30 while transmitting: ' + s.join(','));
  assert.strictEqual(w.length, 5);
  // Key-up: replies right at the edge are dropped, then S readings are S readings.
  rig._cancelCwHold(); rig._transmitting = false; rig.emit('ptt', false);
  codec.onData('SM00012;');
  assert.strictEqual(s.length + w.length, 5, 'a reply at the key edge is dropped');
  codec._smSettleUntil = 0;
  codec.getSmeter(); codec.getSmeter();
  codec.onData('SM00005;SM00006;');
  assert.strictEqual(s.length, 2, 'the S-meter works again at once');
  assert.strictEqual(w.length, 5, 'and no receive reading becomes watts');
});

test('a codec nobody gives a hint keeps the old question-order rule', () => {
  const codec = new KenwoodCodec(RIG_MODELS['TS-480'], () => {});
  const w = [];
  codec.on('powerMeter', (x) => w.push(x));
  codec.getPowerMeter();
  codec.onData('SM00010;');
  assert.deepStrictEqual(w, [44]);
});

console.log('=== #3 settings push size ===');

test('old full-size SSTV template photos are shrunk at start-up (880 KB settings-update)', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const i = main.indexOf('Photo templates saved before 1.11.0 held the camera original');
  assert.ok(i > 0);
  const b = main.slice(i, i + 1600);
  assert.ok(/t\.bgDataUrl\.length <= 150 \* 1024\) continue;/.test(b) && /640 \/ sz\.width, 496 \/ sz\.height/.test(b) && /u\.length <= 140 \* 1024/.test(b));
  assert.ok(/t\.updatedAt = Date\.now\(\)/.test(b), 'an edit the cloud merge adopts');
});

console.log('=== #4 (round 13) an RX readback inside POTACAT\'s own CW keying ===');

test('a key-line hold survives a stale RX readback; the S-meter is not fed the power bar', () => {
  const { rig, codec } = rig480();
  rig._debug = true; // main.js sets this on every controller
  const logs = [];
  rig.on('log', (m) => logs.push(m));
  rig.noteTransmitting(3000);          // DTR text: POTACAT keys the line
  codec.emit('ptt', false);            // LZ3AW 1.11.2: a reply from just before key-down
  assert.strictEqual(rig._transmitting, true, 'the hold ended on a stale readback');
  assert.ok(rig._cwHoldTimer, 'the hold timer was cancelled');
  assert.strictEqual(codec._txHint, true, 'the codec was told RX mid-over');
  codec.emit('ptt', false);            // and again, still said once
  const said = logs.filter((m) => /radio reported receive \d+ ms before POTACAT finishes keying/.test(m));
  assert.strictEqual(said.length, 1, JSON.stringify(logs));
  rig._cancelCwHold();
});

test('the radio\'s own KY buffer still ends its hold on an RX readback', () => {
  const { rig, codec } = rig480();
  rig.noteTransmitting(3000, { queue: true });
  codec.emit('ptt', false);
  assert.strictEqual(rig._transmitting, false);
  assert.ok(!rig._cwHoldTimer);
});

console.log(`\nLZ3AW round 12: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
