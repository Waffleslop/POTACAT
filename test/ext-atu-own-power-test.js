#!/usr/bin/env node
'use strict';
// The RF-sense Tune on a radio POTACAT cannot set the power of (FT-857D class,
// N5XHI 2026-11-24). Runs the REAL request gate, question and tune routine
// from main.js in a sandbox against a fake radio:
//   - no power set, no restore, and no log line that says power was lowered
//     or confirmed;
//   - the question before the first tune, once per rig; Cancel keys nothing;
//   - a device (ECHOCAT) is refused, or asked when it can show the question;
//   - a radio POTACAT does set the power of is untouched by all of this.
// Run: node test/ext-atu-own-power-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const main = readSrc(path.join(__dirname, '..', 'main.js'));
const T = require('../lib/tx-power-control');
const { getModel, RIG_MODELS } = require('../lib/rig-models');
const { flrigModel } = require('../lib/codecs/flrig-codec');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// The tune routine and everything after it up to the dispatcher comment: the
// own-power gate lives there.
const fnStart = main.indexOf('runExternalAtuTune = async function');
const blockEnd = main.indexOf('// THE single rig-control dispatcher.', fnStart);
const block = fnStart > 0 && blockEnd > fnStart ? main.slice(fnStart, blockEnd) : '';
const wfr = main.slice(main.indexOf('async function waitForPowerReadback('), main.indexOf('/**', main.indexOf('async function waitForPowerReadback(')));
const wmr = main.slice(main.indexOf('async function waitForModeReadback('), main.indexOf('\n}\n', main.indexOf('async function waitForModeReadback(')) + 3);

/**
 * A shack: one rig with an RF-sense tuner, a fake radio and a fake dialog.
 * @param {object} o  model, catTarget, codec (extra codec fields), dialogAnswer
 *                    (0 Tune now, 1 Cancel), powerBefore, connected, confirmedMap
 */
function shack(o = {}) {
  const log = [], powers = [], ptt = [], modes = [], dialogs = [], toAsker = [], toWindow = [], powerReads = [];
  const handlers = {};
  const row = o.model ? getModel(o.model, null) : null;
  const transport = T.transportOf(o.catTarget);
  const activeModel = transport === 'flrig' ? flrigModel(row || RIG_MODELS.flrig) : (row || { caps: { txpower: true } });
  const codec = { dataModeState: null, ...(o.codec || {}) };
  if (o.readsPower) codec.getPower = () => { powerReads.push(1); };
  const ctx = {
    console, Date, Promise, setTimeout, clearTimeout, Object, String, Number,
    ExtAtuRestore: require('../lib/ext-atu-restore'),
    PowerRestore: require('../lib/power-restore'),
    TxPowerControl: T,
    getModel, getActiveRigModel: () => activeModel,
    _lastModeReadback: null,
    settings: {
      activeRigId: 'r1', catTarget: o.catTarget,
      rigs: [{ id: 'r1', name: 'Test rig', model: o.model || '', catTarget: o.catTarget, externalAtu: 'rf-sense', externalAtuWatts: 10, externalAtuSeconds: 1 }],
      ...(o.confirmedMap ? { extAtuOwnPowerOk: o.confirmedMap } : {}),
    },
    cat: {
      connected: o.connected !== false, _codec: codec,
      setModeOnly(m) { modes.push(m); setTimeout(() => { ctx._lastModeReadback = { mode: m, at: Date.now() }; }, 40); },
    },
    _currentMode: 'USB', _currentTxPower: o.powerBefore == null ? 100 : o.powerBefore, _currentFreqHz: 14074000,
    EXTERNAL_ATU_CARRIER_MODE: 'AM', _externalAtuActive: false, _externalAtuCancel: false,
    _setupPowerRestoreAttempt: 0, _lastPowerReadback: null,
    win: { isDestroyed: () => false, webContents: { send: (ch, d) => toWindow.push([ch, d]) } },
    BrowserWindow: { fromWebContents: (wc) => (wc && wc._win) || null },
    dialog: { showMessageBox: async (parent, opts) => { dialogs.push({ parent, opts }); return { response: o.dialogAnswer == null ? 1 : o.dialogAnswer }; } },
    ipcMain: { on() {}, handle(ch, fn) { handlers[ch] = fn; } },
    remoteServer: { running: true, sendToAsker: (m) => toAsker.push(m) },
    noteAtuTuneStarted() {},
    sendCatLog: (l) => log.push(l), saveSettings() { ctx._saves = (ctx._saves || 0) + 1; },
    gatedSetTransmit: (on) => { ptt.push(on); return true; },
    sleepMs: (ms) => new Promise((r) => setTimeout(r, ms)),
    gatedSetTxPower: (w) => { powers.push(w); setTimeout(() => { ctx._lastPowerReadback = { watts: w, at: Date.now() }; }, 40); return true; },
  };
  vm.createContext(ctx);
  vm.runInContext(wfr + '\n' + wmr + '\nvar runExternalAtuTune;\n' + block
    + '\nthis.extAtuTuneRequest = typeof extAtuTuneRequest === "function" ? extAtuTuneRequest : null;'
    + '\nthis.isActive = () => _externalAtuActive;', ctx);
  const rig = ctx.settings.rigs[0];
  /** One Tune press; resolves when the question (if any) is answered and the tune (if any) is over. */
  async function press(source = 'desktop', data = {}, meta = null) {
    assert.ok(ctx.extAtuTuneRequest, 'main.js has extAtuTuneRequest(rig, data, source, meta)');
    ctx.extAtuTuneRequest(rig, { action: 'atu-tune', ...data }, source, meta);
    await new Promise((r) => setTimeout(r, 30)); // the question's answer, then the tune starts
    const end = Date.now() + 15000;
    while (ctx.isActive() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  }
  return { ctx, rig, press, log, powers, ptt, modes, dialogs, toAsker, toWindow, powerReads, handlers };
}
const SERIAL = { type: 'serial', path: 'COM3' };
const FLRIG = { type: 'flrig', host: '127.0.0.1', port: 12345 };
// Words that would claim the power was lowered, confirmed or restored.
const POWER_CLAIM = /→ ?\d+ ?W|radio confirms|power left at|power restored|set power back|restoring \d/i;
// Objects made inside the sandbox have another realm's prototypes.
const plain = (x) => JSON.parse(JSON.stringify(x));
const noPowerClaim = (s) => assert.ok(!s.log.some((l) => POWER_CLAIM.test(l)), 'a log line claims something about power:\n' + s.log.join('\n'));

(async () => {
  console.log('RF-sense Tune on a radio with no power control');
  test('the gate and the question exist in main.js, beside the tune routine', () => {
    assert.ok(block, 'the block after runExternalAtuTune');
    assert.ok(/function extAtuTuneRequest\(rig, data, source, meta\)/.test(block));
    assert.ok(/async function extAtuAskOwnPower\(/.test(block));
    assert.ok(/function extAtuPowerControl\(/.test(block));
  });
  if (!/function extAtuTuneRequest\(/.test(block)) { console.log(`\n${passed} passed, ${failed + 1} failed`); process.exit(1); }

  // --- FT-857 direct: Cancel, then Tune now, then no more questions ---------
  const a = shack({ model: 'FT-857', catTarget: SERIAL, dialogAnswer: 1, powerBefore: 0 });
  await a.press();
  test('FT-857, first press: the question is asked, with Tune now and Cancel', () => {
    assert.strictEqual(a.dialogs.length, 1);
    assert.deepStrictEqual(a.dialogs[0].opts.buttons, ['Tune now', 'Cancel']);
    assert.strictEqual(a.dialogs[0].opts.cancelId, 1);
    assert.ok(/up to 25 W on HF for an FT-857/.test(a.dialogs[0].opts.detail));
    assert.strictEqual(a.dialogs[0].parent, a.ctx.win, 'in the main window when no other window pressed Tune');
  });
  test('Cancel: no PTT, no mode change, no power command, nothing remembered', () => {
    assert.deepStrictEqual(a.ptt, []);
    assert.deepStrictEqual(a.modes, []);
    assert.deepStrictEqual(a.powers, []);
    assert.ok(!a.ctx.settings.extAtuOwnPowerOk || !a.ctx.settings.extAtuOwnPowerOk.r1);
    assert.ok(a.log.some((l) => /cancelled at the own-power question: nothing was transmitted/.test(l)), a.log.join('\n'));
    assert.ok(!a.toWindow.some(([ch]) => ch === 'external-atu-start'), 'no tune modal');
  });

  const b = shack({ model: 'FT-857', catTarget: SERIAL, dialogAnswer: 0, powerBefore: 0, readsPower: true });
  const vfoWin = { isDestroyed: () => false };
  await b.press('desktop', {}, { sender: { isDestroyed: () => false, _win: vfoWin } });
  test('Tune now: the carrier is keyed and unkeyed in AM, and the mode is put back', () => {
    assert.strictEqual(b.dialogs.length, 1);
    assert.strictEqual(b.dialogs[0].parent, vfoWin, 'the question is on the window that pressed Tune');
    assert.deepStrictEqual(b.ptt, [true, false]);
    assert.deepStrictEqual(b.modes, ['AM', 'USB']);
  });
  test('... with no power set, no power read, no restore and no restore marker', () => {
    assert.deepStrictEqual(b.powers, [], 'gatedSetTxPower was never called');
    assert.deepStrictEqual(b.powerReads, [], 'the power was not asked for either');
    assert.ok(!b.ctx.settings.setupTxPowerRestore);
  });
  test('... and the log never says power was lowered or confirmed', () => {
    noPowerClaim(b);
    assert.ok(b.log.some((l) => /Firing AM carrier for 1s at the radio's own power .*no power command is sent/.test(l)), b.log.join('\n'));
    assert.ok(b.log.some((l) => /Tune complete — mode USB confirmed; power not touched: this radio's power is set on the radio/.test(l)), b.log.join('\n'));
  });
  test('... the tune modal is told it is the radio\'s own power', () => {
    const start = b.toWindow.find(([ch]) => ch === 'external-atu-start');
    assert.ok(start && start[1].ownPower === true && start[1].seconds === 1);
  });
  test('the answer is remembered for that rig, in settings', () => {
    assert.ok(T.isConfirmed(b.ctx.settings.extAtuOwnPowerOk, 'r1', T.canSetTxPower({ transport: 'direct', modelName: 'FT-857' })));
    assert.ok(b.ctx._saves >= 1);
  });
  await b.press();
  test('asked once per rig: the second press tunes with no question', () => {
    assert.strictEqual(b.dialogs.length, 1);
    assert.deepStrictEqual(b.ptt, [true, false, true, false]);
    assert.deepStrictEqual(b.powers, []);
  });

  // --- The same radio through flrig and rigctld -------------------------------
  // flrig "confirms" whatever it was told (rig.get_power returns the stored
  // number), which is how the log came to say "radio confirms".
  const [f, h, hc, c706, cmd] = [
    shack({ model: '', catTarget: FLRIG, codec: { _xcvr: 'FT-857D' }, readsPower: true, powerBefore: 100, dialogAnswer: 0 }),
    shack({ model: '', catTarget: { type: 'rigctld', rigId: 1022 }, codec: { _hamlibRigId: 1022, canSetRfPower: () => null }, powerBefore: 0, dialogAnswer: 0 }),
    shack({ model: '', catTarget: { type: 'rigctldnet', host: 'pi' }, codec: { _hamlibRigId: 9999, canSetRfPower: () => false }, powerBefore: 50, dialogAnswer: 0 }),
    shack({ model: 'IC-706MKIIG', catTarget: { type: 'icom', path: 'COM4' }, powerBefore: 0, dialogAnswer: 0 }),
    shack({ model: 'IC-7300', catTarget: { type: 'dxlab-commander', host: '127.0.0.1', port: 52002 }, powerBefore: 0, dialogAnswer: 0 }),
  ];
  await Promise.all([f, h, hc, c706, cmd].map((s) => s.press()));
  test('FT-857D through flrig (a reported 100 W): asked, tuned, no power command, no "confirms"', () => {
    assert.strictEqual(f.dialogs.length, 1);
    assert.ok(/up to 25 W on HF for an FT-857/.test(f.dialogs[0].opts.detail));
    assert.deepStrictEqual(f.ptt, [true, false]);
    assert.deepStrictEqual(f.powers, []);
    assert.deepStrictEqual(f.powerReads, []);
    assert.ok(!f.ctx.settings.setupTxPowerRestore);
    noPowerClaim(f);
  });
  test('FT-857 through rigctld (Hamlib 1022): the same', () => {
    assert.strictEqual(h.dialogs.length, 1);
    assert.deepStrictEqual(h.ptt, [true, false]);
    assert.deepStrictEqual(h.powers, []);
    noPowerClaim(h);
  });
  test('a Hamlib backend that lists no RFPOWER to set: the same, and no wattage in the question', () => {
    assert.strictEqual(hc.dialogs.length, 1);
    assert.ok(!/\d\s*W/.test(hc.dialogs[0].opts.detail));
    assert.deepStrictEqual(hc.powers, []);
    noPowerClaim(hc);
  });
  test('IC-706MKIIG: asked, no power command (the radio has no 14 0A), no wattage in the question', () => {
    assert.strictEqual(c706.dialogs.length, 1);
    assert.ok(!/\d\s*W/.test(c706.dialogs[0].opts.detail));
    assert.deepStrictEqual(c706.ptt, [true, false]);
    assert.deepStrictEqual(c706.powers, []);
  });
  test('DXLab Commander: asked, no power command', () => {
    assert.strictEqual(cmd.dialogs.length, 1);
    assert.deepStrictEqual(cmd.powers, []);
  });

  // --- From a device ----------------------------------------------------------
  const r1 = shack({ model: 'FT-857', catTarget: SERIAL, dialogAnswer: 0 });
  await r1.press('echocat');
  test('a device press before the rig is confirmed: refused with the reason, nothing keyed, no dialog at the shack', () => {
    assert.deepStrictEqual(plain(r1.toAsker), [{ type: 'tune-blocked', reason: T.REMOTE_REFUSAL }]);
    assert.deepStrictEqual(r1.ptt, []);
    assert.deepStrictEqual(r1.modes, []);
    assert.strictEqual(r1.dialogs.length, 0);
    assert.ok(r1.log.some((l) => /From a remote device/.test(l)), r1.log.join('\n'));
  });
  await r1.press('echocat', { ownPowerOk: true, rigId: 'r1' });
  test('a device cannot answer a question it was never sent', () => {
    assert.strictEqual(r1.toAsker.length, 2);
    assert.strictEqual(r1.toAsker[1].type, 'tune-blocked');
    assert.deepStrictEqual(r1.ptt, []);
  });
  await r1.press('echocat', { ownPowerAsk: true });
  test('a device that can show the question is sent it, and still nothing is keyed', () => {
    const ask = r1.toAsker[2];
    assert.strictEqual(ask.type, 'tune-own-power-ask');
    assert.strictEqual(ask.rigId, 'r1');
    assert.strictEqual(ask.tuneLabel, 'Tune now');
    assert.strictEqual(ask.cancelLabel, 'Cancel');
    assert.ok(/cannot turn this radio's power down/.test(ask.text) && /up to 25 W on HF for an FT-857/.test(ask.text));
    assert.deepStrictEqual(r1.ptt, []);
  });
  await r1.press('echocat', { ownPowerOk: true, rigId: 'another-rig' });
  test('its Tune now for another rig is not an answer for this one', () => assert.deepStrictEqual(r1.ptt, []));
  await r1.press('echocat', { ownPowerOk: true, rigId: 'r1' }, { guest: true });
  test('a Guest Pass cannot answer it', () => assert.deepStrictEqual(r1.ptt, []));
  await r1.press('echocat', { ownPowerOk: true, rigId: 'r1' });
  test('its Tune now for this rig tunes (no power command) and is remembered', () => {
    assert.deepStrictEqual(r1.ptt, [true, false]);
    assert.deepStrictEqual(r1.powers, []);
    assert.ok(r1.ctx.settings.extAtuOwnPowerOk && r1.ctx.settings.extAtuOwnPowerOk.r1);
    noPowerClaim(r1);
  });
  await r1.press('echocat');
  test('once confirmed, a plain device press tunes', () => {
    assert.deepStrictEqual(r1.ptt, [true, false, true, false]);
    assert.strictEqual(r1.dialogs.length, 0);
  });

  // --- No link, no window -----------------------------------------------------
  const nl = shack({ model: 'FT-857', catTarget: SERIAL, connected: false });
  await nl.press();
  test('radio not connected: no question, "CAT not connected", nothing keyed', () => {
    assert.strictEqual(nl.dialogs.length, 0);
    assert.deepStrictEqual(nl.ptt, []);
    assert.ok(nl.log.some((l) => /CAT not connected/.test(l)));
  });
  const nw = shack({ model: 'FT-857', catTarget: SERIAL, dialogAnswer: 0 });
  nw.ctx.win = null;
  await nw.press();
  test('no window to ask in (headless): nothing keyed, and the log says what to do', () => {
    assert.deepStrictEqual(nw.ptt, []);
    assert.ok(nw.log.includes(T.NO_WINDOW_LINE));
  });

  // --- Radios POTACAT does set the power of: nothing changes ------------------
  const [p1, p2, p3, p4] = [
    shack({ model: 'IC-7300', catTarget: { type: 'icom', path: 'COM5' }, powerBefore: 100 }),
    shack({ model: 'IC-7300', catTarget: { type: 'icom', path: 'COM5' }, powerBefore: 100 }),
    shack({ model: '', catTarget: FLRIG, codec: { _xcvr: 'IC-7300' }, powerBefore: 100 }),
    shack({ model: '', catTarget: { type: 'rigctld', rigId: 3073 }, codec: { _hamlibRigId: 3073, canSetRfPower: () => true }, powerBefore: 0 }),
  ];
  await Promise.all([p1.press(), p2.press('echocat'), p3.press(), p4.press()]);
  test('IC-7300 from the desktop: no question; 10 W, carrier, 100 W back, "radio confirms 100 W"', () => {
    assert.strictEqual(p1.dialogs.length, 0);
    assert.deepStrictEqual(p1.powers, [10, 100]);
    assert.deepStrictEqual(p1.ptt, [true, false]);
    assert.deepStrictEqual(p1.modes, ['AM', 'USB']);
    assert.ok(p1.log.some((l) => l === '[ExtATU] Firing 10 W AM carrier for 1s (mode USB → AM, power 100W → 10W)'), p1.log.join('\n'));
    assert.ok(p1.log.some((l) => l === '[ExtATU] Tune complete — mode USB confirmed; radio confirms 100 W'), p1.log.join('\n'));
    const start = p1.toWindow.find(([ch]) => ch === 'external-atu-start');
    assert.deepStrictEqual(plain(start[1]), { seconds: 1 }, 'the modal payload is what it was');
    assert.ok(!p1.ctx.settings.extAtuOwnPowerOk);
  });
  test('IC-7300 from a device: tuned at once, nothing refused or asked', () => {
    assert.deepStrictEqual(p2.toAsker, []);
    assert.deepStrictEqual(p2.powers, [10, 100]);
    assert.deepStrictEqual(p2.ptt, [true, false]);
  });
  test('an flrig radio that is not a known one keeps its power steps (not guessed)', () => {
    assert.strictEqual(p3.dialogs.length, 0);
    assert.deepStrictEqual(p3.powers, [10, 100]);
  });
  test('a rigctld radio whose power was never reported: tune power sent, nothing restored (as before)', () => {
    assert.strictEqual(p4.dialogs.length, 0);
    assert.deepStrictEqual(p4.powers, [10]);
    assert.ok(p4.log.some((l) => /power never reported by the radio → 10W/.test(l)), p4.log.join('\n'));
  });

  // --- The rig editor's view and the reset ------------------------------------
  test('the rig editor is told: cannot set, the note, and whether the question was answered', () => {
    assert.ok(b.handlers['ext-atu-own-power-state'], 'ipc ext-atu-own-power-state');
    const st = b.handlers['ext-atu-own-power-state'](null, { rigId: 'r1', model: 'FT-857', catTarget: SERIAL });
    assert.deepStrictEqual(plain(st), { canSet: false, note: T.FIELD_NOTE, help: T.SETTINGS_HELP, confirmed: true });
    const other = b.handlers['ext-atu-own-power-state'](null, { rigId: 'new', model: 'IC-7300', catTarget: { type: 'icom' } });
    assert.deepStrictEqual(plain(other), { canSet: true, note: '', help: '', confirmed: false });
    const draft = b.handlers['ext-atu-own-power-state'](null, { rigId: '', model: '', catTarget: { type: 'rigctld', rigId: 1023 } });
    assert.strictEqual(draft.canSet, false);
  });
  test('"Ask me again" forgets the answer: the next press asks', () => {
    assert.ok(b.handlers['ext-atu-own-power-forget'], 'ipc ext-atu-own-power-forget');
    b.handlers['ext-atu-own-power-forget'](null, 'r1');
    assert.ok(!b.ctx.settings.extAtuOwnPowerOk.r1);
  });
  await b.press();
  test('... it does', () => assert.strictEqual(b.dialogs.length, 2));

  console.log('Wiring');
  const disp = main.slice(main.indexOf("case 'atu-tune': {", main.indexOf('applyRigControl = function')), main.indexOf("case 'power-on': {", main.indexOf('applyRigControl = function')));
  test('the dispatcher hands every RF-sense Tune to the gate; the tune routine has one caller', () => {
    assert.ok(/if \(rig && rig\.externalAtu === 'rf-sense'\) \{\s*extAtuTuneRequest\(rig, data, source, meta\);\s*break;\s*\}/.test(disp), disp.slice(0, 1400));
    assert.ok(!/runExternalAtuTune\(/.test(disp), 'the dispatcher no longer starts the tune itself');
    // Comments name the routine too: count the calls that pass an argument.
    const CALL = /runExternalAtuTune\(\{ ownPower: [^}]+\}\)/g;
    assert.strictEqual((main.match(CALL) || []).length, 2, 'two callers: the gate, and the question\'s Tune now');
    assert.strictEqual((block.match(CALL) || []).length, 2, 'both are inside the gate block');
    const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/runExternalAtuTune\(\)/.test(code), 'never called without saying whether power is the radio\'s own');
  });
  test('inside the tune, the power set is skipped only for ownPower, and the restore has nothing to restore', () => {
    const fn = block.slice(0, block.indexOf("ipcMain.on('external-atu-cancel'"));
    assert.ok(/if \(!ownPower\) gatedSetTxPower\(watts\);/.test(fn));
    assert.ok(/const restorePower = ownPower \? null : PowerRestore\.restoreTarget\(_currentTxPower\);/.test(fn));
    assert.strictEqual(fn.split('gatedSetTxPower(').length - 1, 2, 'the tune power and the restore, nothing new');
  });
  test('the desktop sender reaches the gate, so the question opens on the window that pressed Tune', () => {
    assert.ok(/return applyRigControl\(data, 'desktop', \{ sender: _e\.sender \}\);/.test(main));
  });
  test('the answer has one writer: a window saving old settings cannot bring it back', () => {
    const save = main.slice(main.indexOf("ipcMain.handle('save-settings'"), main.indexOf("ipcMain.handle('save-settings'") + 2500);
    assert.ok(/delete newSettings\.extAtuOwnPowerOk;/.test(save));
    const rsave = main.slice(main.indexOf("remoteServer.on('save-settings'"), main.indexOf("remoteServer.on('save-settings'") + 2600);
    assert.ok(/delete partial\.extAtuOwnPowerOk;/.test(rsave), 'nor can a device write it');
    assert.ok(!require('../lib/device-settings').isDeviceWritable || !require('../lib/device-settings').isDeviceWritable('extAtuOwnPowerOk'));
    assert.ok(/'extAtuOwnPowerOk',/.test(main.slice(main.indexOf('const GLOBAL_KEYS = new Set(['), main.indexOf('const GLOBAL_KEYS = new Set([') + 12000)), 'kept with this machine\'s rigs');
  });
  test('a device\'s Tune carries its own-power fields to the dispatcher, on both spellings', () => {
    const rs = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
    const bare = rs.slice(rs.indexOf("case 'atu-tune':"), rs.indexOf("case 'atu-tune':") + 500);
    assert.ok(/ownPowerAsk: msg\.ownPowerAsk === true/.test(bare) && /ownPowerOk: msg\.ownPowerOk === true/.test(bare) && /rigId:/.test(bare), bare);
    const P = require('../lib/echocat-protocol');
    const reg = P.MESSAGES || P.messages || P.REGISTRY || P.registry;
    if (reg) assert.ok(reg['tune-own-power-ask'], 'tune-own-power-ask is in the protocol registry');
    const psrc = readSrc(path.join(__dirname, '..', 'lib', 'echocat-protocol.js'));
    assert.ok(/'tune-own-power-ask': \{ dir: Dir\.S2C/.test(psrc));
  });
  // ECHOCAT Web's ATU button is set-atu, the internal tuner's switch: it has
  // never started the RF-sense carrier, so it has nothing to ask. If it ever
  // sends atu-tune, it must send ownPowerAsk and show tune-own-power-ask.
  test('ECHOCAT Web cannot start this tune (no atu-tune sender), or else it handles the question', () => {
    const rj = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
    if (/atu-tune/.test(rj)) assert.ok(/ownPowerAsk: true/.test(rj) && /case 'tune-own-power-ask':/.test(rj));
  });
  test('the bare atu-tune message says whether its sender is a guest', () => {
    const rs = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
    const bare = rs.slice(rs.indexOf("case 'atu-tune':"), rs.indexOf("case 'atu-tune':") + 500);
    assert.ok(/\{ guest: !!ws\._passSession \}/.test(bare));
  });
  test('the tune modal and the settings text no longer promise a low-power carrier on these radios', () => {
    const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
    const modal = app.slice(app.indexOf('(function setupExternalAtuModal()'), app.indexOf('(function setupExternalAtuModal()') + 2600);
    assert.ok(/ownPower/.test(modal) && /TxPowerControl\.MODAL_LINE/.test(modal));
    const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
    assert.ok(!/Rig restores to its previous mode and power afterwards\./.test(html));
    assert.ok(/id="external-atu-own-power-note"/.test(html) && /id="external-atu-own-power-reset"/.test(html));
    assert.ok(/<script src="\.\.\/lib\/tx-power-control\.js"><\/script>/.test(html));
    assert.ok(/extAtuWattsEl\.disabled = !st\.canSet/.test(app) || /wattsEl\.disabled = !st\.canSet/.test(app));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
