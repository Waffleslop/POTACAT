#!/usr/bin/env node
// Probe what the captured noise actually does in the decoder.
'use strict';
const fs = require('fs');
const path = require('path');
const { SstvDecoder } = require('../lib/sstv-worker');

const SAMPLE_RATE = 48000;
const CHUNK = 4096;

function loadCapture() {
  const pcm = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'sstv-smartsdr-direct-noise-24k.pcm'));
  const inLen = pcm.length / 2;
  const out = new Float32Array(inLen * 2);
  for (let i = 0; i < inLen; i++) {
    const s0 = pcm.readInt16LE(i * 2) / 32768;
    const s1 = i + 1 < inLen ? pcm.readInt16LE((i + 1) * 2) / 32768 : s0;
    out[i * 2]     = s0;
    out[i * 2 + 1] = (s0 + s1) * 0.5;
  }
  return out;
}

const samples = loadCapture();
console.log('Loaded', samples.length, 'samples =', (samples.length / SAMPLE_RATE).toFixed(1), 's @ 48kHz');

const dec = new SstvDecoder();
const events = { 'rx-vis': 0, 'rx-image': 0, 'rx-line': 0, 'rx-debug': 0, 'rx-progress': 0 };
const debugDetails = [];
let lastState = null;
for (let i = 0; i < samples.length; i += CHUNK) {
  const out = dec.processSamples(new Float32Array(samples.subarray(i, Math.min(i + CHUNK, samples.length))));
  for (const r of out) {
    events[r.type] = (events[r.type] || 0) + 1;
    if (r.type === 'rx-debug' && debugDetails.length < 20 && r.detail) {
      debugDetails.push(`  [${(i/SAMPLE_RATE).toFixed(1)}s] state=${r.state} ${r.detail}`);
    }
    if (r.state && r.state !== lastState) {
      console.log(`  [${(i/SAMPLE_RATE).toFixed(2)}s] state -> ${r.state}: ${r.detail || ''}`);
      lastState = r.state;
    }
  }
}
console.log('\nEvent counts:', events);
console.log('\nFirst 20 debug details:');
debugDetails.forEach(d => console.log(d));
console.log('\nFinal decoder state:', dec.state, 'leaderSamples:', dec.leaderSamples, 'lineNum:', dec.lineNum);
