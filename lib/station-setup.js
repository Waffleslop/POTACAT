'use strict';

// Station Setup — one checklist per radio, with LIVE status per step
// (Casey 2026-09-24: "so an 80-year-old who is not confident with computers
// can get set up quickly and effectively ... if this is deployed correctly I
// won't hear any support tickets of people who can't get things to work").
//
// This module is the whole policy and holds no state: main.js gathers what is
// true right now (is the radio answering, did the listen test hear audio, is
// FTDI's library on disk ...) and evaluateChecklist() turns it into steps.
//
// Rules, all load-bearing:
//   - A step is ticked only because POTACAT CHECKED it. The single exception
//     is a radio-menu setting nothing can read back (CW PC KEYING, say): the
//     operator may confirm it, and the step then says "You confirmed this" —
//     never the same green tick as a measured one.
//   - Plain words. Every "needs you" step says what to do next in a sentence
//     an operator can follow without knowing what a COM port is, and offers a
//     button wherever POTACAT can do the work itself.
//   - Radio-menu instructions come ONLY from lib/rig-setup-notes.js, whose
//     entries each come from a real station. A wrong instruction manufactures
//     the support ticket this exists to prevent, so nothing here invents a
//     menu path.
//   - Scope tightly. An IC-7300 owner never sees a Flex step (rig-scoped UI).
//   - Only unfinished REQUIRED steps ever bring the checklist back at launch.
//     Recommended and optional steps are listed, never nagged about.
//
// Pure: no Electron, no I/O. test/station-setup-test.js checks every rule.

const LEVELS = ['required', 'recommended', 'optional'];
// ok       POTACAT checked it and it works
// confirmed the operator says a radio-menu setting is done (unverifiable)
// needs    something is wrong or missing; `instructions` say what to do
// unknown  not checked yet; an action runs the check
// blocked  an earlier step has to work first
// optional an optional feature that is not set up (not a problem)
// skipped  the operator chose not to use this feature
const STATES = ['ok', 'confirmed', 'needs', 'unknown', 'blocked', 'optional', 'skipped'];

// The version that introduced each step, for the "new for your radio" card
// shown once after an update. A step with no `since` predates the checklist.
const STEP_SINCE = {
  'band-scope': '1.10.23',
};

// Radio families whose audio travels over the radio's own network link, not
// a sound card the operator picks.
function audioIsNetwork(rig) {
  return rig.audioSource === 'smartsdr' || rig.audioSource === 'icom-network';
}

function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function fmtDbfs(v) { return Number.isFinite(v) ? `${Math.round(v)} dBFS` : ''; }

// Notes from lib/rig-setup-notes.js for one feature, as instruction lines.
function noteLines(notes, feature) {
  const out = [];
  for (const n of notes || []) {
    if (n.feature !== feature) continue;
    out.push({ title: n.title, steps: n.steps || [], why: n.why || '', noteId: n.id, level: n.level });
  }
  return out;
}

/**
 * @param {object} ctx
 *   rig       {id, name, model, radioType, family, audioSource,
 *              inputDeviceId, outputDeviceId}
 *   modelInfo RIG_MODELS entry or null (maxPower, brand, caps.nativeScope)
 *   platform  process.platform
 *   notes     resolveSetupNotes() output for this rig (menu instructions)
 *   live      what is true right now — see main.js stationSetupLive()
 *   prefs     {skipped:[ids], confirmed:[noteIds], passed:{stepId: ms}} stored
 *             on the rig. `passed` = when a step last WORKED (any session):
 *             a test with no result this session shows "Worked on <date>",
 *             and only a step that has NEVER passed brings the checklist back
 *             at launch — a radio that is simply switched off must not nag.
 * @returns {{steps: object[], summary: object}}
 */
function evaluateChecklist(ctx) {
  const rig = ctx.rig || {};
  const info = ctx.modelInfo || {};
  const live = ctx.live || {};
  const prefs = ctx.prefs || {};
  const skipped = new Set(prefs.skipped || []);
  const confirmed = new Set(prefs.confirmed || []);
  const notes = ctx.notes || [];
  const passed = prefs.passed || {};
  const passedOn = (id) => (passed[id] ? new Date(passed[id]).toISOString().slice(0, 10) : '');
  const steps = [];
  const netAudio = audioIsNetwork(rig);
  const radioName = rig.model || rig.name || 'your radio';

  // 1. Callsign and grid — logs, spots and FT8 all need them.
  {
    const ok = !!(live.callsign && live.grid);
    steps.push({
      id: 'station-identity', group: 'Basics', level: 'required',
      title: 'Your callsign and location',
      state: ok ? 'ok' : 'needs',
      detail: ok ? `${live.callsign}, grid ${live.grid}` : (!live.callsign ? 'POTACAT does not know your callsign yet.' : 'POTACAT does not know your grid square yet.'),
      instructions: ok ? [] : [{ steps: ['Open Settings and fill in your callsign and grid square (for example FN20). If you do not know your grid, type your town into the grid box and POTACAT will look it up.'] }],
      actions: ok ? [] : [{ id: 'open-settings', label: 'Open Settings' }],
    });
  }

  // 2. Radio control — everything else depends on it.
  const catOk = !!live.catConnected;
  {
    const lines = [];
    if (!catOk) {
      lines.push({ steps: [
        `Make sure ${radioName} is switched on and its USB cable is plugged into this computer.`,
        'Close any other program that talks to the radio (WSJT-X, flrig, N1MM, Log4OM, the radio maker\'s own software). Only one program at a time can control the radio.',
        'Then press Check again.',
      ] });
      for (const n of noteLines(notes, 'CAT')) lines.push(n);
    }
    const inactive = rig.active === false;
    steps.push({
      id: 'radio-control', group: 'Basics', level: 'required',
      title: 'POTACAT can control your radio',
      state: catOk ? 'ok' : inactive ? 'unknown' : 'needs',
      detail: catOk
        ? (live.freqHz ? `Connected. The radio is on ${(live.freqHz / 1e6).toFixed(3)} MHz.` : 'Connected.')
        : inactive ? 'This is not the radio in use right now. Switch to it (the radio menu at the top of the main window) to check it.'
        : (live.catError ? `Not connected: ${live.catError}` : 'POTACAT is not connected to the radio.'),
      instructions: inactive ? [] : lines,
      actions: catOk || inactive ? [] : [{ id: 'recheck', label: 'Check again' }, { id: 'open-rig-editor', label: 'Open radio settings' }],
    });
  }

  // 3. Hearing the radio.
  {
    let state, detail, instructions = [], actions = [];
    if (netAudio) {
      state = catOk ? 'ok' : 'blocked';
      detail = catOk ? 'Audio comes straight from the radio over its network connection.' : 'Needs radio control first.';
    } else if (!rig.inputDeviceId) {
      state = 'needs';
      detail = 'No audio input is chosen for this radio.';
      instructions.push({ steps: [
        'Open radio settings and, under Audio, choose the input that belongs to the radio. It is usually called "USB Audio CODEC" or has the radio\'s name in it.',
      ] });
      for (const n of noteLines(notes, 'Audio')) instructions.push(n);
      actions.push({ id: 'open-rig-editor', label: 'Open radio settings' });
    } else if (!live.rxTest && passed['rx-audio']) {
      state = 'ok';
      detail = `Worked on ${passedOn('rx-audio')}.`;
      actions.push({ id: 'rx-test', label: 'Listen again' });
    } else if (!live.rxTest) {
      state = 'unknown';
      detail = 'Not checked yet.';
      actions.push({ id: 'rx-test', label: 'Listen for 3 seconds' });
    } else if (live.rxTest.result === 'unsupported') {
      state = 'unknown';
      detail = live.rxTest.error || 'POTACAT cannot test this input here; it is checked when FT8 runs.';
    } else if (live.rxTest.result === 'ok') {
      state = 'ok';
      detail = `Audio is coming in (${fmtDbfs(live.rxTest.dbfs)}).`;
      actions.push({ id: 'rx-test', label: 'Listen again' });
    } else if (live.rxTest.result === 'low') {
      state = 'ok';
      detail = `Audio is coming in, but quietly (${fmtDbfs(live.rxTest.dbfs)}). FT8 still decodes; if signals look faint, turn up the radio's USB audio output level.`;
      actions.push({ id: 'rx-test', label: 'Listen again' });
    } else if (live.rxTest.result === 'silent') {
      state = 'needs';
      detail = 'The audio input opened, but nothing is coming in.';
      instructions.push({ steps: [
        'Make sure the radio is on a band with some noise or signals, and the volume is not the problem: the USB audio from the radio does not depend on the radio\'s speaker volume on most radios.',
        'Check you picked the right input under Audio in the radio settings. A computer often has several inputs with similar names.',
        'Then press Listen again.',
      ] });
      actions.push({ id: 'rx-test', label: 'Listen again' }, { id: 'open-rig-editor', label: 'Open radio settings' });
    } else {
      state = 'needs';
      detail = `The audio input could not be opened${live.rxTest.error ? ': ' + live.rxTest.error : ''}.`;
      instructions.push({ steps: [
        'The input chosen for this radio is not available. If the radio was unplugged, plug it back in. Otherwise choose the input again under Audio in the radio settings.',
      ] });
      actions.push({ id: 'rx-test', label: 'Listen again' }, { id: 'open-rig-editor', label: 'Open radio settings' });
    }
    steps.push({ id: 'rx-audio', group: 'Basics', level: 'required', title: 'Hearing the radio', state, detail, instructions, actions });
  }

  // 4. Audio to the radio (the output device can be opened).
  const txDevOk = netAudio ? catOk
    : !!(live.txDeviceTest ? live.txDeviceTest.ok : (rig.outputDeviceId && passed['tx-audio']));
  {
    let state, detail, instructions = [], actions = [];
    if (netAudio) {
      state = catOk ? 'ok' : 'blocked';
      detail = catOk ? 'Transmit audio goes straight to the radio over its network connection.' : 'Needs radio control first.';
    } else if (!rig.outputDeviceId) {
      state = 'needs';
      detail = 'No audio output is chosen for this radio.';
      instructions.push({ steps: [
        'Open radio settings and, under Audio, choose the output that belongs to the radio (usually "USB Audio CODEC" or the radio\'s name). Do not choose your speakers.',
      ] });
      actions.push({ id: 'open-rig-editor', label: 'Open radio settings' });
    } else if (!live.txDeviceTest && passed['tx-audio']) {
      state = 'ok';
      detail = `Worked on ${passedOn('tx-audio')}.`;
      actions.push({ id: 'tx-device-test', label: 'Check again' });
    } else if (!live.txDeviceTest) {
      state = 'unknown';
      detail = 'Not checked yet.';
      actions.push({ id: 'tx-device-test', label: 'Check' });
    } else if (live.txDeviceTest.result === 'unsupported') {
      state = 'unknown';
      detail = live.txDeviceTest.error || 'POTACAT cannot test this output here.';
    } else if (live.txDeviceTest.ok) {
      state = 'ok';
      detail = 'The radio\'s audio output is ready.';
    } else {
      state = 'needs';
      detail = `The audio output chosen for this radio could not be opened${live.txDeviceTest.error ? ': ' + live.txDeviceTest.error : ''}.`;
      instructions.push({ steps: [
        'If the radio was unplugged, plug it back in. Otherwise choose the output again under Audio in the radio settings.',
      ] });
      actions.push({ id: 'tx-device-test', label: 'Check again' }, { id: 'open-rig-editor', label: 'Open radio settings' });
    }
    steps.push({ id: 'tx-audio', group: 'Basics', level: 'required', title: 'Sending audio to the radio', state, detail, instructions, actions });
  }

  // 5. Test transmit at low power.
  {
    const maxW = Number(info.maxPower) || 100;
    const testW = Math.min(5, maxW);
    let state, detail, instructions = [], actions = [];
    const t = live.txTest;
    if (!t && passed['tx-test']) {
      state = 'ok';
      detail = `Worked on ${passedOn('tx-test')}.`;
      if (catOk && txDevOk) actions.push({ id: 'tx-test', label: `Test again at ${testW} W` });
    } else if (!catOk || !txDevOk) {
      state = 'blocked';
      detail = 'Needs radio control and the audio output working first.';
    } else if (!t) {
      state = 'unknown';
      detail = `Not tested yet. POTACAT turns the power down to ${testW} W, sends a steady tone for 3 seconds, then puts your power back.`;
      actions.push({ id: 'tx-test', label: `Test transmit at ${testW} W` });
    } else if (t.result === 'ok') {
      state = 'ok';
      detail = `The radio transmitted${t.watts ? ` ${t.watts} W` : ''}${t.swr ? `, SWR ${t.swr.toFixed(1)}` : ''}.${t.restored === false ? ' ' + t.restoreNote : ''}`;
      actions.push({ id: 'tx-test', label: 'Test again' });
    } else if (t.result === 'unmeasured') {
      state = 'needs';
      detail = 'The radio was keyed, but POTACAT cannot measure power on this radio.';
      instructions.push({ steps: ['Did the radio\'s power meter move during the test? If it did, transmitting works.'] });
      actions.push({ id: 'tx-test-confirm', label: 'Yes, the meter moved' }, { id: 'tx-test', label: 'Test again' });
    } else if (t.result === 'swr-high') {
      state = 'needs';
      detail = `The radio transmitted, but the SWR was ${t.swr ? t.swr.toFixed(1) : 'high'}. The antenna is not matched on this band.`;
      instructions.push({ steps: ['Run the antenna tuner, or check the antenna and its cable, then test again.'] });
      actions.push({ id: 'tx-test', label: 'Test again' });
    } else if (t.result === 'no-power') {
      state = 'needs';
      detail = 'The radio was keyed but no power came out.';
      instructions.push({ steps: [
        'This almost always means the audio is not reaching the radio.',
        'Check the output chosen under Audio in the radio settings is the radio, not your speakers.',
        'The radio must also be set to take its transmit audio from USB. Your radio\'s manual covers this setting.',
        'Then test again.',
      ] });
      for (const n of noteLines(notes, 'Audio')) instructions.push(n);
      actions.push({ id: 'tx-test', label: 'Test again' }, { id: 'open-rig-editor', label: 'Open radio settings' });
    } else {
      state = 'needs';
      detail = t.message || 'The test could not run.';
      actions.push({ id: 'tx-test', label: 'Try again' });
      if (t.needsManualPower) actions.push({ id: 'tx-test-current-power', label: 'Test at the radio\'s current power' });
    }
    if (t && t.restored === false && t.result !== 'ok') detail += ' ' + t.restoreNote;
    steps.push({ id: 'tx-test', group: 'Basics', level: 'required', title: 'Transmitting', state, detail, instructions, actions });
  }

  // 6. PC clock (FT8 and the other timed digital modes).
  {
    const c = live.clock;
    let state, detail, instructions = [], actions = [];
    if (!c || c.level === 'unknown') {
      state = 'unknown';
      detail = c && c.error ? `Could not check the clock: ${c.error}` : 'Not checked yet.';
      actions.push({ id: 'check-clock', label: 'Check the clock' });
    } else if (c.level === 'ok') {
      state = 'ok';
      detail = `Your clock is right (off by ${Math.abs(Math.round(c.offsetMs))} ms).`;
    } else {
      state = 'needs';
      detail = `Your clock is off by ${(Math.abs(c.offsetMs) / 1000).toFixed(1)} seconds. FT8 needs it within a second.`;
      instructions.push({ steps: ['Press Fix the clock. If Windows asks for permission, say yes.'] });
      actions.push({ id: 'sync-clock', label: 'Fix the clock' }, { id: 'check-clock', label: 'Check again' });
    }
    steps.push({ id: 'clock', group: 'For FT8 and digital modes', level: 'recommended', title: 'Computer clock', state, detail, instructions, actions });
  }

  // 7. CW keying — only for radios with a confirmed menu note.
  {
    const cw = noteLines(notes, 'CW');
    if (cw.length) {
      const allConfirmed = cw.every(n => confirmed.has(n.noteId));
      const id = 'cw-keying';
      steps.push({
        id, group: 'Optional', level: 'optional',
        title: 'Sending CW from POTACAT',
        state: skipped.has(id) ? 'skipped' : allConfirmed ? 'confirmed' : 'optional',
        detail: allConfirmed ? 'You confirmed the radio\'s CW settings.' : 'Only needed if you send CW from POTACAT. One radio menu setting.',
        instructions: cw,
        actions: allConfirmed ? [] : [{ id: 'confirm-notes', label: 'I have done this', noteIds: cw.map(n => n.noteId) }],
      });
    }
  }

  // 8. FT-710 band scope (FTDI FT4222 bridge; see lib/yaesu-scope.js).
  // nativeScope lives in the model's caps (lib/rig-models.js).
  if (((info.caps && info.caps.nativeScope) || info.nativeScope) === 'yaesu-ft4222') {
    const id = 'band-scope';
    const sc = live.scope || {};
    let state, detail, instructions = [], actions = [];
    if (skipped.has(id)) {
      state = 'skipped';
      detail = 'You chose not to use the band scope.';
      actions.push({ id: 'unskip', label: 'Set it up after all', step: id });
    } else if (sc.status === 'live') {
      state = 'ok';
      detail = 'The band scope is working.';
    } else if (!sc.d2xxFound && ctx.platform === 'win32') {
      state = 'needs';
      detail = 'The driver for the radio\'s scope chip is not installed on this computer.';
      instructions.push({ steps: [
        'Press Open FTDI\'s driver page and download the "setup executable" for Windows (the D2XX driver).',
        'Run it and follow its steps, then restart POTACAT.',
      ] });
      actions.push({ id: 'open-ftdi-driver', label: 'Open FTDI\'s driver page' }, { id: 'recheck', label: 'Check again' });
    } else if (!sc.libraryFound) {
      state = 'needs';
      detail = 'POTACAT needs one small file from FTDI, the company that makes the radio\'s USB chip.';
      instructions.push({ steps: [
        'Press Open FTDI\'s download page. Download "LibFT4222" for ' + (ctx.platform === 'darwin' ? 'Mac' : ctx.platform === 'linux' ? 'Linux' : 'Windows') + '. It arrives as a zip file.',
        ctx.platform === 'win32'
          ? 'Open the zip file (on Windows, double-click it, or right-click and choose Extract All).'
          : 'Unzip it.',
        ctx.platform === 'win32'
          ? 'Press Find the file for me and choose LibFT4222-64.dll. It is in a folder called "amd64". POTACAT copies it where it needs to go; nothing else to install.'
          : 'Press Find the file for me and choose the libft4222 file inside the download. POTACAT copies it where it needs to go.',
      ] });
      actions.push({ id: 'open-ftdi-download', label: 'Open FTDI\'s download page' }, { id: 'locate-ft4222', label: 'Find the file for me' });
    } else if (sc.diagKey && sc.diagKey !== 'no-library') {
      state = 'needs';
      detail = sc.diagHeadline || 'The band scope could not start.';
      instructions.push({ steps: [sc.diagAction || sc.diagDetail || 'Open the Band Scope window for details.'].filter(Boolean) });
      actions.push({ id: 'open-scope', label: 'Open the Band Scope' });
    } else {
      state = 'unknown';
      detail = 'The file is installed. Open the Band Scope to finish: POTACAT turns on the radio\'s scope output for you (menu 03-01-26 SCU-LAN10) and puts it back when you close it.';
      actions.push({ id: 'open-scope', label: 'Open the Band Scope' });
    }
    if (state !== 'skipped' && state !== 'ok') actions.push({ id: 'skip', label: 'I don\'t need this', step: id });
    steps.push({ id, group: 'Optional', level: 'optional', title: 'Band scope', since: STEP_SINCE[id], state, detail, instructions, actions });
  }

  // Skip handling for required/recommended steps is deliberately absent:
  // the operator cannot skip "the radio can transmit" — they can hide the
  // whole checklist instead.
  const summary = summarize(steps, passed);
  return { steps, summary };
}

function summarize(steps, passed = {}) {
  const done = (s) => s.state === 'ok' || s.state === 'confirmed';
  const req = steps.filter(s => s.level === 'required');
  const requiredLeft = req.filter(s => !done(s)).length;
  const nextStep = req.find(s => !done(s) && s.state !== 'blocked')
    || steps.find(s => s.level === 'recommended' && s.state === 'needs')
    || null;
  return {
    total: steps.length,
    ok: steps.filter(done).length,
    requiredTotal: req.length,
    requiredLeft,
    // Required steps that have never worked in any session — the only thing
    // that brings the checklist back at launch.
    requiredNeverDone: req.filter(s => !done(s) && !passed[s.id]).length,
    complete: requiredLeft === 0,
    next: nextStep ? nextStep.id : null,
  };
}

/**
 * Should the "finish setting up" card show at launch? Only for unfinished
 * REQUIRED steps, never once the operator hid the checklist for this rig.
 */
function shouldPromptAtLaunch(result, rigPrefs) {
  if (!result || !result.summary) return false;
  if (rigPrefs && rigPrefs.hidden) return false;
  return result.summary.requiredNeverDone > 0;
}

/**
 * Steps that are new since `lastVersion` and not already working, for the
 * once-per-update "New for your radio" card. Skipped or hidden = nothing.
 */
function newStepsSince(result, lastVersion, rigPrefs) {
  if (!result || !lastVersion) return [];
  if (rigPrefs && rigPrefs.hidden) return [];
  const seen = new Set((rigPrefs && rigPrefs.announced) || []);
  return result.steps.filter(s => s.since
    && cmpVersion(s.since, lastVersion) > 0
    && !seen.has(s.id)
    && s.state !== 'ok' && s.state !== 'confirmed' && s.state !== 'skipped');
}

/** Is this file a 64-bit Windows DLL? (PE header machine = AMD64.) */
function peMachine(buf) {
  if (!buf || buf.length < 64 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null; // "MZ"
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 6 > buf.length) return null;
  if (buf.readUInt32LE(peOff) !== 0x00004550) return null; // "PE\0\0"
  const m = buf.readUInt16LE(peOff + 4);
  return m === 0x8664 ? 'x64' : m === 0x14c ? 'x86' : m === 0xaa64 ? 'arm64' : 'other';
}

module.exports = {
  LEVELS, STATES, STEP_SINCE,
  evaluateChecklist, summarize, shouldPromptAtLaunch, newStepsSince, cmpVersion, peMachine, audioIsNetwork,
};
