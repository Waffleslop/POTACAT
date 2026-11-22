'use strict';
// Split operation "Fake It" (level_death 2026-11-04): the tone goes out at
// 1500-1999 Hz and the dial moves by the difference for each transmission.
// Rules: lib/jtcat-fake-it.js. Engine: lib/ft8-engine.js renders at the
// shifted audio and reports dialShiftHz. Radio: RigController.setDialNow.
// Wiring: main.js (source guards below).
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');
const FakeIt = require('../lib/jtcat-fake-it');
const { Ft8Engine } = require('../lib/ft8-engine');
const { RigController } = require('../lib/rig-controller');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const ROOT = path.join(__dirname, '..');
const MAIN = readSrc(path.join(ROOT, 'main.js'));

(async () => {
  await test('the shift is WSJT-X\'s rule: (n/500)*500 - 1500, the tone lands in 1500-1999 Hz', () => {
    const cases = [[300, -1500], [499, -1500], [500, -1000], [700, -1000], [1000, -500], [1499, -500],
      [1500, 0], [1750, 0], [1999, 0], [2000, 500], [2499, 500], [2500, 1000], [2900, 1000], [3000, 1500]];
    for (const [n, want] of cases) {
      const got = FakeIt.fakeItShiftHz(n);
      assert.strictEqual(got, want, `${n} Hz -> ${got}, want ${want}`);
      const tone = n - got;
      assert.ok(tone >= 1500 && tone < 2000, `${n} Hz plays at ${tone}`);
    }
    assert.strictEqual(FakeIt.fakeItShiftHz(0), 0);
    assert.strictEqual(FakeIt.fakeItShiftHz(NaN), 0);
  });

  await test('only FT8, FT4 and FT2 shift, and only when switched on', () => {
    assert.strictEqual(FakeIt.shiftFor({ enabled: true, mode: 'FT8', txAudioHz: 700 }), -1000);
    assert.strictEqual(FakeIt.shiftFor({ enabled: true, mode: 'ft4', txAudioHz: 2600 }), 1000);
    assert.strictEqual(FakeIt.shiftFor({ enabled: true, mode: 'FT2', txAudioHz: 400 }), -1500);
    assert.strictEqual(FakeIt.shiftFor({ enabled: false, mode: 'FT8', txAudioHz: 700 }), 0);
    for (const m of ['WSPR', 'PSK31', 'JTTY', 'JS8', '']) {
      assert.strictEqual(FakeIt.shiftFor({ enabled: true, mode: m, txAudioHz: 700 }), 0, m);
    }
  });

  await test('the plan moves the dial by the shift, and needs a dial the radio reported', () => {
    assert.deepStrictEqual(FakeIt.planShift({ shiftHz: -1000, dialHz: 14074000 }), { dialHz: 14074000, txDialHz: 14073000, shiftHz: -1000 });
    assert.strictEqual(FakeIt.planShift({ shiftHz: 0, dialHz: 14074000 }), null);
    assert.strictEqual(FakeIt.planShift({ shiftHz: 500, dialHz: 0 }), null);
    // RF stays put: dial + tone before = shifted dial + played tone.
    const n = 2730; const s = FakeIt.fakeItShiftHz(n);
    const p = FakeIt.planShift({ shiftHz: s, dialHz: 7074000 });
    assert.strictEqual(7074000 + n, p.txDialHz + (n - s));
  });

  await test('a reading at the shifted dial is ours while shifted and after, until another frequency is read', () => {
    const st = { active: true, txDialHz: 14073000, restoredAt: 0 };
    assert.strictEqual(FakeIt.isShiftEcho(14073000, st), true);
    assert.strictEqual(FakeIt.isShiftEcho(7074000, st), true, "nothing is the operator's while shifted");
    const after = { active: false, txDialHz: 14073000, restoredAt: 10000 };
    assert.strictEqual(FakeIt.isShiftEcho(14073000, after), true, 'a late poll answer');
    assert.strictEqual(FakeIt.isShiftEcho(14074000, after), false, 'the restored dial');
    assert.strictEqual(FakeIt.isShiftEcho(14073000, { ...after, settled: true }), false, "after another read, the operator's");
    assert.strictEqual(FakeIt.isShiftEcho(14073000, { active: false, txDialHz: 0 }), false);
  });

  // GitHub #681 (FTDX10 on a Mac): the dial crept 500 Hz per transmission.
  // Run the whole cycle against a model radio: TX shifts from the home dial,
  // the restore goes out, then the radio is read back.
  function cycle(st, homeHz, shiftHz) {
    const plan = FakeIt.planShift({ shiftHz, dialHz: homeHz });
    Object.assign(st, { active: true, dialHz: plan.dialHz, txDialHz: plan.txDialHz, shiftHz, restoredAt: 0, restorePending: false, settled: false, restoreRetries: 0, lastRetryAt: 0 });
    return plan;
  }
  function read(st, hz, now) {
    const r = FakeIt.onDialRead(hz, st, now);
    if (r.patch) Object.assign(st, r.patch);
    return r;
  }

  await test('#681: a late read of the shifted dial, however late, never becomes the dial', () => {
    const st = {};
    let home = 14074000;
    for (let i = 0; i < 8; i++) {
      const plan = cycle(st, home, 500);
      assert.strictEqual(plan.txDialHz, 14074500, `cycle ${i} shifts from the operator's dial`);
      st.active = false; st.restoredAt = 100000 * (i + 1);            // the restore went out
      const r = read(st, plan.txDialHz, st.restoredAt + 9000 + i * 5000);   // 9 s and later: the old window was 3 s
      assert.strictEqual(r.echo, true, `cycle ${i}: late read dropped`);
      assert.strictEqual(r.action, 'restore', 'and the dial is sent back again');
      const ok = read(st, 14074000, st.restoredAt + 20000 + i * 5000);
      assert.strictEqual(ok.echo, false, "the restored dial is the operator's");
      assert.strictEqual(st.settled, true);
      home = 14074000;                                            // what _currentFreqHz holds: only accepted reads
    }
  });

  await test('#681: a restore the radio dropped is sent again, at most three times, then the read is accepted', () => {
    const st = {};
    const plan = cycle(st, 7074000, -1000);
    st.active = false; st.restoredAt = 1000;
    const acts = [];
    for (let t = 1500; t <= 9000; t += 500) {
      const r = read(st, plan.txDialHz, t);
      acts.push(r.echo ? (r.action || 'echo') : r.action);
      if (!r.echo) break;
    }
    assert.deepStrictEqual(acts.filter(a => a === 'restore').length, FakeIt.RESTORE_RETRIES, acts.join(','));
    assert.strictEqual(acts[acts.length - 1], 'accept', acts.join(','));
    // Retries are at least a second apart.
    assert.deepStrictEqual(acts.slice(0, 4), ['restore', 'echo', 'restore', 'echo']);
    assert.strictEqual(st.settled, true);
    assert.strictEqual(FakeIt.onDialRead(plan.txDialHz, st, 20000).echo, false, "settled: the operator's");
  });

  await test('#681: the operator turning the knob after a transmission is never held back', () => {
    const st = {};
    const plan = cycle(st, 14074000, 500);
    st.active = false; st.restoredAt = 1000;
    const r = read(st, 14080000, 1200);
    assert.deepStrictEqual([r.echo, r.action], [false, null]);
    assert.strictEqual(st.settled, true);
    // A stale read of the shifted dial after the knob is no longer ours to drop or undo.
    const late = read(st, plan.txDialHz, 9000);
    assert.deepStrictEqual([late.echo, late.action], [false, null]);
    // During TX everything is ours; with the link down the restore waits, no re-send.
    cycle(st, 14074000, 500);
    assert.strictEqual(read(st, 14080000, 1).echo, true);
    st.active = false; st.restorePending = true;
    assert.deepStrictEqual(FakeIt.onDialRead(14074500, st, 5000), { echo: true, action: null, patch: null });
    assert.deepStrictEqual(FakeIt.onDialRead(14074000, {}, 5000), { echo: false, action: null, patch: null });
  });

  await test('the engine renders the tone at the shifted audio and reports the dial shift on tx-start', async () => {
    const eng = new Ft8Engine();
    eng._running = true; eng._workerReady = true; eng._mode = 'FT8';
    const asked = [];
    eng.encodeMessage = async (text, freq) => { asked.push(freq); return new Float32Array(1000); };
    eng._txMessage = 'CQ K3SBP FN20';
    eng._txFreq = 700;
    eng.setFakeIt(true);
    await (eng._preEncodePromise || Promise.resolve());
    assert.strictEqual(asked[asked.length - 1], 1700, 'tone rendered at 1700 Hz, asked ' + asked.join(','));
    assert.strictEqual(eng._txEncodedShift, -1000);
    assert.strictEqual(eng._txEncodedFreq, 700, 'the TX offset the operator set is unchanged');
    // Moving the offset re-renders; the shift follows it.
    eng.setTxFreq(2600, { operator: true });
    await (eng._preEncodePromise || Promise.resolve());
    assert.strictEqual(asked[asked.length - 1], 1600);
    assert.strictEqual(eng._txEncodedShift, 1000);
    // tx-start carries it.
    let payload = null;
    eng.on('tx-start', (d) => { payload = d; });
    eng._txEnabled = true;
    eng._mode = 'FT2'; // FT2 fires without a slot; same payload shape
    eng._lastTxCycleNum = -1;
    eng._onTxBoundary();
    if (eng._txEndTimer) clearTimeout(eng._txEndTimer);
    assert.ok(payload, 'tx-start fired');
    assert.strictEqual(payload.dialShiftHz, 1000);
    assert.strictEqual(payload.freq, 2600);
    // Off again: rendered at the offset itself, no shift.
    eng._txActive = false; eng._mode = 'FT8';
    eng.setFakeIt(false);
    await (eng._preEncodePromise || Promise.resolve());
    assert.strictEqual(asked[asked.length - 1], 2600);
    assert.strictEqual(eng._txEncodedShift, 0);
  });

  await test('audio rendered for one shift is never sent under another', async () => {
    const eng = new Ft8Engine();
    eng._running = true; eng._workerReady = true; eng._mode = 'FT8';
    eng.encodeMessage = async () => new Float32Array(1000);
    eng._txMessage = 'CQ K3SBP FN20'; eng._txFreq = 700;
    await eng._preEncode();
    assert.strictEqual(eng._txEncodedShift, 0);
    eng._fakeIt = true; // flipped without re-rendering
    eng._txEnabled = true;
    assert.strictEqual(eng.tryImmediateTx(), false, 'stale shift refuses the immediate TX');
  });

  await test('RigController.setDialNow writes the frequency at once, ahead of a key-down sent after it', () => {
    const writes = [];
    const transport = new EventEmitter();
    transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => true;
    const codec = new Proxy({
      setFrequency: (hz) => writes.push('F' + hz),
      setTransmit: (on) => writes.push(on ? 'TX' : 'RX'),
    }, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^(set|get|poll|parse|resolve|mode|on|emit)/.test(k) ? () => {} : undefined)) });
    const rig = new RigController({ caps: {} }, transport, codec);
    rig.connected = true;
    assert.strictEqual(rig.setDialNow(14073000, { resumeMs: -1 }), true);
    rig.setTransmit(true);
    rig.setTransmit(false);
    assert.strictEqual(rig.setDialNow(14074000, { resumeMs: -1 }), true);
    assert.deepStrictEqual(writes, ['F14073000', 'TX', 'RX', 'F14074000']);
    rig.connected = false;
    assert.strictEqual(rig.setDialNow(14074000), false);
  });

  await test('main.js: the dial moves before the FT8 key-down and back after the key-up', () => {
    const start = MAIN.indexOf("ft8Engine.on('tx-start', (data) => {\n    // Radio-owner arbiter");
    assert.ok(start > 0, 'single-band tx-start handler');
    const body = MAIN.slice(start, MAIN.indexOf("ft8Engine.on('tx-end'", start));
    const shift = body.indexOf('fakeItShiftForTx(data)');
    const key = body.indexOf("handleRemotePtt(true, { audio: true, emission: 'DATA'");
    assert.ok(shift > 0 && key > shift, 'shift before the key-down');
    assert.ok(body.indexOf('jtcatTxWatchdogTripped') < shift && body.indexOf('ownTxPrivilegeRefused') < shift, 'after every refusal');
    const endAt = MAIN.indexOf("ft8Engine.on('tx-end', () => {");
    const end = MAIN.slice(endAt, endAt + 1500);
    assert.ok(end.indexOf("fakeItRestoreDial('end of transmission')") > end.indexOf('handleRemotePtt(false)'), 'restore after the key-up');
    assert.ok(/if \(!state && _fakeIt\.active\) fakeItRestoreDial\('key-up'\)/.test(MAIN), 'every other key-up restores too');
    assert.ok(/_fakeIt\.restorePending\) setImmediate\(\(\) => fakeItRestoreDial\('the radio link is back'\)\)/.test(MAIN), 'a dropped link restores on return');
  });

  await test('main.js: the shifted dial never reaches the displays, log or JTCAT anchor', () => {
    const h = MAIN.slice(MAIN.indexOf('function catFrequencyHandler(hz) {'));
    assert.ok(/^function catFrequencyHandler\(hz\) \{\n[^\n]*\n  if \(fakeItIsEcho\(hz\)\) return;/.test(h), 'CAT reads');
    assert.ok(/smartSdr\.on\('frequency', \(hz\) => \{\n    if \(fakeItIsEcho\(hz\)\) return;/.test(MAIN), 'Flex slice reads, before rememberFlexSlice');
    assert.ok(/ft8Engine\.setFakeIt\(fakeItEnabled\(\) && !multi && !isRemoteMode\(\) && !noCat\)/.test(MAIN), 'one band, CAT, not a remote laptop');
    assert.ok(/fakeItSyncEngine\(\); \/\/ split operation/.test(MAIN), 'armed at engine start');
    assert.ok(/'jtcatFakeIt' in newSettings\) setImmediate\(\(\) => \{ fakeItSyncEngine\(\)/.test(MAIN), 'follows the window toggle');
    assert.ok(/if \(key === 'jtcatFakeIt'\) \{\s+fakeItSyncEngine\(\);\s+updateRemoteSettings\(\);/.test(MAIN), 'follows a remote window or device, and tells every device');
    assert.ok(/jtcatFakeIt: settings\.jtcatFakeIt === true,/.test(MAIN), 'devices read it at connect');
  });

  await test('the FT8 window has the toggle and a remote window\'s choice reaches the shack', () => {
    const html = readSrc(path.join(ROOT, 'renderer/jtcat-popout.html'));
    const js = readSrc(path.join(ROOT, 'renderer/jtcat-popout.js'));
    assert.ok(html.includes('id="jp-fake-it"'));
    assert.ok(js.includes("window.api.saveSettings({ jtcatFakeIt: fakeIt })"));
    assert.ok(js.includes('fakeIt = s.jtcatFakeIt === true;'));
    const RemoteBridge = require('../lib/remote-bridge');
    assert.strictEqual(RemoteBridge.acceptPref('jtcatFakeIt', true), true);
  });

  console.log(`\njtcat-fake-it: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
