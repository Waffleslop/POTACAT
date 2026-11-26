// A shorter first run (lib/first-run.js): which step opens, Back, resume, what
// Esc keeps, the grid square left unset, firstRun turning false at the station
// step only, and the local milestone markers.
'use strict';
const assert = require('assert');
const FR = require('../lib/first-run');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + '\n    ' + (err && err.stack || err)); }
}

console.log('A shorter first run');

t('a new install opens at the station step, every launch until it is finished', () => {
  assert.strictEqual(FR.openAt({ firstRun: true }), 'station');
  assert.strictEqual(FR.openAt({ firstRun: true, firstRunState: { step: 'where' } }), 'station');
});

t('an existing install sees nothing unasked', () => {
  assert.strictEqual(FR.openAt({ firstRun: false }), null);
  assert.strictEqual(FR.openAt({}), null);
  assert.strictEqual(FR.resumeStep({ firstRun: false }), 'station', 'no state: a card would start at the beginning');
});

t('closing part-way does not reopen the flow at launch; the card resumes at that step', () => {
  const s = { firstRun: false, firstRunState: { step: 'where' } };
  assert.strictEqual(FR.openAt(s), null);
  assert.strictEqual(FR.resumeStep(s), 'where');
  assert.strictEqual(FR.resumeStep({ firstRun: false, firstRunState: { step: 'done' } }), null);
  assert.strictEqual(FR.resumeStep({ firstRun: true, firstRunState: { step: 'where' } }), 'station');
});

t('F11 opens the station step on any install', () => {
  assert.strictEqual(FR.openAt({ firstRun: false }, { force: true }), 'station');
});

t('Next and Back walk the steps; Back from the first step goes nowhere', () => {
  assert.deepStrictEqual(FR.STEPS.slice(0, 4), ['station', 'where', 'radio', 'check']);
  assert.strictEqual(FR.nextStep('station'), 'where');
  assert.strictEqual(FR.backStep('where'), 'station');
  assert.strictEqual(FR.backStep('station'), null);
  assert.strictEqual(FR.nextStep('nonsense'), null);
  assert.strictEqual(FR.stepLabel('station'), 'Step 1 of ' + FR.STEPS.length);
});

t('finishing the station step is the save that turns firstRun false', () => {
  const r = FR.finishStation(null, { callsign: ' k1abc ', grid: 'fn20JB', telemetry: true, appVersion: '1.14.9' });
  assert.ok(!r.error);
  assert.strictEqual(r.patch.firstRun, false);
  assert.strictEqual(r.patch.myCallsign, 'K1ABC');
  assert.strictEqual(r.patch.grid, 'FN20jb');
  assert.strictEqual(r.patch.enableTelemetry, true);
  assert.strictEqual(r.patch.lastVersion, '1.14.9');
  assert.strictEqual(r.state.step, 'where');
  assert.strictEqual(r.patch.firstRunState.step, 'where');
});

t('the statistics box is the operator\'s: unticked saves off', () => {
  const r = FR.finishStation(null, { callsign: 'K1ABC', grid: '', telemetry: false });
  assert.strictEqual(r.patch.enableTelemetry, false);
});

t('no later step touches firstRun or the statistics choice', () => {
  for (const c of Object.keys(FR.WHERE)) {
    const r = FR.chooseWhere({ step: 'where' }, c);
    assert.ok(!('firstRun' in r.patch) && !('enableTelemetry' in r.patch), c);
  }
  const f = FR.finishFlow({ step: 'where' });
  assert.ok(!('firstRun' in f.patch) && !('enableTelemetry' in f.patch));
  const k = FR.keepDraft({}, { callsign: 'K1ABC' });
  assert.ok(!('firstRun' in k));
});

t('a blank grid is left unset, never FN20jb, and the screen says so', () => {
  const r = FR.finishStation(null, { callsign: 'K1ABC', grid: '   ', telemetry: true });
  assert.strictEqual(r.patch.grid, '');
  assert.ok(/No grid square yet/.test(FR.gridNote('')));
  assert.ok(/Settings > Station/.test(FR.gridNote('')));
  assert.ok(!/No grid square/.test(FR.gridNote('FN20')));
});

t('a grid that is not a grid square is refused with a sentence, and nothing is saved', () => {
  const r = FR.finishStation(null, { callsign: 'K1ABC', grid: 'Philadelphia' });
  assert.ok(r.error && /4 or 6 characters/.test(r.error));
  assert.ok(!r.patch);
  for (const g of ['FN2', 'FN20j', 'ZZ20', 'FN20jbx']) assert.ok(FR.readGrid(g).error, g);
  for (const g of ['FN20', 'fn20jb', 'FN20JB12', 'IO91wm']) assert.ok(!FR.readGrid(g).error, g);
  assert.strictEqual(FR.readGrid('io91WM').grid, 'IO91wm');
});

t('Esc keeps what was typed; the next open shows it', () => {
  const st = FR.keepDraft(null, { callsign: 'k1abc', grid: 'FN2' });
  const s = { firstRun: true, myCallsign: '', grid: '', enableTelemetry: true, firstRunState: st };
  assert.strictEqual(FR.openAt(s), 'station');
  assert.deepStrictEqual(FR.stationFields(s), { callsign: 'K1ABC', grid: 'FN2', telemetry: true });
  // Finishing clears the draft.
  const r = FR.finishStation(st, { callsign: 'K1ABC', grid: 'FN20', telemetry: true });
  assert.strictEqual(r.state.draft, null);
});

t('F11 on an existing install shows the saved values; unset statistics stay unticked', () => {
  const s = { firstRun: false, myCallsign: 'W1AW', grid: 'FN31pr' };
  assert.deepStrictEqual(FR.stationFields(s), { callsign: 'W1AW', grid: 'FN31pr', telemetry: false });
  assert.strictEqual(FR.stationFields({ enableTelemetry: true }).telemetry, true);
});

t('where is your radio: here goes on to which radio, another computer the pairing panel, no radio the spots', () => {
  const here = FR.chooseWhere({ step: 'where' }, 'here');
  assert.strictEqual(here.action, 'radio-step');
  assert.strictEqual(here.state.step, 'radio', 'a close here resumes at which radio');
  assert.strictEqual(here.state.where, 'here');
  const remote = FR.chooseWhere({ step: 'where' }, 'remote');
  assert.strictEqual(remote.action, 'remote-panel');
  assert.strictEqual(remote.state.step, 'where', 'still on the step until Get Started');
  assert.strictEqual(FR.finishFlow(remote.state).state.step, 'done');
  const none = FR.chooseWhere({ step: 'where' }, 'none');
  assert.strictEqual(none.action, 'spots');
  assert.ok(FR.chooseWhere({}, 'elsewhere').error);
});

t('which radio, then the radio check: saved radio, Back, and how the check ended', () => {
  const r = FR.saveRadio({ step: 'radio', where: 'here' }, 'rig_123');
  assert.strictEqual(r.state.step, 'check');
  assert.strictEqual(r.state.rigId, 'rig_123', 'Back and Save again changes this radio, not a new one');
  assert.deepStrictEqual(r.patch, { firstRunState: r.state });
  assert.strictEqual(FR.backStep('check'), 'radio');
  assert.strictEqual(FR.backStep('radio'), 'where');
  assert.strictEqual(FR.atStep(r.state, 'radio').state.step, 'radio');
  assert.strictEqual(FR.atStep(r.state, 'station').state.step, 'check', 'the station step is reopened only by F11');
  assert.strictEqual(FR.resumeStep({ firstRun: false, firstRunState: r.state }), 'check');
  const p = FR.finishCheck(r.state, 'passed', 1000);
  assert.strictEqual(p.state.step, 'done');
  assert.deepStrictEqual(p.state.radioCheck, { result: 'passed', at: 1000 });
  assert.strictEqual(p.state.milestones.radioCheck, 1000, 'a pass is the radioCheck marker');
  assert.strictEqual(FR.milestoneDone({ firstRunState: p.state }, 'radioCheck'), true);
  assert.strictEqual(FR.radioCheckResult({ firstRunState: p.state }), 'passed');
  for (const res of ['failed', 'skipped']) {
    const q = FR.finishCheck(r.state, res, 2000);
    assert.strictEqual(q.state.step, 'done');
    assert.strictEqual(q.state.radioCheck.result, res, res + ' is kept for the card');
    assert.ok(!q.state.milestones.radioCheck, res + ' is not a pass');
    assert.strictEqual(FR.radioCheckResult({ firstRunState: JSON.parse(JSON.stringify(q.state)) }), res);
  }
  assert.ok(FR.finishCheck(r.state, 'maybe').error);
  assert.strictEqual(FR.radioCheckResult({}), null, 'never run');
  // None of these touch firstRun or the statistics choice.
  for (const x of [r.patch, p.patch, FR.atStep(r.state, 'radio').patch]) assert.deepStrictEqual(Object.keys(x), ['firstRunState']);
});

t('damaged or old state reads as a fresh start, keeping only good markers', () => {
  const fresh = { step: 'station', where: null, draft: null, milestones: {}, rigId: null, radioCheck: null };
  assert.deepStrictEqual(FR.normalize(null), fresh);
  assert.deepStrictEqual(FR.normalize('x'), fresh);
  const n = FR.normalize({ step: 'later', where: 'moon', milestones: { firstQso: 5, cloudOn: 'no', other: 9 }, rigId: 7, radioCheck: { result: 'great' } });
  assert.deepStrictEqual(n, { ...fresh, milestones: { firstQso: 5 } });
});

t('milestones: recorded once, kept local, and the existing phone flag counts', () => {
  let st = FR.markMilestone(null, 'radioCheck', 1000);
  st = FR.markMilestone(st, 'radioCheck', 2000);
  assert.strictEqual(st.milestones.radioCheck, 1000, 'the first time stays');
  st = FR.markMilestone(st, 'bogus', 3000);
  assert.ok(!('bogus' in st.milestones));
  assert.strictEqual(FR.milestoneDone({ firstRunState: st }, 'radioCheck'), true);
  assert.strictEqual(FR.milestoneDone({ firstRunState: st }, 'firstQso'), false);
  assert.strictEqual(FR.milestoneDone({ echocatAppConnected: true }, 'phoneConnected'), true);
  assert.deepStrictEqual(FR.MILESTONES, ['radioCheck', 'cloudOn', 'phoneConnected', 'firstQso', 'logImported']);
});

t('nothing fills a blank grid with FN20jb: defaults, the Settings save, the maps', () => {
  const path = require('path');
  const { readSrc } = require('./_src');
  const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
  const main = R('main.js'), app = R('renderer/app.js'), prop = R('renderer/prop-popout.js');
  const fresh = (main.match(/return \{ catTarget: null,[^\n]*enableTelemetry: true[^\n]*\};/) || [''])[0];
  assert.ok(fresh && !/grid:/.test(fresh), 'fresh-install defaults carry no grid');
  for (const [name, src] of [['main.js', main], ['app.js', app], ['prop-popout.js', prop]]) {
    assert.ok(!/grid[^\n]*\|\| '(FN20jb|FN20)'/.test(src), name + ' substitutes a made-up grid');
  }
  assert.ok(/grid: setGrid\.value\.trim\(\),/.test(app), 'the Settings save keeps a blank grid blank');
  assert.ok(/if \(!pos\) \{ mainHomePos = null; return; \}/.test(app), 'no home marker without a grid');
  assert.ok(/if \(!pos\) \{ rbnHomePos = null; return; \}/.test(app), 'no RBN home without a grid');
});

t('firstRunState is machine-scoped and is not a secret', () => {
  const path = require('path');
  const { readSrc } = require('./_src');
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const g = main.slice(main.indexOf('const GLOBAL_KEYS = new Set(['), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS = new Set([')));
  assert.ok(/'firstRunState',/.test(g));
  const secrets = readSrc(path.join(__dirname, '..', 'lib', 'settings-secrets.js'));
  assert.ok(!/firstRunState/.test(secrets));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
