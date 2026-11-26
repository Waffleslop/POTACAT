#!/usr/bin/env node
'use strict';
// #1085: when the shack refuses Run, the JTCAT window keeps Run visible and
// shows why; each of the three causes has its own sentence; a refused Run
// never leaves TX enabled at the shack.
// Run: node test/jtcat-run-refusal-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = require('../lib/jtcat-run-refusal');
const B = require('../lib/remote-bridge');
const { MESSAGES } = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => { passed++; console.log('  ok  ' + name); },
    (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }));
}
const src = (f) => readSrc(path.join(__dirname, '..', f));
const main = src('main.js');
const popout = src('renderer/jtcat-popout.js');
const server = src('lib/remote-server.js');

// ── (a) the window keeps Run visible on a refused start ─────────────────────
test('the shack\'s ultracat:false does not reach the window as its own ULTRACAT', () => {
  const out = B.IN['jtcat-ultracat-state']({ type: 'jtcat-ultracat-state', ultracat: false, fullAutoCq: false, owner: null,
    reason: R.text('ultracat-locked'), code: 'ultracat-locked' });
  assert.ok(!out.some(([ch]) => ch === 'jtcat-ultracat'), 'jtcat-ultracat would hide Run and every ULTRACAT control');
  assert.deepStrictEqual(out, [['jtcat-full-auto-cq-state',
    { active: false, owner: null, reason: R.text('ultracat-locked'), code: 'ultracat-locked' }]]);
});

test('the window shows the refusal reason in its error toast, only for a start it asked for', () => {
  const at = popout.indexOf('window.api.onJtcatFullAutoCqState(function(state) {');
  assert.ok(at > 0);
  const body = popout.slice(at, at + 1500);
  assert.ok(/runStartPendingUntil && state && state\.reason\)[\s\S]{0,120}showJtcatErrorToast\(String\(state\.reason\)\)/.test(body),
    'the run-state handler shows state.reason');
  assert.ok(!/applyUltracat/.test(body), 'run state never hides the ULTRACAT controls');
  const click = popout.slice(popout.indexOf("fullAutoCqBtn.addEventListener('click'"), at);
  assert.ok(/runStartPendingUntil = Date\.now\(\) \+ \d+/.test(click), 'a Run click marks a start as pending');
});

test('no JTCAT pop-out-to-shack branch in the window: the run row lives in lib/remote-bridge.js', () => {
  const at = popout.indexOf('window.api.onJtcatFullAutoCqState(function(state) {');
  const region = popout.slice(popout.indexOf("fullAutoCqBtn.addEventListener('click'"), at + 1500);
  assert.ok(!/remoteShackMode|isRemoteMode/.test(region));
});

// ── (b) each cause has its own text ─────────────────────────────────────────
test('three causes, three codes, three different sentences for each audience', () => {
  const codes = Object.values(R.CODES);
  assert.deepStrictEqual(codes.sort(), ['engine-off', 'no-call-grid', 'ultracat-locked']);
  for (const aud of ['shack', 'here']) {
    const texts = codes.map(c => R.text(c, aud));
    assert.strictEqual(new Set(texts).size, 3, aud + ': ' + texts.join(' | '));
    for (const t of texts) {
      assert.ok(t.length > 10 && /\.$/.test(t), t);
      assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(t), 'no emoji: ' + t);
    }
  }
  assert.strictEqual(R.text('ultracat-locked'), 'The shack has not unlocked ULTRACAT. Unlock it on the shack computer, then press Run again.');
  assert.strictEqual(R.text('engine-off'), 'FT8 is not running at the shack. Start FT8, then press Run again.');
  assert.strictEqual(R.text('no-call-grid'), 'The shack has no callsign or grid set. Set them in Settings on the shack computer.');
  assert.strictEqual(R.text('nonsense'), 'The shack did not start Run.');
  assert.strictEqual(R.text('', 'here'), 'Run did not start.');
});

test('precheck: ULTRACAT first, then the engine', () => {
  assert.strictEqual(R.precheck({ ultracat: false, engine: false }), 'ultracat-locked');
  assert.strictEqual(R.precheck({ ultracat: true, engine: false }), 'engine-off');
  assert.strictEqual(R.precheck({ ultracat: true, engine: true }), '');
});

test('the shack replies with the cause\'s code and its sentence, not the one vague string', () => {
  assert.ok(!main.includes('ULTRACAT locked, FT8 engine not running, or callsign/grid not set'), 'the single three-cause string is gone');
  assert.ok(/JtcatRunRefusal\.precheck\(\{ ultracat: settings\.ultracat, engine: !!ft8Engine \}\)/.test(main));
  assert.ok(/why\.code = JtcatRunRefusal\.CODES\.NO_CALL_GRID;/.test(main));
  assert.ok(/broadcastFullAutoCqState\(JtcatRunRefusal\.text\(r\.code, 'shack'\), \{ code: r\.code \}\)/.test(main));
  assert.ok(/\.\.\.\(o\.code \? \{ code: o\.code \} : \{\}\)/.test(main), 'jtcat-ultracat-state carries code on a refusal');
  // A refused callsign/grid start pushes one state (the refusal), not a stop and then a refusal.
  assert.ok(/stopFullAutoCq\('callsign\/grid not set', opts && opts\.why \? \{ silent: true \} : undefined\)/.test(main));
});

test('requestStart reports the code startFullAutoCq set', async () => {
  for (const code of Object.values(R.CODES)) {
    const r = await R.requestStart({ engine: { _txEnabled: false }, start: async (why) => { why.code = code; return false; } });
    assert.deepStrictEqual(r, { ok: false, code });
  }
  assert.deepStrictEqual(await R.requestStart({ engine: null, start: async () => true }), { ok: true, code: '' });
});

// ── (c) TX after a refusal ──────────────────────────────────────────────────
test('a refused Run leaves TX off; an accepted Run leaves it on; TX that was on stays on', async () => {
  let notes = 0;
  const e1 = { _txEnabled: false };
  let txDuringStart = null;
  const r1 = await R.requestStart({ engine: e1, txOn: true, onTxOn: () => notes++, start: async (why) => { txDuringStart = e1._txEnabled; why.code = 'ultracat-locked'; return false; } });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(e1._txEnabled, false, 'TX left enabled after a refused start');
  assert.strictEqual(txDuringStart, true, 'TX is on during the start, as the old separate TX on was');

  const e2 = { _txEnabled: false };
  const r2 = await R.requestStart({ engine: e2, txOn: true, onTxOn: () => notes++, start: async () => true });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(e2._txEnabled, true, 'an accepted start keeps TX on (unchanged behaviour)');
  assert.strictEqual(notes, 2, 'turning TX on notes the operator for the transmit watchdog');

  const e3 = { _txEnabled: true };
  await R.requestStart({ engine: e3, txOn: true, start: async () => false });
  assert.strictEqual(e3._txEnabled, true, 'a refusal does not undo TX the operator already had on');

  const e4 = { _txEnabled: false };
  await assert.rejects(R.requestStart({ engine: e4, txOn: true, start: async () => { throw new Error('boom'); } }));
  assert.strictEqual(e4._txEnabled, false, 'a start that throws leaves TX off too');
});

// The shack, reduced to the two wire handlers that touch TX.
function shackEngineAfter(sends, startOk) {
  const engine = { _txEnabled: false };
  const queue = [];
  for (const m of sends) {
    if (m.type === 'jtcat-full-auto-cq' && m.on) queue.push(R.requestStart({ engine, txOn: !!m.txOn, start: async (why) => { why.code = 'ultracat-locked'; return startOk; } }));
    else if (m.type === 'jtcat-enable-tx') engine._txEnabled = !!m.enabled;
  }
  return Promise.all(queue).then(() => engine._txEnabled);
}

test('the window\'s Run click, through the bridge, leaves the shack\'s TX off when it refuses', async () => {
  const click = popout.slice(popout.indexOf("fullAutoCqBtn.addEventListener('click'"), popout.indexOf('window.api.onJtcatFullAutoCqState('));
  assert.ok(!/jtcatEnableTx\(true\)/.test(click), 'the Run click sends no separate TX on (it would land after the refusal)');
  assert.ok(/txOn: true/.test(click), 'the Run click asks for TX on with the start');
  const st = { serverCaps: ['jtcat', B.RUN_TX_ON_CAP] };
  const r = B.OUT['jtcat-popout-full-auto-cq']([{ on: true, modifier: '', txOn: true }], st);
  assert.deepStrictEqual(r.send, [{ type: 'jtcat-full-auto-cq', on: true, modifier: '', txOn: true }]);
  assert.strictEqual(await shackEngineAfter(r.send, false), false, 'refused: TX off at the shack');
  assert.strictEqual(await shackEngineAfter(r.send, true), true, 'accepted: TX on at the shack');
});

test('an older shack (no capability) still gets its separate TX on; Stop never turns TX on', () => {
  const old = B.OUT['jtcat-popout-full-auto-cq']([{ on: true, modifier: 'POTA', txOn: true }], { serverCaps: ['jtcat'] });
  assert.deepStrictEqual(old.send, [{ type: 'jtcat-full-auto-cq', on: true, modifier: 'POTA' }, { type: 'jtcat-enable-tx', enabled: true }]);
  const stop = B.OUT['jtcat-popout-full-auto-cq']([{ on: false, modifier: '', txOn: true }], { serverCaps: [B.RUN_TX_ON_CAP] });
  assert.deepStrictEqual(stop.send, [{ type: 'jtcat-full-auto-cq', on: false, modifier: '' }]);
});

test('the shack advertises the capability, the wire registry knows txOn, both handlers use the one request', () => {
  assert.ok(server.includes(`'${B.RUN_TX_ON_CAP}',`));
  assert.strictEqual(MESSAGES['jtcat-full-auto-cq'].fields.txOn.type, 'boolean');
  assert.ok(/await jtcatRequestRunStart\('remote', modifier \|\| '', !!txOn\)/.test(main));
  assert.ok(/jtcatRequestRunStart\('popout', \(payload && payload\.modifier\) \|\| '', !!\(payload && payload\.txOn\)\)/.test(main));
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
