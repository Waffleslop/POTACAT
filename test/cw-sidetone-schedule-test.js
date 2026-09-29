#!/usr/bin/env node
'use strict';
// ECHOCAT Web local sidetone (LZ3AW 2026-09-26: "the sidetone does not
// produce correct dot and dash, they sound choppy" on paddle and live typing,
// fine on macros). Paddle elements are now scheduled on the audio clock at
// their exact length, and live typing appends instead of cutting off the
// letters still sounding. Run: node test/cw-sidetone-schedule-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8').replace(/\r\n/g, '\n');
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' missing');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

// A fake Web Audio context that records the gain automation.
function fakeCtx() {
  const events = [];
  const param = {
    setValueAtTime: (v, t) => events.push(['set', v, t]),
    linearRampToValueAtTime: (v, t) => events.push(['ramp', v, t]),
    cancelScheduledValues: (t) => events.push(['cancel', t]),
  };
  const ctx = {
    currentTime: 0,
    destination: {},
    createOscillator: () => ({ type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }),
    createGain: () => ({ gain: param, connect() {} }),
  };
  return { ctx, events };
}

console.log('cw sidetone schedule');

test('paddle elements keep their exact length and a one-dit space despite late timers', () => {
  const { ctx, events } = fakeCtx();
  // eslint-disable-next-line no-new-func
  const api = new Function('ctx', `
    var cwAudioCtx = ctx, cwSidetoneFreq = 600, cwSidetoneVol = 0.5, cwWpm = 25;
    function ensureCwAudioCtx() {}
    var paddleOsc = null, paddleGain = null, paddleNextAt = 0;
    ${extract('ensurePaddleVoice')}
    ${extract('schedulePaddleElement')}
    return { schedule: schedulePaddleElement };
  `)(ctx);
  const dit = 1.2 / 25; // 48 ms
  // "dah dit dah": the keyer's timers fire LATE by 4-9 ms each time, as
  // setTimeout does, but always before the next element is due.
  ctx.currentTime = 1.000; api.schedule(dit * 3000);
  ctx.currentTime = 1.000 + 4 * dit + 0.006; api.schedule(dit * 1000);
  ctx.currentTime = 1.000 + 6 * dit + 0.009; api.schedule(dit * 3000);
  // The first set-to-0 is the voice's initial silence, not an element.
  const starts = events.filter((e) => e[0] === 'set' && e[1] === 0).map((e) => e[2]).slice(1);
  const ends = events.filter((e) => e[0] === 'ramp' && e[1] === 0).map((e) => e[2]);
  assert.strictEqual(starts.length, 3);
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(close(ends[0] - starts[0], 3 * dit), 'dah length exact');
  assert.ok(close(ends[1] - starts[1], dit), 'dit length exact');
  assert.ok(close(starts[1] - ends[0], dit), 'space exact despite a 6 ms late timer');
  assert.ok(close(starts[2] - ends[1], dit), 'space exact despite a 9 ms late timer');
});

test('iambic keyer hands each element its length; its end is not re-switched', () => {
  assert.ok(/onKey\(true, isDit \? ditMs\(\) : dahMs\(\)(, \{[^}]*\})?\);/.test(src));
  assert.ok(/onKey\(false, 0\); \/\/ the scheduled element already ends itself/.test(src));
  assert.ok(/if \(durMs\) \{ (sendCwKeyStream\(true, durMs, info\); )?schedulePaddleElement\(durMs\); return; \}/.test(src));
});

test('live typing appends to the sidetone instead of cutting off what is sounding', () => {
  assert.ok(/playCwTextSidetone\(delta, \{ append: true \}\);/.test(src));
  assert.ok(/if \(!append\) stopCwTextSidetone\(\);/.test(src));
  assert.ok(/if \(append && cwTextEndAt > now\) \{/.test(src));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
