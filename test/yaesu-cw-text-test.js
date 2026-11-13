// Yaesu CW text keys through BK-IN, never TX1; first (W2XYZ FTX-1, W3MDT
// FT-710, 2026-10-28: TX1; alone in CW keys a steady carrier, BK-IN on or
// off). Hamlib's newcat_send_morse does the same: KM1 text, then play, no PTT.
//
// Run: node test/yaesu-cw-text-test.js

'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { cwAirtimeMs } = require('../lib/cw-airtime');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
  })());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(modelId, Codec = KenwoodCodec) {
  const model = RIG_MODELS[modelId];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new Codec(model, (d) => writes.push(String(d)));
  const r = new RigController(model, transport, codec);
  r.connected = true;
  r._lastReadOkMs = Date.now();
  const logs = [];
  r.on('log', (m) => logs.push(m));
  return { rig: r, codec, writes, logs };
}

for (const id of ['FTX-1 Field', 'FTX-1 Optima', 'FTDX101D/MP', 'FT-710', 'FTDX10', 'FT-991/991A']) {
  test(`${id}: CW text never sends TX1; and holds TX for the message`, async () => {
    const { rig: r, writes } = rig(id);
    r.sendCwText('CQ POTA DE W2XYZ K');
    await sleep(80);
    assert.ok(!writes.some((w) => /^TX1;/.test(w)), 'no TX1; — it keyed a carrier: ' + JSON.stringify(writes));
    assert.ok(writes.some((w) => /^KM|^KY/.test(w)), 'the text went to the radio: ' + JSON.stringify(writes));
    assert.strictEqual(r._transmitting, true, 'held as transmitting for the envelope');
    r.disconnect();
  });
}

test('FT-710 without a key port: keyer memory 1, played with KY01; (W3MDT)', async () => {
  const { rig: r, writes } = rig('FT-710');
  r.sendCwText('TEST');
  assert.deepStrictEqual(writes.slice(-2), ['KM1TEST;', 'KY01;']);
  r.disconnect();
});

test('FTX-1: KM5 then KY05; a long message waits for each memory to play', async () => {
  const { rig: r, writes } = rig('FTX-1 Field');
  r.setCwSpeed(60); // 200 ms per character keeps the test short
  writes.length = 0;
  const text = 'A'.repeat(50) + 'B';
  r.sendCwText(text);
  assert.deepStrictEqual(writes.filter((w) => !/^BI/.test(w)), ['KM5' + 'A'.repeat(50) + ';', 'KY05;'], 'only the first memory now');
  assert.strictEqual(r._cwKmTimers.length, 1, 'the second chunk waits');
  r.stopCwText();
  assert.strictEqual(r._cwKmTimers.length, 0, 'stop drops the waiting chunk');
  r.disconnect();
});

// #384: the FTX-1 CAT manual (2508-C p.18) plays keyer memory with KY P1 P2;
// P1 0 = TEXT memory, P2 1-5 = the memory. There is no KYA; form, and the
// radio played nothing. The KY that plays must name the memory KM wrote.
for (const id of ['FTX-1 Field', 'FTX-1 Optima']) {
  test(`${id}: KM5<text>; then KY05; (the documented form, not KYA;)`, async () => {
    const { rig: r, writes } = rig(id);
    r._breakIn = true;
    r.sendCwText('TU 73');
    assert.deepStrictEqual(writes.slice(-2), ['KM5TU 73;', 'KY05;']);
    assert.ok(!writes.includes('KYA;'), JSON.stringify(writes));
    r.disconnect();
  });
}

test('every keyer-memory rig plays the memory it wrote (KY0n; names kmMemory n)', () => {
  for (const [id, m] of Object.entries(RIG_MODELS)) {
    const cw = m && m.cw;
    if (!cw || cw.kyMode !== 'km' || !cw.kmPlay) continue;
    const mm = /^KY0([1-5]);$/.exec(cw.kmPlay);
    assert.ok(mm, `${id}: kmPlay ${cw.kmPlay} is not KY0n;`);
    assert.strictEqual(Number(mm[1]), cw.kmMemory, `${id}: KM writes ${cw.kmMemory} but ${cw.kmPlay} plays ${mm[1]}`);
  }
});

test('rigctld on an FTX-1 (W2XYZ): "b text" with no "T 1" before it', async () => {
  const { rig: r, writes } = rig('FTX-1 Field', RigctldCodec);
  r.sendCwText('TU 73 DE W2XYZ');
  await sleep(80);
  assert.ok(!writes.some((w) => /^T 1/.test(w)), JSON.stringify(writes));
  assert.ok(writes.some((w) => /^b TU 73 DE W2XYZ/.test(w)), JSON.stringify(writes));
  r.disconnect();
});

test('BK-IN read as off: turned on once for back-to-back messages, and said once', async () => {
  const { rig: r, codec, writes, logs } = rig('FTX-1 Field');
  codec.emit('breakIn', false);
  r.sendCwText('E');
  r.sendCwText('E');
  assert.strictEqual(logs.filter((l) => /turned BK-IN on/.test(l)).length, 1);
  assert.strictEqual(writes.filter((w) => w === 'BI1;').length, 1, JSON.stringify(writes));
  r.disconnect();
});

test('a non-Yaesu ky1 rig keeps its old path (X6100 still keys first)', async () => {
  const { rig: r, writes } = rig('X6100');
  r.sendCwText('E');
  assert.ok(writes.some((w) => /^TX1;|^TX;/.test(w)), JSON.stringify(writes));
  r.disconnect();
});

test('macOS cannot nap POTACAT while it times CW itself: the key port and the paddle keyer hold it awake (N8JMS)', async () => {
  const main = readSrc(require('path').join(__dirname, '..', 'main.js'));
  assert.ok(/function cwKeyingAwake\(ms\)[\s\S]{0,300}powerSaveBlocker\.start\('prevent-app-suspension'\)/.test(main));
  const dtr = main.indexOf('function sendCwTextViaDtrKey(');
  assert.ok(main.slice(dtr, dtr + 4000).includes('cwKeyingAwake(t + 2000)'), 'the key-port text path');
  assert.ok(/keyer\.on\('key', \(\{ down \}\) => \{\s*\/\/[^\n]*\n\s*cwKeyingAwake\(3000\);/.test(main), 'the paddle keyer');
});

// --- BK-IN and the stuck-transmit backstop (2026-11-01) --------------------
// With BK-IN off the radio plays the text in the sidetone only (W2XYZ FTX-1F
// on 1.13.8: "unable to send any CW"); a radio left keyed after a message
// stayed on the air until Stop (kc9hekbrian FTDX10). BI; was never even read.

test('FTDX10: keyer memory 5 played with KYA, like the FTDX101', async () => {
  const { rig: r, writes } = rig('FTDX10');
  r._breakIn = true;
  r.sendCwText('TEST');
  assert.deepStrictEqual(writes.slice(-2), ['KM5TEST;', 'KYA;']);
  r.disconnect();
});

test('BK-IN known off: turned on before the text, back off after the message', async () => {
  const { rig: r, writes, logs } = rig('FT-710');
  r._cwWpm = 60;
  r._breakIn = false;
  r.sendCwText('E');
  const bi1 = writes.indexOf('BI1;'), km = writes.findIndex((w) => /^KM/.test(w));
  assert.ok(bi1 >= 0 && bi1 < km, 'BI1; before the text: ' + JSON.stringify(writes));
  assert.ok(!writes.includes('BI0;'), 'not restored mid-message');
  await sleep(5200);
  assert.ok(writes.includes('BI0;'), 'BK-IN put back: ' + JSON.stringify(writes));
  assert.ok(logs.some((l) => /BK-IN back off/.test(l)));
  r.disconnect();
});

test('BK-IN unknown: asks, turns it on, and restores what the radio said', async () => {
  const { rig: r, codec, writes } = rig('FTX-1 Field');
  r._cwWpm = 60;
  r.sendCwText('E');
  assert.ok(writes.indexOf('BI;') >= 0 && writes.indexOf('BI;') < writes.indexOf('BI1;'), 'query, then on: ' + JSON.stringify(writes));
  codec.emit('breakIn', false); // the reply to BI;: it was off
  assert.strictEqual(r._breakIn, true, 'on now');
  await sleep(5200);
  assert.ok(writes.includes('BI0;'), 'put back off');
  r.disconnect();
});

test('BK-IN unknown but the radio says it was on: left on', async () => {
  const { rig: r, codec, writes } = rig('FTX-1 Field');
  r._cwWpm = 60;
  r.sendCwText('E');
  codec.emit('breakIn', true);
  await sleep(5200);
  assert.ok(!writes.includes('BI0;'), 'never turned off: ' + JSON.stringify(writes));
  r.disconnect();
});

test('BK-IN already on: no BI commands at all', async () => {
  const { rig: r, writes } = rig('FT-710');
  r._breakIn = true;
  r.sendCwText('TEST');
  assert.ok(!writes.some((w) => /^BI/.test(w)), JSON.stringify(writes));
  r.disconnect();
});

test('a radio still in transmit 4 s after the message is sent to receive, and the operator is told', async () => {
  const { rig: r, codec, writes } = rig('FTDX10');
  const notices = [];
  r.on('notice', (m) => notices.push(m));
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  const polls = setInterval(() => { if (!writes.includes('TX0;')) codec.emit('ptt', true); }, 500); // TX at every poll
  await sleep(6000);
  clearInterval(polls);
  assert.ok(writes.includes('TX0;'), 'RX sent: ' + JSON.stringify(writes));
  assert.ok(notices.some((m) => /stayed in transmit after the CW message/.test(m)));
  assert.strictEqual(r._transmitting, false);
  r.disconnect();
});

test('a receive readback in a word space does not end the watch: a radio keyed after the message is sent to receive', async () => {
  // FT-710 keyer memory over BK-IN: TX0 for ~120 ms in each word space.
  const { rig: r, codec, writes } = rig('FT-710');
  const notices = [];
  r.on('notice', (m) => notices.push(m));
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E E');
  codec.emit('ptt', true);
  codec.emit('ptt', false);            // the word space
  assert.strictEqual(r._transmitting, true, 'still keying the message');
  const polls = setInterval(() => { if (!writes.includes('TX0;')) codec.emit('ptt', true); }, 500); // then stuck in TX
  await sleep(6500);
  clearInterval(polls);
  assert.ok(writes.includes('TX0;'), 'RX sent: ' + JSON.stringify(writes));
  assert.ok(notices.some((m) => /stayed in transmit after the CW message/.test(m)));
  r.disconnect();
});

test('the backstop is armed even when the last readback before the end was receive', async () => {
  const { rig: r, codec, writes } = rig('FT-710');
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  codec.emit('ptt', false);            // a word-space readback just before the estimate ends
  await sleep(700);                    // the hold has ended
  const polls = setInterval(() => { if (!writes.includes('TX0;')) codec.emit('ptt', true); }, 500);
  await sleep(5500);
  clearInterval(polls);
  assert.ok(writes.includes('TX0;'), 'RX sent: ' + JSON.stringify(writes));
  r.disconnect();
});

test('the backstop leaves a PTT POTACAT itself is holding alone', async () => {
  const { rig: r, codec, writes } = rig('FTDX10');
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  codec.emit('ptt', true);
  r._pttCommanded = true; // e.g. the phone's PTT pressed right after the macro
  await sleep(6000);
  assert.ok(!writes.includes('TX0;'), JSON.stringify(writes));
  r.disconnect();
});

test('the radio returning to receive by itself cancels the backstop', async () => {
  const { rig: r, codec, writes } = rig('FTDX10');
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  codec.emit('ptt', true);
  await sleep(1500);
  codec.emit('ptt', false);
  await sleep(4500);
  assert.ok(!writes.includes('TX0;'), JSON.stringify(writes));
  r.disconnect();
});

test('the backstop needs a fresh readback: a TX report from seconds ago proves nothing', async () => {
  const { rig: r, codec, writes } = rig('FTDX10');
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  codec.emit('ptt', true); // once, then the radio goes quiet
  await sleep(6000);
  assert.ok(!writes.includes('TX0;'), JSON.stringify(writes));
  r.disconnect();
});

test('#120: an Icom still reporting TX past the estimate is left alone, with no warning', async () => {
  const { rig: r, codec } = rig('IC-7610', CivCodec);
  const notices = [];
  let rxSent = 0;
  const realSet = codec.setTransmit.bind(codec);
  r.on('notice', (m) => notices.push(m));
  r._cwWpm = 60;
  r.sendCwText('E');
  await sleep(100);
  codec.setTransmit = (on) => { if (!on) rxSent++; realSet(on); };
  const polls = setInterval(() => codec.emit('ptt', true), 500);
  await sleep(6000);
  clearInterval(polls);
  assert.strictEqual(rxSent, 0, 'no RX in the middle of a message');
  assert.deepStrictEqual(notices, []);
  r.disconnect();
});

test('a Yaesu message then an Icom-path message does not keep the watch armed', async () => {
  const { rig: r, codec } = rig('TS-480');
  const notices = [];
  r.on('notice', (m) => notices.push(m));
  r._cwStuckWatch = true;
  r._cwWpm = 60;
  r.sendCwText('E');
  const polls = setInterval(() => codec.emit('ptt', true), 500);
  await sleep(5800);
  clearInterval(polls);
  assert.deepStrictEqual(notices, []);
  r.disconnect();
});

test('Stop ends the TX state at once, on a radio that sends no readback', async () => {
  const { rig: r, codec } = rig('TS-480');
  const states = [];
  r.on('ptt', (on) => states.push(on));
  r._cwWpm = 20;
  r.sendCwText('CQ CQ CQ DE K3SBP K');
  await sleep(100);
  assert.strictEqual(r._transmitting, true);
  r.stopCwText();
  assert.strictEqual(r._transmitting, false, 'TX indicator cleared');
  assert.strictEqual(states[states.length - 1], false);
  r.disconnect();
});

test('Stop also ends the TX banner, which runs on its own estimate', () => {
  const main = readSrc(require('path').join(__dirname, '..', 'main.js'));
  const stop = main.slice(main.indexOf('function cancelAllCwSends'), main.indexOf('function cancelAllCwSends') + 2600);
  assert.ok(/_cwTxLockoutUntilMs = 0; _broadcastEffectiveTxState\(\)/.test(stop));
});

test('airtime is real Morse timing, and the hold covers digits the old figure did not', () => {
  assert.strictEqual(cwAirtimeMs('PARIS', 20), Math.ceil(43 * 60)); // 50 dits with the trailing word gap
  assert.strictEqual(cwAirtimeMs('', 20), 0);
  const digits = '599 5NN 0000 1234 7890';
  assert.ok(cwAirtimeMs(digits, 20) > digits.length * 600, 'the old figure was short here');
  const { rig: r } = rig('TS-480');
  r._holdTxForCw(digits);
  assert.ok(r._cwHoldUntil - Date.now() >= cwAirtimeMs(digits, 20));
  r.disconnect();
});

test('ECHOCAT: an unchanged speed sends the radio no speed command ahead of the macro', () => {
  const main = readSrc(require('path').join(__dirname, '..', 'main.js'));
  assert.ok(/!\(wpm === settings\.cwWpm && \(!cat \|\| cat\._cwWpm === wpm\)\)\) applyCwWpm\(wpm, 'remote'\)/.test(main));
});

test('N8JMS: a frequency event keeps the selected spot, and a map Tune finds its own call', () => {
  const app = readSrc(require('path').join(__dirname, '..', 'renderer', 'app.js'));
  assert.ok(/const onSpot = onPicked \? lastTunedSpot : allSpots\.find/.test(app));
  assert.ok(/s\.callsign === btn\.dataset\.call/.test(app));
  assert.ok(/class="tune-btn" data-call=/.test(app));
});

test('#116: one rbn.telegraphy.de connection, and only commands the server has', () => {
  const main = readSrc(require('path').join(__dirname, '..', 'main.js'));
  const fn = main.slice(main.indexOf('function connectCwSpots'), main.indexOf('function disconnectCwSpots'));
  assert.ok(!/set\/clubs \$\{/.test(fn), 'no per-club command');
  assert.ok(!/forEach/.test(fn) && !/ssid/i.test(fn.replace(/SSID/g, '')), 'no per-club login');
  assert.ok(/\['set\/clubs', 'set\/nodupes'\]/.test(fn));
});

test('main shows the controller notice on screen and on the phone', async () => {
  const main = readSrc(require('path').join(__dirname, '..', 'main.js'));
  assert.ok(/controller\.on\('notice', \(msg\) => \{[\s\S]{0,400}send\('app-notice'[\s\S]{0,300}type: 'tune-blocked', reason: msg/.test(main));
});

// --- #127: the backstop re-checks, survives a link drop, and the hold is capped ---
// kc9hekbrian FTDX10: a macro left the radio keyed until ECHOCAT's STOP. The
// 1.13.9 backstop sent ONE TX0; and never looked again; a link that was down
// when the message ended skipped it with nothing armed for its return.

test('#127: still keyed after the first TX0;: a second TX0; and cw-stuck, and no more than 3 in all', async () => {
  const { rig: r, codec, writes, logs } = rig('FTDX10');
  const stuck = [];
  r.on('cw-stuck', (info) => stuck.push(info));
  r._cwStuckCheckMs = 300;
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  const polls = setInterval(() => codec.emit('ptt', true), 100); // the radio never unkeys
  await sleep(4000);
  clearInterval(polls);
  const rx = writes.filter((w) => w === 'TX0;').length;
  assert.strictEqual(rx, 3, 'three receive commands, then it stops trying: ' + JSON.stringify(writes));
  assert.ok(stuck.length >= 1, 'cw-stuck emitted for main to stop every CW backend');
  assert.ok(logs.some((l) => /still keyed after TX0;/.test(l)), 'pass 2 says so: ' + JSON.stringify(logs));
  r.disconnect();
});

test('#127: the re-check needs a TX readback newer than its own TX0;', async () => {
  const { rig: r, codec, writes } = rig('FTDX10');
  r._cwStuckCheckMs = 300;
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  // TX at every poll until our TX0; lands, then the radio goes silent.
  const polls = setInterval(() => { if (!writes.includes('TX0;')) codec.emit('ptt', true); }, 100);
  await sleep(3000);
  clearInterval(polls);
  assert.strictEqual(writes.filter((w) => w === 'TX0;').length, 1, JSON.stringify(writes));
  r.disconnect();
});

test('#127: link down when the message ended: TX0; as soon as the radio answers again', async () => {
  const { rig: r, codec, writes, logs } = rig('FTDX10');
  r._cwStuckCheckMs = 300;
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  codec.emit('ptt', true);
  r.connected = false; r._linkStale = true; // the staleness watchdog fired mid-message
  await sleep(2500);
  assert.ok(!writes.includes('TX0;'), 'nothing to send it on yet');
  const polls = setInterval(() => codec.emit('ptt', true), 100); // link restored, radio still keyed
  await sleep(1000);
  clearInterval(polls);
  assert.ok(writes.includes('TX0;'), 'RX sent once the link came back: ' + JSON.stringify(writes));
  assert.ok(logs.some((l) => /CW message/.test(l) && /link/.test(l)), JSON.stringify(logs));
  r.disconnect();
});

test('#127: a reconnect after a CW message was left keyed says why its PTT off matters', async () => {
  const { rig: r, codec, writes, logs } = rig('FTDX10');
  r._cwStuckCheckMs = 300;
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  codec.emit('ptt', true);
  r.connected = false;
  await sleep(2500);
  writes.length = 0;
  r._transport.emit('connect');
  assert.ok(writes.includes('TX0;'), 'the connect safety: ' + JSON.stringify(writes));
  assert.ok(logs.some((l) => /CW message/.test(l)), JSON.stringify(logs));
  r.disconnect();
});

test('#127: one hold never runs past 180 s, however much text is queued', async () => {
  const { rig: r, logs } = rig('FTDX10');
  r._holdTxForCw('E'.repeat(20000)); // ~4 minutes at 20 wpm
  r._holdTxForCw('E'.repeat(20000));
  assert.ok(r._cwHoldUntil - Date.now() <= 180000 + 1000, 'capped: ' + (r._cwHoldUntil - Date.now()));
  assert.ok(logs.some((l) => /capped/.test(l)), JSON.stringify(logs));
  r.disconnect();
});

Promise.all(pending).then(() => {
  console.log(`\nYaesu CW text: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
