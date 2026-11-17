'use strict';
// #717: FreeDV audio arrival, sync and capture failures reach the session log
// (sendCatLog), so Report a Bug shows them. Rate-limited; diagnostics only.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { FreedvDiag, SUMMARY_MS, SYNC_LINE_MS } = require('../lib/freedv-diag');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }
const read = (p) => readSrc(path.join(__dirname, '..', p));

t('first RX audio block is logged once, with its level', () => {
  const d = new FreedvDiag(0);
  const line = d.audio(new Int16Array([0, 16384, -100]));
  assert.ok(/First RX audio: 3 samples, peak 50\.0%/.test(line), line);
  assert.strictEqual(d.audio(new Int16Array([1, 2])), null);
});
t('an all-zero first block is flagged', () => {
  const d = new FreedvDiag(0);
  assert.ok(/ALL ZERO/.test(d.audio(new Int16Array(160))));
});
t('sync achieved, lost and regained, each with SNR; repeats say nothing', () => {
  const d = new FreedvDiag(0);
  assert.strictEqual(d.sync({ sync: false, snr: -3 }, 100), null);
  assert.strictEqual(d.sync({ sync: true, snr: 4.25 }, 1000), '[FreeDV] Sync achieved, SNR 4.3 dB');
  assert.strictEqual(d.sync({ sync: true, snr: 4 }, 1100), null);
  assert.strictEqual(d.sync({ sync: false, snr: -1 }, 1000 + SYNC_LINE_MS), '[FreeDV] Sync lost, SNR -1.0 dB');
  assert.strictEqual(d.sync({ sync: true, snr: 3 }, 1000 + 2 * SYNC_LINE_MS), '[FreeDV] Sync regained, SNR 3.0 dB');
});
t('a flapping decoder is held to one line per window; a state that holds is still logged', () => {
  const d = new FreedvDiag(0);
  let lines = 0;
  let now = 0;
  for (let i = 0; i < 40; i++) { now += 100; if (d.sync({ sync: i % 2 === 0, snr: 1 }, now)) lines++; }
  assert.strictEqual(lines, 1, 'one line in 4 s of flapping');
  // it settles on "lost": once the window passes, the log says so
  let last = null;
  for (let i = 0; i < 60; i++) { now += 100; last = d.sync({ sync: false, snr: -5 }, now) || last; }
  assert.strictEqual(last, '[FreeDV] Sync lost, SNR -5.0 dB');
  assert.ok(/sync changed \d+ more times/.test(d.tick(now + SUMMARY_MS)));
});
t('a 30 s summary: audio in, speech out, sync, SNR; then nothing until the next 30 s', () => {
  const d = new FreedvDiag(0);
  for (let i = 0; i < 5; i++) d.audio(new Int16Array([0, 3277]));
  d.speech(); d.speech();
  d.sync({ sync: true, snr: 2 }, 10);
  assert.strictEqual(d.tick(SUMMARY_MS - 1), null);
  const line = d.tick(SUMMARY_MS);
  assert.strictEqual(line, '[FreeDV] Last 30 s: 5 audio blocks in (input peak 10.0%), 2 speech blocks out, sync yes, SNR 2.0 dB');
  assert.strictEqual(d.tick(SUMMARY_MS + 1000), null);
  assert.ok(/0 audio blocks in \(no input\), 0 speech blocks out/.test(d.tick(2 * SUMMARY_MS)));
});

// --- main.js and the renderer wire it to the session log ---
const main = read('main.js');
const startBody = main.slice(main.indexOf('function startFreedvEngine('), main.indexOf('function stopFreedvEngine('));
t('main feeds the diag from the engine and logs its lines with sendCatLog', () => {
  assert.ok(/require\('\.\/lib\/freedv-diag'\)/.test(main));
  assert.ok(/_freedvDiag\.sync\(/.test(startBody), 'sync lines');
  assert.ok(/_freedvDiag\.speech\(\)/.test(startBody), 'speech out counted');
  assert.ok(/_freedvDiag\.tick\(/.test(startBody), '30 s summary');
  const rx = main.slice(main.indexOf("ipcMain.on('freedv-rx-audio'"), main.indexOf("ipcMain.on('freedv-tx-audio'"));
  assert.ok(/_freedvDiag\.audio\(/.test(rx), 'audio in counted');
  const stop = main.slice(main.indexOf('function stopFreedvEngine('), main.indexOf('function freedvCodecFor('));
  assert.ok(/clearInterval\(_freedvDiagTimer\)/.test(stop), 'the summary timer stops with the engine');
});
t('the renderer relays a capture failure to the session log', () => {
  const app = read('renderer/app.js');
  const i = app.indexOf("console.error('[FreeDV] RX audio capture failed:'");
  assert.ok(i > 0);
  assert.ok(/window\.api\.jtcatLog\('\[FreeDV\] RX audio capture failed/.test(app.slice(i, i + 400)));
});

console.log(`freedv-diag: ${passed} passed`);
