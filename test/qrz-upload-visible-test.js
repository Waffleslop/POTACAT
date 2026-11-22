'use strict';
// QRZ Logbook uploads are visible (B8 row 3: an operator's contacts came IN
// from QRZ but never went out, and nothing anywhere said why).
// - every upload writes one [QRZ] line: sent, already there, refused, or skipped;
// - the API key never appears in that line;
// - the log toast names a QRZ refusal;
// - a subscription check never unticks the saved upload box.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LoggerForward = require('../lib/logger-forward');

let passed = 0, failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ok  ' + name); },
    (e) => { failed++; console.log('  FAIL ' + name + ': ' + e.message); }));
}

function deps(qrzImpl) {
  const lines = [];
  return {
    lines,
    d: {
      forwardToLogbook: async () => {},
      sendExtraUdp: async () => {},
      sendToQrzLogbook: qrzImpl,
      log: (m) => lines.push(m),
      error: () => {},
    },
  };
}
const ops = { qrzLogbook: true, qrzApiKey: 'SECRET-KEY-1234' };

check('a sent upload writes one [QRZ] line with the call and QRZ log id', async () => {
  const { d, lines } = deps(async () => ({ ok: true, logId: '998877' }));
  const r = await LoggerForward.forwardToLoggers({ callsign: 'w1aw' }, ops, d);
  assert.deepStrictEqual(lines, ['[QRZ] Uploaded W1AW (QRZ log id 998877)']);
  assert.strictEqual(r.qrzError, undefined);
});

check('a duplicate says it is already in the QRZ logbook', async () => {
  const { d, lines } = deps(async () => ({ ok: true, logId: '', duplicate: true }));
  await LoggerForward.forwardToLoggers({ callsign: 'K3SBP' }, ops, d);
  assert.deepStrictEqual(lines, ['[QRZ] K3SBP is already in the QRZ logbook']);
});

check('a refusal is logged with QRZ\'s reason and returned as qrzError', async () => {
  const { d, lines } = deps(async () => { throw new Error('invalid api key'); });
  const r = await LoggerForward.forwardToLoggers({ callsign: 'N0CALL' }, ops, d);
  assert.deepStrictEqual(lines, ['[QRZ] Upload refused for N0CALL: invalid api key']);
  assert.strictEqual(r.qrzError, 'invalid api key');
});

check('upload ticked but no key: the line says why nothing went', async () => {
  const { d, lines } = deps(async () => { throw new Error('must not be called'); });
  await LoggerForward.forwardToLoggers({ callsign: 'N0CALL' }, { qrzLogbook: true, qrzApiKey: '' }, d);
  assert.deepStrictEqual(lines, ['[QRZ] Not uploaded N0CALL: no QRZ Logbook API key is set']);
});

check('upload off or the extra multi-park record: no line, no upload', async () => {
  const { d, lines } = deps(async () => { throw new Error('must not be called'); });
  await LoggerForward.forwardToLoggers({ callsign: 'N0CALL' }, { qrzLogbook: false, qrzApiKey: 'k' }, d);
  await LoggerForward.forwardToLoggers({ callsign: 'N0CALL', skipLogbookForward: true }, ops, d);
  assert.deepStrictEqual(lines, []);
});

check('the API key never appears in any [QRZ] line', () => {
  const all = [
    LoggerForward.qrzUploadLine({ callsign: 'A1A' }, { ok: true, logId: '1' }, null),
    LoggerForward.qrzUploadLine({ callsign: 'A1A' }, null, new Error('bad')),
  ].join('\n');
  assert.ok(!all.includes('SECRET'));
});

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

check('the log toast names a QRZ refusal', () => {
  assert.ok(/else if \(lastResult\.qrzError\) \{\s*showLogToast\(`Logged \$\{displayCalls\}, but QRZ Logbook did not take it: \$\{lastResult\.qrzError\}`/.test(app));
});

check('the subscription check never unticks the saved upload box', () => {
  const m = app.match(/function showQrzLoginStatus\(result\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'showQrzLoginStatus found');
  assert.ok(!/setQrzLogbook\.checked = false/.test(m[0]), 'no untick in the status handler');
  assert.ok(!/qrzLogbookConfig\.classList\.add\('hidden'\)/.test(m[0]), 'the key field is not hidden under a ticked box');
});

check('main hands the upload result back so the line can name the log id', () => {
  assert.ok(/return QrzClient\.uploadQso\(apiKey, record, s\.myCallsign \|\| ''\);/.test(main));
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
