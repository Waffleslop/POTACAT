'use strict';
// GitHub #713 (w9tef, 1.14.6): the VFO window's "Audio on" monitor kept
// playing during PTT. A radio that sends its transmit monitor down the USB
// audio put the operator's own voice on the PC speakers: echo, then feedback.
// The monitor's gain now follows the TX state through lib/vfo-monitor-tx-mute.js
// and comes back to exactly what the operator had afterwards.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let M;
try { M = require('../lib/vfo-monitor-tx-mute'); } catch (e) { M = null; }
assert.ok(M && typeof M.monitorGain === 'function' && typeof M.transmitting === 'function',
  'lib/vfo-monitor-tx-mute.js with monitorGain() and transmitting()');

let n = 0;
function t(name, fn) { fn(); n++; }

t('listening, not transmitting: the volume', () => {
  assert.strictEqual(M.monitorGain({ volume: 0.8, muted: false, sdrLive: false, transmitting: false }), 0.8);
});
t('transmitting: silent', () => {
  assert.strictEqual(M.monitorGain({ volume: 0.8, muted: false, sdrLive: false, transmitting: true }), 0);
});
t('after TX: back to the volume', () => {
  const s = { volume: 1.2, muted: false, sdrLive: false, transmitting: true };
  assert.strictEqual(M.monitorGain(s), 0);
  s.transmitting = false;
  assert.strictEqual(M.monitorGain(s), 1.2);
});
t('muted by the operator stays muted after TX', () => {
  assert.strictEqual(M.monitorGain({ volume: 1, muted: true, sdrLive: false, transmitting: false }), 0);
});
t('SDR live stays silent after TX (the SDR is what he hears)', () => {
  assert.strictEqual(M.monitorGain({ volume: 1, muted: false, sdrLive: true, transmitting: false }), 0);
});
t('volume changed during TX applies after TX, not during', () => {
  const s = { volume: 1, muted: false, sdrLive: false, transmitting: true };
  s.volume = 0.5;
  assert.strictEqual(M.monitorGain(s), 0);
  s.transmitting = false;
  assert.strictEqual(M.monitorGain(s), 0.5);
});
t('bad volume never plays loud', () => {
  assert.strictEqual(M.monitorGain({ volume: NaN }), 0);
  assert.strictEqual(M.monitorGain({ volume: -1 }), 0);
  assert.strictEqual(M.monitorGain(null), 0);
});
t('transmitting = the window PTT or the radio reports TX (any source)', () => {
  assert.strictEqual(M.transmitting(false, false), false);
  assert.strictEqual(M.transmitting(true, false), true);
  assert.strictEqual(M.transmitting(false, true), true);
  assert.strictEqual(M.transmitting(true, true), true);
});

// Glue: the VFO window loads the module and routes every monitor gain
// write through it, on PTT down/up and on both TX-state edges.
const vfo = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'), 'utf8');
t('the VFO window loads lib/vfo-monitor-tx-mute.js', () => {
  assert.ok(/<script src="\.\.\/lib\/vfo-monitor-tx-mute\.js"><\/script>/.test(vfo));
});
function body(name) {
  const i = vfo.indexOf(name);
  assert.ok(i >= 0, name + ' not found');
  return vfo.slice(i, i + 2500);
}
t('pttStart mutes the monitor', () => {
  assert.ok(/applyMonitorGain\(\)/.test(body('async function pttStart()').split('let stream = null')[0]));
});
t('pttStop restores the monitor', () => {
  assert.ok(/applyMonitorGain\(\)/.test(body('function pttStop()').split('Stop mic')[0]));
});
t('onTxState sets the radio TX flag and applies the gain on both edges', () => {
  const b = body('window.api.onTxState(').split('// --- CW Macros')[0];
  assert.ok(/vfoRadioTx\s*=\s*!!state/.test(b));
  assert.strictEqual((b.match(/applyMonitorGain\(\)/g) || []).length >= 1, true);
});
t('no monitor gain is set to the volume outside the module', () => {
  assert.ok(!/audioMonitorGain\.gain\.value\s*=\s*[^;]*monitorVolume/.test(vfo),
    'a direct audioMonitorGain.gain.value = ...monitorVolume would unmute during TX');
});

console.log('vfo-monitor-tx-mute-test: ' + n + ' passed');
