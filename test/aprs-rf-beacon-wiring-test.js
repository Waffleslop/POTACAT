#!/usr/bin/env node
'use strict';
// APRS phase 7: the radio beacon as wired in main.js, the preload and the APRS
// window (source-text guards; CRLF and LF both pass). The rules: only the
// operator's Transmit sends, never a timer; the transmit Dire Wolf exists only
// for the beacon and keys only through its own shim and the gate; the window
// closing, listening stopping or the stuck-TX limit unkey at once; power is
// shown, never changed; the receive-only listen path is untouched.
// Run: node test/aprs-rf-beacon-wiring-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (src, name) => {
  let i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) i = src.indexOf('\nasync function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return src.slice(i, src.indexOf('\n}\n', i));
};

console.log('APRS beacon over the radio: wiring');

const main = read('main.js');
const html = read('renderer/aprs-popout.html');
const bar = read('renderer/aprs-rf-beacon-bar.js');
const preload = read('preload-aprs-popout.js');
const list = read('scripts/run-tests.js');
const block = (() => {
  const a = main.indexOf('// ── APRS phase 7: ONE manual beacon over the radio');
  const b = main.indexOf('\nfunction killArdop() {', a);
  assert.ok(a > 0 && b > a, 'the phase 7 block');
  return main.slice(a, b);
})();

test('only the operator\'s Transmit sends: one IPC path into aprsRfSend, no RF timer', () => {
  assert.strictEqual((main.match(/aprsRfSend\(\)\.catch/g) || []).length, 1, 'called from one place');
  assert.strictEqual((main.match(/aprsRfSend\(/g) || []).length, 2, 'the definition and the one call');
  assert.ok(/ipcMain\.on\('aprs-rf-send', \(\) => \{ aprsRfSend\(\)/.test(main));
  assert.ok(!/setInterval\(/.test(block), 'no interval in the RF block');
  for (const t of (block.match(/setTimeout\([^;]*/g) || [])) assert.ok(!/aprsRfSend|send\(/.test(t), 'no timed send: ' + t);
  assert.ok(!/aprsRfSend|rfSend/.test(fnBody(main, 'aprsBeaconSchedule')), 'the internet timer never sends over the radio');
});

test('the press only asks: the confirmation line carries band, frequency, mode and power', () => {
  const ask = fnBody(main, 'aprsRfAsk');
  assert.ok(/aprsRfUi\.confirm = \{ at: Date\.now\(\), band, bandLabel: .*hz, mhz: .*mode: .*powerW: pw \}/.test(ask));
  assert.ok(!/aprsRfRunner|handleRemotePtt/.test(ask), 'asking keys nothing');
  assert.ok(/Transmit one APRS beacon on ' \+ c\.bandLabel \+ ', ' \+ c\.mhz \+ ' MHz ' \+ c\.mode \+ ', ' \+ powerWords\(c\.powerW\)/.test(bar));
  assert.ok(!/confirm\(|alert\(|showMessageBox/.test(bar + block), 'no pop-ups');
});

test('Transmit judges the gate again, refuses an expired or changed confirmation, and a dev build never transmits', () => {
  const send = fnBody(main, 'aprsRfSend');
  assert.ok(/Date\.now\(\) - c\.at >= APRS_RF_CONFIRM_MS/.test(send));
  assert.ok(send.indexOf('if (APRS_DEV_FRAMES)') < send.indexOf('aprsRfRunner()'));
  assert.ok(send.indexOf('AprsRfGate.readiness(aprsRfGateState())') < send.indexOf('aprsRfRunner()'));
  assert.ok(/aprsListen\.band !== c\.band \|\| !aprsListen\.freq \|\| aprsListen\.freq\.hz !== c\.hz/.test(send));
  assert.ok(/AprsRfBeacon\.capFor\(/.test(send) && /capMs: cap\.capMs/.test(send));
});

test('the shim keys only through the runner and the gate; it never tunes', () => {
  const shim = fnBody(main, 'aprsRfStartShim');
  assert.ok(/setPtt: \(on\) => onPtt\(!!on\)/.test(shim));
  assert.ok(/setFreqHz: \(hz\) => \{.*return false; \},/.test(shim));
  assert.ok(/host: '127\.0\.0\.1'/.test(shim));
  assert.ok(/mayKey: \(\) => AprsRfGate\.mayKey\(aprsRfGateState\(\)\)/.test(fnBody(main, 'aprsRfRunner')));
  assert.ok(/begin: \(\) => acquireRadio\('aprs'\)/.test(fnBody(main, 'aprsRfRunner')));
});

test('the gate reads the real state: window, listen, callsign, the APRS frequency against the dial, owner, PTT', () => {
  const g = fnBody(main, 'aprsRfGateState');
  for (const k of ['windowOpen: !!(aprsWin && !aprsWin.isDestroyed())', 'listenOn: aprsListen.on', 'settingsCall: settings.myCallsign',
    'aprsHz: aprsListen.freq ? aprsListen.freq.hz : 0', 'dialHz: _currentFreqHz', 'radioOwner,', 'pttKeyed: !!_remoteTxState', 'swrTripped: !!_swrTripped', 'inFlight: aprsRfInFlight()']) {
    assert.ok(g.indexOf(k) >= 0, k);
  }
});

test('the key-down goes through handleRemotePtt with the APRS stuck-TX kind; power is never set', () => {
  const key = fnBody(main, 'aprsRfKey');
  assert.ok(/handleRemotePtt\(true, \{ audio: true, \.\.\.pttMode, emission: 'DATA', txKind: AprsRfBeacon\.TX_KIND\[band\]/.test(key));
  assert.ok(!/setPower|setRfPower|rfpower|set-power|applyRigControl/i.test(block), 'nothing in the RF block changes power');
});

test('the transmit Dire Wolf exists only for the beacon: the TX config, its conf removed on kill', () => {
  const m = fnBody(main, 'aprsRfStartModem');
  assert.ok(/aprsStopModem\(\)/.test(m), 'the listen-only one stops first');
  assert.ok(/buildDirewolfAprsTxConfig\(/.test(m));
  assert.ok(/fs\.unlinkSync\(confPath\)/.test(m));
  assert.ok(/aprsTxAgwPort\(/.test(m));
  // Listening itself still writes only the receive-only config.
  const rx = fnBody(main, 'aprsSpawnDirewolf');
  assert.ok(/buildDirewolfAprsRxConfig\(/.test(rx) && !/AprsTx|TxConfig|shimPort/.test(rx));
});

test('unkey at once when the window closes, listening stops, Winlink takes the radio, the band changes, or the stuck-TX limit trips', () => {
  const closed = main.slice(main.indexOf("aprsWin.on('closed'"), main.indexOf("aprsWin.on('closed'") + 600);
  assert.ok(closed.indexOf("aprsRfAbort('the APRS window closed')") > 0 && closed.indexOf("aprsRfAbort('the APRS window closed')") < closed.indexOf('aprsListenStop('));
  assert.ok(/aprsRfAbort\(`listening stopped: \$\{why\}`\)/.test(fnBody(main, 'aprsListenStop')));
  const stop = fnBody(main, 'aprsListenStop');
  assert.ok(stop.indexOf('aprsListen.on = false;') < stop.indexOf('aprsRfAbort('), 'off first, so the listen modem does not come back');
  assert.ok(/aprsRfAbort\(/.test(fnBody(main, 'aprsListenYieldToWinlink')));
  assert.ok(/aprsRfAbort\('the band changed'\)/.test(fnBody(main, 'aprsListenSetBand')));
  assert.ok(/aprsRfAbort\('the stuck-TX limit tripped'\)/.test(fnBody(main, 'txLimitTrip')));
});

test('listening does not restart its modem under a beacon; the modem audio carries the beacon', () => {
  assert.ok(/if \(aprsRfInFlight\(\)\) return;/.test(fnBody(main, 'aprsListenTick')));
  assert.ok(/srv\.on\('tx-out', \(mono24k\) => \{ if \(_aprsRfKeyed && !winlinkTxActive\) winlinkDispatchOut\(mono24k\); \}\);/.test(main));
  assert.ok(/aprsRfLaneDrained\(\)/.test(main.slice(main.indexOf("srv.on('drained'"), main.indexOf("srv.on('drained'") + 120)));
  assert.ok(/if \(aprsRfInFlight\(\)\) return true;/.test(fnBody(main, 'modemBridgeWanted')));
});

test('the Winlink shim is unchanged: it still keys only for a Winlink radio session', () => {
  const w = fnBody(main, 'startWinlinkShim');
  assert.ok(/if \(!_winlinkShimArmed \|\| radioOwner !== 'winlink'\) \{/.test(w));
  assert.ok(!/aprs/i.test(w), 'no APRS path through the Winlink shim');
});

test('the window: the radio button sits next to the internet one, starts disabled, and has its confirmation row', () => {
  const i = html.indexOf('id="aprs-beacon-now"');
  const j = html.indexOf('id="aprs-rf-now"');
  assert.ok(i > 0 && j > i && j - i < 400, 'next to it');
  assert.ok(/id="aprs-rf-now" disabled/.test(html));
  assert.ok(/id="aprs-rf-confirm"/.test(html) && /id="aprs-rf-send"/.test(html) && /id="aprs-rf-cancel"/.test(html));
  assert.ok(/<script src="aprs-rf-beacon-bar\.js"><\/script>/.test(html));
  assert.ok(/btn\.disabled = !s\.allowed \|\| busy \|\| !!s\.confirm/.test(bar));
  assert.ok(/rfAsk: \(\) => ipcRenderer\.send\('aprs-rf-ask'\)/.test(preload) && /rfSend: \(\) => ipcRenderer\.send\('aprs-rf-send'\)/.test(preload));
});

test('every new test is in scripts/run-tests.js', () => {
  for (const t of ['aprs-rf-gate-test.js', 'aprs-rf-beacon-test.js', 'aprs-rf-beacon-wiring-test.js', 'direwolf-aprs-tx-config-test.js', 'direwolf-aprs-tx-offline-test.js']) {
    assert.ok(list.indexOf("'test/" + t + "'") >= 0, t);
  }
});

// 2026-11-19: the 8600M refused the 30 m beacon (interlock NOT_READY), yet the
// log said "sent over the radio" and the window "Last radio beacon 1 min ago".
test('sent only when the radio reported transmit: the last-beacon time and "sent" line need res.confirmed', () => {
  const send = fnBody(main, 'aprsRfSend');
  const i = send.indexOf('if (res.ok && res.confirmed) {');
  const j = send.indexOf('} else if (res.ok) {', i);
  assert.ok(i > 0 && j > i, 'confirmed first, then keyed-but-not-confirmed');
  const confirmed = send.slice(i, j);
  assert.ok(/aprsRfUi\.lastAt = Date\.now\(\)/.test(confirmed) && /sent over the radio/.test(confirmed));
  assert.strictEqual((send.match(/aprsRfUi\.lastAt = /g) || []).length, 1, 'no other path records a last beacon');
  assert.strictEqual((send.match(/sent over the radio/g) || []).length, 1, 'no other path says sent');
});

test('the radio\'s own readbacks feed the runner (no new poll): Flex interlock and refusals, CAT TX readback', () => {
  assert.ok(/smartSdr\.on\('interlock', \(kv\) => \{ if \(kv\.state === 'TRANSMITTING'\) aprsRfNoteRadioTx\(\); \}\);/.test(main));
  assert.ok(/smartSdr\.on\('radio-message', \(m\) => aprsRfNoteRadioRefusal\(m && m\.text\)\);/.test(main));
  assert.ok(/smartSdr\.on\('cmd-error', \(\{ status, line \}\) => \{[^\n]*aprsRfNoteRadioRefusal\(t\)/.test(main));
  assert.ok(/controller\.on\('ptt', \(on\) => \{ if \(on && controller === cat\) aprsRfNoteRadioTx\(\); \}\);/.test(main));
  assert.ok(/txProof: aprsRfTxProof,/.test(fnBody(main, 'aprsRfRunner')));
  assert.ok(/AprsRfBeacon\.txProofFor\(/.test(fnBody(main, 'aprsRfTxProof')));
  assert.ok(!/setInterval|setTimeout/.test(fnBody(main, 'aprsRfTxProof') + fnBody(main, 'aprsRfNoteRadioTx') + fnBody(main, 'aprsRfNoteRadioRefusal')), 'no poll of its own');
});

test('the button reads the radio\'s interlock: NOT_READY disables it before the press', () => {
  const g = fnBody(main, 'aprsRfGateState');
  assert.ok(/txInterlock: smartSdr && smartSdr\.connected \? \(smartSdr\.interlockState \|\| ''\) : ''/.test(g));
  assert.ok(/txInterlockReason: /.test(g));
});

test('the Flex client: an M line is the radio\'s message; the interlock keeps its reason', () => {
  const { SmartSdrClient } = require('../lib/smartsdr');
  const c = new SmartSdrClient();
  const got = [];
  c.on('radio-message', (m) => got.push(m));
  c._handleLine('M31000003|Interlock is preventing transmission');
  assert.deepStrictEqual(got, [{ code: '31000003', text: 'Interlock is preventing transmission' }]);
  c._handleLine('S58E318C3|interlock tx_client_handle=0x00000000 state=NOT_READY reason= source= tx_allowed=0 amplifier=');
  assert.strictEqual(c.interlockState, 'NOT_READY');
  assert.strictEqual(c.interlockReason, '');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
