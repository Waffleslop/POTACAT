// test/jtcat-waterfall-off-test.js — #391: the JTCAT window can switch its audio
// waterfall off. Options > The picture > "Show the audio waterfall", default on.
// Off hides the pane and stops drawing it (no canvas work, no animation frame);
// the decoder is fed by the capture worklet, never by the waterfall, so decoding
// carries on. The choice is a machine-wide display setting (jtcatShowWaterfall).
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const js = readSrc(path.join(root, 'renderer', 'jtcat-popout.js')).replace(/\r\n/g, '\n');
const html = readSrc(path.join(root, 'renderer', 'jtcat-popout.html')).replace(/\r\n/g, '\n');
const main = readSrc(path.join(root, 'main.js')).replace(/\r\n/g, '\n');
const doc = readSrc(path.join(root, 'docs', 'JTCAT.md')).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function extract(name) {
  const i = js.indexOf('function ' + name + '(');
  assert.ok(i !== -1, name + ' exists');
  let depth = 0;
  const j = js.indexOf('{', i);
  for (let k = j; k < js.length; k++) {
    if (js[k] === '{') depth++;
    else if (js[k] === '}' && --depth === 0) return js.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
function has(text, re, msg) { assert.ok(re.test(text), (msg || 'missing') + ': ' + re); }
function fakeEl() {
  const set = new Set();
  return {
    classList: {
      toggle(c, on) { if (on === undefined) on = !set.has(c); if (on) set.add(c); else set.delete(c); return on; },
      contains(c) { return set.has(c); }, add(c) { set.add(c); }, remove(c) { set.delete(c); },
    },
    set,
  };
}

// Runs wfApplyShown + wfSetShown against fake elements and counters.
function harness(opts) {
  opts = opts || {};
  const els = { 'jp-wf-single': fakeEl(), 'jp-wf-multi': fakeEl() };
  const toggle = fakeEl();
  const calls = { raf: 0, cancel: 0, saved: [], resize: 0, reset: 0, multiBuild: 0 };
  const env = {
    document: { getElementById: (id) => els[id] || null },
    window: { api: { saveSettings: (o) => calls.saved.push(o) } },
    requestAnimationFrame: () => { calls.raf++; return 7; },
    cancelAnimationFrame: () => { calls.cancel++; },
    resizeWaterfall: () => { calls.resize++; },
    wfResetAccum: () => { calls.reset++; },
    buildMultiWaterfalls: () => { calls.multiBuild++; },
    popoutWaterfallLoop: function () {},
  };
  const f = new Function('env', 'wfShowToggle', 'popoutAnalyser', 'multiActive', 'popoutWaterfallAnim', 'multiWfAnim',
    'var document = env.document, window = env.window, requestAnimationFrame = env.requestAnimationFrame,' +
    ' cancelAnimationFrame = env.cancelAnimationFrame, resizeWaterfall = env.resizeWaterfall,' +
    ' wfResetAccum = env.wfResetAccum, buildMultiWaterfalls = env.buildMultiWaterfalls,' +
    ' popoutWaterfallLoop = env.popoutWaterfallLoop;\nvar wfShown = true;\n' +
    extract('wfApplyShown') + '\n' + extract('wfSetShown') +
    '\nreturn { set: wfSetShown, shown: function(){ return wfShown; }, anim: function(){ return popoutWaterfallAnim; }, multiAnim: function(){ return multiWfAnim; } };');
  const api = f(env, toggle, opts.analyser === undefined ? {} : opts.analyser, !!opts.multi,
    opts.anim === undefined ? 3 : opts.anim, opts.multiAnim === undefined ? null : opts.multiAnim);
  return { api, els, toggle, calls };
}

t('the option is in Options > The picture, first, labelled plainly and on by default', () => {
  const pic = html.indexOf('<div class="jp-opt-section">The picture</div>');
  assert.ok(pic !== -1, 'The picture section');
  const row = html.indexOf('id="jp-wf-show"');
  assert.ok(row > pic, 'row sits in The picture');
  assert.ok(row < html.indexOf('id="jp-wf-speed"'), 'row comes before Waterfall speed');
  const tag = html.slice(html.lastIndexOf('<', row), html.indexOf('>', row) + 1);
  assert.match(tag, /<button[^>]*class="jp-opt-row active"/, 'a checkbox row, ticked in the markup');
  const label = html.slice(row, html.indexOf('</button>', row));
  assert.match(label, /<span class="jp-opt-label">Show the audio waterfall<\/span>/);
  assert.match(label, /decod/i, 'help says decoding carries on');
});

t('default on: a missing setting shows the waterfall, only false hides it', () => {
  has(js, /var wfShown = true;/);
  has(js, /wfSetShown\(s\.jtcatShowWaterfall !== false, false\)/, 'applySettings reads it, default on');
});

t('persisted: the click saves jtcatShowWaterfall; it is a machine-wide display setting', () => {
  const h = harness();
  h.api.set(false, true);
  assert.deepStrictEqual(h.calls.saved, [{ jtcatShowWaterfall: false }]);
  h.api.set(true, true);
  assert.deepStrictEqual(h.calls.saved[1], { jtcatShowWaterfall: true });
  h.api.set(false, false);
  assert.strictEqual(h.calls.saved.length, 2, 'loading the setting does not save it back');
  has(js, /wfShowToggle\.addEventListener\('click', function\(\) \{ wfSetShown\(!wfShown, true\); \}\)/);
  has(main, /'jtcatShowWaterfall',/, 'listed in the GLOBAL keys beside jtcatShowBandScope');
  has(doc, /jtcatShowWaterfall/, 'docs/JTCAT.md names it with the other display settings');
});

t('off hides the pane: single and multi-slice panes get jp-wf-off, the row unticks', () => {
  const h = harness();
  h.api.set(false, false);
  assert.ok(h.els['jp-wf-single'].classList.contains('jp-wf-off'));
  assert.ok(h.els['jp-wf-multi'].classList.contains('jp-wf-off'));
  assert.ok(!h.toggle.classList.contains('active'));
  h.api.set(true, false);
  assert.ok(!h.els['jp-wf-single'].classList.contains('jp-wf-off'));
  assert.ok(h.toggle.classList.contains('active'));
  has(html, /#jp-wf-single\.jp-wf-off > canvas[^{]*\{ display: none; \}/, 'CSS hides the canvas');
  has(html, /#jp-wf-multi\.jp-wf-off \{ display: none !important; \}/, 'CSS hides the multi panes');
});

t('off stops drawing: the pending frame is cancelled and the loop does not re-arm', () => {
  const h = harness({ anim: 3, multiAnim: 9 });
  h.api.set(false, false);
  assert.strictEqual(h.calls.cancel, 2, 'single and multi frames cancelled');
  assert.strictEqual(h.api.anim(), null);
  assert.strictEqual(h.api.multiAnim(), null);
  assert.strictEqual(h.calls.raf, 0, 'no new frame requested while off');
  // The loop itself: its first statement leaves when the waterfall is off,
  // before any analyser read, canvas call or requestAnimationFrame.
  const loop = extract('popoutWaterfallLoop');
  const guard = loop.indexOf('if (!wfShown) { popoutWaterfallAnim = null; return; }');
  assert.ok(guard !== -1, 'loop has the off guard');
  for (const later of ['requestAnimationFrame', 'getByteFrequencyData', 'jpWfCtx', 'jtcatSpectrum']) {
    assert.ok(loop.indexOf(later) > guard, later + ' comes after the guard');
  }
  const ran = new Function('wfShown', 'popoutWaterfallAnim', 'requestAnimationFrame', 'popoutAnalyser', 'jpWfCtx',
    loop + '\npopoutWaterfallLoop(); return popoutWaterfallAnim;');
  let rafs = 0;
  const ctx = new Proxy({}, { get() { throw new Error('canvas touched while off'); } });
  const an = new Proxy({}, { get() { throw new Error('analyser read while off'); } });
  assert.strictEqual(ran(false, 5, () => { rafs++; return 1; }, an, ctx), null);
  assert.strictEqual(rafs, 0);
  // Multi-slice: the panes are built (so turning it back on is instant) but never animated.
  const multi = extract('buildMultiWaterfalls');
  const gate = multi.indexOf('if (!wfShown) return;');
  assert.ok(gate !== -1 && gate < multi.lastIndexOf('multiWfAnim = requestAnimationFrame(drawMultiWf)'), 'multi loop gated');
});

t('back on: the loop restarts once, the canvas is resized, multi panes rebuild', () => {
  const h = harness({ anim: null, multi: true });
  h.api.set(false, false);
  h.api.set(true, false);
  assert.strictEqual(h.calls.raf, 1, 'one frame requested');
  assert.strictEqual(h.calls.resize, 1, 'canvas resized from its hidden 0x0');
  assert.strictEqual(h.calls.reset, 1);
  assert.strictEqual(h.calls.multiBuild, 1);
  h.api.set(true, false);
  assert.strictEqual(h.calls.raf, 1, 'already on: nothing restarts');
  const noAudio = harness({ anim: null, analyser: null });
  noAudio.api.set(false, false); noAudio.api.set(true, false);
  assert.strictEqual(noAudio.calls.raf, 0, 'no audio yet: startPopoutAudio starts the loop, not the toggle');
});

t('the warnings still work while it is off: a slow tick runs the watchdog, not the picture', () => {
  const watch = extract('wfWatchFrame');
  assert.match(watch, /popoutRxGainLevel <= 0\.001/, 'RX gain at 0 notice');
  assert.match(watch, /WF_SILENCE_MS/, 'Flex DAX-silent watchdog');
  assert.match(watch, /jttyFeedLevels/, 'JTTY Clear spot levels');
  assert.ok(extract('popoutWaterfallLoop').indexOf('wfWatchFrame(freqData, passbandBins)') !== -1, 'the loop uses it');
  const tick = extract('wfOffTick');
  assert.match(tick, /if \(wfShown \|\| !popoutAnalyser\) return;/);
  assert.match(tick, /wfWatchFrame\(/);
  assert.ok(!/jpWfCtx|requestAnimationFrame|putImageData/.test(tick), 'no canvas work in the tick');
  has(js, /setInterval\(wfOffTick, 500\)/);
  // The overlay stays readable as a strip when the canvas is gone.
  has(html, /#jp-wf-single\.jp-wf-off #jp-wf-silent\.show \{ position: static;/);
});

t('decoding is unaffected: the capture path never reads wfShown', () => {
  const start = js.indexOf('async function startPopoutAudio(');
  assert.ok(start !== -1, 'startPopoutAudio exists');
  const body = extract('startPopoutAudio');
  assert.match(body, /window\.api\.jtcatAudio\(/, 'samples go to the decoder from the capture path');
  assert.ok(!/wfShown/.test(body), 'startPopoutAudio does not consult the waterfall option');
  // Every line that sends audio to main is outside any wfShown condition.
  const lines = js.split('\n');
  lines.forEach((l, i) => {
    if (/window\.api\.jtcatAudio\(/.test(l)) {
      const ctx = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
      assert.ok(!/wfShown/.test(ctx), 'jtcatAudio near line ' + (i + 1) + ' is not gated');
    }
  });
  // Main measures the quiet TX frequency itself when no window reports (lib/jtcat-quiet-freq.js),
  // and phones get the in-process spectrum, so neither depends on this loop.
  has(main, /jtcatQuietTracker\.windowFresh\(now\)/);
});

t('ECHOCAT Web waterfall is untouched', () => {
  const remote = readSrc(path.join(root, 'renderer', 'remote.js'));
  assert.ok(!/jtcatShowWaterfall/.test(remote));
});

console.log(`\njtcat-waterfall-off: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
