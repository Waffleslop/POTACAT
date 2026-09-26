// The one-time "Rate ECHOCAT" ask (lib/review-ask.js): who is eligible, when,
// and that it can be seen at most twice. Plus the wiring guards that keep it
// out of an operator's way.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/review-ask');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 1, 15);
const iphone = { platform: 'ios', addedAt: new Date(NOW - 10 * DAY).toISOString() };
const pixel = { platform: 'android', addedAt: new Date(NOW - 20 * DAY).toISOString() };
const browser = { platform: 'web', addedAt: new Date(NOW - 90 * DAY).toISOString() };
const seen3 = { ...R.freshAsk(), daysSeen: ['2026-09-20', '2026-09-24', '2026-09-30'] };
const calm = { ok: true, why: '' };
const decide = (o) => R.decideReviewAsk({ devices: [iphone], ask: seen3, now: NOW, calm, ...o });

test('eligible: an iPhone paired 10 days ago, seen on 3 days, at a calm moment', () => {
  const d = decide({});
  assert.strictEqual(d.show, true, d.why);
  assert.deepStrictEqual(d.stores, ['ios']);
});

test('never without a paired phone or tablet (browsers do not count)', () => {
  assert.strictEqual(decide({ devices: [] }).show, false);
  assert.strictEqual(decide({ devices: [browser] }).show, false);
});

test('waits a week after the first phone paired, and for 3 days of use', () => {
  const fresh = { platform: 'ios', addedAt: new Date(NOW - 3 * DAY).toISOString() };
  assert.strictEqual(decide({ devices: [fresh] }).show, false);
  assert.strictEqual(decide({ ask: { ...seen3, daysSeen: seen3.daysSeen.slice(0, 2) } }).show, false);
  // The EARLIEST phone decides: a new tablet next to an old phone does not reset it.
  assert.strictEqual(decide({ devices: [fresh, pixel] }).show, true);
});

test('never at a busy moment', () => {
  const d = decide({ calm: { ok: false, why: 'transmitting' } });
  assert.strictEqual(d.show, false);
  assert.ok(/transmitting/.test(d.why));
});

test('the right store: iOS, Android, or both', () => {
  assert.deepStrictEqual(decide({ devices: [pixel] }).stores, ['android']);
  assert.deepStrictEqual(decide({ devices: [pixel, iphone, browser] }).stores, ['ios', 'android']);
});

test('Rate and "Don\'t ask again" end it', () => {
  for (const a of ['rate', 'never']) {
    const after = R.applyAction(R.markShown(seen3), a, NOW);
    assert.strictEqual(after.state, 'done');
    assert.strictEqual(decide({ ask: after }).show, false);
  }
});

test('Not now snoozes 30 days; a second Not now ends it — at most twice, ever', () => {
  let a = R.applyAction(R.markShown(seen3), 'later', NOW);
  assert.strictEqual(a.state, 'snoozed');
  assert.strictEqual(decide({ ask: a, now: NOW + 29 * DAY }).show, false);
  assert.strictEqual(decide({ ask: a, now: NOW + 31 * DAY }).show, true);
  a = R.applyAction(R.markShown(a), 'later', NOW + 31 * DAY);
  assert.strictEqual(a.state, 'done');
  assert.strictEqual(decide({ ask: a, now: NOW + 400 * DAY }).show, false);
});

test('days a phone connected: phones only, each day once, stop at 3', () => {
  assert.ok(R.isPhonePlatform('ios 18.2 phone') && R.isPhonePlatform('android 34 tablet'));
  assert.ok(!R.isPhonePlatform('web') && !R.isPhonePlatform('node') && !R.isPhonePlatform(''));
  let a = R.freshAsk();
  a = R.recordDaySeen(a, '2026-09-01');
  a = R.recordDaySeen(a, '2026-09-01');
  a = R.recordDaySeen(a, '2026-09-02');
  a = R.recordDaySeen(a, '2026-09-03');
  a = R.recordDaySeen(a, '2026-09-04');
  assert.deepStrictEqual(a.daysSeen, ['2026-09-01', '2026-09-02', '2026-09-03']);
});

test('store links are the ones the stores publish', () => {
  assert.strictEqual(R.STORE_LINKS.ios, 'https://apps.apple.com/app/id6766321194?action=write-review');
  assert.strictEqual(R.STORE_LINKS.android, 'https://play.google.com/store/apps/details?id=co.cmox.echocat');
});

// --- wiring ------------------------------------------------------------------
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const card = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'echocat-review.js'), 'utf8');

test('main: every calm-moment gate is checked', () => {
  const c = main.slice(main.indexOf('function reviewAskCalm('), main.indexOf('function reviewAskTick('));
  for (const g of ['2 * 60 * 1000', 'transmitting', 'FT8 running', 'Run/Hunt active', 'activation running', 'QSO just logged', 'hosting a Guest Pass']) {
    assert.ok(c.includes(g), 'missing gate: ' + g);
  }
  assert.ok(/_lastQsoLoggedAt = Date\.now\(\);/.test(main), 'QSO time stamped where every log path passes');
  assert.ok(/'echocatReviewAsk',/.test(main.slice(main.indexOf('const GLOBAL_KEYS'), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS')))));
});

test('card: no incentives, no gating, never stacks on another notice', () => {
  assert.ok(!/free|reward|unlock|Pro time|raffle|5 stars|five stars/i.test(card), 'incentive or gating wording');
  assert.ok(!/like it\?|happy/i.test(card), 'no "do you like it" gate');
  assert.ok(/echocatReviewDeferred\(\)/.test(card), 'defers when another card or dialog is up');
  assert.ok(/'Not now'/.test(card) && /Don\\'t ask again/.test(card));
});

console.log(`\nReview ask: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
