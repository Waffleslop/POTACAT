// #1072: the Station Setup launch card must be offered when Welcome finishes,
// not lost because the one 12 s launch check ran while Welcome was still up.
// On a real first install there is no radio yet during Welcome (rig null), and
// firstRun is set when there is one. Either way the check runs again after
// Get Started, once, and not when the operator already opened the checklist.
'use strict';
const assert = require('assert');
const vm = require('vm');
const path = require('path');
const { readSrc } = require('./_src');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + '\n    ' + (err && err.stack || err)); }
}

function load(getResult) {
  const timers = [];
  const cardTexts = [];      // every text shown on the launch card
  const els = {};
  const plain = () => new Proxy(function () {}, {
    get(_t, k) {
      if (k === 'open') return false;
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      if (k === 'style' || k === 'dataset') return {};
      if (k === 'textContent' || k === 'innerHTML' || k === 'value') return '';
      return () => plain();
    },
    set() { return true; },
    apply() { return plain(); },
  });
  const byId = (id) => {
    if (els[id]) return els[id];
    const state = { open: false };
    els[id] = new Proxy(function () {}, {
      get(_t, k) {
        if (k === 'open') return state.open;
        if (k === 'showModal') return () => { state.open = true; };
        if (k === 'close') return () => { state.open = false; };
        if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
        if (k === 'style' || k === 'dataset') return {};
        if (k === 'textContent' || k === 'innerHTML' || k === 'value') return '';
        return () => plain();
      },
      set(_t, k, v) {
        if (id === 'ss-card-text' && k === 'textContent') cardTexts.push(v);
        return true;
      },
      apply() { return plain(); },
    });
    return els[id];
  };
  const window = {
    api: new Proxy({ stationSetupGet: async () => getResult() }, {
      get: (tg, k) => (k in tg ? tg[k] : async () => ({})),
    }),
  };
  const document = {
    getElementById: byId,
    createElement: () => plain(),
    querySelector: () => plain(),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const ctx = vm.createContext({
    window, document, console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {}, requestAnimationFrame() {},
  });
  const src = readSrc(path.join(__dirname, '..', 'renderer', 'station-setup.js'));
  vm.runInContext(src, ctx, { filename: 'station-setup.js' });
  return { window, timers, cardTexts };
}

const withRig = (firstRun) => ({
  rig: { id: 'r1', model: 'IC-7300' },
  summary: { requiredNeverDone: 2 },
  steps: [],
  launch: { firstRun, prompt: true, newSteps: [] },
});

(async () => {
  await t('first install: no radio during Welcome, the card comes after Get Started', async () => {
    // main.js stationSetupPayload with settings.rigs empty: { rig: null }, no launch.
    let payload = { rig: null };
    const h = load(() => payload);
    assert.strictEqual(h.timers[0].ms, 12000);
    await h.timers[0].fn();
    assert.strictEqual(h.cardTexts.length, 0, 'nothing shown while Welcome is up');
    // Operator adds a radio in Welcome and presses Get Started.
    payload = withRig(false);
    const before = h.timers.length;
    h.window.stationSetupAfterWelcome();
    assert.strictEqual(h.timers.length, before + 1, 'the check is scheduled again');
    assert.strictEqual(h.timers[before].ms, 12000);
    await h.timers[before].fn();
    assert.strictEqual(h.cardTexts.length, 1);
    assert.ok(/Finish setting up your IC-7300/.test(h.cardTexts[0]));
  });

  await t('radio present but firstRun set during Welcome: card after Get Started', async () => {
    const state = { firstRun: true };
    const h = load(() => withRig(state.firstRun));
    await h.timers[0].fn();
    assert.strictEqual(h.cardTexts.length, 0);
    state.firstRun = false;
    const before = h.timers.length;
    h.window.stationSetupAfterWelcome();
    assert.strictEqual(h.timers.length, before + 1);
    await h.timers[before].fn();
    assert.strictEqual(h.cardTexts.length, 1);
  });

  await t('Get Started twice schedules only one check', async () => {
    const h = load(() => ({ rig: null }));
    await h.timers[0].fn();
    const before = h.timers.length;
    h.window.stationSetupAfterWelcome();
    h.window.stationSetupAfterWelcome();
    assert.strictEqual(h.timers.length, before + 1);
  });

  await t('the normal launch check already ran: nothing scheduled after Welcome', async () => {
    const h = load(() => withRig(false));
    await h.timers[0].fn();
    assert.strictEqual(h.cardTexts.length, 1);
    const n = h.timers.length;
    h.window.stationSetupAfterWelcome();
    assert.strictEqual(h.timers.length, n);
  });

  await t('Get Started before the first 12 s check fired: the card shows once', async () => {
    let payload = { rig: null };
    const h = load(() => payload);
    payload = withRig(false);
    h.window.stationSetupAfterWelcome();
    for (const tm of h.timers.slice()) await tm.fn();
    assert.strictEqual(h.cardTexts.length, 1);
  });

  await t('checklist opened this session (radio added in Welcome): no card after it', async () => {
    let payload = { rig: null };
    const h = load(() => payload);
    await h.timers[0].fn();
    payload = withRig(false);
    // #1070: Get Started opens the checklist for the new radio, then the
    // operator closes it.
    await h.window.openStationSetup('r1');
    const before = h.timers.length;
    h.window.stationSetupAfterWelcome();
    for (const tm of h.timers.slice(before)) await tm.fn();
    assert.strictEqual(h.cardTexts.length, 0);
  });

  await t('checklist opened before the launch check fires: no card either', async () => {
    const h = load(() => withRig(false));
    await h.window.openStationSetup('r1');
    await h.timers[0].fn();
    assert.strictEqual(h.cardTexts.length, 0);
  });

  // A shorter first run (2026-11-26): the flow ends on Get Started (remote
  // shack panel), on "No radio yet", on the radio check's Done or Skip (part
  // 2, renderer/first-run-radio.js, through welcomeCloseFlow), or with Esc
  // after the station step. Every way out closes the Welcome, then runs the
  // hook; after the radio check the hook finds the steps already seen.
  await t('app.js runs the hook after the Welcome closes, on every way out of the first run', () => {
    const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js')).replace(/\r\n/g, '\n');
    const fi = app.indexOf('function welcomeCloseFlow() {');
    const flow = app.slice(fi, app.indexOf('\n}\n', fi));
    assert.ok(fi > 0, 'welcomeCloseFlow found');
    const close = flow.indexOf('welcomeDialog.close()');
    const hook = flow.indexOf('window.stationSetupAfterWelcome()');
    assert.ok(close > 0 && hook > close, 'order: close, then stationSetupAfterWelcome');
    const gs = app.indexOf("document.getElementById('welcome-start').addEventListener('click'");
    assert.ok(gs > 0 && /welcomeCloseFlow\(\);\n\}\);/.test(app.slice(gs, gs + 400)), 'Get Started ends the flow');
    const ci = app.indexOf('async function welcomeChooseWhere(');
    const choose = app.slice(ci, app.indexOf('\n}\n', ci));
    assert.ok(/welcomeCloseFlow\(\);/.test(choose), 'No radio yet ends the flow');
    assert.ok(!/openSettingsDialog\(/.test(choose), 'Here stays in the Welcome (which radio, then the radio check)');
    const radio = readSrc(path.join(__dirname, '..', 'renderer', 'first-run-radio.js'));
    assert.ok(/closeFlow: \(\) => welcomeCloseFlow\(\),/.test(app), 'the radio check ends the flow the same way');
    assert.ok(/flow\(\)\.closeFlow\(\);/.test(radio.slice(radio.indexOf('async function endCheck('))), 'Done and Skip close through it');
    const cl = app.indexOf("welcomeDialog.addEventListener('close', () => {");
    assert.ok(cl > 0 && /if \(_welcomeStationSaved && typeof window\.stationSetupAfterWelcome === 'function'\) window\.stationSetupAfterWelcome\(\);/.test(app.slice(cl, cl + 300)),
      'Esc after the station step runs it too; before it (firstRun still set) it does not');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
