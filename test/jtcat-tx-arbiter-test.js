#!/usr/bin/env node
'use strict';
// Which JTCAT slice transmits (lib/jtcat-manager.js requestTx / releaseTx /
// scheduleTx / setTxSlice) and what main posts to the modem audio lane to key
// and end an over (lib/modem-audio-lane-client.js key / endOver / cancelEnd).
// Engines are stand-ins (no decoder, no audio); the lane process is a fake.
// Run: node test/jtcat-tx-arbiter-test.js
const assert = require('assert');
const { EventEmitter } = require('events');
const { JtcatManager } = require('../lib/jtcat-manager');
const { ModemAudioLane } = require('../lib/modem-audio-lane-client');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + ((e && e.stack) || e)); } };

function mgr(slices) {
  const m = new JtcatManager();
  for (const [id, { tx = true, msg = 'CQ K3SBP FN20' } = {}] of Object.entries(slices)) {
    const engine = new EventEmitter();
    engine._txEnabled = tx; engine._txMessage = msg;
    m._engines.set(id, { engine, config: { sliceId: id } });
  }
  return m;
}
const qso = (phase) => ({ phase });

// ---- requestTx / releaseTx ----
t('requestTx queues a slice once; releaseTx removes it', () => {
  const m = mgr({ A: {}, B: {} });
  m.requestTx('A'); m.requestTx('A'); m.requestTx('B');
  assert.deepStrictEqual(m._txQueue, ['A', 'B']);
  m.releaseTx('A');
  assert.deepStrictEqual(m._txQueue, ['B']);
});

t('releaseTx of the slice that holds TX frees the TX slot; releasing another slice does not', () => {
  const m = mgr({ A: {}, B: {} });
  m.requestTx('A'); m.requestTx('B');
  m.scheduleTx();
  assert.strictEqual(m._txSlice, 'A');
  m.releaseTx('B');
  assert.strictEqual(m._txSlice, 'A');
  m.releaseTx('A');
  assert.strictEqual(m._txSlice, null);
});

// ---- scheduleTx ----
t('nothing queued: no slice transmits', () => {
  const m = mgr({ A: {} });
  assert.strictEqual(m.scheduleTx(), null);
  assert.strictEqual(m._txSlice, null);
});

t('a queued slice with TX off or no message is never picked', () => {
  const m = mgr({ A: { tx: false }, B: { msg: '' } });
  m.requestTx('A'); m.requestTx('B');
  assert.strictEqual(m.scheduleTx(), null);
});

t('a queued slice that has no engine (stopped) is skipped, not thrown on', () => {
  const m = mgr({ A: {} });
  m.requestTx('GONE'); m.requestTx('A');
  assert.strictEqual(m.scheduleTx(), 'A');
});

t('a manual CQ (TX on, message, no QSO state) has priority 1 and wins', () => {
  const m = mgr({ A: {} });
  m.requestTx('A');
  const sw = []; m.on('tx-switch', (e) => sw.push(e));
  assert.strictEqual(m.scheduleTx(), 'A');
  assert.deepStrictEqual(sw, [{ sliceId: 'A', priority: 1 }]);
});

t('priority: mid-QSO exchange (3) beats reply/73 (2) beats CQ (1) beats idle', () => {
  assert.strictEqual(JtcatManager._txPriority(null), 0);
  assert.strictEqual(JtcatManager._txPriority(qso('idle')), 0);
  assert.strictEqual(JtcatManager._txPriority(qso('cq')), 1);
  assert.strictEqual(JtcatManager._txPriority(qso('reply')), 2);
  assert.strictEqual(JtcatManager._txPriority(qso('73')), 2);
  for (const p of ['r+report', 'cq-rr73', 'cq-report', 'cq-r-report']) assert.strictEqual(JtcatManager._txPriority(qso(p)), 3, p);
});

t('two slices: the one mid-QSO transmits, the CQ slice is switched off', () => {
  const m = mgr({ A: {}, B: {} });
  m.requestTx('A'); m.requestTx('B');
  m._qsoState.set('A', { popout: qso('cq'), remote: null });
  m._qsoState.set('B', { popout: null, remote: qso('r+report') });
  assert.strictEqual(m.scheduleTx(), 'B');
  assert.strictEqual(m._txSlice, 'B');
  assert.strictEqual(m.getEngine('A')._txEnabled, false, 'the losing slice is not left able to key');
  assert.strictEqual(m.getEngine('B')._txEnabled, true);
});

t('the higher of the popout and remote owners counts', () => {
  const m = mgr({ A: {}, B: {} });
  m.requestTx('A'); m.requestTx('B');
  m._qsoState.set('A', { popout: qso('cq'), remote: qso('reply') }); // 2
  m._qsoState.set('B', { popout: qso('cq'), remote: null });         // 1
  assert.strictEqual(m.scheduleTx(), 'A');
});

t('equal priority: the first requested keeps it (queue order)', () => {
  const m = mgr({ A: {}, B: {} });
  m.requestTx('A'); m.requestTx('B');
  assert.strictEqual(m.scheduleTx(), 'A');
  const m2 = mgr({ A: {}, B: {} });
  m2.requestTx('B'); m2.requestTx('A');
  assert.strictEqual(m2.scheduleTx(), 'B');
});

t('scheduleTx does not announce a switch when the winner already holds TX', () => {
  const m = mgr({ A: {} });
  m.requestTx('A');
  let n = 0; m.on('tx-switch', () => n++);
  m.scheduleTx(); m.scheduleTx();
  assert.strictEqual(n, 1);
});

t('a slice mid-QSO takes TX over from a CQ slice at the next cycle, once its engine has TX enabled again', () => {
  const m = mgr({ A: {}, B: {} });
  m.requestTx('A');
  assert.strictEqual(m.scheduleTx(), 'A');
  m.requestTx('B');
  m._qsoState.set('B', { popout: qso('r+report'), remote: null });
  m.getEngine('B')._txEnabled = true; // what the QSO start does on the engine
  assert.strictEqual(m.scheduleTx(), 'B');
  assert.strictEqual(m._txSlice, 'B');
});

t('DOCUMENTED: a slice that lost an earlier arbitration was switched off by setTxSlice and is not picked later until something re-enables its engine', () => {
  const m = mgr({ A: {}, B: {} });
  m.requestTx('A');
  m.scheduleTx();                       // A wins, B's engine is switched off
  m.requestTx('B');
  m._qsoState.set('B', { popout: qso('r+report'), remote: null });
  assert.strictEqual(m.scheduleTx(), 'A', 'B has priority 3 but its _txEnabled is false, so A keeps TX');
});

t('setTxSlice names the slice that owns TX (txEngine) and disables TX on every other engine', () => {
  const m = mgr({ A: {}, B: {}, C: {} });
  m.setTxSlice('B');
  assert.strictEqual(m.txEngine, m.getEngine('B'));
  assert.strictEqual(m.getEngine('A')._txEnabled, false);
  assert.strictEqual(m.getEngine('C')._txEnabled, false);
  assert.strictEqual(m.getEngine('B')._txEnabled, true);
});

t('stopSlice of the TX slice frees TX and drops its queue-visible state', () => {
  const m = mgr({ A: {}, B: {} });
  m.getEngine('A').stop = () => {};
  m.requestTx('A'); m.scheduleTx();
  m._qsoState.set('A', { popout: qso('cq'), remote: null });
  m.stopSlice('A');
  assert.strictEqual(m._txSlice, null);
  assert.strictEqual(m.getEngine('A'), null);
  assert.strictEqual(m._qsoState.has('A'), false);
});

t('DOCUMENTED: stopSlice leaves the slice in _txQueue (releaseTx must be called separately); scheduleTx skips it as engineless', () => {
  const m = mgr({ A: {} });
  m.getEngine('A').stop = () => {};
  m.requestTx('A');
  m.stopSlice('A');
  assert.deepStrictEqual(m._txQueue, ['A']);
  assert.strictEqual(m.scheduleTx(), null);
});

t('DOCUMENTED: releaseTx never turns the other slices\' TX back on (setTxSlice disabled them and nothing re-enables)', () => {
  const m = mgr({ A: {}, B: {} });
  m.requestTx('A'); m.requestTx('B');
  m._qsoState.set('B', { popout: qso('r+report'), remote: null });
  m.scheduleTx();                       // B wins, A switched off
  m.releaseTx('B');
  assert.strictEqual(m.getEngine('A')._txEnabled, false);
});

// ---- ModemAudioLane client: key / endOver / cancelEnd ----
function lane() {
  const posts = [];
  const proc = new EventEmitter();
  proc.postMessage = (msg) => posts.push(msg);
  const electron = { utilityProcess: { fork: () => proc }, MessageChannelMain: class {} };
  const l = new ModemAudioLane({ electron });
  l.proc = proc;
  return { l, posts, proc };
}

t('key(true/false) posts a key command with the boolean, seed gain and bridge flag', () => {
  const { l, posts } = lane();
  l.key(true, { seedGain: 0.4, bridge: true });
  l.key(false);
  l.key(1);
  assert.deepStrictEqual(posts, [
    { cmd: 'key', on: true, seedGain: 0.4, bridge: true },
    { cmd: 'key', on: false, seedGain: undefined, bridge: undefined },
    { cmd: 'key', on: true, seedGain: undefined, bridge: undefined },
  ]);
});

t('endOver posts end-over with leaveMs (default 0); cancelEnd posts cancel-end', () => {
  const { l, posts } = lane();
  l.endOver(); l.endOver({ leaveMs: 400 }); l.cancelEnd();
  assert.deepStrictEqual(posts, [
    { cmd: 'end-over', leaveMs: 0 },
    { cmd: 'end-over', leaveMs: 400 },
    { cmd: 'cancel-end' },
  ]);
});

t('with no lane process every control call is a silent no-op (never throws)', () => {
  const l = new ModemAudioLane({ electron: { utilityProcess: {}, MessageChannelMain: class {} } });
  l.key(true); l.endOver(); l.cancelEnd(); l.txLevelReset(0.5);
});

t('a postMessage that throws is swallowed', () => {
  const { l, proc } = lane();
  proc.postMessage = () => { throw new Error('channel closed'); };
  l.key(false); l.endOver(); l.cancelEnd();
});

t('the lane\'s drained report reaches main as a drained event; modem-gone clears connected', () => {
  const { l } = lane();
  const ev = [];
  l.on('drained', (d) => ev.push(['drained', d]));
  l._onMsg({ evt: 'modem-connected' });
  assert.strictEqual(l.connected, true);
  l._onMsg({ evt: 'drained', data: { ms: 12 } });
  l._onMsg({ evt: 'modem-gone' });
  assert.strictEqual(l.connected, false);
  assert.deepStrictEqual(ev, [['drained', { ms: 12 }]]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
