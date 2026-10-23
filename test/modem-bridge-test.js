'use strict';
// The modem audio bridge window (docs/modem-audio-bridge-plan.md phase 1):
// spawns Electron on test/modem-bridge/harness.js with Chromium's fake audio
// device, the REAL bridge page and preload, and a REAL modem audio server.
// Proves: the captured audio reaches the server as 12 kHz PCM, TX chunks are
// accepted and ACKed, a bogus device fails with the exact wording and
// captures nothing. LAYOUT_REQUIRED=1 (CI) turns "could not run" into a failure.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const required = process.env.LAYOUT_REQUIRED === '1';
let electronPath = null;
try { electronPath = require('electron'); } catch { electronPath = null; }
if (!electronPath || typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  console.log('modem bridge: SKIP (electron binary not available)');
  process.exit(required ? 1 : 0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-modem-bridge-'));
const out = path.join(dir, 'result.json');
const res = spawnSync(electronPath, [path.join(__dirname, 'modem-bridge', 'harness.js'), '--no-sandbox', '--out=' + out], {
  cwd: ROOT, encoding: 'utf8', timeout: 90000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
if (!fs.existsSync(out)) {
  console.log('modem bridge: ' + (required ? 'FAIL' : 'SKIP') + ' (harness produced no result; exit ' + res.status + ')\n' + (res.stderr || '').slice(-1500));
  process.exit(required ? 1 : 0);
}
const r = JSON.parse(fs.readFileSync(out, 'utf8'));
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const first = r.statuses.find((s) => s && typeof s.ok === 'boolean');
t('the bridge opened the (fake) input and output and said so', () => {
  assert.ok(first, 'a status arrived: ' + JSON.stringify(r.statuses).slice(0, 300));
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.ok(first.captureLabel, 'capture label');
  assert.strictEqual(first.playback, true);
});
t('captured audio reaches main in 20 ms batches at the context rate, with signal', () => {
  assert.ok(r.rx.batches > 40, 'batches ' + r.rx.batches);
  assert.ok(r.rx.sampleRate >= 44100, 'rate ' + r.rx.sampleRate);
  const perBatch = r.rx.samples / r.rx.batches;
  assert.ok(Math.abs(perBatch - r.rx.sampleRate * 0.02) < 64, 'batch ' + perBatch);
  assert.ok(r.rx.peak > 0.01, 'fake device audio has a signal (peak ' + r.rx.peak + ')');
});
t('the modem receives 12 kHz PCM with the same signal', () => {
  const secs = r.modem.bytes / 2 / 12000;
  assert.ok(secs > 1.5, 'modem got ' + secs.toFixed(2) + ' s');
  assert.ok(r.modem.rms > 0.003, 'modem rms ' + r.modem.rms);
});
t('TX chunks are accepted and ACKed', () => { assert.ok(r.acks >= 20, 'acks ' + r.acks); });
t('a device that cannot be opened fails with the exact wording and captures nothing', () => {
  const i = r.statuses.findIndex((s) => s && s.marker === 'bogus-start');
  const bad = r.statuses.slice(i + 1).find((s) => s && typeof s.ok === 'boolean');
  assert.ok(bad && bad.ok === false, JSON.stringify(bad));
  assert.ok(/microphone was NOT used/.test(bad.error), bad.error);
  assert.ok(r.rx.batchesAfterBogus < 10, 'no capture after a refused start (' + r.rx.batchesAfterBogus + ')');
});
t('no renderer errors', () => { assert.deepStrictEqual(r.errors, []); });
console.log(`\nmodem bridge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
