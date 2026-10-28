#!/usr/bin/env node
'use strict';
/**
 * The phone's VFO waterfall with no FT8/JS8 engine running (cap 'rx-spectrum';
 * Casey's go 2026-10-28, first case a Flex 8600 on Flex Direct,
 * BUG-K3SBP-20261028-1D6678).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RxSpectrumRing, RATE } = require('../lib/rx-spectrum-ring');
const { computeSpectrumBins } = require('../lib/spectrum-fft');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function tone(hz, rate, seconds) {
  const n = Math.round(rate * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * hz * i / rate);
  return a;
}

console.log('The ring');
check('every rate lands at 12 kHz: the Flex 24 kHz, a sound card 48 kHz, 12 kHz as is', () => {
  for (const rate of [12000, 24000, 48000, 44100]) {
    const r = new RxSpectrumRing();
    r.push(new Float32Array(rate / 10 | 0), rate, 1000);
    assert.ok(Math.abs(r.offset - RATE / 10) <= 2, rate + ' Hz gave ' + r.offset + ' samples for 100 ms');
  }
});
check('fresh only while audio arrives', () => {
  const r = new RxSpectrumRing();
  assert.strictEqual(r.fresh(1000), false);
  r.push(new Float32Array(100), 12000, 1000);
  assert.strictEqual(r.fresh(2000), true);
  assert.strictEqual(r.fresh(5000), false, 'a stopped stream does not paint stale bins');
});
check('a 1 kHz tone from a 24 kHz Flex stream peaks at the 1 kHz bin', () => {
  const r = new RxSpectrumRing();
  const t = tone(1000, 24000, 0.5);
  for (let i = 0; i < t.length; i += 2400) r.push(t.subarray(i, i + 2400), 24000);
  const bins = computeSpectrumBins(r.buffer, r.offset, 160);
  let peak = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
  const hz = peak * 3000 / 160;
  assert.ok(Math.abs(hz - 1000) <= 25, 'peak at ' + hz + ' Hz');
});

console.log('Wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
check('Flex Direct and Icom Network feed the ring while a phone watches', () => {
  assert.ok(/smartSdrAudio\.on\('audio-frame'[\s\S]{0,200}if \(_mobileWantsSpectrum\) rxSpecRing\.push\(pcm, sampleRate\);/.test(main));
  assert.ok(/if \(_mobileWantsSpectrum && !meta\.lossFill\) rxSpecRing\.push\(pcm, sampleRate\);/.test(main));
});
check('the engine wins while it runs; the RX ring otherwise; frames say which', () => {
  const loop = main.slice(main.indexOf('function startInProcessSpectrum('), main.indexOf('function stopInProcessSpectrum('));
  assert.ok(loop.indexOf("source = 'engine'") < loop.indexOf("source = 'rx'"));
  assert.ok(/if \(specBuf && rxSpectrumEngineLive\(\)\)/.test(loop) && /else if \(rxSpecRing\.fresh\(\)\)/.test(loop));
  assert.ok(/broadcastJtcatSpectrum\(out, source\)/.test(loop));
});
check('a sound-card radio: the audio window captures the CHOSEN input only, spectrum only', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/remote-audio.html'), 'utf8');
  const block = html.slice(html.indexOf('onRxSpectrumWant'), html.indexOf('window.api.onStartAudio'));
  assert.ok(/deviceId: \{ exact: o\.inputDeviceId \}/.test(block), 'never the default input');
  assert.ok(/if \(!o \|\| !o\.on \|\| !o\.inputDeviceId\) return;/.test(block), 'no device chosen: no capture');
  assert.ok(!/RTCPeerConnection|addTrack/.test(block), 'nothing leaves the PC but the bins');
  const sync = main.slice(main.indexOf('function rxSpectrumSync('), main.indexOf('function rxSpectrumSync(') + 1400);
  assert.ok(/!rxSpectrumEngineLive\(\)/.test(sync) && /!socketAudio/.test(sync), 'only when the engine is idle and there is no Flex/Icom stream');
});
check('capability and wire', () => {
  const rs = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');
  assert.ok(/'rx-spectrum'\]/.test(rs));
  assert.ok(/type: 'jtcat-spectrum', bins, source: source \|\| 'engine'/.test(rs));
  const proto = require('../lib/echocat-protocol');
  assert.ok(proto.MESSAGES['jtcat-spectrum'].fields.source, 'source registered');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
