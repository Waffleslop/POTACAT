#!/usr/bin/env node
'use strict';
// GitHub #187 (NA4DQ, IC-7300, ARDOP): a Winlink session holds the DATA mode
// from its QSY to its end, and the dial goes back once, to exactly where the
// operator was, with a log line that says so.
//
// Before: an Icom reports USB + a separate DATA flag, so every ARDOP frame
// logged "[PTT] USB -> DIGU", waited ~135 ms for the DATA report, and after
// the unkey "Restoring USB mode" turned DATA off again: 20 mode commands for
// the ten ConReq frames of one attempt, and the session's own DIGU undone
// after the first.
// Run: node test/winlink-data-hold-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const S = require('../lib/ptt-mode-swap');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js'));
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0, j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}

console.log('the plan for one key-down');
test('a Winlink frame with the radio already in DATA keys with no mode change and no restore', () => {
  assert.strictEqual(typeof S.sessionDataPlan, 'function', 'sessionDataPlan exists');
  assert.strictEqual(S.sessionDataPlan({ hold: true, inData: true }), 'keep');
});
test('a Winlink frame with DATA off switches once and holds it (no per-over restore)', () => {
  assert.strictEqual(S.sessionDataPlan({ hold: true, inData: false }), 'switch-hold');
});
test('anything else keeps the per-over swap (SSB-over-DATA voice, SSTV)', () => {
  assert.strictEqual(S.sessionDataPlan({ hold: false, inData: false }), 'switch-restore');
  assert.strictEqual(S.sessionDataPlan({ hold: false, inData: true }), 'switch-restore');
  assert.strictEqual(S.sessionDataPlan({}), 'switch-restore');
});

// A fake IC-7300: base mode USB, DATA as its own flag. Each key-down asks the
// plan; a switch sets DATA on; a per-over restore sets it off at the release.
function replay(bursts, { hold, dataAtStart }) {
  let data = dataAtStart;
  const cmds = [];
  for (let i = 0; i < bursts; i++) {
    const plan = S.sessionDataPlan({ hold, inData: data });
    if (plan !== 'keep') { cmds.push('DIGU'); data = true; }
    // ... the frame goes out, the modem unkeys ...
    if (plan === 'switch-restore') { cmds.push('USB'); data = false; }
  }
  return cmds;
}
test('replay of the 15:49:40-15:50:16 attempt (ten ConReq2000M): no mode command at all', () => {
  assert.deepStrictEqual(replay(10, { hold: true, dataAtStart: true }), []);
});
test('the same attempt before the fix: 20 mode commands (USB -> DIGU, Restoring USB) — the log', () => {
  assert.strictEqual(replay(10, { hold: false, dataAtStart: true }).length, 20);
});
test('the session tune\'s DATA frame lost: one switch on the first frame, then held', () => {
  assert.deepStrictEqual(replay(10, { hold: true, dataAtStart: false }), ['DIGU']);
});

console.log('the mode to come back to');
test('an Icom in DATA comes back in DATA: USB-D is DIGU, not USB', () => {
  assert.strictEqual(typeof S.dataFormOf, 'function', 'dataFormOf exists');
  assert.strictEqual(S.dataFormOf('USB'), 'DIGU');
  assert.strictEqual(S.dataFormOf('usb'), 'DIGU');
  assert.strictEqual(S.dataFormOf('LSB'), 'DIGL');
  assert.strictEqual(S.dataFormOf('FM'), 'DIGFM');
  assert.strictEqual(S.dataFormOf('AM'), 'DIGAM');
});
test('a mode with no data form, or one already in it, is unchanged', () => {
  for (const m of ['DIGU', 'DIGL', 'CW', 'RTTY', '']) assert.strictEqual(S.dataFormOf(m), m);
});

console.log('one switch per session (#300)');
test('a session that already asked for DATA keys as the radio is, whatever it reports', () => {
  assert.strictEqual(S.sessionDataPlan({ hold: true, inData: false, tried: true }), 'keep');
  assert.strictEqual(S.sessionDataPlan({ hold: true, inData: true, tried: true }), 'keep');
  assert.strictEqual(S.sessionDataPlan({ hold: true, inData: false, tried: false }), 'switch-hold');
  assert.strictEqual(S.sessionDataPlan({ hold: false, inData: false, tried: true }), 'switch-restore', 'voice and SSTV are not a session');
});
test('NA4DQ IC-7100 on rigctld: the radio reads back FM after every switch; 79 overs send ONE mode command, not 70', () => {
  // A radio that never reports DATA: before, every over planned switch-hold.
  let tried = false; const cmds = [];
  for (let i = 0; i < 79; i++) {
    const plan = S.sessionDataPlan({ hold: true, inData: false, tried });
    if (plan === 'switch-hold') { cmds.push('DIGFM'); tried = true; }
  }
  assert.deepStrictEqual(cmds, ['DIGFM']);
});
test('main.js: the key-down marks the session as asked; FM-D is asked for before Pat dials, off the key-down', () => {
  const p = fnBody(main, 'handleRemotePtt');
  assert.ok(/if \(_dataPlan === 'switch-hold'\) _winlinkDataAskedFor = _winlinkSessionSeq;/.test(p));
  assert.ok(/not a DATA mode, after this session asked for one — keying as it is/.test(p), 'said once, with what to check');
  const e = fnBody(main, 'winlinkEnterFmDataBeforeDial');
  assert.ok(/!WinlinkModes\.isFmMode\(mode\)/.test(e) && /!icom/.test(e), 'Icom FM modems only: HF sessions QSY in DIGU already');
  assert.ok(/\(pttModeReport\(\) \|\| \{\}\)\.data\) return;/.test(e), 'nothing sent to a radio already in data');
  assert.ok(e.indexOf('_winlinkDataAskedFor = _winlinkSessionSeq;') < e.indexOf("cat.setModeOnly('DIGFM'"), 'marked before it is sent');
  assert.ok(/noAnchor: true/.test(e), 'an Icom memory channel keeps its duplex: no frequency write');
  const s = fnBody(main, 'winlinkStartSession');
  const tune = s.indexOf("{ origin: 'Winlink session' }");
  const enter = s.indexOf('await winlinkEnterFmDataBeforeDial(mode);');
  const dial = s.indexOf('await patClient.connect(url)');
  assert.ok(tune > 0 && enter > tune && dial > enter, 'after the QSY, before Pat dials');
  assert.ok(/await winlinkEnterFmDataBeforeDial\(mode\);\n\s*if \(!live\(\)\) throw cancelled\(\);/.test(s), 'a stopped attempt goes no further');
});

console.log('main.js wiring');
const ptt = fnBody(main, 'handleRemotePtt');
test('handleRemotePtt asks the plan for a Winlink key-down, judged on the radio\'s DATA report', () => {
  assert.ok(/const _holdData = forceData && opts\.txKind === 'winlink';/.test(ptt), 'hold = a forced-DATA Winlink frame');
  assert.ok(/const _inData = !!\(pttModeReport\(\) \|\| \{\}\)\.data;/.test(ptt) && /PttModeSwap\.sessionDataPlan\(\{ hold: _holdData, inData: _inData, tried: _holdData && _winlinkDataAskedFor === _winlinkSessionSeq \}\)/.test(ptt), 'judged on pttModeReport(), and on whether this session already asked (#300)');
});
test('a frame with the radio in DATA keys straight away, logged once per session', () => {
  assert.ok(/_dataPlan === 'keep'/.test(ptt));
  assert.ok(/keying without a mode change; it stays in DATA until the Winlink session ends/.test(ptt));
  assert.ok(/_pttDataHeldLoggedFor !== _winlinkSessionSeq/.test(ptt), 'once per session');
});
test('a held switch arms no per-over restore and no 120 s broadcast hold', () => {
  assert.ok(/_ssbModeBeforePtt = _dataPlan === 'switch-hold' \? null : curMode;/.test(ptt));
  assert.ok(/_modeSuppressUntil = Date\.now\(\) \+ \(_dataPlan === 'switch-hold' \? 2000 : 120000\);/.test(ptt));
  assert.ok(/held until the Winlink session ends/.test(ptt));
});
test('both return-to captures fold the DATA flag in (winlinkDialHere)', () => {
  const here = fnBody(main, 'winlinkDialHere');
  assert.ok(/PttModeSwap\.dataFormOf\(/.test(here) && /pttModeReport\(\)/.test(here));
  assert.ok(/_winlinkPreviewReturnTo = winlinkDialHere\('before the gateway pick'\)/.test(fnBody(main, 'winlinkPreviewQsy')));
  assert.ok(/returnTo: radio \? \(_winlinkPreviewReturnTo \|\| winlinkDialHere\('at Connect'\)\)/.test(fnBody(main, 'winlinkStartSession')));
});
test('session start says where the radio goes back to', () => {
  assert.ok(/the radio goes back to \$\{winlinkDialText\(/.test(fnBody(main, 'winlinkStartSession')));
});
test('the restore says where it goes, and never lands under a newer session', () => {
  const r = fnBody(main, 'winlinkRestoreDial');
  assert.ok(/if \(winlinkSessionActive\(\)\) \{/.test(r), 'refuses while a session runs');
  assert.ok(/lead = 'session over: the radio goes back to'/.test(r), 'the session-end wording is the default');
  assert.ok(/winlinkLog\(`\$\{lead\} \$\{winlinkDialText\(returnTo\)\}`\)/.test(r), 'every return names where it goes');
  assert.ok(/winlinkRestoreDial\(returnTo, waitedMs \+ 500, lead\)/.test(r), 'the ATU wait keeps the wording');
  assert.ok(r.indexOf('if (winlinkSessionActive())') < r.indexOf('tuneRadio('), 'checked before the tune');
});

// ── decision 2026-11-07: the radio stays after an attempt; it goes back once,
// when the mail window closes, Winlink stops or POTACAT quits ───────────────
const R = require('../lib/winlink-return');

// A fake station driven the way main.js drives it, through the decisions in
// lib/winlink-return.js. Every tune is recorded.
function station({ windowOpen = true, dial = 28074000, mode = 'DIGU' } = {}) {
  const st = { dial, mode, pending: null, session: null, leftAt: 0, tunes: [], logs: [], windowOpen };
  const tune = (hz, m, why) => { st.dial = hz; st.mode = m; st.tunes.push({ hz, mode: m, why }); };
  const restore = (rt, why) => {
    if (st.session) { st.logs.push('not going back — a new session is running'); return; }
    tune(rt.freqHz, rt.mode, why);
  };
  const noteHand = () => {
    if (st.pending && R.movedByHand(st.leftAt, st.dial)) st.logs.push('moved by hand; still going back to ' + st.pending.freqHz);
  };
  return {
    st,
    pick(hz) {
      noteHand();
      if (!st.pending) st.pending = { freqHz: st.dial, mode: st.mode, from: R.PICK };
      tune(hz, 'DIGU', 'gateway pick');
      st.leftAt = hz;
    },
    start(hz) {
      noteHand();
      const returnTo = st.pending || { freqHz: st.dial, mode: st.mode, from: 'at Connect' };
      st.pending = null;
      st.session = { returnTo, tuned: false };
      tune(hz, 'DIGU', 'session start');
      st.session.tuned = true;
    },
    end() {
      const s = st.session; st.session = null;
      const a = R.atSessionEnd({ tuned: s.tuned, returnTo: s.returnTo, windowOpen: st.windowOpen });
      if (a === 'keep') { st.pending = { ...s.returnTo, moved: true }; st.leftAt = st.dial; }
      else if (a === 'return') restore(s.returnTo, 'session over');
      return a;
    },
    close() {
      st.windowOpen = false;
      const a = R.atClose({ pending: st.pending, sessionActive: !!st.session, sessionReturn: st.session && st.session.returnTo });
      if (a === 'after-session') return a;
      const r = st.pending; st.pending = null;
      if (a === 'return') restore(r, 'window closed');
      return a;
    },
    stop({ quit = false } = {}) {
      const a = R.atStop({ pending: st.pending, windowOpen: st.windowOpen, quit });
      if (a === 'none' || a === 'keep') return a;
      const r = st.pending; st.pending = null;
      if (a === 'return') restore(r, 'Winlink stopped');
      return a;
    },
    hand(hz) { st.dial = hz; },
  };
}
const toHome = (st) => st.tunes.filter((t) => t.hz === 28074000);

console.log('the return point (decision 2026-11-07)');
test('a failed attempt does not QSY: the radio stays on the gateway, the return point is kept', () => {
  const s = station();
  s.pick(14109100); s.start(14109100);
  assert.strictEqual(s.end(), 'keep');
  assert.strictEqual(s.st.dial, 14109100, 'still on the gateway');
  assert.strictEqual(toHome(s.st).length, 0, 'no tune back to 28.074');
  assert.deepStrictEqual([s.st.pending.freqHz, s.st.pending.mode, s.st.pending.from], [28074000, 'DIGU', R.PICK]);
});
test('NA4DQ replay: two gateways, five attempts: no band change between them, the return point is still 28.074', () => {
  const s = station();
  s.pick(14109100); s.start(14109100); s.end(); s.start(14109100); s.end();
  s.pick(14102300); s.start(14102300); s.end(); s.start(14102300); s.end(); s.start(14102300); s.end();
  assert.strictEqual(toHome(s.st).length, 0, 'never went back to 10 m in between (each was two ATU tunes before)');
  assert.strictEqual(s.st.pending.freqHz, 28074000, 'not replaced by a gateway dial');
  assert.strictEqual(s.st.pending.from, R.PICK);
});
test('a second attempt with no pick in between (the first from Connect) keeps the Connect dial', () => {
  const s = station({ dial: 7074000 });
  s.start(14109100); s.end(); s.start(14109100); s.end();
  assert.strictEqual(s.st.pending.freqHz, 7074000);
  assert.strictEqual(s.st.pending.from, 'at Connect');
});
test('an attempt that never tuned still keeps the return point an earlier one carried', () => {
  assert.strictEqual(R.atSessionEnd({ tuned: false, returnTo: { freqHz: 7074000, from: 'at Connect', moved: true }, windowOpen: true }), 'keep');
  assert.strictEqual(R.atSessionEnd({ tuned: false, returnTo: { freqHz: 7074000, from: 'at Connect' }, windowOpen: true }), 'none', 'the radio never moved');
  assert.strictEqual(R.atSessionEnd({ tuned: true, returnTo: null, windowOpen: true }), 'none');
});
test('closing the mail window goes back once, to the original dial and mode', () => {
  const s = station();
  s.pick(14109100); s.start(14109100); s.end(); s.pick(14102300); s.start(14102300); s.end();
  assert.strictEqual(s.close(), 'return');
  assert.strictEqual(toHome(s.st).length, 1);
  assert.deepStrictEqual([s.st.dial, s.st.mode], [28074000, 'DIGU']);
  assert.strictEqual(s.close(), 'none', 'a second close has nothing to do');
  assert.strictEqual(s.stop(), 'none', 'nor does a stop after it');
  assert.strictEqual(toHome(s.st).length, 1);
});
test('a session running when the window closes is not moved; it goes back when it ends', () => {
  const s = station();
  s.pick(14109100); s.start(14109100);
  assert.strictEqual(s.close(), 'after-session');
  assert.strictEqual(s.st.dial, 14109100, 'not moved mid-session');
  assert.strictEqual(s.end(), 'return', 'the window is closed by then');
  assert.strictEqual(toHome(s.st).length, 1);
});
test('a return that would land while a newer session runs is refused (the restore guard)', () => {
  const s = station();
  s.pick(14109100); s.start(14109100); s.end();
  const r = s.st.pending;
  s.start(14102300);                    // a new session starts before the return lands
  s.st.pending = r;                     // e.g. the return was waiting out an ATU tune
  s.close();
  assert.strictEqual(s.st.dial, 14102300, 'not moved off the running session');
  assert.strictEqual(toHome(s.st).length, 0);
});
test('stopping Winlink goes back once; a relaunch with the mail window open keeps the return point', () => {
  const s = station();
  s.pick(14109100); s.start(14109100); s.end();
  assert.strictEqual(s.stop(), 'keep', 'Pat relaunch for a settings change, window still open');
  assert.strictEqual(toHome(s.st).length, 0);
  s.st.windowOpen = false;
  assert.strictEqual(s.stop(), 'return');
  assert.strictEqual(s.stop(), 'none');
  assert.strictEqual(toHome(s.st).length, 1);
});
test('a session from an ECHOCAT device with no mail window open goes back at its end, as before', () => {
  const s = station({ windowOpen: false });
  s.start(14109100);
  assert.strictEqual(s.end(), 'return');
  assert.strictEqual(toHome(s.st).length, 1);
});
test('quit: go back only with the radio link up and no ATU tune, inside the cleanup budget', () => {
  const p = { freqHz: 28074000, mode: 'DIGU', from: R.PICK };
  assert.deepStrictEqual(R.atQuit({ pending: null, catUp: true }), { act: 'none' });
  const ok = R.atQuit({ pending: p, catUp: true, atuBusy: false });
  assert.strictEqual(ok.act, 'return');
  assert.ok(ok.waitMs > 0 && ok.waitMs < 4000, 'shorter than the 4 s quit flush and the 5 s watchdog');
  assert.strictEqual(R.atQuit({ pending: p, catUp: false }).act, 'skip');
  assert.ok(/link is down/.test(R.atQuit({ pending: p, catUp: false }).why));
  assert.strictEqual(R.atQuit({ pending: p, catUp: true, atuBusy: true }).act, 'skip');
  assert.strictEqual(R.atStop({ pending: p, windowOpen: true, quit: true }), 'skip', 'Winlink stops after the CAT link closed: logged, not sent');
});
test('the dial moved by hand between attempts: the original return point is kept, and it is logged', () => {
  assert.strictEqual(R.movedByHand(14102300, 14102350), false, 'a nudge inside 100 Hz is not a move');
  assert.strictEqual(R.movedByHand(14102300, 7074000), true);
  assert.strictEqual(R.movedByHand(0, 7074000), false, 'nothing to compare with');
  const s = station();
  s.pick(14109100); s.start(14109100); s.end();
  s.hand(7074000);
  s.start(7101000); s.end();
  assert.strictEqual(s.st.pending.freqHz, 28074000, 'still the original');
  assert.ok(s.st.logs.some((l) => /moved by hand/.test(l)), 'said so');
});

console.log('main.js wiring of the return');
test('session end keeps the return point while the mail window is open, and says so', () => {
  const end = fnBody(main, 'winlinkEndSession');
  assert.ok(/WinlinkReturn\.atSessionEnd\(\{ tuned: s\.tuned, returnTo: s\.returnTo, windowOpen: winlinkMailWindowOpen\(\) \}\)/.test(end));
  assert.ok(/=== 'keep'\) winlinkKeepReturn\(s\.returnTo\)/.test(end));
  assert.ok(/else if \(_ret === 'return'\) setTimeout\(\(\) => winlinkRestoreDial\(s\.returnTo\), 1500\);/.test(end), 'goes back at once only with no mail window');
  const keep = fnBody(main, 'winlinkKeepReturn');
  assert.ok(/_winlinkPreviewReturnTo = \{ \.\.\.returnTo, moved: true \}/.test(keep), 'the session\'s (original) return point is kept');
  assert.ok(/stays on .* until the mail window closes/.test(keep));
  assert.ok(/_winlinkLeftAtHz = _currentFreqHz/.test(keep));
});
test('a later gateway pick never replaces the return point; a hand tune between attempts is logged', () => {
  assert.ok(/if \(!_winlinkPreviewReturnTo && _currentFreqHz\) _winlinkPreviewReturnTo = winlinkDialHere/.test(fnBody(main, 'winlinkPreviewQsy')));
  assert.ok(/winlinkNoteHandTune\(\)/.test(fnBody(main, 'winlinkPreviewQsy')));
  assert.ok(/winlinkNoteHandTune\(\)/.test(fnBody(main, 'winlinkStartSession')));
  assert.ok(/WinlinkReturn\.movedByHand\(_winlinkLeftAtHz, _currentFreqHz\)/.test(fnBody(main, 'winlinkNoteHandTune')));
});
test('closing the mail window goes back once through the guarded restore', () => {
  assert.ok(/winlinkPreviewRestore\('window closed'\)/.test(main));
  const close = fnBody(main, 'winlinkPreviewRestore');
  assert.ok(/WinlinkReturn\.atClose\(/.test(close));
  assert.ok(/_winlinkPreviewReturnTo = null;/.test(close), 'once');
  assert.ok(/'the mail window closed' : why\}: the radio now goes back to`/.test(close), 'says the window closed and it now goes back');
  assert.ok(/if \(act === 'return'\) winlinkRestoreDial\(r, 0, lead\);/.test(close), 'through the guarded restore');
  assert.ok(/during a session — the radio goes back to/.test(close), 'a running session is not moved');
  assert.ok(!/tuneRadio\(/.test(close), 'no unguarded tune of its own');
});
test('stopping Winlink goes back once; on quit it says it was skipped', () => {
  const dis = fnBody(main, 'disconnectWinlink');
  assert.ok(dis.indexOf('winlinkReturnOnStop(quit)') > dis.indexOf('winlinkEndSession('), 'after the session ended');
  const stop = fnBody(main, 'winlinkReturnOnStop');
  assert.ok(/WinlinkReturn\.atStop\(/.test(stop));
  assert.ok(/winlinkRestoreDial\(r, 0, 'Winlink stopped: the radio now goes back to'\)/.test(stop));
  assert.ok(/not going back to/.test(stop), 'a skipped return is logged');
});
test('quit goes back first when it can, inside the cleanup budget, before the CAT link closes', () => {
  const i = main.indexOf("app.on('before-quit', (e) => {");
  const bq = main.slice(i, main.indexOf('gracefulCleanup();', i));
  assert.ok(/if \(winlinkReturnBeforeQuit\(\(\) => app\.quit\(\)\)\) \{ e\.preventDefault\(\); return; \}/.test(bq));
  const q = fnBody(main, 'winlinkReturnBeforeQuit');
  assert.ok(/WinlinkReturn\.atQuit\(/.test(q));
  assert.ok(/_winlinkPreviewReturnTo = null;/.test(q), 'once: the second before-quit carries on');
  assert.ok(/not going back to/.test(q), 'a skipped return is logged');
  assert.ok(q.indexOf('tuneRadio(') > 0 && /setTimeout\(then, v\.waitMs\)/.test(q));
});

console.log(`\nWinlink DATA hold (#187): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
