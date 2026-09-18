// CW keying vs the poll-staleness watchdog (LZ3AW, TS-480 over serial).
//
// "After several seconds the radio stops transmitting" (2026-09-14). The
// TS-480 mutes CAT while it transmits; the watchdog exempts only
// _transmitting; and nothing on the CW paths ever set it — the radio keys
// itself from its KY buffer, and the paddle's TX;/RX; went straight to the
// codec. Ten seconds into a CQ, or a few seconds of key-as-I-type, the link
// was declared DOWN and every later keystroke was dropped (rig-controller
// refuses sends while !connected). These tests pin:
//   - the CW envelope hold on the live and macro KY paths,
//   - the paddle route flagging TX,
//   - Kenwood IF; P8 as the radio's own PTT readback (Kenwood codec 'ptt'),
//   - the watchdog never firing inside an envelope, and firing normally after,
//   - the renderers not re-sending a live line on Enter.
//
// Run: node test/cw-live-watchdog-test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}

const TS480 = RIG_MODELS['TS-480'];

// The same IF; frame the rig-test fixture builds field by field, plus P8.
function kenwoodIf({ tx = '0', vfo = '0', split = '0' } = {}) {
  return 'IF' + '00014074000' + '0000' + '+00000' + '0' + '0' + '0' + '00' + tx + '2' + vfo + '0' + split + '0' + '00' + '0' + ';';
}

function rig480() {
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new KenwoodCodec(TS480, (d) => writes.push(String(d)));
  const rig = new RigController(TS480, transport, codec);
  rig.connected = true;
  rig._target = { path: 'COM9' };
  rig._lastReadOkMs = Date.now();
  const ptt = [];
  rig.on('ptt', (on) => ptt.push(on));
  const logs = [];
  rig.on('log', (m) => logs.push(m));
  return { rig, codec, writes, ptt, logs };
}
const ago = (ms) => Date.now() - ms;
const STALE = RigController.POLL_STALE_MS + 1000;

console.log('=== Kenwood IF; P8 = the radio\'s own PTT ===');
test('P8 sits at index 28 in the 38-char frame', () => {
  const f = kenwoodIf({ tx: '1' });
  assert.strictEqual(f.length, 38);
  assert.strictEqual(f.charAt(28), '1');
  assert.strictEqual(f.charAt(30), '0', 'P10 still at 30');
  assert.strictEqual(f.charAt(32), '0', 'P12 still at 32');
});
test('codec emits ptt on P8 change only; controller follows it', () => {
  const { rig, codec, ptt } = rig480();
  codec.onData(kenwoodIf({ tx: '1' }));
  assert.strictEqual(rig._transmitting, true);
  codec.onData(kenwoodIf({ tx: '1' }));
  assert.deepStrictEqual(ptt, [true], 'no repeat for an unchanged flag');
  codec.onData(kenwoodIf({ tx: '0' }));
  assert.strictEqual(rig._transmitting, false);
  assert.deepStrictEqual(ptt, [true, false]);
});

console.log('\n=== CW envelope hold ===');
test('live KY: one character marks TX and the watchdog stays quiet inside the envelope', () => {
  const { rig, writes, logs } = rig480();
  rig.sendCwText('C', { live: true });
  assert.ok(writes.some((w) => w === 'KY C;'), 'unpadded live frame went out');
  assert.strictEqual(rig._transmitting, true);
  assert.ok(rig._cwHoldUntil > Date.now());
  // Radio muted on CAT for longer than the stale window: still fine.
  rig._lastReadOkMs = ago(STALE);
  rig._checkPollStaleness();
  assert.strictEqual(rig.connected, true, 'not declared down while transmitting');
  assert.ok(!logs.some((l) => /treating the radio link as DOWN/.test(l)));
  rig._cancelCwHold();
});
test('live KY: each appended character extends the hold; a later keystroke is still sent', () => {
  const { rig, writes } = rig480();
  rig.sendCwText('C', { live: true });
  const first = rig._cwHoldUntil;
  rig.sendCwText('Q', { live: true });
  assert.ok(rig._cwHoldUntil > first, 'extended');
  rig._lastReadOkMs = ago(STALE);
  rig._checkPollStaleness();
  rig.sendCwText(' ', { live: true });
  assert.strictEqual(writes.filter((w) => w.startsWith('KY ')).length, 3, 'nothing dropped');
  rig._cancelCwHold();
});
test('hold expiry clears TX and restarts the no-reply window from THAT moment', () => {
  const { rig, ptt } = rig480();
  rig.sendCwText('CQ', { live: true });
  rig._lastReadOkMs = ago(STALE);
  rig._cwHoldExpired();
  assert.strictEqual(rig._transmitting, false);
  assert.deepStrictEqual(ptt, [true, false]);
  rig._checkPollStaleness();
  assert.strictEqual(rig.connected, true, 'silence during TX does not count');
  rig._lastReadOkMs = ago(STALE);
  rig._checkPollStaleness();
  assert.strictEqual(rig.connected, false, 'after the envelope the watchdog works as before');
});
test('a radio that reports itself still keyed keeps TX past the estimate; its RX readback ends it', () => {
  const { rig, codec } = rig480();
  rig.sendCwText('CQ', { live: true });
  codec.onData(kenwoodIf({ tx: '1' }));
  rig._cwHoldExpired();
  assert.strictEqual(rig._transmitting, true, 'radio said TX — believe it');
  codec.onData(kenwoodIf({ tx: '0' }));
  assert.strictEqual(rig._transmitting, false);
  assert.strictEqual(rig._cwHoldTimer, null, 'RX readback also cancels a pending hold');
});
test('an RX readback while typing ends the hold; the next character re-arms it', () => {
  const { rig, codec } = rig480();
  rig.sendCwText('C', { live: true });
  codec.onData(kenwoodIf({ tx: '0' }));
  assert.strictEqual(rig._transmitting, false);
  rig.sendCwText('Q', { live: true });
  assert.strictEqual(rig._transmitting, true);
  rig._cancelCwHold();
});
console.log('\n=== paddle route (TS-480 "ta": bare TX;/RX;) ===');
test('key-down flags TX; release clears it and restarts the window', () => {
  const { rig, ptt } = rig480();
  rig.setCwKeyTxRx(true);
  assert.strictEqual(rig._transmitting, true);
  rig._lastReadOkMs = ago(STALE);
  rig._checkPollStaleness();
  assert.strictEqual(rig.connected, true);
  rig._cwPttRelease();
  assert.strictEqual(rig._transmitting, false);
  assert.deepStrictEqual(ptt, [true, false]);
  assert.ok(Date.now() - rig._lastReadOkMs < 100, 'window restarted at release');
});

console.log('\n=== explicit key-up ends a hold ===');
test('setTransmit(false) cancels the envelope', () => {
  const { rig } = rig480();
  rig.sendCwText('CQ', { live: true });
  rig.setTransmit(false);
  assert.strictEqual(rig._cwHoldTimer, null);
  assert.strictEqual(rig._transmitting, false);
});

console.log('\n=== renderers: Enter in live mode never re-sends the line ===');
test('desktop and web clear the box and reset the live cursor instead of calling Send', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const kd = app.slice(app.indexOf("cwMacroInput.addEventListener('keydown'"), app.indexOf("cwMacroInput.addEventListener('keydown'") + 900);
  assert.ok(/if \(cwLiveMode\) \{[\s\S]{0,400}cwLiveSent = 0;[\s\S]{0,200}return;[\s\S]{0,100}\}\s*cwMacroSendBtn\.click\(\)/.test(kd), 'desktop Enter');
  const web = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8');
  const send = web.slice(web.indexOf("cwTextSend.addEventListener('click'"), web.indexOf("cwTextSend.addEventListener('click'") + 700);
  assert.ok(/if \(cwLiveMode\) \{[\s\S]{0,700}cwLiveSent = 0;[\s\S]{0,50}return;/.test(send), 'web Send/Enter');
});

// The macro-path hold arms 50 ms after the call; verify it asynchronously.
(async () => {
  const { rig } = rig480();
  rig.setCwSpeed(20);
  rig.sendCwText('CQ CQ CQ DE LZ3AW LZ3AW LZ3AW K');
  await new Promise((r) => setTimeout(r, 120));
  test('macro KY (non-live): held for the estimated length of the message', () => {
    assert.strictEqual(rig._transmitting, true);
    const expected = 31 * 600; // 31 chars at 20 wpm ≈ 18.6 s — longer than the stale window
    assert.ok(rig._cwHoldUntil - Date.now() > expected - 1500, `hold covers the message (${rig._cwHoldUntil - Date.now()} ms)`);
    rig._lastReadOkMs = ago(STALE);
    rig._checkPollStaleness();
    assert.strictEqual(rig.connected, true);
  });
  rig._cancelCwHold();
  console.log(`\nCW live watchdog: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
