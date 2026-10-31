#!/usr/bin/env node
'use strict';
// ATU Calibration Wizard (lib/atu-wizard.js): the plan builder against the
// privilege table, the point classifier, the run loop against a fake Flex,
// and guards on the main.js / smartsdr.js / station-setup wiring.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/atu-wizard');
const { OWNERS } = require('../lib/radio-owner');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + '\n    ' + (err && err.stack || err)); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + '\n    ' + (err && err.stack || err)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('ATU wizard — plan');
const HF = ['40m', '30m', '20m', '17m', '15m', '12m', '10m'];

t('the Normal plan for 40-10 m under Extra is the handoff table: 56 points (FT2 on every band the app dials)', () => {
  const { points, dropped } = W.buildPlan({ bands: HF, licenseClass: 'us_extra' });
  assert.strictEqual(points.length, 56, JSON.stringify(points.map(p => p.freqKhz)));
  assert.strictEqual(dropped.length, 0, JSON.stringify(dropped));
  const khz = points.map(p => p.freqKhz);
  for (const k of [7025, 7047.5, 7052, 7074, 7090, 10136, 14074, 14080, 14084, 14090, 28600]) assert.ok(khz.includes(k), `${k} missing`);
  assert.ok(!points.some(p => p.band === '30m' && p.mode === 'SSB'), '30 m has no SSB');
});

t('digital dials come from the app tables, never retyped', () => {
  const E = require('../lib/ft8-engine');
  const d = W.digitalDials('20m').map(x => x.khz);
  assert.deepStrictEqual(d, [E.DIGITAL_FREQS['20m'], E.freqsForMode('FT4')['20m'], E.FT2_FREQS['20m'], W.JTTY_KHZ['20m']].sort((a, b) => a - b));
  // JTTY dials pinned to the JTCAT window's table.
  const pop = R('renderer/jtcat-popout.js');
  const m = pop.match(/JTTY_BAND_FREQS = \{([\s\S]*?)\};/);
  assert.ok(m, 'JTTY_BAND_FREQS in renderer/jtcat-popout.js');
  for (const [band, khz] of Object.entries(W.JTTY_KHZ)) assert.ok(new RegExp(`'${band}':\\s*${khz}\\b`).test(m[1]), `${band} JTTY ${khz}`);
});

t('General drops the edge CW points and 7.150 phone; the class filter decides, not the table', () => {
  const { points, dropped } = W.buildPlan({ bands: HF, licenseClass: 'us_general' });
  const khz = points.map(p => p.freqKhz);
  for (const k of [7025, 14025, 21025, 7150]) assert.ok(!khz.includes(k), `${k} should be dropped`);
  assert.ok(dropped.some(d => d.freqKhz === 7025 && /edge/.test(d.reason)));
  assert.ok(dropped.some(d => d.freqKhz === 7150 && /privileges/.test(d.reason)));
  assert.ok(khz.includes(7040) && khz.includes(14225) === false && khz.includes(14250));
});

t('every point stays 3 kHz inside its segment under every class', () => {
  for (const cls of ['none', 'us_extra', 'us_general', 'us_technician', 'ca_basic', 'ca_honours']) {
    for (const density of ['normal', 'dense']) {
      const { points } = W.buildPlan({ bands: W.BANDS, licenseClass: cls, density });
      for (const p of points) {
        const v = W.pointAllowed(p.freqKhz, p.mode, cls, 3);
        assert.ok(v.ok, `${cls} ${density} ${p.band} ${p.mode} ${p.freqKhz}: ${v.reason}`);
      }
    }
  }
});

t('Technician has no HF phone below 10 m and keeps CW on 40/15/10', () => {
  const { points } = W.buildPlan({ bands: HF, licenseClass: 'us_technician' });
  assert.ok(!points.some(p => p.mode === 'SSB' && p.band !== '10m'));
  assert.ok(points.some(p => p.band === '40m' && p.mode === 'CW'));
  assert.ok(!points.some(p => p.band === '20m'), 'no 20 m for a Technician');
});

t('dense fills each segment on the band step and merges within 2 kHz, dial labels winning', () => {
  const { points } = W.buildPlan({ bands: ['20m'], licenseClass: 'us_extra', density: 'dense' });
  const steps = points.filter(p => p.label === 'step');
  assert.ok(steps.length > 10);
  const at14080 = points.filter(p => Math.abs(p.freqKhz - 14080) <= 2);
  assert.strictEqual(at14080.length, 1);
  assert.strictEqual(at14080[0].label, 'FT4');
  for (let i = 1; i < points.length; i++) assert.ok(points[i].freqKhz - points[i - 1].freqKhz > 2);
});

t('custom points are filtered like any other; a bad one is reported, never transmitted', () => {
  const { points, dropped } = W.buildPlan({ bands: [], licenseClass: 'us_general', custom: [
    { band: '40m', mode: 'SSB', freqKhz: 7188, label: 'net' },
    { band: '40m', mode: 'SSB', freqKhz: 7100, label: 'bad' },
    { band: '20m', mode: 'CW', freqKhz: 14001, label: 'edge' },
  ] });
  assert.deepStrictEqual(points.map(p => p.freqKhz), [7188]);
  assert.strictEqual(dropped.length, 2);
});

t('estimate: the 56-point Normal run is about 11 minutes at the defaults (under 12)', () => {
  const { points } = W.buildPlan({ bands: HF, licenseClass: 'us_extra' });
  const ms = W.estimateRunMs(points);
  assert.ok(ms < 12 * 60 * 1000, `${ms} ms`);
  assert.ok(ms > 9 * 60 * 1000);
});

console.log('ATU wizard — classify');
t('results follow the handoff table', () => {
  const c = (m) => W.classifyPoint(m);
  assert.strictEqual(c({ bypassSwr: 1.3, tunedSwr: null, atuStatus: 'TUNE_BYPASS' }), 'NATIVE');
  assert.strictEqual(c({ bypassSwr: 2.8, tunedSwr: 1.2, atuStatus: 'TUNE_SUCCESSFUL' }), 'TUNED');
  assert.strictEqual(c({ recalled: true, tunedSwr: 1.4, atuStatus: 'TUNE_OK' }), 'RECALLED');
  assert.strictEqual(c({ bypassSwr: 4, tunedSwr: 2.6, atuStatus: 'TUNE_SUCCESSFUL' }), 'MARGINAL');
  assert.strictEqual(c({ bypassSwr: 4, tunedSwr: 3.5, atuStatus: 'TUNE_SUCCESSFUL' }), 'FAILED');
  assert.strictEqual(c({ bypassSwr: 6, atuStatus: 'TUNE_FAIL_BYPASS' }), 'FAILED');
  assert.strictEqual(c({ skipped: true }), 'SKIPPED');
  assert.strictEqual(c({ timeout: true }), 'TIMEOUT');
  assert.strictEqual(c({ recalled: true, tunedSwr: 2.5, atuStatus: 'TUNE_OK' }), 'MARGINAL');
  assert.strictEqual(W.classifyPoint({ bypassSwr: 2.8, tunedSwr: 2.4, atuStatus: 'TUNE_SUCCESSFUL' }, { swrThreshold: 2.5 }), 'TUNED');
});
t('median ignores non-numbers and survives one relay-bounce frame', () => {
  assert.strictEqual(W.median([1.2, 1.3, 9.9, 1.1, null, 1.2]), 1.2);
  assert.strictEqual(W.median([]), null);
});
t('trend flags a bypass rise over 0.5 only', () => {
  const prev = { points: [{ id: 'a', bypassSwr: 1.4 }, { id: 'b', bypassSwr: 1.4 }] };
  const run = { points: [{ id: 'a', bypassSwr: 2.1, band: '20m', freqKhz: 14074 }, { id: 'b', bypassSwr: 1.8 }] };
  assert.deepStrictEqual(W.trendFlags(run, prev).map(f => f.id), ['a']);
});
t('advice names a whole failed band, else the count', () => {
  assert.ok(/15m/.test(W.adviceFor([{ band: '15m', result: 'FAILED' }, { band: '15m', result: 'MARGINAL' }, { band: '20m', result: 'TUNED' }])));
  assert.ok(/1 point did not match/.test(W.adviceFor([{ band: '15m', result: 'FAILED' }, { band: '15m', result: 'TUNED' }])));
  assert.strictEqual(W.adviceFor([{ band: '15m', result: 'TUNED' }]), '');
});
t('CSV has one header and one row per point', () => {
  const csv = W.csvFor({ points: [{ band: '20m', mode: 'CW', freqKhz: 14045, label: '', bypassSwr: 1.4, tunedSwr: 1.1, atuStatus: 'TUNE_SUCCESSFUL', result: 'TUNED', durationMs: 2400 }] });
  assert.strictEqual(csv.trim().split('\n').length, 2);
  assert.ok(csv.includes('20m,CW,14045,,1.4,1.1,TUNE_SUCCESSFUL,TUNED,2400'));
});

// ─── the run against a fake Flex ───
function fakeRadio(behaviour = {}) {
  const r = { log: [], run: null, keyed: false, freqKhz: 0, mode: '', filter: 0, bypassed: false, retuned: false, tunePower: null, memories: null, signal: behaviour.signalDbm ?? -120 };
  const b = { swrBypass: () => 3.0, swrTuned: () => 1.2, tuneStatus: () => 'TUNE_SUCCESSFUL', recall: () => false, ...behaviour };
  const emitAtu = (status, usingMem) => setTimeout(() => r.run && r.run.noteAtuStatus({ status, atu_enabled: '1', memories_enabled: r.memories ? '1' : '0', using_mem: usingMem ? '1' : '0' }), 2);
  let swrTimer = null;
  r.setMemoriesEnabled = (on) => { r.memories = on; r.log.push(`mem ${on ? 1 : 0}`); emitAtu('TUNE_NOT_STARTED', false); };
  r.setTunePower = (w) => { r.tunePower = w; r.log.push(`tunepower ${w}`); };
  r.tune = (khz, mode, filter) => { r.freqKhz = khz; r.mode = mode; r.filter = filter || 0; r.retuned = false; r.log.push(`tune ${khz} ${mode}`); emitAtu(b.recall(khz) ? 'TUNE_OK' : 'TUNE_NOT_STARTED', b.recall(khz)); };
  r.bypass = () => { r.bypassed = true; r.log.push('bypass'); };
  r.startTune = () => {
    r.log.push('atu start'); r.bypassed = false; r.retuned = true;
    emitAtu('TUNE_IN_PROGRESS', false);
    // The radio keys ITSELF for the sweep and the interlock says so.
    setTimeout(() => r.run && r.run.noteInterlock({ state: 'TRANSMITTING' }), 5);
    setTimeout(() => emitAtu(b.tuneStatus(r.freqKhz), false), 15);
  };
  r.keyTune = (on) => {
    r.keyed = on; r.log.push(`key ${on ? 1 : 0}`);
    if (swrTimer) { clearInterval(swrTimer); swrTimer = null; }
    const frame = () => { const swr = r.bypassed ? b.swrBypass(r.freqKhz) : b.swrTuned(r.freqKhz, r.retuned); r.run && r.run.noteSwr(swr, 9.5); };
    if (on) { frame(); swrTimer = setInterval(frame, 2); }
  };
  r.signalDbm = () => r.signal;
  return r;
}
const FAST = { dwellMs: 2000, pauseMs: 5, sampleMs: 400, statusTimeoutMs: 1000, tuneTimeoutMs: 2000, keyedMaxMs: 400 };
// dwell is clamped to MIN_DWELL_MS (2 s) — too long for a test loop, so the
// run's clock is sped up: `now` advances 40x while `sleep` stays real.
function fastHooks(log) {
  const t0 = Date.now();
  return { log: (l) => log.push(l), now: () => t0 + (Date.now() - t0) * 40, sleep: (ms) => new Promise(r => setTimeout(r, Math.max(1, ms / 40))) };
}

(async () => {
  console.log('ATU wizard — run');
  const plan = W.buildPlan({ bands: ['20m'], modes: ['CW'], licenseClass: 'us_extra' }).points; // 3 points

  await ta('a run tunes, reads bypass, tunes the ATU, verifies and classifies every point; the carrier is never left up', async () => {
    const radio = fakeRadio(); const log = [];
    const run = new W.AtuWizardRun(radio, plan, FAST, fastHooks(log));
    radio.run = run;
    const st = await run.start();
    assert.strictEqual(st.phase, 'done');
    assert.deepStrictEqual(st.points.map(p => p.result), ['TUNED', 'TUNED', 'TUNED']);
    assert.ok(st.points.every(p => Math.abs(p.bypassSwr - 3.0) < 0.01 && Math.abs(p.tunedSwr - 1.2) < 0.01), JSON.stringify(st.points));
    assert.strictEqual(radio.keyed, false);
    assert.strictEqual(radio.log[0], 'mem 1');
    assert.ok(radio.log.includes('tunepower 10'));
    assert.strictEqual(radio.log.filter(l => l === 'atu start').length, 3);
    assert.strictEqual(radio.tunePower, 10);
    assert.strictEqual(st.memoriesConfirmed, true);
  });

  await ta('a resonant spot is NATIVE: no ATU tune is started there', async () => {
    const radio = fakeRadio({ swrBypass: (k) => (k === 14045 ? 1.1 : 3.0) }); const log = [];
    const run = new W.AtuWizardRun(radio, plan, FAST, fastHooks(log)); radio.run = run;
    const st = await run.start();
    assert.deepStrictEqual(st.points.map(p => p.result), ['TUNED', 'NATIVE', 'TUNED']);
    assert.strictEqual(radio.log.filter(l => l === 'atu start').length, 2);
  });

  await ta('a stored memory is RECALLED: measured, never re-tuned, no bypass read', async () => {
    const radio = fakeRadio({ recall: (k) => k === 14065, swrTuned: () => 1.3 }); const log = [];
    const run = new W.AtuWizardRun(radio, plan, FAST, fastHooks(log)); radio.run = run;
    const st = await run.start();
    assert.strictEqual(st.points[2].result, 'RECALLED');
    assert.strictEqual(st.points[2].bypassSwr, null);
    assert.strictEqual(radio.log.filter(l => l === 'atu start').length, 2);
  });

  await ta('ATU failure and timeout are recorded and the run goes on', async () => {
    const radio = fakeRadio({ tuneStatus: (k) => (k === 14025 ? 'TUNE_FAIL_BYPASS' : k === 14045 ? 'TUNE_IN_PROGRESS' : 'TUNE_SUCCESSFUL') }); const log = [];
    const run = new W.AtuWizardRun(radio, plan, FAST, fastHooks(log)); radio.run = run;
    const st = await run.start();
    assert.deepStrictEqual(st.points.map(p => p.result), ['FAILED', 'TIMEOUT', 'TUNED']);
    assert.strictEqual(st.phase, 'done');
  });

  await ta('a busy frequency is skipped by default, shifted when asked, and only "ask" waits', async () => {
    const radio = fakeRadio({ signalDbm: -70 }); const log = [];
    let run = new W.AtuWizardRun(radio, plan.slice(0, 1), FAST, fastHooks(log)); radio.run = run;
    let st = await run.start();
    assert.strictEqual(st.points[0].result, 'SKIPPED');
    const radio2 = fakeRadio({ signalDbm: -70 });
    run = new W.AtuWizardRun(radio2, plan.slice(0, 1), { ...FAST, busyAction: 'shift' }, fastHooks(log)); radio2.run = run;
    st = await run.start();
    assert.strictEqual(st.points[0].freqKhz, 14027);
    assert.strictEqual(st.points[0].result, 'TUNED');
    const radio3 = fakeRadio({ signalDbm: -70 });
    run = new W.AtuWizardRun(radio3, plan.slice(0, 1), { ...FAST, busyAction: 'ask' }, fastHooks(log)); radio3.run = run;
    const p = run.start();
    await new Promise(r => setTimeout(r, 150));
    assert.ok(run.state().asking, 'asks the operator');
    run.answerBusy('go');
    st = await p;
    assert.strictEqual(st.points[0].result, 'TUNED');
  });

  await ta('STOP unkeys at once and ends the run; pause holds the loop', async () => {
    const radio = fakeRadio(); const log = [];
    const run = new W.AtuWizardRun(radio, plan, { ...FAST, sampleMs: 300 }, fastHooks(log)); radio.run = run;
    const p = run.start();
    await new Promise(r => setTimeout(r, 90));
    run.pause('test');
    assert.strictEqual(run.phase, 'paused');
    assert.strictEqual(radio.keyed, false);
    run.resume();
    await new Promise(r => setTimeout(r, 70));
    run.stop('operator');
    const st = await p;
    assert.strictEqual(st.phase, 'stopped');
    assert.strictEqual(radio.keyed, false);
    assert.ok(st.points.some(p => !p.result), 'not every point ran');
  });

  await ta('the keyed-carrier watchdog unkeys a read that never ends', async () => {
    const radio = fakeRadio(); const log = [];
    const run = new W.AtuWizardRun(radio, plan.slice(0, 1), { ...FAST, sampleMs: 100000, keyedMaxMs: 60 }, fastHooks(log)); radio.run = run;
    const st = await run.start();
    assert.strictEqual(radio.keyed, false);
    assert.strictEqual(st.phase, 'stopped');
    assert.ok(log.some(l => /WATCHDOG/.test(l)));
  });

  await ta('a verification run never keys and reads using_mem per point', async () => {
    const radio = fakeRadio({ recall: (k) => k !== 14045 }); const log = [];
    const pts = plan.map(p => ({ ...p, bypassSwr: p.freqKhz === 14045 ? 1.2 : null }));
    const run = new W.AtuWizardRun(radio, pts, { ...FAST, verify: true }, fastHooks(log)); radio.run = run;
    const st = await run.start();
    assert.deepStrictEqual(st.points.map(p => p.result), ['RECALLED', 'NATIVE', 'RECALLED']);
    assert.ok(!radio.log.some(l => /^key|atu start|bypass/.test(l)), radio.log.join(','));
  });

  await ta('K3SBP run 1: the radio keying itself for OUR sweep is not "another client" (interlock ignored while sweeping)', async () => {
    const radio = fakeRadio(); const log = [];
    const run = new W.AtuWizardRun(radio, plan, FAST, fastHooks(log)); radio.run = run;
    const st = await run.start();
    assert.strictEqual(st.phase, 'done', log.join('\n'));
    assert.ok(!log.some(l => /paused/.test(l)), 'never paused: ' + log.filter(l => /paused/.test(l)).join('; '));
    assert.deepStrictEqual(st.points.map(p => p.result), ['TUNED', 'TUNED', 'TUNED']);
  });

  await ta('K3SBP run 1: a recalled memory with a bad SWR is re-tuned, not FAILED', async () => {
    // Memory everywhere; stale at 14045 (reads 3.5:1 until the tuner runs again, then 1.3:1).
    const radio = fakeRadio({ recall: () => true, swrTuned: (k, retuned) => (k === 14045 && !retuned ? 3.5 : 1.3) }); const log = [];
    const run = new W.AtuWizardRun(radio, plan, FAST, fastHooks(log)); radio.run = run;
    const st = await run.start();
    assert.deepStrictEqual(st.points.map(p => p.result), ['RECALLED', 'TUNED', 'RECALLED'], JSON.stringify(st.points.map(p => [p.result, p.tunedSwr])));
    assert.strictEqual(st.points[1].recalledSwr, 3.5);
    assert.strictEqual(radio.log.filter(l => l === 'atu start').length, 1, 'only the stale point was re-tuned');
    assert.ok(log.some(l => /re-tuning to replace it/.test(l)));
  });

  await ta('K3SBP run 1: a recalled point still listens first — busy means no carrier at all', async () => {
    const radio = fakeRadio({ recall: () => true, signalDbm: -70 }); const log = [];
    const run = new W.AtuWizardRun(radio, plan.slice(0, 1), FAST, fastHooks(log)); radio.run = run;
    const st = await run.start();
    assert.strictEqual(st.points[0].result, 'SKIPPED');
    assert.ok(!radio.log.some(l => /^key 1/.test(l)), 'never keyed');
  });

  await ta('K3SBP run 1: a point interrupted by a real pause is measured again after Resume, not left blank', async () => {
    const radio = fakeRadio(); const log = [];
    const run = new W.AtuWizardRun(radio, plan, FAST, fastHooks(log)); radio.run = run;
    const p = run.start();
    // A pause during the LISTEN just waits and the point carries on; a pause
    // in the middle of the ATU sweep (here: the slice moved under us) leaves
    // the point without a result, and that is the one redone.
    for (let i = 0; i < 400 && !run._sweeping; i++) await new Promise(r => setTimeout(r, 2));
    assert.ok(run._sweeping, 'reached a sweep');
    run.noteSliceMoved(7000000);
    assert.strictEqual(run.phase, 'paused');
    await new Promise(r => setTimeout(r, 30));   // the loop notices the pause before Resume
    run.resume();
    const st = await p;
    assert.strictEqual(st.phase, 'done');
    assert.ok(st.points.every(pt => pt.result), JSON.stringify(st.points.map(pt => pt.result)));
    assert.ok(log.some(l => /interrupted — measuring it again/.test(l)), log.join('\n'));
  });

  await ta('a digital dial is listened to in CW with a 500 Hz filter; SSB stays wide', async () => {
    const pts = W.buildPlan({ bands: ['20m'], modes: ['DIGITAL', 'SSB'], licenseClass: 'us_extra' }).points;
    const radio = fakeRadio(); const log = [];
    const seen = [];
    const t = radio.tune; radio.tune = (khz, mode, filter) => { seen.push([khz, mode, filter]); t(khz, mode, filter); };
    const run = new W.AtuWizardRun(radio, pts, FAST, fastHooks(log)); radio.run = run;
    await run.start();
    const ft8 = seen.find(x => x[0] === 14074), ssb = seen.find(x => x[0] === 14250);
    assert.deepStrictEqual(ft8.slice(1), ['CW', 500]);
    assert.deepStrictEqual(ssb.slice(1), ['USB', 0]);
  });

  await ta('dwell is never below 2 s and tune power never above 25 W', async () => {
    const run = new W.AtuWizardRun(fakeRadio(), [], { dwellMs: 100, tunePowerW: 90 }, {});
    assert.strictEqual(run.settings.dwellMs, W.MIN_DWELL_MS);
    assert.strictEqual(run.settings.tunePowerW, 25);
  });

  console.log('ATU wizard — wiring');
  const main = R('main.js');
  const sdr = R('lib/smartsdr.js');
  const setup = R('lib/station-setup.js');
  t('radio-owner knows the wizard and main acquires it for the run', () => {
    assert.ok(OWNERS.includes('atu-wizard'));
    assert.ok(main.includes("acquireRadio('atu-wizard')"));
    assert.ok(main.includes("releaseRadio('atu-wizard')"));
  });
  t('smartsdr.js carries the three new commands and the interlock parse', () => {
    assert.ok(/atu set memories_enabled=\$\{/.test(sdr));
    assert.ok(/transmit set tunepower=\$\{/.test(sdr));
    assert.ok(/transmit tune \$\{/.test(sdr));
    assert.ok(/_parseInterlockStatus\(line\)/.test(sdr));
    assert.ok(sdr.includes("this.emit('interlock'"));
  });
  t('atu clear is never sent from POTACAT (comments may name it; code may not)', () => {
    const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/[^:]\/\/[^\n]*$/gm, '');
    for (const f of ['main.js', 'lib/smartsdr.js', 'lib/atu-wizard.js', 'renderer/atu-wizard-popout.js']) assert.ok(!/atu clear/.test(code(R(f))), f);
  });
  t('the SWR guard defers to the wizard while it runs, and PTT is refused', () => {
    assert.ok(/atuWizardActive\(\)/.test(main));
    assert.ok(main.includes('atuWizardRun.noteSwr('));
  });
  t('Station Setup has the step, scoped to a Flex with an ATU, and main answers its action', () => {
    assert.ok(setup.includes("'atu-memories'"));
    assert.ok(main.includes("case 'open-atu-wizard'"));
    assert.ok(/atu:\s*atuWizardSetupLive\(rig\)/.test(main.slice(main.indexOf('function stationSetupLive'), main.indexOf('function stationSetupLive') + 4000)));
  });
  t('remote mode lists the wizard as unavailable and the menu entry is rig-scoped', () => {
    const rf = require('../lib/remote-features');
    assert.strictEqual(rf.check('atuWizard').ok, false);
    assert.ok(R('renderer/index.html').includes('id="view-atu-wizard-btn"'));
    assert.ok(/view-atu-wizard-btn/.test(R('renderer/app.js')));
  });
  t('the pop-out is wired: preload, window, IPC', () => {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'preload-atu-wizard-popout.js')));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'atu-wizard-popout.html')));
    assert.ok(main.includes("'atu-wizard-start'") && main.includes("'atu-wizard-stop'") && main.includes("'atu-wizard-plan'"));
    assert.ok(R('scripts/run-tests.js').includes('test/atu-wizard-test.js'));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
