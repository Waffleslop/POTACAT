// #256 (LZ3AW, K4DZC): Step down / Step up buttons and arrow-key tuning in the
// VFO window and ECHOCAT Web's VFO view. Up / Down tune one step (hold to
// repeat), Left / Right change the step; never while typing; the VFO lock and
// the "no dial yet" guard hold; the main window's arrows stay on the spots.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const K = require('../lib/vfo-step-keys');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n    ' + e.message); }
}
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const vfo = read('renderer', 'vfo-popout.html');
const remote = read('renderer', 'remote.js');
const remoteHtml = read('renderer', 'remote.html');
const app = read('renderer', 'app.js');
const server = read('lib', 'remote-server.js');

// Pull `function name(...) { ... }` out of a source file (body ends at a line
// holding only the closing brace at the function's own indent).
function fnSource(src, name) {
  const m = new RegExp('\\n([ \\t]*)function ' + name + '\\(([^)]*)\\) \\{').exec(src);
  assert.ok(m, name + ' found');
  const indent = m[1];
  const start = m.index + 1;
  const end = src.indexOf('\n' + indent + '}', start);
  assert.ok(end > start, name + ' has an end');
  return src.slice(start, end + indent.length + 2);
}

// --- step math ---
test('one step up and down from the dial, in Hz', () => {
  assert.strictEqual(K.stepFreqHz(14074000, 1000, 1), 14075000);
  assert.strictEqual(K.stepFreqHz(14074000, 1000, -1), 14073000);
  assert.strictEqual(K.stepFreqHz(7030010, 10, 1), 7030020);
  assert.strictEqual(K.stepFreqHz(28074000, 25000, -1), 28049000);
});
test('no dial known (0), no step or no direction: nothing tunes', () => {
  assert.strictEqual(K.stepFreqHz(0, 1000, 1), 0);
  assert.strictEqual(K.stepFreqHz(NaN, 1000, 1), 0);
  assert.strictEqual(K.stepFreqHz(14074000, 0, 1), 0);
  assert.strictEqual(K.stepFreqHz(14074000, 1000, 0), 0);
  assert.strictEqual(K.stepFreqHz(14074000, 1000, 2), 0);
});
test('a step never goes below 0 Hz', () => {
  assert.strictEqual(K.stepFreqHz(500, 1000, -1), 0);
});
test('Left / Right move the step inside the list, no wrap', () => {
  assert.strictEqual(K.stepIndexMove(4, 1, 8), 5);
  assert.strictEqual(K.stepIndexMove(4, -1, 8), 3);
  assert.strictEqual(K.stepIndexMove(7, 1, 8), 7);
  assert.strictEqual(K.stepIndexMove(0, -1, 8), 0);
});

// --- key handling ---
const key = (k, extra) => Object.assign({ key: k }, extra);
test('Up / Down tune, Right / Left change the step', () => {
  assert.strictEqual(K.keyAction(key('ArrowUp')), 'up');
  assert.strictEqual(K.keyAction(key('ArrowDown')), 'down');
  assert.strictEqual(K.keyAction(key('ArrowRight')), 'step-bigger');
  assert.strictEqual(K.keyAction(key('ArrowLeft')), 'step-smaller');
  assert.strictEqual(K.keyAction(key('a')), null);
  assert.strictEqual(K.keyAction(key('Enter')), null);
});
test('arrows are ignored while typing in a text box, list or slider', () => {
  assert.strictEqual(K.keyAction(key('ArrowUp'), { typing: true }), null);
  assert.strictEqual(K.keyAction(key('ArrowLeft'), { typing: true }), null);
  assert.strictEqual(K.isTypingTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.strictEqual(K.isTypingTarget({ tagName: 'INPUT' }), true);
  assert.strictEqual(K.isTypingTarget({ tagName: 'INPUT', type: 'number' }), true);
  assert.strictEqual(K.isTypingTarget({ tagName: 'INPUT', type: 'range' }), true);
  assert.strictEqual(K.isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.strictEqual(K.isTypingTarget({ tagName: 'SELECT' }), true);
  assert.strictEqual(K.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
});
test('a focused button, checkbox or the page itself does not block the arrows', () => {
  assert.strictEqual(K.isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.strictEqual(K.isTypingTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.strictEqual(K.isTypingTarget({ tagName: 'BODY' }), false);
  assert.strictEqual(K.isTypingTarget(null), false);
});
test('Ctrl, Alt or Cmd with an arrow is left to the shortcut', () => {
  assert.strictEqual(K.keyAction(key('ArrowUp', { ctrlKey: true })), null);
  assert.strictEqual(K.keyAction(key('ArrowDown', { altKey: true })), null);
  assert.strictEqual(K.keyAction(key('ArrowRight', { metaKey: true })), null);
  assert.strictEqual(K.keyAction(key('ArrowUp', { shiftKey: true })), 'up');
});

// --- hold to repeat, fake timers ---
function fakeTimers() {
  let now = 0, id = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, ms) { jobs.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout(i) { jobs.delete(i); },
    setInterval(fn, ms) { jobs.set(++id, { fn, at: now + ms, every: ms }); return id; },
    clearInterval(i) { jobs.delete(i); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [i, j] of jobs) if (j.at <= end && (!next || j.at < next[1].at)) next = [i, j];
        if (!next) break;
        const [i, j] = next;
        now = j.at;
        if (j.every) j.at += j.every; else jobs.delete(i);
        j.fn();
      }
      now = end;
    },
    pending: () => jobs.size,
  };
}
test('a press tunes one step at once; a short press tunes only that one', () => {
  const t = fakeTimers(); const calls = [];
  const h = K.createHoldRepeat((d) => { calls.push(d); return true; }, { timers: t });
  h.start(1);
  assert.deepStrictEqual(calls, [1]);
  t.advance(200); h.stop(); t.advance(2000);
  assert.deepStrictEqual(calls, [1]);
  assert.strictEqual(t.pending(), 0);
});
test('holding waits 400 ms, then repeats every 100 ms until let go', () => {
  const t = fakeTimers(); const calls = [];
  const h = K.createHoldRepeat((d) => { calls.push(d); return true; }, { timers: t });
  assert.strictEqual(K.HOLD_DELAY_MS, 400);
  assert.strictEqual(K.HOLD_INTERVAL_MS, 100);
  h.start(-1);
  t.advance(399); assert.strictEqual(calls.length, 1);
  t.advance(1);   assert.strictEqual(calls.length, 2);
  t.advance(100); assert.strictEqual(calls.length, 3);
  t.advance(500); assert.strictEqual(calls.length, 8);
  assert.ok(calls.every((d) => d === -1));
  h.stop(); t.advance(1000);
  assert.strictEqual(calls.length, 8);
  assert.strictEqual(h.held(), 0);
});
test('keyboard auto-repeat in the same direction does not restart or add steps', () => {
  const t = fakeTimers(); const calls = [];
  const h = K.createHoldRepeat((d) => { calls.push(d); return true; }, { timers: t });
  h.start(1); t.advance(50); h.start(1); h.start(1);
  assert.strictEqual(calls.length, 1);
  t.advance(350); assert.strictEqual(calls.length, 2);
  h.start(-1); // the other way: a fresh press
  assert.deepStrictEqual(calls.slice(-1), [-1]);
  h.stop();
});
test('a step that cannot tune (VFO locked) ends the hold', () => {
  const t = fakeTimers(); let n = 0;
  const h = K.createHoldRepeat(() => { n++; return false; }, { timers: t });
  h.start(1); t.advance(2000);
  assert.strictEqual(n, 1);
  assert.strictEqual(t.pending(), 0);
});

// --- VFO window: the step goes through the wheel's path; lock and 0 respected ---
function runStepTune(state) {
  const src = fnSource(vfo, 'stepTune');
  const tunes = [];
  const f = new Function('S', 'window', 'tuneFromPopout', 'updateDisplay', 'drawVfoDial',
    'let { vfoLocked, currentFreqHz, stepIdx, vfoAngle } = S; const STEPS = S.STEPS, STEP_ANGLE = 1;\n' + src +
    '\nconst r = stepTune(S.dir); return { r, currentFreqHz, vfoAngle };');
  const out = f(state, { VfoStepKeys: K }, (khz) => tunes.push(khz), () => {}, () => {});
  return Object.assign(out, { tunes });
}
const STEPS = [{ hz: 10 }, { hz: 100 }, { hz: 1000 }];
test('VFO window: a step tunes the radio by the chosen step', () => {
  const o = runStepTune({ vfoLocked: false, currentFreqHz: 14074000, stepIdx: 2, vfoAngle: 0, STEPS, dir: 1 });
  assert.strictEqual(o.r, true);
  assert.deepStrictEqual(o.tunes, [14075]);
  assert.strictEqual(o.currentFreqHz, 14075000);
});
test('VFO window: locked VFO tunes nothing', () => {
  const o = runStepTune({ vfoLocked: true, currentFreqHz: 14074000, stepIdx: 2, vfoAngle: 0, STEPS, dir: 1 });
  assert.strictEqual(o.r, false);
  assert.deepStrictEqual(o.tunes, []);
});
test('VFO window: no dial known yet tunes nothing (never from 0)', () => {
  const o = runStepTune({ vfoLocked: false, currentFreqHz: 0, stepIdx: 2, vfoAngle: 0, STEPS, dir: -1 });
  assert.strictEqual(o.r, false);
  assert.deepStrictEqual(o.tunes, []);
});
test('VFO window: the wheel, buttons and keys share stepTune', () => {
  assert.ok(vfo.includes('<script src="../lib/vfo-step-keys.js"></script>'));
  assert.ok(/function handleFreqWheel\(e\) \{[\s\S]*?stepTune\(dir\)[\s\S]*?\n\}/.test(vfo), 'wheel tunes via stepTune');
  const press = fnSource(vfo, 'stepPress');
  assert.ok(/if \(vfoLocked\) \{ showLockedToast\(\); return false; \}/.test(press), 'locked press says so');
  assert.ok(/return stepTune\(dir\)/.test(press));
  assert.ok(/createHoldRepeat\(stepPress\)/.test(vfo));
});
test('VFO window: Step down / Step up buttons sit with the step chip', () => {
  const sec = /<span class="vfo-section step-group" id="sec-step">([\s\S]*?)<\/span>/.exec(vfo);
  assert.ok(sec, 'sec-step found');
  assert.ok(/id="step-down-btn"[^>]*aria-label="Step down"/.test(sec[1]));
  assert.ok(/id="step-up-btn"[^>]*aria-label="Step up"/.test(sec[1]));
  assert.ok(sec[1].indexOf('step-down-btn') < sec[1].indexOf('step-select'));
  assert.ok(sec[1].indexOf('step-select') < sec[1].indexOf('step-up-btn'));
  assert.ok(/\['step-down-btn', -1\], \['step-up-btn', 1\]/.test(vfo));
});
test('VFO window: arrow keys skip text boxes, the settings sheet and typed entry', () => {
  const m = /window\.addEventListener\('keydown', \(e\) => \{\n  if \(sheetOpen\(\) \|\| stripEntry\) return;([\s\S]*?)\n\}\);/.exec(vfo);
  assert.ok(m, 'arrow keydown handler found');
  assert.ok(/VfoStepKeys\.keyAction\(e, \{ typing: t !== kpInput && window\.VfoStepKeys\.isTypingTarget\(t\) \}\)/.test(m[1]));
  assert.ok(/stepHold\.start\(act === 'up' \? 1 : -1\)/.test(m[1]));
  assert.ok(/moveStep\(act === 'step-bigger' \? 1 : -1\)/.test(m[1]));
  assert.ok(/window\.addEventListener\('blur', \(\) => stepHold\.stop\(\)\)/.test(vfo));
});

// --- ECHOCAT Web ---
function runVfStepTune(state) {
  const src = fnSource(remote, 'vfStepTune');
  const sent = [];
  const f = new Function('S', 'window', 'dpTune', 'renderAll', 'drawDial',
    'let { currentFreqKhz, dpStepIdx, vfoLocked, dialRotation } = S; const STEP_SIZES = S.STEP_SIZES;\n' + src +
    '\nreturn stepFn(S.dir);'.replace('stepFn', 'vfStepTune'));
  const r = f(state, { VfoStepKeys: K }, (khz) => sent.push(khz), () => {}, () => {});
  return { r, sent };
}
const KHZ = [0.01, 0.1, 0.5, 1, 5, 10, 25, 100];
test('Web: a step tunes by the chosen step through dpTune (lock and range live there)', () => {
  const o = runVfStepTune({ currentFreqKhz: 14074, dpStepIdx: 3, vfoLocked: false, dialRotation: 0, STEP_SIZES: KHZ, dir: 1 });
  assert.strictEqual(o.r, true);
  assert.deepStrictEqual(o.sent, [14075]);
  const o2 = runVfStepTune({ currentFreqKhz: 7030.01, dpStepIdx: 0, vfoLocked: false, dialRotation: 0, STEP_SIZES: KHZ, dir: -1 });
  assert.deepStrictEqual(o2.sent, [7030]);
});
test('Web: locked VFO ends the hold (dpTune shows the lock note, sends nothing)', () => {
  const o = runVfStepTune({ currentFreqKhz: 14074, dpStepIdx: 3, vfoLocked: true, dialRotation: 0, STEP_SIZES: KHZ, dir: 1 });
  assert.strictEqual(o.r, false);
  assert.ok(/if \(vfoLocked\) \{\s*showToast\('VFO Locked/.test(fnSource(remote, 'dpTune')), 'dpTune refuses while locked');
});
test('Web: no dial known yet tunes nothing', () => {
  const o = runVfStepTune({ currentFreqKhz: 0, dpStepIdx: 3, vfoLocked: false, dialRotation: 0, STEP_SIZES: KHZ, dir: 1 });
  assert.strictEqual(o.r, false);
  assert.deepStrictEqual(o.sent, []);
});
test('Web: arrows and wheel wired on the VFO view; both modules inlined', () => {
  assert.ok(remoteHtml.includes('<!-- vfo-step-keys-js -->'));
  assert.ok(remoteHtml.includes('<!-- wheel-tune-js -->'));
  assert.ok(server.includes("['vfo-step-keys-js', 'vfo-step-keys.js']"));
  assert.ok(server.includes("['wheel-tune-js', 'wheel-tune.js']"));
  assert.ok(/if \(!isOpen \|\| !document\.getElementById\('dial-pad'\)\.classList\.contains\('hidden'\)\) return;\s*const act = window\.VfoStepKeys\.keyAction\(e, \{ typing: window\.VfoStepKeys\.isTypingTarget\(document\.activeElement\) \}\)/.test(remote));
  assert.ok(/vfDial\.addEventListener\('wheel', vfWheel/.test(remote));
  assert.ok(/createHoldRepeat\(vfStepTune\)/.test(remote));
});
test('Web: the dead status-bar freq-up / freq-down code is gone', () => {
  assert.ok(!/freq-up-btn|freq-down-btn|freqUpBtn|freqDownBtn/.test(remote));
  assert.ok(!/freq-up-btn|freq-down-btn/.test(remoteHtml));
});

// --- main window: Up / Down stay on the spots ---
test('main window: Up / Down still step through the spot table and tune each spot', () => {
  assert.ok(/\/\/ Arrow Up\/Down — navigate spots in table view\n  if \(\(e\.key === 'ArrowUp' \|\| e\.key === 'ArrowDown'\) && !e\.target\.matches\('input, select, textarea'\) && showTable && !scanning\) \{/.test(app));
  assert.ok(/const step = e\.key === 'ArrowDown' \? 1 : -1;[\s\S]{0,1200}window\.api\.tune\(spot\.frequency, spot\.mode, spot\.bearing\)/.test(app));
  assert.ok(!/VfoStepKeys/.test(app), 'the main window does not take the arrows for step tuning');
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
