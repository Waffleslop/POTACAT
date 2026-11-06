#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// hoogskev (FTX-1, macOS, 2026-11-05): the VFO window's radio monitor played
// in the left channel only. The capture comes back as two channels with only
// channel 0 filled; channel 0 is now taken and up-mixed to both sides.
// Run: node test/mono-upmix-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { monoToBothSides } = require('../lib/mono-upmix');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// A Web Audio stand-in that records the graph.
function fakeCtx() {
  const edges = [];
  const node = (kind, extra = {}) => ({ kind, ...extra, connect(to, output = 0) { edges.push({ from: this, to, output }); return to; } });
  return {
    edges,
    createChannelSplitter: (n) => node('splitter', { outputs: n }),
    createGain: () => node('gain', { channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers', gain: { value: 1 } }),
    source: node('source'),
  };
}

test('channel 0 is taken (a splitter output 0), not an average of both channels', () => {
  const ctx = fakeCtx();
  const out = monoToBothSides(ctx, ctx.source);
  const toSplit = ctx.edges.find((e) => e.from === ctx.source);
  assert.strictEqual(toSplit.to.kind, 'splitter');
  const fromSplit = ctx.edges.find((e) => e.from === toSplit.to);
  assert.strictEqual(fromSplit.to, out);
  assert.strictEqual(fromSplit.output, 0, 'output 0 = the left/first channel');
});

test('the node handed on is forced to one channel, so the destination plays it in both ears', () => {
  const ctx = fakeCtx();
  const out = monoToBothSides(ctx, ctx.source);
  assert.strictEqual(out.kind, 'gain');
  assert.strictEqual(out.channelCount, 1);
  assert.strictEqual(out.channelCountMode, 'explicit');
  assert.strictEqual(out.channelInterpretation, 'speakers', 'speakers: mono up-mixes to L and R');
});

test('the VFO window\'s capture monitor goes through it', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));
  assert.ok(/<script src="\.\.\/lib\/mono-upmix\.js"><\/script>/.test(html));
  const fn = html.slice(html.indexOf('async function startAudioMonitor() {'), html.indexOf('} catch (e) {', html.indexOf('async function startAudioMonitor() {')));
  assert.ok(/window\.MonoUpmix\.monoToBothSides\(audioMonitorCtx, source\)/.test(fn));
  assert.ok(/monoSource\.connect\(audioMonitorGain\);/.test(fn));
  assert.ok(!/\n\s*source\.connect\(audioMonitorGain\);/.test(fn), 'the capture no longer goes straight to the gain');
});

console.log(`\nMono up-mix: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
