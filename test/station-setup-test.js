// Station Setup checklist (lib/station-setup.js) — the policy for every radio
// in the first set, every step state, the launch prompt and the "new for your
// radio" card — plus guards on the main/renderer wiring that fails silently.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SS = require('../lib/station-setup');
const { resolveSetupNotes } = require('../lib/rig-setup-notes');
const { RIG_MODELS } = require('../lib/rig-models');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + '\n    ' + (err && err.stack || err)); }
}

const LIVE_OK = {
  callsign: 'K3SBP', grid: 'FN20', catConnected: true, freqHz: 14074000,
  clock: { level: 'ok', offsetMs: 40 },
  rxTest: { result: 'ok', dbfs: -30 }, txDeviceTest: { ok: true },
  txTest: { result: 'ok', watts: 5, swr: 1.2 },
};

function evalRig({ model, radioType = 'serialcat', audioSource = '', platform = 'win32', live = {}, prefs = {}, input = 'in1', output = 'out1', active = true }) {
  const notes = resolveSetupNotes({ model, modelInfo: RIG_MODELS[model] || null, radioType, platform, done: prefs.confirmed || [] });
  return SS.evaluateChecklist({
    rig: { id: 'r1', name: model, model, radioType, audioSource, inputDeviceId: input, outputDeviceId: output, active },
    modelInfo: RIG_MODELS[model] || null,
    platform, notes,
    live: { ...LIVE_OK, ...live },
    prefs,
  });
}
const step = (res, id) => res.steps.find(s => s.id === id);
const ids = (res) => res.steps.map(s => s.id);

console.log('Station Setup');

// --- the six radios ---
t('every phase-1 radio exists in RIG_MODELS under the name the checklist is keyed on', () => {
  for (const m of ['FT-710', 'IC-7300', 'FT-891', 'FTDX10', 'IC-705', 'QMX']) assert.ok(RIG_MODELS[m], m);
});

t('IC-7300 (Icom CI-V): basics + clock + CW keying from the confirmed Icom note; no band scope', () => {
  const r = evalRig({ model: 'IC-7300', radioType: 'icom' });
  assert.deepStrictEqual(ids(r), ['station-identity', 'radio-control', 'rx-audio', 'tx-audio', 'tx-test', 'clock', 'cw-keying']);
  assert.ok(step(r, 'cw-keying').instructions.some(b => /USB Keying \(CW\)/.test(b.steps.join(' '))));
  assert.strictEqual(r.summary.complete, true);
});

t('FT-710: band scope step, marked new in 1.10.23', () => {
  const r = evalRig({ model: 'FT-710', live: { scope: { libraryFound: false, d2xxFound: true } } });
  const sc = step(r, 'band-scope');
  assert.ok(sc);
  assert.strictEqual(sc.since, '1.10.23');
  assert.strictEqual(sc.level, 'optional');
});

t('FT-891 and FTDX10: CW keying step carries their PC KEYING note', () => {
  for (const m of ['FT-891', 'FTDX10']) {
    const r = evalRig({ model: m });
    assert.ok(step(r, 'cw-keying'), m);
    assert.ok(step(r, 'cw-keying').instructions.some(b => /PC KEYING/.test(b.title + b.steps.join(' '))), m);
    assert.ok(!step(r, 'band-scope'), m);
  }
});

t('IC-705: basics and the Icom CW note', () => {
  const r = evalRig({ model: 'IC-705', radioType: 'icom' });
  assert.ok(step(r, 'cw-keying'));
  assert.ok(!step(r, 'band-scope'));
});

t('QMX: the test transmit never exceeds the radio\'s 5 W', () => {
  const r = evalRig({ model: 'QMX', live: { txTest: null } });
  const tx = step(r, 'tx-test');
  assert.strictEqual(tx.state, 'unknown');
  assert.ok(tx.actions.some(a => a.label === 'Test transmit at 5 W'), JSON.stringify(tx.actions));
});

t('100 W radio tests at 5 W', () => {
  const r = evalRig({ model: 'FT-710', live: { txTest: null } });
  assert.ok(step(r, 'tx-test').actions.some(a => a.label === 'Test transmit at 5 W'));
});

t('Flex (network audio): audio steps follow radio control, no device pickers', () => {
  const r = evalRig({ model: 'FLEX-8400/8600', radioType: 'flex', audioSource: 'smartsdr', input: '', output: '', live: { rxTest: null, txDeviceTest: null } });
  assert.strictEqual(step(r, 'rx-audio').state, 'ok');
  assert.strictEqual(step(r, 'tx-audio').state, 'ok');
  assert.ok(!step(r, 'cw-keying'));
  const off = evalRig({ model: 'FLEX-8400/8600', radioType: 'flex', audioSource: 'smartsdr', input: '', output: '', live: { catConnected: false, rxTest: null, txDeviceTest: null, txTest: null } });
  assert.strictEqual(step(off, 'rx-audio').state, 'blocked');
  assert.strictEqual(step(off, 'tx-test').state, 'blocked');
});

// --- step states ---
t('identity: missing callsign or grid needs the operator, with an Open Settings button', () => {
  const r = evalRig({ model: 'IC-7300', live: { grid: '' } });
  const s = step(r, 'station-identity');
  assert.strictEqual(s.state, 'needs');
  assert.ok(s.actions.some(a => a.id === 'open-settings'));
});

t('radio control: disconnected = plain-language steps + CAT notes; inactive rig = "switch to it", not a fault', () => {
  const r = evalRig({ model: 'FT-891', live: { catConnected: false } });
  const s = step(r, 'radio-control');
  assert.strictEqual(s.state, 'needs');
  assert.match(s.instructions[0].steps.join(' '), /switched on and its USB cable/);
  assert.ok(s.instructions.some(b => b.noteId === 'cat-rate-matches'));
  const i = evalRig({ model: 'FT-891', active: false, live: { catConnected: false } });
  assert.strictEqual(step(i, 'radio-control').state, 'unknown');
  assert.match(step(i, 'radio-control').detail, /not the radio in use/);
});

t('listen test: ok / low (still ok) / silent / error / unsupported / none yet', () => {
  const st = (rx) => step(evalRig({ model: 'IC-7300', live: { rxTest: rx } }), 'rx-audio');
  assert.strictEqual(st({ result: 'ok', dbfs: -30 }).state, 'ok');
  const low = st({ result: 'low', dbfs: -60 });
  assert.strictEqual(low.state, 'ok');
  assert.match(low.detail, /quietly/);
  assert.strictEqual(st({ result: 'silent', dbfs: -95 }).state, 'needs');
  assert.strictEqual(st({ result: 'error', error: 'NotFoundError' }).state, 'needs');
  assert.strictEqual(st({ result: 'unsupported' }).state, 'unknown');
  const none = st(null);
  assert.strictEqual(none.state, 'unknown');
  assert.ok(none.actions.some(a => a.id === 'rx-test'));
});

t('no audio device chosen: rx and tx need the operator, and the TX test waits', () => {
  const r = evalRig({ model: 'IC-7300', input: '', output: '', live: { rxTest: null, txDeviceTest: null, txTest: null } });
  assert.strictEqual(step(r, 'rx-audio').state, 'needs');
  assert.strictEqual(step(r, 'tx-audio').state, 'needs');
  assert.strictEqual(step(r, 'tx-test').state, 'blocked');
});

t('test transmit outcomes map to plain next steps', () => {
  const tx = (txTest) => step(evalRig({ model: 'FT-710', live: { txTest } }), 'tx-test');
  assert.strictEqual(tx({ result: 'ok', watts: 5 }).state, 'ok');
  const un = tx({ result: 'unmeasured' });
  assert.strictEqual(un.state, 'needs');
  assert.ok(un.actions.some(a => a.id === 'tx-test-confirm'));
  const np = tx({ result: 'no-power' });
  assert.strictEqual(np.state, 'needs');
  assert.match(np.instructions[0].steps.join(' '), /audio is not reaching the radio/);
  assert.match(tx({ result: 'swr-high', swr: 4.2 }).detail, /SWR was 4\.2/);
  const man = tx({ result: 'error', message: 'cannot read', needsManualPower: true });
  assert.ok(man.actions.some(a => a.id === 'tx-test-current-power'));
  const unrestored = tx({ result: 'ok', watts: 5, restored: false, restoreNote: 'Check the power on the radio.' });
  assert.match(unrestored.detail, /Check the power on the radio/);
});

t('clock: unknown offers a check, bad offers the fix', () => {
  assert.strictEqual(step(evalRig({ model: 'IC-7300', live: { clock: null } }), 'clock').state, 'unknown');
  const bad = step(evalRig({ model: 'IC-7300', live: { clock: { level: 'bad', offsetMs: 2400 } } }), 'clock');
  assert.strictEqual(bad.state, 'needs');
  assert.ok(bad.actions.some(a => a.id === 'sync-clock'));
  assert.strictEqual(bad.level, 'recommended', 'the clock never counts toward the launch prompt');
});

t('CW: an operator-confirmed menu note shows "confirmed", never the measured tick', () => {
  const cw = step(evalRig({ model: 'FT-891', prefs: { confirmed: ['ft891-pc-keying'] } }), 'cw-keying');
  assert.strictEqual(cw.state, 'confirmed');
  assert.strictEqual(step(evalRig({ model: 'FT-891' }), 'cw-keying').state, 'optional');
});

t('band scope: driver missing (Windows) -> driver page; library missing -> download + "Find the file for me"', () => {
  const drv = step(evalRig({ model: 'FT-710', live: { scope: { libraryFound: false, d2xxFound: false } } }), 'band-scope');
  assert.strictEqual(drv.state, 'needs');
  assert.ok(drv.actions.some(a => a.id === 'open-ftdi-driver'));
  const lib = step(evalRig({ model: 'FT-710', live: { scope: { libraryFound: false, d2xxFound: true } } }), 'band-scope');
  assert.strictEqual(lib.state, 'needs');
  assert.deepStrictEqual(lib.actions.map(a => a.id), ['open-ftdi-download', 'locate-ft4222', 'skip']);
  assert.match(lib.instructions[0].steps.join(' '), /amd64/);
});

t('band scope: installed but never run -> open the scope; live -> ok; helper diagnosis shown; skip/unskip', () => {
  const ready = step(evalRig({ model: 'FT-710', live: { scope: { libraryFound: true, d2xxFound: true, status: 'stopped' } } }), 'band-scope');
  assert.strictEqual(ready.state, 'unknown');
  assert.ok(ready.actions.some(a => a.id === 'open-scope'));
  assert.match(ready.detail, /03-01-26 SCU-LAN10/);
  assert.strictEqual(step(evalRig({ model: 'FT-710', live: { scope: { libraryFound: true, d2xxFound: true, status: 'live' } } }), 'band-scope').state, 'ok');
  const diag = step(evalRig({ model: 'FT-710', live: { scope: { libraryFound: true, d2xxFound: true, status: 'blocked', diagKey: 'no-device', diagHeadline: 'No FT4222 device found on USB', diagAction: 'Turn the radio on.' } } }), 'band-scope');
  assert.strictEqual(diag.state, 'needs');
  assert.strictEqual(diag.detail, 'No FT4222 device found on USB');
  const sk = step(evalRig({ model: 'FT-710', prefs: { skipped: ['band-scope'] }, live: { scope: { libraryFound: false, d2xxFound: true } } }), 'band-scope');
  assert.strictEqual(sk.state, 'skipped');
  assert.ok(sk.actions.some(a => a.id === 'unskip'));
});

// --- summary, remembered passes, the launch prompt ---
t('summary: next = first unfinished required step that is not waiting on another', () => {
  const r = evalRig({ model: 'IC-7300', live: { rxTest: null, txTest: null } });
  assert.strictEqual(r.summary.next, 'rx-audio');
  assert.strictEqual(r.summary.requiredLeft, 2);
});

t('a test that passed in an earlier session shows "Worked on <date>" and is not asked about again', () => {
  const at = Date.parse('2026-09-20T12:00:00Z');
  const r = evalRig({ model: 'IC-7300', live: { rxTest: null, txDeviceTest: null, txTest: null }, prefs: { passed: { 'rx-audio': at, 'tx-audio': at, 'tx-test': at } } });
  assert.strictEqual(step(r, 'rx-audio').state, 'ok');
  assert.match(step(r, 'rx-audio').detail, /Worked on 2026-09-20/);
  assert.strictEqual(step(r, 'tx-test').state, 'ok');
  assert.strictEqual(r.summary.requiredLeft, 0);
});

t('launch prompt: only required steps that have NEVER worked; a radio that is just switched off does not nag', () => {
  const at = Date.now();
  const allPassed = { 'station-identity': at, 'radio-control': at, 'rx-audio': at, 'tx-audio': at, 'tx-test': at };
  const off = evalRig({ model: 'FT-710', live: { catConnected: false, rxTest: null, txDeviceTest: null, txTest: null }, prefs: { passed: allPassed } });
  assert.ok(off.summary.requiredLeft > 0, 'the checklist itself shows the live truth');
  assert.strictEqual(SS.shouldPromptAtLaunch(off, {}), false);
  const fresh = evalRig({ model: 'FT-710', live: { txTest: null } });
  assert.strictEqual(SS.shouldPromptAtLaunch(fresh, {}), true);
  assert.strictEqual(SS.shouldPromptAtLaunch(fresh, { hidden: true }), false, '"Don\'t ask again" is final');
  const optionalOnly = evalRig({ model: 'FT-710', live: { scope: { libraryFound: false, d2xxFound: true } } });
  assert.strictEqual(SS.shouldPromptAtLaunch(optionalOnly, {}), false, 'optional features never nag');
});

t('"new for your radio": once, after the update that added it, only while not working', () => {
  const r = evalRig({ model: 'FT-710', live: { scope: { libraryFound: false, d2xxFound: true } } });
  assert.deepStrictEqual(SS.newStepsSince(r, '1.10.22', {}).map(s => s.id), ['band-scope']);
  assert.deepStrictEqual(SS.newStepsSince(r, '1.10.23', {}), [], 'already on the version that added it');
  assert.deepStrictEqual(SS.newStepsSince(r, null, {}), [], 'fresh install: the checklist itself covers it');
  assert.deepStrictEqual(SS.newStepsSince(r, '1.10.22', { announced: ['band-scope'] }), [], 'shown once');
  assert.deepStrictEqual(SS.newStepsSince(r, '1.10.22', { hidden: true }), []);
  const live = evalRig({ model: 'FT-710', live: { scope: { libraryFound: true, d2xxFound: true, status: 'live' } } });
  assert.deepStrictEqual(SS.newStepsSince(live, '1.10.22', {}), [], 'already working: nothing to announce');
  const other = evalRig({ model: 'IC-7300' });
  assert.deepStrictEqual(SS.newStepsSince(other, '1.10.22', {}), [], 'an IC-7300 owner never hears about the FT-710 scope');
});

t('cmpVersion', () => {
  assert.strictEqual(SS.cmpVersion('1.10.23', '1.10.22'), 1);
  assert.strictEqual(SS.cmpVersion('1.10.9', '1.10.10'), -1);
  assert.strictEqual(SS.cmpVersion('1.10.22', '1.10.22'), 0);
});

t('peMachine tells the 64-bit LibFT4222 from the 32-bit one', () => {
  const pe = (machine) => {
    const b = Buffer.alloc(0x100);
    b.write('MZ', 0, 'latin1');
    b.writeUInt32LE(0x80, 0x3c);
    b.writeUInt32LE(0x00004550, 0x80);
    b.writeUInt16LE(machine, 0x84);
    return b;
  };
  assert.strictEqual(SS.peMachine(pe(0x8664)), 'x64');
  assert.strictEqual(SS.peMachine(pe(0x14c)), 'x86');
  assert.strictEqual(SS.peMachine(Buffer.from('not a dll')), null);
  const real = path.join(__dirname, '..', 'assets', 'hamlib', 'libhamlib-4.dll');
  if (fs.existsSync(real)) assert.strictEqual(SS.peMachine(fs.readFileSync(real)), 'x64');
});

// --- wiring guards ---
t('main.js: settings saves keep setup progress; test-transmit restore trusts only a readback; scope finds our FTDI copy', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\s+/g, ' ');
  const has = (snip) => assert.ok(main.includes(snip.replace(/\s+/g, ' ')), 'main.js missing: ' + snip);
  has("const SETUP_KEYS = ['setupPassed', 'setupSkipped', 'setupChecklistHidden', 'setupAnnounced'];");
  has('_lastPowerReadback = { watts: Number(watts) || 0, at: Date.now() }; if (!isRemoteActive()) stationSetupReconcilePower(Number(watts) || 0);');
  has('const back = await waitForPowerReadback(sentAt, (w) => w > testW + 0.5, 6000);');
  has("if (process.platform === 'win32') pre('PATH', ';');");
  has("proc = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env });");
  has("_stationSetupLaunchLastVersion = settings.lastVersion || null;");
  for (const ch of ['station-setup-get', 'station-setup-report', 'station-setup-action']) has(`ipcMain.handle('${ch}'`);
  // The only transmit paths are operator actions: never an automatic check.
  assert.ok(!/autoChecks[^}]*tx-test/.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'station-setup.js'), 'utf8')), 'tx-test must never be an automatic check');
});

t('renderer: window, entry points, launch card, bug-report line', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const id of ['station-setup-dialog', 'station-setup-card', 'view-station-setup-btn', 'settings-station-setup-btn']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('<script src="station-setup.js"></script>'));
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const fn of ['stationSetupGet', 'stationSetupReport', 'stationSetupAction', 'onStationSetupChanged']) assert.ok(pre.includes(fn + ':'), fn);
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(app.includes("'**Station Setup:** ' + md.stationSetup"));
  assert.ok(app.includes('window.openStationSetup(newId)'), 'Add Rig opens the checklist');
});

console.log(`Station Setup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
