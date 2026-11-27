'use strict';
// #1121: the Extra UDP broadcast (GridTracker, JTAlert) carries the operator's
// home grid as MY_GRIDSQUARE on a home contact, as the main logbook forward
// does. Never on an activation, never over a grid the QSO has, and the QRZ
// upload is unchanged. Run: node test/extra-udp-home-grid-test.js

const assert = require('assert');
const LF = require('../lib/logger-forward');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const OPS = { grid: 'EM73tu', homeState: 'GA', extraUdpEnabled: true, extraUdpHost: '127.0.0.1', extraUdpPort: '2237', extraUdpFormat: 'wsjtx' };
const HOME_QSO = { callsign: 'K1ABC', frequency: '14074', mode: 'FT8', qsoDate: '2026-11-27', timeOn: '18:30' };

function deps() {
  const sent = { udp: [], qrz: [] };
  return {
    sent,
    d: {
      forwardToLogbook: async () => {},
      sendExtraUdp: async (q) => { sent.udp.push(q); },
      sendToQrzLogbook: async (q) => { sent.qrz.push(q); return { result: 'OK', logid: '1' }; },
      log: () => {}, error: () => {},
    },
  };
}

(async () => {
  await test('a home contact reaches the Extra UDP destination with the home grid', async () => {
    const { sent, d } = deps();
    await LF.forwardToLoggers(HOME_QSO, OPS, d);
    assert.strictEqual(sent.udp.length, 1);
    assert.strictEqual(sent.udp[0].myGridsquare, 'EM73tu');
  });
  await test('the QSO handed in is not changed (the saved record keeps no grid)', async () => {
    const q = { ...HOME_QSO };
    await LF.forwardToLoggers(q, OPS, deps().d);
    assert.strictEqual(q.myGridsquare, undefined);
  });
  await test('an activation keeps its own location: no home grid', async () => {
    const { sent, d } = deps();
    await LF.forwardToLoggers({ ...HOME_QSO, mySigInfo: 'US-1234', mySig: 'POTA' }, OPS, d);
    assert.ok(!sent.udp[0].myGridsquare);
  });
  await test('a grid the QSO has is never replaced', async () => {
    const { sent, d } = deps();
    await LF.forwardToLoggers({ ...HOME_QSO, myGridsquare: 'FN31' }, OPS, d);
    assert.strictEqual(sent.udp[0].myGridsquare, 'FN31');
  });
  await test('no grid set: nothing added', async () => {
    const { sent, d } = deps();
    await LF.forwardToLoggers(HOME_QSO, { ...OPS, grid: '' }, d);
    assert.ok(!sent.udp[0].myGridsquare);
  });
  await test('the QRZ upload copy is unchanged', async () => {
    const { sent, d } = deps();
    await LF.forwardToLoggers(HOME_QSO, { ...OPS, qrzLogbook: true, qrzApiKey: 'x' }, d);
    assert.strictEqual(sent.qrz.length, 1);
    assert.ok(!sent.qrz[0].myGridsquare);
  });
  console.log(`extra-udp-home-grid: ${passed} passed`);
})();
