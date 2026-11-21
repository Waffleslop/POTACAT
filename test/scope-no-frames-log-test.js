#!/usr/bin/env node
'use strict';
// K3SBP 2026-11-21 (BUG-K3SBP-20261121-EAFC83): a Flex scope subscribed and
// stayed blank, and the log could not say whether no frame arrived or every
// frame was dropped as misaligned. The scope now logs one line when no picture
// has come SCOPE_NO_FRAMES_MS after a start (with what did arrive), and one
// line on the first misaligned frame of a start. The status code is glue in
// main.js; this runs the two functions out of main.js with stand-ins.
// Run: node test/scope-no-frames-log-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const block = main.slice(main.indexOf('const SCOPE_NO_FRAMES_MS'), main.indexOf('/** Called from sendCatFrequency'));

/** The status setter with fake timers and a fake log. */
function harness(source) {
  const logs = [];
  const timers = [];
  const env = {
    yaesuScopeState: { source, status: 'stopped', frames: 0, misaligned: 0 },
    icomScopeEntry: null,
    sendCatLog: (l) => logs.push(l),
    yaesuScopeBroadcastState: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (h) => { if (timers[h - 1]) timers[h - 1].fn = null; },
  };
  // eslint-disable-next-line no-new-func
  const fns = new Function(...Object.keys(env), block + '\nreturn { yaesuScopeSetStatus, SCOPE_NO_FRAMES_MS };')(...Object.values(env));
  const fire = () => { for (const t of timers.splice(0)) if (t.fn) t.fn(); };
  return { env, fns, logs, timers, fire };
}

console.log('Scope: say when no picture comes, and when frames are misaligned');

test('a Flex pan that sends nothing for 6 s: one line saying nothing reached POTACAT', () => {
  const h = harness('flex');
  h.fns.yaesuScopeSetStatus('starting', null);
  assert.strictEqual(h.timers[0].ms, 6000);
  h.fire();
  assert.deepStrictEqual(h.logs, ['[Scope] no picture from the Flex panadapter 6 s after it started: 0 frames arrived (nothing reached POTACAT from the radio)']);
});

test('frames that all came misaligned are counted in the line', () => {
  const h = harness('sculan10');
  h.fns.yaesuScopeSetStatus('starting', null);
  h.env.yaesuScopeState.frames = 40; h.env.yaesuScopeState.misaligned = 40;
  h.fire();
  assert.deepStrictEqual(h.logs, ['[Scope] no picture from the SCU-LAN10 scope 6 s after it started: 40 frames arrived, 40 of them misaligned and dropped']);
});

test('a scope that goes live, or is stopped, in time says nothing', () => {
  const h = harness('flex');
  h.fns.yaesuScopeSetStatus('starting', null);
  h.env.yaesuScopeState.status = 'live';
  h.fire();
  assert.deepStrictEqual(h.logs, []);
  const g = harness('flex');
  g.fns.yaesuScopeSetStatus('starting', null);
  g.fns.yaesuScopeSetStatus('stopped', null);
  g.fire();
  assert.deepStrictEqual(g.logs, []);
});

test('the first misaligned frame of a start is logged once', () => {
  const onFrame = main.slice(main.indexOf('function yaesuScopeOnFrame('), main.indexOf('function yaesuScopeOnFrame(') + 600);
  assert.ok(/yaesuScopeState\.misaligned === 1\) sendCatLog\(/.test(onFrame));
  assert.ok(/arrived misaligned and was dropped/.test(onFrame));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
