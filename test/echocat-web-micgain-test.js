#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// ECHOCAT Web: the radio's MIC GAIN as a slider (K6RBJ: "a Mic Gain slider
// for ECHOCAT ... I could dump my custom commands"). The app had it; the web
// client did not. Run: node test/echocat-web-micgain-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const html = readSrc(path.join(root, 'renderer', 'remote.html'));
const js = readSrc(path.join(root, 'renderer', 'remote.js'));
const main = readSrc(path.join(root, 'main.js'));

console.log('echocat web mic gain');

test('a Mic Gain slider in Settings and the Full VFO pane, hidden by default', () => {
  assert.ok(/id="so-micgain-row" class="so-row hidden"/.test(html));
  assert.ok(/id="rc-micgain-slider"/.test(html));
  assert.ok(/class="vf-rig-slider-row hidden" id="vf-micgain-row"/.test(html));
  assert.ok(/id="vf-micgain-slider"/.test(html));
});

test('shown only when the rig reports micGain; state fills both sliders', () => {
  assert.ok(/setMicGainVisible\(!!s\.capabilities\.micGain\);/.test(js));
  assert.ok(/applyMicGainState\(s\.micGain\)/.test(js));
});

test('sent through the one rig-control dispatcher that main handles', () => {
  assert.ok(/type: 'rig-control', data: \{ action: 'set-mic-gain', value:/.test(js));
  assert.ok(/case 'set-mic-gain': \{/.test(main));
  assert.ok(/micGain: _currentMicGain,/.test(main), 'rig state carries micGain');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
