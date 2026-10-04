#!/usr/bin/env node
'use strict';
/**
 * JttyEngine (lib/jtty-engine.js) — Phase 3 of docs/jtty-integration-plan.md.
 *
 * The rule worth protecting: the whole station loop closes inside the engine
 * — text in, one tx-start of audio out, that audio fed back as RX, the
 * message re-assembled on 'jtty-rx' — on BOTH decoder hosts (inline for
 * tests, the worker thread the app uses). And the transmitter never alters
 * meaning: text the grammar cannot carry is refused with 'encode-failed'.
 *
 * Plus static guards on the main.js / jtcat-manager / preload wiring, the
 * precedent being test/js8call-main-wiring-test.js.
 *
 * Run: node test/jtty-engine-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JttyEngine, validateMessage, PROFILES, TX_MAX_SEC } = require('../lib/jtty-engine');
const { JtcatManager } = require('../lib/jtcat-manager');

let pass = 0, fail = 0;
const failures = [];
function report(name, err) {
  if (err) { fail++; failures.push(name + ': ' + (err.stack || err.message || err)); console.log('  FAIL ' + name + '\n       ' + (err.message || err).split('\n')[0]); }
  else { pass++; console.log('  ok  ' + name); }
}
async function test(name, fn) {
  try { await fn(); report(name); } catch (e) { report(name, e); }
}
function waitFor(emitter, event, timeoutMs, filter) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.removeListener(event, on); reject(new Error(`timeout waiting for '${event}'`)); }, timeoutMs);
    function on(data) {
      if (filter && !filter(data)) return;
      clearTimeout(timer); emitter.removeListener(event, on); resolve(data);
    }
    emitter.on(event, on);
  });
}
/** Lead/tail silence around a TX buffer at a modest level, as the rig would hand it back. */
function onAir(pcm, leadSec, tailSec) {
  const lead = Math.round(leadSec * 12000), tail = Math.round(tailSec * 12000);
  const out = new Float32Array(lead + pcm.length + tail);
  for (let i = 0; i < pcm.length; i++) out[lead + i] = 0.3 * pcm[i];
  return out;
}

(async () => {
  console.log('JTTY engine');

  await test('validateMessage: the composer and the transmitter share one verdict', () => {
    const ok = validateMessage('CQ K1ABC CQ', 'unknown');
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.strictEqual(ok.nframes, 1);
    assert.ok(Math.abs(ok.durationSec - 1.888) < 0.01, 'duration ' + ok.durationSec);
    assert.deepStrictEqual(validateMessage('', 'unknown'), { ok: false, reason: 'Empty message' });
    assert.deepStrictEqual(validateMessage('   ', 'unknown'), { ok: false, reason: 'Empty message' });
    // The 64-char alphabet covers braces and friends; what the grammar cannot
    // carry is LENGTH. The reference packer silently truncates to 80
    // characters (WSJT-X's text box holds no more) — here that is a refusal,
    // never a trim, because a composer that accepts more must not send half.
    assert.ok(validateMessage('CQ K1ABC {}', 'unknown').ok, 'braces are in the alphabet');
    assert.ok(validateMessage('A'.repeat(80), 'unknown').ok, '80 characters fit');
    const long = validateMessage('A'.repeat(81), 'unknown');
    assert.strictEqual(long.ok, false, 'an 81st character is refused, not trimmed');
    assert.ok(/at most 80/.test(long.reason), long.reason);
    assert.ok(validateMessage('  CQ   K1ABC  CQ  ', 'unknown').ok, 'whitespace is squeezed before counting');
    assert.ok(TX_MAX_SEC <= 125, 'cap sits under the 130 s PTT failsafe');
  });

  await test('inline loopback: text -> one tx-start -> fed back -> the same text on jtty-rx', async () => {
    const tx = new JttyEngine({ worker: false });
    tx.start();
    tx._txEnabled = true;
    const samples = await tx.setTxMessage('TU NOW JA6DEF 599 102');
    assert.ok(samples instanceof Float32Array && samples.length > 0, 'rendered');
    let started = null;
    tx.on('tx-start', (d) => { started = d; });
    assert.strictEqual(tx.requestTx(), true);
    assert.ok(started, 'tx-start emitted');
    assert.strictEqual(started.slot, '--');
    assert.strictEqual(started.offsetMs, 0);
    assert.strictEqual(started.freq, 1500);
    assert.strictEqual(started.message, 'TU NOW JA6DEF 599 102');
    assert.ok(started.nframes >= 2, 'multi-frame: ' + started.nframes);
    assert.strictEqual(tx._txActive, true);
    assert.strictEqual(tx.requestTx(), false, 'no double key');
    tx.txComplete();
    assert.strictEqual(tx._txActive, false);
    tx.stop();

    const rx = new JttyEngine({ worker: false });
    const seen = [];
    rx.on('jtty-rx', (d) => seen.push(d));
    rx.start();
    const air = onAir(started.samples, 0.8, 2.5);
    for (let i = 0; i < air.length; i += 4800) rx.feedAudio(air.subarray(i, Math.min(i + 4800, air.length)));
    rx.feedAudio(new Float32Array(28320)); // let the tail be searched
    rx.stop();
    const complete = seen.filter((d) => d.complete);
    assert.strictEqual(complete.length, 1, JSON.stringify(seen));
    assert.strictEqual(complete[0].text, 'TU NOW JA6DEF 599 102');
    assert.strictEqual(complete[0].mode, 'JTTY');
    assert.ok(Math.abs(complete[0].freqHz - 1500) < 2, 'freq ' + complete[0].freqHz);
    assert.ok(seen.some((d) => !d.complete), 'a partial update arrived before the EOM (the operator sees text arriving)');
    assert.ok(typeof complete[0].utcMs === 'number' && complete[0].utcMs > Date.now() - 60000, 'utc stamp');
    assert.ok(Math.abs((complete[0].utcMs - rx._streamStartMs) / 1000 - 0.8) < 0.1, 'utc = stream start + tStart');
  });

  await test('worker loopback: the app\'s decoder thread decodes, and the caller\'s buffer is never detached', async () => {
    const tx = new JttyEngine({ worker: false });
    tx.start(); tx._txEnabled = true;
    await tx.setTxMessage('CQ K1ABC CQ');
    let started = null; tx.on('tx-start', (d) => { started = d; });
    tx.requestTx(); tx.txComplete(); tx.stop();

    const rx = new JttyEngine();
    rx.start();
    assert.ok(rx._worker, 'worker spawned');
    const done = waitFor(rx, 'jtty-rx', 30000, (d) => d.complete);
    // Audio before the thread reports ready is dropped by design; wait for it.
    const t0 = Date.now();
    while (!rx._workerReady && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(rx._workerReady, 'worker ready');
    const air = onAir(started.samples, 0.6, 2.5);
    const chunk = air.subarray(0, 4800);
    rx.feedAudio(chunk);
    assert.strictEqual(chunk.length, 4800, 'the caller still owns its buffer');
    for (let i = 4800; i < air.length; i += 4800) rx.feedAudio(air.subarray(i, Math.min(i + 4800, air.length)));
    rx.feedAudio(new Float32Array(28320));
    const d = await done;
    rx.stop();
    assert.strictEqual(rx._worker, null, 'stop terminates the thread');
    assert.strictEqual(d.text, 'CQ K1ABC CQ');
  });

  await test('during our own transmission the receiver hears silence, and the clock keeps running', () => {
    const tx = new JttyEngine({ worker: false });
    tx.start(); tx._txEnabled = true;
    tx.setTxMessage('WB9XYZ 599 123');
    let started = null; tx.on('tx-start', (d) => { started = d; });
    tx.requestTx();
    // Now keyed. Feed the very signal we are sending — a loopback echo.
    const seen = [];
    tx.on('jtty-rx', (d) => seen.push(d));
    const air = onAir(started.samples, 0.5, 2.5);
    const before = tx._samplesFed;
    for (let i = 0; i < air.length; i += 4800) tx.feedAudio(air.subarray(i, Math.min(i + 4800, air.length)));
    tx.feedAudio(new Float32Array(28320));
    assert.strictEqual(tx._samplesFed - before, air.length + 28320, 'stream clock advanced by every sample');
    assert.strictEqual(seen.length, 0, 'own echo not decoded: ' + JSON.stringify(seen));
    tx.txComplete();
    tx.stop();
  });

  await test('a refused message emits encode-failed, renders nothing, and never keys', async () => {
    const e = new JttyEngine({ worker: false });
    e.start(); e._txEnabled = true;
    const refusals = [];
    e.on('encode-failed', (d) => refusals.push(d));
    const essay = Array.from({ length: 60 }, (_, i) => 'WORD' + i).join(' ');
    const r = await e.setTxMessage(essay);
    assert.strictEqual(r === null, true, 'refused: no samples');
    assert.strictEqual(refusals.length, 1, JSON.stringify(refusals));
    assert.strictEqual(refusals[0].mode, 'JTTY');
    assert.strictEqual(refusals[0].message, essay);
    assert.ok(refusals[0].reason, 'reason given');
    assert.strictEqual(e.requestTx(), false, 'nothing to key');
    assert.strictEqual(e._txActive, false);
    // Fixing the text clears it.
    const ok = await e.setTxMessage('HELLO WORLD');
    assert.ok(ok instanceof Float32Array, 'renders once valid');
    assert.strictEqual(e.requestTx(), true);
    e.txComplete(); e.stop();
  });

  await test('frequency and profile changes re-render a pending message, so requestTx is never stale', async () => {
    const e = new JttyEngine({ worker: false, profile: 'rtty-roundup' });
    assert.strictEqual(e.profile, 'rtty-roundup');
    e.start(); e._txEnabled = true;
    await e.setTxMessage('K1ABC 599 MA');
    e.setTxFreq(2210);
    assert.strictEqual(e._txFreq, 2210);
    assert.strictEqual(e._rxFreq, 2210, 'transceive');
    assert.strictEqual(e._inline.qsoFreq, 2210, 'the decoder window follows');
    e.setProfile('field-day');
    assert.strictEqual(e.profile, 'field-day');
    let started = null; e.on('tx-start', (d) => { started = d; });
    assert.strictEqual(e.requestTx(), true, 'rendered at the new freq and profile');
    assert.strictEqual(started.freq, 2210);
    e.txComplete();
    e.setTxFreq(50);
    assert.strictEqual(e._txFreq, 200, 'clamped to the receiver\'s band');
    e.setTxFreq(9000);
    assert.strictEqual(e._txFreq, 2700, 'clamped so the 127 Hz signal stays under 2800');
    e.setProfile('nonsense');
    assert.strictEqual(e.profile, 'unknown', 'unknown profile names fall back to unknown');
    e.stop();
    assert.deepStrictEqual(PROFILES, ['unknown', 'field-day', 'rtty-roundup']);
  });

  await test('a per-message profile packs a native template\'s serial exchange without moving the operator\'s profile', async () => {
    const e = new JttyEngine({ worker: false });
    e.start(); e._txEnabled = true;
    assert.strictEqual(e.profile, 'unknown');
    await e.setTxMessage('K1ABC 599 001');
    const plain = e._txRenderedFrames;
    await e.setTxMessage('K1ABC 599 001', { profile: 'rtty-roundup' });
    assert.strictEqual(e.profile, 'unknown', 'the operator\'s profile is untouched');
    assert.ok(e._txRenderedFrames < plain, `serial exchange is shorter: ${e._txRenderedFrames} vs ${plain}`);
    let started = null; e.on('tx-start', (d) => { started = d; });
    assert.strictEqual(e.requestTx(), true, 'rendered under the override is not stale');
    assert.strictEqual(started.nframes, e._txRenderedFrames);
    e.txComplete();
    // A later plain setTxMessage drops the override.
    await e.setTxMessage('K1ABC 599 001');
    assert.strictEqual(e._txRenderedFrames, plain);
    assert.strictEqual(validateMessage('K1ABC 599 001', 'rtty-roundup').nframes, e.validate('K1ABC 599 001', 'rtty-roundup').nframes);
    e.stop();
  });

  await test('Ft8Engine-contract surface: every method main.js calls unconditionally exists', () => {
    const e = new JttyEngine({ worker: false });
    for (const m of ['start', 'stop', 'feedAudio', 'setTxFreq', 'setRxFreq', 'setTxMessage', 'requestTx', 'txComplete',
      'tryImmediateTx', 'setMode', 'setTxSlot', 'setHoldTxFreq', 'setLateStartTx', 'setApContext', 'setAudioLatencyMs',
      'setAudioLatencyAuto', 'seedAudioLatencyMs', 'setWsprDial', 'setSquelch', 'reBaseline', 'encodeMessage', 'renderMessage', 'validate']) {
      assert.strictEqual(typeof e[m], 'function', m);
    }
    for (const f of ['_running', '_txEnabled', '_txActive', '_txFreq', '_mode', '_txMessage']) assert.ok(f in e, f);
    assert.strictEqual(e._mode, 'JTTY');
    e.setMode('FT8');
    assert.strictEqual(e._mode, 'JTTY', 'single-mode: setMode never coerces');
  });

  await test('JtcatManager.startSlice({mode:"JTTY"}) builds a JttyEngine with the profile and forwards jtty-rx', async () => {
    const mgr = new JtcatManager();
    const eng = mgr.startSlice({ sliceId: 'default', mode: 'JTTY', jttyProfile: 'field-day' });
    try {
      assert.ok(eng instanceof JttyEngine, 'engine class');
      assert.strictEqual(eng.profile, 'field-day');
      assert.strictEqual(mgr.engine, eng);
      const got = waitFor(mgr, 'jtty-rx', 1000);
      eng.emit('jtty-rx', { id: 1, text: 'X', complete: true });
      const d = await got;
      assert.strictEqual(d.sliceId, 'default');
      assert.strictEqual(d.text, 'X');
      const failed = waitFor(mgr, 'encode-failed', 1000);
      eng.emit('encode-failed', { mode: 'JTTY', message: 'm', reason: 'r' });
      assert.strictEqual((await failed).reason, 'r');
    } finally {
      mgr.stopAll();
    }
    assert.strictEqual(eng._worker, null, 'stopSlice terminated the decoder thread');
  });

  await test('main.js / preload / manager wiring (static)', () => {
    const root = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const mgr = fs.readFileSync(path.join(root, 'lib', 'jtcat-manager.js'), 'utf8');
    const pre = fs.readFileSync(path.join(root, 'preload-jtcat-popout.js'), 'utf8');
    // Both family switches rebuild the slice for JTTY (Ft8Engine.setMode coerces unknown modes to FT8).
    const fam = main.match(/const familyOf = \(m\) => \(([^\n]+)\);/g) || [];
    assert.ok(fam.length >= 2, 'two familyOf sites: ' + fam.length);
    for (const f of fam) assert.ok(f.includes("m === 'JTTY' ? 'jtty'"), 'familyOf knows JTTY: ' + f);
    assert.ok(main.includes("ft8Engine.removeAllListeners('jtty-rx');"), 'stale jtty-rx listeners are swept per startJtcat');
    assert.ok(main.includes("ft8Engine.on('jtty-rx',"), 'jtty-rx is consumed');
    assert.ok(main.includes("jttyProfile: settings.jttyProfile || 'unknown'"), 'startSlice carries the profile');
    assert.ok(main.includes("ipcMain.on('jtcat-jtty-send'"), 'Send IPC');
    assert.ok(main.includes("ipcMain.on('jtcat-jtty-set-profile'"), 'profile IPC');
    assert.ok(main.includes("if (mode === 'JTTY') {") && main.includes('_jttyEngineMod.validateMessage('), 'validate-tx-msg has a JTTY branch on the shared validator');
    assert.ok(main.includes("webContents.send('jtcat-jtty-rx'"), 'updates reach the popout');
    // Rig-mode mapping: everywhere PSK counts as a USB data mode, JTTY does too.
    const pskSites = (main.match(/startsWith\('PSK'\)/g) || []).length;
    const jttySites = (main.match(/=== 'JTTY'\)/g) || []).length + (main.match(/=== 'JTTY';/g) || []).length;
    assert.ok(jttySites >= pskSites, `JTTY appears beside every startsWith('PSK') mapping (${jttySites} vs ${pskSites})`);
    assert.ok(mgr.includes("config.mode === 'JTTY'") && mgr.includes('new JttyEngine({ profile: config.jttyProfile })'), 'manager branch');
    assert.ok(/'js8-tx-done', 'jtty-rx', 'encode-failed'/.test(mgr), 'manager forwards jtty-rx');
    for (const k of ['jtcatJttySend', 'jtcatJttySetProfile', 'jtcatJttyValidate', 'onJtcatJttyRx']) assert.ok(pre.includes(k), 'preload ' + k);
    assert.ok(main.includes("ipcMain.handle('jtcat-jtty-validate'"), 'composer preview IPC');
    assert.ok(main.includes('setTxMessage(t, { profile: p.profile })'), 'Send carries a per-message profile');
    assert.ok(!/jtcat-jtty-send[\s\S]{0,600}jtcatJttySetProfile\(p\.profile\)/.test(main), 'a Send never persists the profile');
  });

  await test('JTCAT pop-out: the JTTY pane (static)', () => {
    const root = path.join(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'renderer', 'jtcat-popout.html'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'renderer', 'jtcat-popout.js'), 'utf8');
    assert.ok(/<option value="JTTY"[^>]*>JTTY<\/option>/.test(html), 'JTTY is in the mode select, not hidden');
    for (const id of ['jp-jtty-pane', 'jp-jtty-list', 'jp-jtty-tx', 'jp-jtty-frames', 'jp-jtty-profile', 'jp-jtty-his', 'jp-jtty-exch',
      'jp-jtty-serial', 'jp-jtty-serial-up', 'jp-jtty-serial-dn', 'jp-jtty-queued', 'jp-jtty-templates', 'jp-jtty-send', 'jp-jtty-stop',
      'jp-jtty-log', 'jp-jtty-clear', 'jp-jtty-editor', 'jp-jtty-ed-text', 'jp-jtty-ed-save', 'jp-jtty-ed-cancel', 'jp-jtty-ed-reset']) {
      assert.ok(html.includes(`id="${id}"`), 'markup ' + id);
    }
    assert.ok(html.includes('maxlength="80"'), 'the composer stops at the grammar\'s 80 characters');
    // The eight templates are WSJT-X's, verbatim (jtty_design.md).
    const m = js.match(/var JTTY_DEFAULT_TEMPLATES = (\[[^\]]*\]);/);
    assert.ok(m, 'template table present');
    assert.deepStrictEqual(JSON.parse(m[1].replace(/'/g, '"')), ['CQ %M CQ', '%H %E', '%H TU CQ %M CQ', '%M', '%H', 'TU NOW %Q %E', '%H AGN?', '%E']);
    assert.ok(/var JTTY_BAND_FREQS = \{[\s\S]*?'20m': 14080[\s\S]*?\};/.test(js), 'RTTY sub-band dials');
    assert.ok(js.includes("m === 'JTTY' ? JTTY_BAND_FREQS"), 'band buttons follow the mode');
    for (const fn of ['function applyJttyMode(', 'function jttySyncFreq(', 'function jttyInit(', 'function jttyPackProfile(', 'function jttyApplyUpdate(', 'function isKeyboardMode(']) {
      assert.ok(js.includes(fn), fn);
    }
    assert.ok(js.includes("applyJttyMode(modeSelect.value === 'JTTY');"), 'mode change swaps the pane');
    assert.ok(/window\.api\.jtcatStart\(modeSelect\.value\);[\s\S]{0,400}if \(modeSelect\.value === 'JTTY'\) jttySyncFreq\(\);/.test(js), 'restored audio frequency is pushed AFTER jtcat-start');
    assert.ok(js.includes("s.jtcatLastMode === 'JTTY'"), 'reopening JTCAT comes back in JTTY');
    // Every PSK-only exclusion that is really "keyboard mode" uses the shared predicate;
    // the one bare PSK31 guard left is PSK31's own TX-echo handler.
    assert.strictEqual((js.match(/modeSelect\.value !== 'PSK31'/g) || []).length, 1, 'keyboard-mode guards share isKeyboardMode()');
    assert.ok(js.includes("if (mode === 'PSK31' || mode === 'JTTY') {"), 'status strip sweeps for JTTY too');
    assert.ok(/if \(modeSelect\.value === 'JTTY'\) \{\s*jpWfCtx\.fillStyle[\s\S]{0,200}127 \/ 3000/.test(js), '127 Hz footprint on the waterfall');
    assert.ok(js.includes("jttyTemplates[i] === JTTY_DEFAULT_TEMPLATES[i] && /%E/.test(jttyTemplates[i])) return 'rtty-roundup'"), 'unedited native templates pack a serial exchange');
    assert.ok(js.includes("window.api.jtcatJttySend(text, profile)"), 'Send passes the per-message profile');
    assert.ok(js.includes('window.api.onJtcatJttyRx('), 'RX updates are consumed');
  });

  console.log(`\nJTTY engine: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.join('\n')); process.exit(1); }
  process.exit(0);
})();
