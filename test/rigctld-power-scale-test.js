#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// rigctld TX power is converted on HAMLIB's scale, both ways (profdbe KX3 +
// KXPA100 and frank9425 G90, 2026-10-24/31: "WSPR changes my KX3 power
// settings to 11 watts").
//
// RFPOWER is a 0..1 fraction of what Hamlib thinks full power is. POTACAT
// divided watts by 100 on the way out and multiplied readbacks by the model's
// maxPower (15 W for a KX3) on the way in, while Hamlib's full scale with the
// amplifier is 110 W: every read and write was off, and a WSPR restore landed
// at 11 W. The codec now asks `+\power2mW 1.0 <freq> <mode>` and uses the
// answer for both directions; main hands it watts.
// Run: node test/rigctld-power-scale-test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

function codecFor(modelId) {
  const writes = [];
  const c = new RigctldCodec(RIG_MODELS[modelId], (d) => writes.push(String(d)));
  const logs = [];
  c.on('log', (l) => logs.push(l));
  const feed = (...lines) => c.onData(Buffer.from(lines.join('\n') + '\n'));
  return { c, writes, logs, feed };
}

test('Hamlib says 110 W: 20 W is written as 0.182 and read back as 20 W', () => {
  const { c, writes, feed } = codecFor('KX2/KX3');
  c._lastFreqHz = 14095600;
  c.probePowerScale();
  assert.ok(writes.some((w) => /^\+\\power2mW 1\.0 14095600 /.test(w)), JSON.stringify(writes));
  feed('power2mW: 1.0 14095600 USB', 'Power mW: 110000', 'RPRT 0');
  assert.strictEqual(c.powerFullScaleW(), 110);
  c.setTxPowerWatts(20);
  assert.strictEqual(writes[writes.length - 1], 'L RFPOWER 0.182\n');
  let read = null;
  c.on('power', (w) => { read = w; });
  c.getPower();
  feed('0.182');
  assert.strictEqual(read, 20);
});

test('the WSPR cap of 1 W on a 110 W scale is 0.009, never full power', () => {
  const { c, writes, feed } = codecFor('KX2/KX3');
  c._lastFreqHz = 14095600; c.probePowerScale();
  feed('power2mW: 1.0 14095600 USB', 'Power mW: 110000', 'RPRT 0');
  c.setTxPowerWatts(1);
  assert.strictEqual(writes[writes.length - 1], 'L RFPOWER 0.009\n');
});

test('before Hamlib answers, a write errs low: 20 W on a 15 W model is 0.200, not 1.000', () => {
  const { c, writes } = codecFor('KX2/KX3');
  c.setTxPowerWatts(20);
  assert.strictEqual(writes[writes.length - 1], 'L RFPOWER 0.200\n');
});

test('a backend that rejects power2mW latches it off and uses the model maximum', () => {
  const { c, writes, logs, feed } = codecFor('KX2/KX3');
  c._lastFreqHz = 7074000; c.probePowerScale();
  feed('RPRT -11');
  assert.strictEqual(c._power2mwUnsupported, true);
  assert.ok(logs.some((l) => /cannot convert power/.test(l)));
  const n = writes.length;
  c.probePowerScale(14074000);
  assert.strictEqual(writes.length, n, 'asked again after a refusal');
});

test('the probe reply cannot be taken for a frequency, and RPRT pops only its own query', () => {
  const { c, writes, feed } = codecFor('KX2/KX3');
  let freq = null;
  c.on('frequency', (hz) => { freq = hz; });
  c._lastFreqHz = 14074000;
  c.probePowerScale();
  c.getFrequency ? c.getFrequency() : c._write('f\n');
  feed('power2mW: 1.0 14074000 USB', 'Power mW: 110000', 'RPRT 0', '14074000');
  assert.strictEqual(c.powerFullScaleW(), 110);
  assert.strictEqual(freq, 14074000);
});

test('a band change asks again; a QSY inside the band does not', () => {
  const { c, writes, feed } = codecFor('KX2/KX3');
  const probes = () => writes.filter((w) => /power2mW/.test(w)).length;
  c._write('f\n'); feed('14074000');
  assert.strictEqual(probes(), 1, 'first frequency');
  feed('power2mW: 1.0 14074000 USB', 'Power mW: 110000', 'RPRT 0');
  c._write('f\n'); feed('14095600');
  assert.strictEqual(probes(), 1, 'same band');
  c._write('f\n'); feed('7074000');
  assert.strictEqual(probes(), 2, 'new band');
});

test('main hands the controller watts; the controller never throttles a power write away', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/if \(typeof cat\.setTxPowerWatts === 'function'\) cat\.setTxPowerWatts\(actual\);/.test(main));
  const rc = readSrc(path.join(__dirname, '..', 'lib', 'rig-controller.js'));
  const i = rc.indexOf('  setTxPowerWatts(watts) {');
  assert.ok(i > 0 && !/_lastPcTime && now - this\._lastPcTime/.test(rc.slice(i, i + 500)), 'setTxPowerWatts throttled');
});

// Against the real bundled rigctld (dummy radio: 100 W full scale).
const bin = path.join(__dirname, '..', 'assets', 'hamlib', process.platform === 'win32' ? 'rigctld.exe' : 'rigctld');
test('real rigctld: the dummy radio reports 100 W full scale through the codec', async () => {
  if (!fs.existsSync(bin)) { console.log('       (SKIP: no bundled rigctld)'); return; }
  const port = 45000 + Math.floor(Math.random() * 1000);
  const proc = spawn(bin, ['-m', '1', '-T', '127.0.0.1', '-t', String(port)], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    const c = new RigctldCodec(RIG_MODELS['KX2/KX3'], (d) => sock.write(d));
    sock.on('data', (d) => c.onData(d));
    c.probePowerScale(14074000);
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(c.powerFullScaleW(), 100);
    c.setTxPowerWatts(25);
    let read = null;
    c.on('power', (w) => { read = w; });
    c.getPower();
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(read, 25, 'set 25 W, read back ' + read);
    sock.end();
  } finally { proc.kill(); }
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
  }
  console.log(`\nrigctld power scale: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
