#!/usr/bin/env node
'use strict';
// GitHub #300 (IC-7100, 2 m packet): Winlink has its own transmit audio level,
// the session summary always says the receive peak and what our overs sent to
// the radio, and says in plain words when that was full scale. The audio-gap
// meter no longer counts the pause between overs as a gap.
// Run: node test/winlink-tx-level-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const L = require('../lib/winlink-tx-level');
const { AudioFlowMeter } = require('../lib/winlink-diag');
const WinlinkOutcome = require('../lib/winlink-outcome');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const lane = readSrc(path.join(root, 'lib', 'modem-audio-lane.js'));
const html = readSrc(path.join(root, 'renderer', 'winlink-popout.html'));
const js = readSrc(path.join(root, 'renderer', 'winlink-popout.js'));
const preload = readSrc(path.join(root, 'preload-winlink-popout.js'));
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0;
  for (let k = src.indexOf('{', src.indexOf(')', i)); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  return '';
}

console.log('the Winlink TX level');
test('square curve, the same as every audio slider', () => {
  assert.strictEqual(L.gainFromPct(50), 0.25);
  assert.strictEqual(L.pctFromGain(0.25), 50);
  assert.strictEqual(L.gainFromPct(100), 1);
  assert.strictEqual(L.gainFromPct(-3), 0);
  assert.strictEqual(L.pctFromGain(4), 100);
});
test('upgrade: an operator with no Winlink level keeps the JTCAT drive Winlink used until now', () => {
  const s = { jtcatTxGain: 0.25 };
  assert.strictEqual(L.resolveTxGain(s), 0.25);
  assert.strictEqual(L.seedTxGain(s), true);
  assert.strictEqual(s.winlinkTxGain, 0.25, 'written once');
  s.jtcatTxGain = 0.81; // a later JTCAT Drive change
  assert.strictEqual(L.resolveTxGain(s), 0.25, 'no longer moves Winlink');
  assert.strictEqual(L.seedTxGain(s), false);
  const fresh = {};
  assert.strictEqual(L.seedTxGain(fresh, 1), true);
  assert.strictEqual(fresh.winlinkTxGain, 1, 'nothing set anywhere: full, as before');
  assert.strictEqual(L.resolveTxGain({ winlinkTxGain: 7 }), 1, 'clamped');
});
test('what an over sent to the radio: after the leveler (never past full scale) and the TX level', () => {
  assert.strictEqual(L.overOutDbfs({ peakDbfs: 0, gainDb: 0, txGain: 1 }), 0);
  assert.strictEqual(L.overOutDbfs({ peakDbfs: 0, gainDb: 0, txGain: 0.25 }), -12);
  assert.strictEqual(L.overOutDbfs({ peakDbfs: -7, gainDb: 9, txGain: 1 }), 0, 'the leveler stops at full scale');
  assert.strictEqual(L.overOutDbfs({ peakDbfs: 0, txGain: 0.25, soundCard: false }), 0, 'network audio: the TX level is not applied');
  assert.strictEqual(L.overOutDbfs({ peakDbfs: null }), null);
  assert.strictEqual(L.overOutDbfs({ peakDbfs: 0, txGain: 0 }), null, 'silent');
});

console.log('the session summary');
test('every over at full scale on a sound card: said in plain words, with the setting to turn down', () => {
  const s = new L.SessionLevels();
  s.noteRx(0.18);
  for (let i = 0; i < 12; i++) s.noteOver({ peakDbfs: 0, gainDb: 0, txGain: 1, soundCard: true });
  assert.strictEqual(s.text(), 'radio to modem peak -14.9 dBFS, modem to radio peak 0 dBFS at TX level 100% over 12 overs');
  assert.ok(/reached full scale \(0 dBFS\) on 12 of 12 overs/.test(s.advice()), s.advice());
  assert.ok(/turn down "TX level" in the Winlink window/.test(s.advice()));
});
test('the same overs at TX level 50%: -12 dBFS, no warning', () => {
  const s = new L.SessionLevels();
  s.noteRx(0.5);
  s.noteOver({ peakDbfs: 0, gainDb: 0, txGain: 0.25, soundCard: true });
  assert.strictEqual(s.text(), 'radio to modem peak -6 dBFS, modem to radio peak -12 dBFS at TX level 50% over 1 over');
  assert.strictEqual(s.advice(), '');
});
test('the receive peak is always there, silent and clipped included; network audio never warns', () => {
  const s = new L.SessionLevels();
  assert.strictEqual(s.text(), 'radio to modem peak silent (no audio heard), modem to radio: no over measured');
  s.noteRx(1);
  assert.ok(/radio to modem peak 0 dBFS \(clipped\)/.test(s.text()));
  const n = new L.SessionLevels();
  n.noteOver({ peakDbfs: 0, soundCard: false });
  assert.ok(/network audio/.test(n.text()));
  assert.strictEqual(n.advice(), '');
});
test('summaryLine carries "levels:" and the warning', () => {
  const base = { outcome: { kind: 'error' }, mode: 'packet', gateway: 'GW1XYZ-10', dialKhz: 145000, ranMs: 60000 };
  const line = WinlinkOutcome.summaryLine({ ...base, levels: 'radio to modem peak -14.9 dBFS', levelsAdvice: 'our transmit audio reached full scale' });
  assert.ok(/; levels: radio to modem peak -14\.9 dBFS; our transmit audio reached full scale/.test(line), line);
  assert.ok(!/levels:/.test(WinlinkOutcome.summaryLine(base)));
});

console.log('the audio-gap meter (#300)');
test('the pause between two overs is not a gap; a dropout inside an over is', () => {
  const m = new AudioFlowMeter({ rate: 1000 }); // 1 sample = 1 ms
  let t = 1000;
  for (let i = 0; i < 8; i++) { m.note(100, t); t += 100; } // an 800 ms over, 100 ms blocks
  m.rest();                                                // the carrier dropped
  t += 985;                                                // NA4DQ's pause between overs
  for (let i = 0; i < 8; i++) { m.note(100, t); t += 100; }
  assert.strictEqual(m.snapshot(1000).maxGapMs, 0, 'between overs');
  assert.strictEqual(m.snapshot(1000).gapsOverWarn, 0);
  t += 120;                                                // a 120 ms dropout mid-over
  m.note(100, t);
  assert.strictEqual(m.snapshot(1000).maxGapMs, 120);
  assert.strictEqual(m.snapshot(1000).gapsOverWarn, 1);
});
test('the lane marks every key-down and carrier drop as an over boundary on both meters', () => {
  assert.ok(/case 'key': core\.key\(!!m\.on, \{ seedGain: m\.seedGain, bridge: m\.bridge \}\); if \(srv\) srv\.overBoundary\(\); break;/.test(lane));
  const srv = readSrc(path.join(root, 'lib', 'modem-audio-server.js'));
  assert.ok(/overBoundary\(\) \{\s*this\.rxMeter\.rest\(\); this\.txMeter\.rest\(\);/.test(srv));
});

console.log('main.js and the Winlink window');
test('the bridge plays modem audio at the Winlink TX level, never JTCAT\'s drive', () => {
  for (const fn of ['startModemBridge', 'modemBridgePlayback']) {
    const b = fnBody(main, fn);
    assert.ok(/txGain: winlinkTxGain\(\)/.test(b), fn);
    assert.ok(!/_jtcatDirectTxGainLevel/.test(b), fn);
  }
  assert.ok(/'modem-bridge-start', \{ \.\.\.modemBridgeDevices\(\), playback: modemBridge\.playback, txGain: winlinkTxGain\(\) \}/.test(main));
  assert.ok(/WinlinkTxLevel\.seedTxGain\(settings, _jtcatDirectTxGainLevel\)/.test(main), 'seeded once at load from what Winlink used');
  assert.ok(/'winlinkTxGain',/.test(main), 'a machine audio property, like jtcatTxGain');
});
test('a change applies at once to the playing bridge, and is logged once', () => {
  const a = fnBody(main, 'applyWinlinkTxGain');
  assert.ok(/settings\.winlinkTxGain = v;/.test(a));
  assert.ok(/'modem-bridge-tx-gain'/.test(a));
  assert.ok(/winlinkLog\(`TX level set to/.test(a));
  assert.ok(/key === 'winlinkTxGain'\) \{ applyWinlinkTxGain\(value\); return; \}/.test(main));
  const bridgePreload = readSrc(path.join(root, 'preload-modem-audio-bridge.js'));
  assert.ok(/onTxGain: \(cb\) => ipcRenderer\.on\('modem-bridge-tx-gain'/.test(bridgePreload));
  const bridge = readSrc(path.join(root, 'renderer', 'modem-audio-bridge.js'));
  assert.ok(/window\.bridge\.onTxGain\(\(g\) => radio\.setTxGain\(g\)\);/.test(bridge));
});
test('every over and the summary carry the level that reached the radio', () => {
  const end = fnBody(main, 'winlinkTxBurstEnd');
  assert.ok(/_winlinkLevels\.noteOver\(\{ peakDbfs: burst\.peakDbfs, gainDb: burst\.gainDb, txGain: winlinkTxGain\(\), soundCard: !winlinkIpAudioRoute\(\) \}\)/.test(end));
  const rx = fnBody(main, 'winlinkFeedRx');
  assert.ok(/if \(!winlinkTxActive\) _winlinkLevels\.noteRx\(pk\);/.test(rx), 'the gateway, not our own over');
  const settle = fnBody(main, 'winlinkSettleOutcome');
  assert.ok(/levels: _winlinkLevels\.text\(\), levelsAdvice: _winlinkLevels\.advice\(\),/.test(settle));
  assert.ok(/_winlinkLevels\.reset\(\);/.test(fnBody(main, 'winlinkOutcomeReset')));
});
test('the Winlink window has the slider, next to Power, in theme colours', () => {
  assert.ok(/<input type="range" id="wl-txlevel" min="0" max="100" step="1"/.test(html));
  assert.ok(html.indexOf('id="wl-txlevel"') > html.indexOf('id="wl-pwr"'));
  assert.ok(/\.wl-rig input\[type="range"\] \{[^}]*accent-color: var\(--accent-blue/.test(html));
  assert.ok(/window\.api\.setPref\('winlinkTxGain'/.test(js));
  assert.ok(/state\.txLevel/.test(js));
  assert.ok(/setPref: \(key, value\) => ipcRenderer\.send\('winlink-cmd-pref'/.test(preload));
  assert.ok(/txLevel: \{ gain: winlinkTxGain\(\), soundCard: !winlinkIpAudioRoute\(\) \}/.test(main));
});

console.log(`\nWinlink TX level (#300): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
