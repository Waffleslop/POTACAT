#!/usr/bin/env node
'use strict';
// TX slot lock for FT8/FT4/FT2 (Casey 2026-10-24). Run: node test/jtcat-tx-slot-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/jtcat-tx-slot');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const P = 15000; // FT8 period

test('lock values: WSJT-X 1st/2nd wording accepted, anything else is Auto', () => {
  assert.strictEqual(S.normalizeLock('1st'), 'even');
  assert.strictEqual(S.normalizeLock('2nd'), 'odd');
  assert.strictEqual(S.normalizeLock('ODD'), 'odd');
  for (const v of [undefined, null, '', 'x', 'auto', 3]) assert.strictEqual(S.normalizeLock(v), 'auto');
  assert.strictEqual(S.slotLabel('even'), '1st (even)');
  assert.strictEqual(S.slotLabel('odd'), '2nd (odd)');
});

test('parity is the same arithmetic for every period length', () => {
  assert.strictEqual(S.slotAt(0, P), 'even');
  assert.strictEqual(S.slotAt(15000, P), 'odd');
  assert.strictEqual(S.slotAt(7500, 7500), 'odd');   // FT4
  assert.strictEqual(S.slotAt(7600, 3800), 'even');  // FT2
});

test('CQ: a lock always wins', () => {
  for (const nowMs of [0, 3000, 14000, 16000]) {
    assert.deepStrictEqual(S.decideCqSlot({ lock: 'odd', nowMs, periodMs: P, lateCapMs: 7000, lastTx: { slot: 'even', at: nowMs } }), { slot: 'odd', why: 'locked' });
  }
});

test('CQ in Auto keeps the slot of our last transmission (WSJT-X: the Tx even box stays put)', () => {
  const now = 10 * 60 * 1000 + 1000; // even slot, 1 s in
  const d = S.decideCqSlot({ lock: 'auto', nowMs: now, periodMs: P, lateCapMs: 7000, lastTx: { slot: 'odd', at: now - 60000 } });
  assert.deepStrictEqual(d, { slot: 'odd', why: 'last-tx' });
});

test('CQ in Auto with no recent transmission takes the soonest reachable boundary', () => {
  const base = 10 * 60 * 1000; // an even boundary
  assert.strictEqual(S.decideCqSlot({ lock: 'auto', nowMs: base + 2000, periodMs: P, lateCapMs: 7000 }).slot, 'even');
  assert.strictEqual(S.decideCqSlot({ lock: 'auto', nowMs: base + 9000, periodMs: P, lateCapMs: 7000 }).slot, 'odd');
  const stale = { slot: 'odd', at: base - S.LAST_TX_FRESH_MS - 1 };
  assert.strictEqual(S.decideCqSlot({ lock: 'auto', nowMs: base + 2000, periodMs: P, lateCapMs: 7000, lastTx: stale }).why, 'soonest');
});

test('reply in Auto: opposite the station, else opposite the last RX slot', () => {
  assert.deepStrictEqual(S.decideReplySlot({ lock: 'auto', theirSlot: 'even' }), { ok: true, slot: 'odd', why: 'opposite' });
  assert.strictEqual(S.decideReplySlot({ lock: 'auto', fallbackSlot: 'odd' }).slot, 'even');
  assert.strictEqual(S.decideReplySlot({ lock: 'auto' }).slot, 'auto');
});

test('reply under a lock: a station in the other slot is called in the lock; one in ours is refused', () => {
  assert.deepStrictEqual(S.decideReplySlot({ lock: 'even', theirSlot: 'odd' }), { ok: true, slot: 'even', why: 'locked' });
  assert.deepStrictEqual(S.decideReplySlot({ lock: 'even', theirSlot: 'even' }), { ok: false, slot: 'even', why: 'same-slot' });
  // the engine's last RX slot is a guess, never grounds for a refusal
  assert.ok(S.decideReplySlot({ lock: 'even', fallbackSlot: 'even' }).ok);
});

test('Hound overrides the lock (the Fox decides), and says so', () => {
  const d = S.decideReplySlot({ lock: 'odd', theirSlot: 'odd', hound: true });
  assert.deepStrictEqual(d, { ok: true, slot: 'even', why: 'hound', override: true });
  assert.strictEqual(S.decideReplySlot({ lock: 'even', theirSlot: 'odd', hound: true }).override, false);
});

test('Hunt/auto-answer: only stations in the other slot are workable under a lock', () => {
  assert.ok(S.workableUnderLock('auto', 'even'));
  assert.ok(S.workableUnderLock('even', 'odd'));
  assert.ok(!S.workableUnderLock('even', 'even'));
  assert.ok(S.workableUnderLock('even', undefined));
  assert.match(S.refusalText('K1ABC', 'odd'), /K1ABC transmits in 2nd \(odd\), the slot you locked/);
});

test('engine: the lock survives every setTxSlot reset, a QSO end, and a mode change', () => {
  const { Ft8Engine } = require('../lib/ft8-engine');
  const e = new Ft8Engine();
  e.setSlotLock('odd');
  assert.strictEqual(e._txSlot, 'odd');
  assert.strictEqual(e.setTxSlot('even'), false);
  assert.strictEqual(e._txSlot, 'odd');
  e.setTxSlot('auto');
  assert.strictEqual(e._txSlot, 'odd');
  assert.strictEqual(e._lockedTxSlot, 'odd');
  e.setTxSlot('even', { override: true }); // Hound
  assert.strictEqual(e._txSlot, 'even');
  e._txMessage = 'X'; e.setTxMessage(''); // QSO over: back to the lock
  assert.strictEqual(e._txSlot, 'odd');
  e.setMode('FT4');
  assert.strictEqual(e._lockedTxSlot, 'odd');
  e.setSlotLock(null);
  assert.strictEqual(e._txSlot, 'auto');
  assert.strictEqual(e._lockedTxSlot, null);
});

test('manager: the lock reaches every slice, including ones started later', () => {
  const JtcatManager = require('../lib/jtcat-manager');
  const M = JtcatManager.JtcatManager || JtcatManager;
  const m = new M();
  const calls = [];
  m._engines.set('a', { engine: { setSlotLock: (l) => calls.push(['a', l]) }, config: {} });
  m.setSlotLock('even');
  assert.deepStrictEqual(calls, [['a', 'even']]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'jtcat-manager.js'), 'utf8');
  assert.ok(/if \(this\._slotLock && typeof engine\.setSlotLock === 'function'\) engine\.setSlotLock\(this\._slotLock\);\s*engine\.start\(\);/.test(src));
});

test('wiring: every CQ and reply in main.js goes through the slot rules', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  // no path picks a slot on its own any more
  assert.ok(!/setTxSlot\(theirSlot === 'even'/.test(main), 'a reply picks its slot by hand');
  assert.ok(!/setTxSlot\(targetSlot === 'even'/.test(main), 'a reply picks its slot by hand');
  assert.ok(!/const nextSlot = ft8Engine\._lastRxSlot/.test(main), 'a CQ takes the opposite of the last decode');
  assert.ok(!/setTxSlot\(msIntoCycle <= lateCap/.test(main), 'Run picks its slot by hand');
  assert.strictEqual((main.match(/jtcatCqSlot\(ft8Engine\)/g) || []).length, 3, 'popout CQ, phone CQ and Run');
  assert.ok(/jtcatReplySlot\(replyEngine, data\.call, data\.slot, \{ hound, source: 'popout'/.test(main));
  assert.ok(/jtcatReplySlot\(targetEngine, call, slot, \{ hound, source: 'remote'/.test(main));
  assert.ok(/jtcatReplySlot\(ft8Engine, best\.call, best\.slot\)/.test(main) && /jtcatReplySlot\(ft8Engine, senderCall, caller\.slot\)/.test(main));
  assert.ok(/if \(!JtcatTxSlot\.workableUnderLock\(jtcatTxSlotLock\(\), d\.slot\)\) return false;/.test(main), 'Hunt filters the locked slot');
  assert.ok(/ipcMain\.on\('jtcat-set-tx-slot', \(_e, slot\) => \{ applyJtcatTxSlotLock\(slot, 'popout'\); \}\);/.test(main));
  assert.ok(/applyJtcatTxSlotLock\(slot, 'remote'\);/.test(main));
  assert.strictEqual((main.match(/jtcatNoteTxSlot\(data\.slot\)/g) || []).length, 2, 'single- and multi-slice tx-start');
  assert.strictEqual((main.match(/jtcatManager\.setSlotLock\(jtcatTxSlotLock\(\)\)/g) || []).length, 2);
  assert.ok(/type: 'jtcat-tx-slot-state', lock: jtcatTxSlotLock\(\)/.test(main), 'hydrated at connect');
});

test('wire: registry, capability, and both clients', () => {
  const proto = require('../lib/echocat-protocol');
  const M = proto.MESSAGES || proto.messages || proto;
  assert.ok(M['jtcat-tx-slot-state'] && M['jtcat-slot-refused'] && M['jtcat-set-tx-slot']);
  const rs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  assert.ok(rs.includes("'tx-slot-lock'") && rs.includes('broadcastJtcatTxSlotState'));
  const web = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8');
  assert.ok(web.includes("case 'jtcat-tx-slot-state'") && web.includes("case 'jtcat-slot-refused'") && web.includes('Unlock and call'));
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'), 'utf8');
  assert.ok(pop.includes('onJtcatTxSlotState') && pop.includes('Unlock and call'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html'), 'utf8');
  assert.ok(html.includes('id="jp-tx-slot"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
