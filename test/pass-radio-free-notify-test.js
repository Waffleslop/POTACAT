'use strict';
// Guest Pass "radio is free" notify (#541, B5 row 6): the contract in
// docs/handoffs/CLOUD_TO_DESKTOP_HANDOFF_2026-11-14_RADIO_FREE_NOTIFY.md.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRadioFreeNotifier, describeOutcome, notifyPath } = require('../lib/pass-radio-free-notify');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack)); process.exitCode = 1; }
}
function httpErr(status, code) { const e = new Error(code); e.status = status; e.code = code; return e; }

(async () => {
  await t('POSTs only {kind: radio_free} to /v1/passes/:code/notify', async () => {
    const calls = [];
    const n = createRadioFreeNotifier({ getRequest: () => async (m, p, b) => { calls.push([m, p, b]); return { sent: 1, devices: 1 }; } });
    const r = await n.notify({ code: 'apple pie', call: 'K3SBP', sessionId: 'abc', offeredAt: '2026-11-15T22:00:00.000Z' });
    assert.deepStrictEqual(calls, [['POST', '/v1/passes/apple%20pie/notify', { kind: 'radio_free' }]]);
    assert.deepStrictEqual(r, { outcome: 'sent', sent: 1, devices: 1 });
  });

  await t('once per offer: the same offer is never sent twice; a new offer is', async () => {
    let n200 = 0;
    const n = createRadioFreeNotifier({ getRequest: () => async () => { n200++; return { sent: 0, devices: 0 }; } });
    const s = { code: 'X', offeredAt: 'a' };
    await n.notify(s); await n.notify(s);
    assert.strictEqual(n200, 1);
    await n.notify({ code: 'X', offeredAt: 'b' });
    assert.strictEqual(n200, 2);
  });

  await t('429, 409, 410 and 404 are skips, each called once, never retried', async () => {
    for (const [status, code] of [[429, 'push_rate_limited'], [409, 'no_guest_session'], [410, 'pass_over'], [404, 'not_found']]) {
      let calls = 0;
      const n = createRadioFreeNotifier({ getRequest: () => async () => { calls++; throw httpErr(status, code); } });
      const r = await n.notify({ code: 'C', offeredAt: String(status) });
      assert.strictEqual(r.outcome, 'skipped', String(status));
      assert.strictEqual(calls, 1);
    }
  });

  await t('not signed in: no call, skipped', async () => {
    const n = createRadioFreeNotifier({ getRequest: () => null });
    const r = await n.notify({ code: 'C', offeredAt: 'x' });
    assert.strictEqual(r.outcome, 'skipped');
  });

  await t('no pass code: no call', async () => {
    let calls = 0;
    const n = createRadioFreeNotifier({ getRequest: () => async () => { calls++; } });
    assert.strictEqual((await n.notify({ offeredAt: 'x' })).outcome, 'skipped');
    assert.strictEqual(calls, 0);
  });

  await t('times out at the given limit and never throws', async () => {
    const n = createRadioFreeNotifier({ timeoutMs: 20, getRequest: () => () => new Promise(() => {}) });
    const r = await n.notify({ code: 'C', offeredAt: 'x' });
    assert.strictEqual(r.outcome, 'failed');
    assert.strictEqual(r.reason, 'timeout');
  });

  await t('a network error is a failure, not a throw', async () => {
    const n = createRadioFreeNotifier({ getRequest: () => async () => { throw new Error('ECONNRESET'); } });
    const r = await n.notify({ code: 'C', offeredAt: 'x' });
    assert.strictEqual(r.outcome, 'failed');
  });

  await t('the log line carries no call or code', async () => {
    const line = describeOutcome({ outcome: 'sent', sent: 1, devices: 2 });
    assert.ok(/1 of 2 phones/.test(line));
    assert.ok(!/K3SBP/.test(line));
    assert.strictEqual(notifyPath('a/b'), '/v1/passes/a%2Fb/notify');
  });

  await t('main.js wires the idle offer to the notifier', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const m = main.match(/function onOwnerIdleOffered\(session\) \{([\s\S]*?)\n\}/);
    assert.ok(m, 'onOwnerIdleOffered exists');
    assert.ok(/radioFreeNotifier\.notify\(session\)/.test(m[1]), 'calls radioFreeNotifier.notify(session)');
  });

  console.log(`pass-radio-free-notify: ${passed} passed`);
})();
