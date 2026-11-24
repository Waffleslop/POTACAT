#!/usr/bin/env node
'use strict';
// #741 Enter Sends Message: the wiring in the main window. The ESM block of
// renderer/app.js runs here against stub fields and a stub window.api, so the
// keying rules are checked on the real code: ESM off, not CW, or a key in any
// other field sends nothing; Esc cancels through the one path; a failed log
// sends no TU. Plus source checks that it stays wired that way.
// Run: node test/cw-esm-wiring-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const root = path.join(__dirname, '..');
const app = readSrc(path.join(root, 'renderer/app.js'));
const html = readSrc(path.join(root, 'renderer/index.html'));
const main = readSrc(path.join(root, 'main.js'));
const vfo = readSrc(path.join(root, 'renderer/vfo-popout.html'));
const CwBanks = require('../lib/cw-banks');
const CwEsm = require('../lib/cw-esm');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const START = '// --- CW Enter Sends Message (#741) ---';
const END = '// Enter key in callsign or RST fields triggers log (with ESM';
const block = app.slice(app.indexOf(START), app.indexOf(END));

function field(value = '') {
  return { value, focused: 0, listeners: {}, classList: { toggle() {}, add() {}, remove() {} },
    focus() { this.focused++; }, addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); } };
}
function key(k, extra) {
  return Object.assign({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, prevented: false,
    preventDefault() { this.prevented = true; }, stopPropagation() {} }, extra || {});
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// A main window with the ESM block loaded. opts: esm, mode, blModeVal, logOk, bankRun, bankSp
function load(opts = {}) {
  const sent = [], cancels = [], logs = [], toasts = [];
  const els = { 'activator-hunter-park': field(''), 'activator-county-state': field('PA'),
    'activator-esm-badge': field(), 'bl-esm-badge': field(), 'activator-esm-toggle': field(), 'activator-esm-wrap': field() };
  const ctx = {
    CwBanks, CwEsm, console,
    setTimeout: (fn) => 0, clearTimeout: () => {},
    activatorModeSelect: { value: opts.mode || 'CW', addEventListener() {} },
    blMode: { value: opts.blModeVal || 'CW', addEventListener() {} },
    activatorCallsignInput: field(''), blCallsign: field(''),
    blRef: field(''), blType: { value: '' }, blRstSent: field('599'),
    document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
    window: { confirm: () => false, api: {
      sendCwText: (t) => sent.push(t),
      cwCancel: () => cancels.push(1),
      getSettings: async () => ({}), saveSettings: async () => true,
    } },
    activatorLogContact: async () => { logs.push('run'); return opts.logOk !== false; },
    saveBannerQso: async () => { logs.push('sp'); return opts.logOk !== false; },
    showLogToast: (m) => toasts.push(m),
    getRstDigits: (id, fb) => fb,
    JtcatParser: { baseCall: (c) => c },
    qrzData: new Map(), cleanQrzName: (x) => x || '',
    activatorParkRefs: [{ ref: 'US-1234' }], activatorContacts: [], activatorParkGrid: 'FN20', grid: 'FN21',
    activationActive: true, cwMacroWpm: 20,
    CW_BANK_NAMES: { run: 'Activator (Run)', sp: 'Hunter (S&P)' },
    _cwBanks: { run: opts.bankRun || CwBanks.defaultsFor('run'), sp: opts.bankSp || CwBanks.defaultsFor('sp') },
    _cwEsmEnabled: opts.esm === undefined ? true : opts.esm,
    _cwHomeState: 'VA',
    reloadCwEsmSettings: async () => {}, saveCwMacroSlots: () => {},
  };
  vm.createContext(ctx);
  const api = vm.runInContext('(function(){\n' + block + '\nreturn { esmHandleCallKey, esmHandleRowKey, esmSessions, updateEsmBadges };\n})()', ctx);
  return Object.assign(api, { ctx, sent, cancels, logs, toasts, els });
}

test('the ESM block is found in app.js', () => {
  assert.ok(app.includes(START) && app.includes(END) && block.length > 2000, 'markers moved');
});

test('Run: Enter in the call field sends CQ, then call + exchange, then logs and sends TU', async () => {
  const w = load();
  const call = w.ctx.activatorCallsignInput;
  let e = key('Enter');
  assert.strictEqual(w.esmHandleCallKey(e, 'run'), true);
  assert.ok(e.prevented);
  await tick();
  call.value = 'W1AW';
  w.esmHandleCallKey(key('Enter'), 'run'); await tick();
  w.esmHandleCallKey(key('Enter'), 'run'); await tick(); await tick();
  assert.deepStrictEqual(w.sent, ['CQ POTA DE {MYCALL} {MYCALL} K', 'W1AW 5NN PA', 'TU 73 {MYCALL}']);
  assert.deepStrictEqual(w.logs, ['run']);
});

test('S&P in the banner logger: my call, then log and exchange (home state off a park)', async () => {
  const w = load();
  w.ctx.activationActive = false;
  w.ctx.blCallsign.value = 'N1MM';
  w.esmHandleCallKey(key('Enter'), 'sp'); await tick();
  w.esmHandleCallKey(key('Enter'), 'sp'); await tick(); await tick();
  assert.deepStrictEqual(w.sent, ['{MYCALL}', '5NN VA']);
  assert.deepStrictEqual(w.logs, ['sp']);
});

test('ESM off: Enter is not taken (the field logs as before) and nothing is sent', async () => {
  const w = load({ esm: false });
  w.ctx.activatorCallsignInput.value = 'W1AW';
  assert.strictEqual(w.esmHandleCallKey(key('Enter'), 'run'), false);
  assert.strictEqual(w.esmHandleCallKey(key('F1'), 'run'), false);
  assert.strictEqual(w.esmHandleCallKey(key('Escape'), 'run'), false);
  await tick();
  assert.deepStrictEqual(w.sent, []);
});

test('not CW: Enter logs as before, F keys and Esc are not taken, nothing is sent', async () => {
  for (const mode of ['SSB', 'FT8', 'FM']) {
    const w = load({ mode, blModeVal: mode });
    assert.strictEqual(w.esmHandleCallKey(key('Enter'), 'run'), false, mode);
    assert.strictEqual(w.esmHandleCallKey(key('Enter'), 'sp'), false, mode);
    assert.strictEqual(w.esmHandleCallKey(key('F2'), 'run'), false, mode);
    await tick();
    assert.deepStrictEqual(w.sent, [], mode);
  }
});

test('Enter in another field never keys: the row handler only stops a send on Esc', async () => {
  const w = load();
  assert.strictEqual(w.esmHandleRowKey(key('Enter'), 'run'), false);
  assert.strictEqual(w.esmHandleRowKey(key('F1'), 'run'), false);
  assert.strictEqual(w.esmHandleRowKey(key('Enter'), 'sp'), false);
  await tick();
  assert.deepStrictEqual(w.sent, []);
  assert.strictEqual(w.esmHandleRowKey(key('Escape'), 'run'), true);
  assert.deepStrictEqual(w.cancels, [1]);
  // and the only call sites of the call-field handler are the two call fields
  const sites = app.match(/esmHandleCallKey\(e, '(run|sp)'\)/g) || [];
  assert.deepStrictEqual(sites.slice().sort(), ["esmHandleCallKey(e, 'run')", "esmHandleCallKey(e, 'sp')"]);
  const actIdx = app.indexOf("activatorCallsignInput.addEventListener('keydown', (e) => {\n    if (esmHandleCallKey(e, 'run')) return;");
  const blIdx = app.indexOf("blCallsign.addEventListener('keydown', (e) => {\n  if (esmHandleCallKey(e, 'sp')) return;");
  assert.ok(actIdx > 0 && blIdx > 0, 'the handlers sit first in the two call fields\' keydown');
});

test('Esc in the call field cancels at once through window.api.cwCancel', async () => {
  const w = load();
  w.esmHandleCallKey(key('Enter'), 'run'); await tick();
  const e = key('Escape');
  assert.strictEqual(w.esmHandleCallKey(e, 'run'), true);
  assert.ok(e.prevented);
  assert.deepStrictEqual(w.cancels, [1]);
});

test('a failed log sends no TU and the next Enter retries the log, not the exchange', async () => {
  const w = load({ logOk: false });
  w.ctx.activatorCallsignInput.value = 'W1AW';
  w.esmHandleCallKey(key('Enter'), 'run'); await tick();
  w.esmHandleCallKey(key('Enter'), 'run'); await tick(); await tick();
  w.esmHandleCallKey(key('Enter'), 'run'); await tick(); await tick();
  assert.deepStrictEqual(w.sent, ['W1AW 5NN PA']);
  assert.deepStrictEqual(w.logs, ['run', 'run']);
});

test('a bank not laid out for ESM sends nothing and says where to fix it', async () => {
  const legacy = CwBanks.LEGACY_DEFAULTS.map((m) => ({ label: m.label, text: m.text }));
  const w = load({ bankRun: legacy });
  w.ctx.activatorCallsignInput.value = 'W1AW';
  w.esmHandleCallKey(key('Enter'), 'run'); await tick();
  assert.deepStrictEqual(w.sent, []);
  assert.deepStrictEqual(w.logs, []);
  assert.ok(/Load ESM layout/.test(w.toasts[0]));
});

test('F keys from the call field send that key of the bank; Shift+F the other bank', async () => {
  const w = load();
  w.ctx.activatorCallsignInput.value = 'W1AW';
  w.esmHandleCallKey(key('F3'), 'run');
  w.esmHandleCallKey(key('F3', { shiftKey: true }), 'run');
  w.esmHandleCallKey(key('F7'), 'run');
  assert.deepStrictEqual(w.sent, ['TU 73 {MYCALL}', 'TU 73', '5NN PA US-1234']);
  const e = key('F1', { ctrlKey: true });
  assert.strictEqual(w.esmHandleCallKey(e, 'run'), false, 'Ctrl+F belongs to the hotkey table');
});

test('the badge shows the next message, only in CW with ESM on', () => {
  const w = load();
  w.updateEsmBadges();
  assert.strictEqual(w.els['activator-esm-badge'].textContent, 'CQ');
  w.ctx.activatorCallsignInput.value = 'W1AW';
  w.updateEsmBadges();
  assert.strictEqual(w.els['activator-esm-badge'].textContent, 'EXCH');
  assert.strictEqual(w.els['bl-esm-badge'].textContent, 'MYCALL');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(block), 'no emoji');
});

test('off by default: only a saved true turns ESM on', () => {
  assert.ok(app.includes('_cwEsmEnabled = s.cwEsmEnabled === true;'));
  assert.ok(app.includes("cwEsmEnabled: !!(cwEsmEl && cwEsmEl.checked)"));
  assert.ok(/let _cwEsmEnabled = false;/.test(app));
});

test('keying and abort use the existing paths only', () => {
  assert.ok(/function esmSend\(text\) \{\n  window\.api\.sendCwText\(text\);/.test(block));
  assert.ok(block.includes("cancel: () => window.api.cwCancel()"));
  for (const bad of ['ipcRenderer', 'rigControl(', 'catCommand', 'sendRaw']) assert.ok(!block.includes(bad), bad);
});

test('log first, then TU: the logs resolve true only for a saved contact', () => {
  const fn = app.slice(app.indexOf('async function activatorLogContact(opts) {'), app.indexOf('function activatorReadEntry()'));
  assert.ok(fn.includes('if (!snap) return false;'));
  assert.ok(fn.includes('ok = (await activatorLogContactNow(_activatorLogInFlight)) === true;'));
  assert.ok(fn.includes('_activatorLogInFlight.resolve(ok);'));
  assert.ok(fn.includes('return wantResult ? snap.done : undefined;'));
  assert.ok(block.includes('activatorLogContact({ result: true })'), 'ESM asks for the result');
  const now = app.slice(app.indexOf('async function activatorLogContactNow(s) {'), app.indexOf('function clearActivatorEntry()'));
  assert.ok(now.includes("showLogToast(`Not logged: ${(res && res.error) || 'save failed'}`, { warn: true, duration: 6000 });\n    return false;"));
  assert.ok(/clearActivatorEntry\(\);\n  return true;\n\}/.test(now));
  const bl = app.slice(app.indexOf('async function saveBannerQso() {'), app.indexOf("blLogBtn.addEventListener('click', saveBannerQso);"));
  assert.ok(bl.includes('saved = true;') && bl.includes('  return saved;\n}'));
});

test('banks: Settings saves cwMacros (S&P) and cwMacrosRun (Run); the bar follows the mode', () => {
  assert.ok(app.includes('cwMacros: cwBanksVal.sp,'));
  assert.ok(app.includes('cwMacrosRun: cwBanksVal.run,'));
  assert.ok(app.includes("_cwMacroCache = appMode === 'activator' ? banks.run : banks.sp;"));
  assert.ok(app.includes('_cwMacroCache = null; updateCwMacroBar(); // the macro bar follows the mode'));
  assert.ok(!/const DEFAULT_CW_MACROS = \[/.test(app), 'one default set: lib/cw-banks.js');
  assert.ok(vfo.includes('CwBanks.banksFromSettings(s).sp') && vfo.includes('<script src="../lib/cw-banks.js"></script>'));
  assert.ok(!/UR 599 BK/.test(vfo), 'the VFO pop-out\'s own copy is gone');
});

test('page loads the modules before app.js; the switch, badges and bank tabs exist', () => {
  const i1 = html.indexOf('<script src="../lib/cw-banks.js"></script>');
  const i2 = html.indexOf('<script src="../lib/cw-esm.js"></script>');
  const i3 = html.indexOf('<script src="app.js"></script>');
  assert.ok(i1 > 0 && i2 > i1 && i3 > i2);
  for (const id of ['activator-esm-toggle', 'activator-esm-badge', 'bl-esm-badge', 'set-cw-esm', 'cw-bank-load-esm', 'cw-bank-esm-note']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('data-bank="run"') && html.includes('data-bank="sp"'));
});

test('phones: remoteCwMacros stays the S&P bank; remoteCwBanks carries both', () => {
  assert.ok(main.includes('remoteCwMacros: settings.cwMacros || settings.remoteCwMacros || null,'));
  assert.ok(main.includes('remoteCwBanks: (() => { const b = CwBanks.banksFromSettings(settings); return { run: b.run, sp: b.sp, esm: settings.cwEsmEnabled === true }; })(),'));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e).split('\n').slice(0, 3).join('\n       ')); }
  }
  console.log(`\nCW ESM wiring: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
