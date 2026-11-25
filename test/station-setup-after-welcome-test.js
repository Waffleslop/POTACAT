// #1072: the Station Setup launch card must be offered when Welcome finishes,
// not lost because the one 12 s launch check ran while firstRun was still set.
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
  const shown = [];
  const el = () => new Proxy(function () {}, {
    get(_t, k) {
      if (k === 'open') return false;
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      if (k === 'style' || k === 'dataset') return {};
      if (k === 'textContent' || k === 'innerHTML' || k === 'value') return '';
      return () => el();
    },
    set() { return true; },
    apply() { return el(); },
  });
  const window = {
    api: new Proxy({ stationSetupGet: async () => getResult() }, {
      get: (t, k) => (k in t ? t[k] : async () => ({})),
    }),
  };
  const document = {
    getElementById: () => el(),
    createElement: () => el(),
    querySelector: () => el(),
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
  // Count card shows through the "Continue setup" label the check sets.
  const src = readSrc(path.join(__dirname, '..', 'renderer', 'station-setup.js'));
  vm.runInContext(src, ctx, { filename: 'station-setup.js' });
  return { window, timers, shown };
}

(async () => {
  const state = { firstRun: true };
  const result = () => ({
    rig: { id: 'r1', model: 'IC-7300' },
    summary: { requiredNeverDone: 2 },
    launch: { firstRun: state.firstRun, prompt: true, newSteps: [] },
  });
  let gets = 0;
  const h = load(() => { gets++; return result(); });

  await t('the 12 s launch check while Welcome is open shows nothing', async () => {
    assert.strictEqual(h.timers[0].ms, 12000);
    await h.timers[0].fn();
    assert.strictEqual(gets, 1);
  });

  await t('Welcome finishing schedules the check again (Get Started)', async () => {
    assert.strictEqual(typeof h.window.stationSetupAfterWelcome, 'function');
    const before = h.timers.length;
    state.firstRun = false;
    h.window.stationSetupAfterWelcome();
    assert.strictEqual(h.timers.length, before + 1);
    await h.timers[before].fn();
    assert.strictEqual(gets, 2, 'the check ran and read the setup state again');
  });

  await t('after Welcome with no skipped check, nothing is scheduled twice', async () => {
    const h2 = load(() => result());
    state.firstRun = false;
    await h2.timers[0].fn();       // normal launch, firstRun already clear
    const n = h2.timers.length;
    h2.window.stationSetupAfterWelcome();
    assert.strictEqual(h2.timers.length, n);
  });

  await t('app.js calls the hook when Get Started saves', () => {
    const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
    assert.ok(/welcomeDialog\.close\(\);[\s\S]{0,200}stationSetupAfterWelcome/.test(app));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
