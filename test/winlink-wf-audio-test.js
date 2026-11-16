'use strict';
// The Winlink waterfall says why it is black instead of staying black (lib/winlink-wf-audio.js).
const assert = require('assert');
const W = require('../lib/winlink-wf-audio');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

const T0 = 100000;
const base = { mode: 'frames', startedAt: T0, bridge: { state: 'ok', error: '' } };

t('no line when the waterfall is not listening', () => {
  assert.strictEqual(W.noAudioText({ mode: 'none', now: T0 + 60000 }), '');
  assert.strictEqual(W.noAudioText(null), '');
});

t('no line while audio with sound arrives', () => {
  assert.strictEqual(W.noAudioText({ ...base, now: T0 + 10000, lastFrameAt: T0 + 9900, lastSoundAt: T0 + 9900 }), '');
});

t('no line in the first seconds while it starts', () => {
  assert.strictEqual(W.noAudioText({ ...base, now: T0 + 1000 }), '');
  assert.strictEqual(W.noAudioText({ ...base, bridge: { state: 'starting' }, now: T0 + 2000 }), '');
});

t('a bridge error is shown at once, with its own reason', () => {
  const s = W.noAudioText({ ...base, bridge: { state: 'error', error: 'Radio audio input not found' }, now: T0 + 10 });
  assert.strictEqual(s, 'No radio audio is reaching POTACAT: Radio audio input not found');
});

t('a bridge that is off says so after the grace period', () => {
  const s = W.noAudioText({ ...base, bridge: { state: 'off' }, now: T0 + 5000 });
  assert.match(s, /^No radio audio is reaching POTACAT: the modem audio bridge is not running$/);
});

t('frames that stop are counted in seconds and point at the input', () => {
  const s = W.noAudioText({ ...base, now: T0 + 20000, lastFrameAt: T0 + 12000, lastSoundAt: T0 + 12000 });
  assert.match(s, /nothing has arrived for 8 s; check the rig.s audio Input in Settings > My Rigs$/);
});

t('only exact zeros = silence, named as such', () => {
  const s = W.noAudioText({ ...base, now: T0 + 10000, lastFrameAt: T0 + 9950, lastSoundAt: 0 });
  assert.match(s, /only silence \(exact zeros\)/);
});

t('Flex Direct / Icom Network (no bridge): no Settings hint about a sound card', () => {
  const s = W.noAudioText({ mode: 'frames', bridge: null, startedAt: T0, now: T0 + 6000 });
  assert.strictEqual(s, 'No radio audio is reaching POTACAT: nothing has arrived yet');
});

t('the window’s own capture failure is shown as it is', () => {
  const s = W.noAudioText({ mode: 'capture', captureError: 'Requested device not found', startedAt: T0, now: T0 + 1 });
  assert.strictEqual(s, 'No radio audio is reaching POTACAT: Requested device not found');
});

t('a start time of 0 is a real time, not "just started"', () => {
  assert.match(W.noAudioText({ mode: 'frames', bridge: { state: 'off' }, startedAt: 0, now: 20000 }), /bridge is not running/);
  assert.strictEqual(W.noAudioText({ mode: 'frames', bridge: { state: 'off' }, now: 20000 }), '');
});

t('hasSound', () => {
  assert.strictEqual(W.hasSound(new Float32Array(8)), false);
  assert.strictEqual(W.hasSound(Float32Array.from([0, 0, 1e-6])), true);
  assert.strictEqual(W.hasSound(null), false);
});

t('the mail window loads the module and uses it', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'winlink-popout.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'winlink-popout.js'), 'utf8');
  assert.ok(html.includes('../lib/winlink-wf-audio.js'), 'popout html loads lib/winlink-wf-audio.js');
  assert.ok(html.includes('id="wl-wf-noaudio"'), 'popout html has the no-audio line');
  assert.ok(js.includes('WinlinkWfAudio.noAudioText('), 'popout js asks the shared rule');
});

t('framePeak: the largest absolute sample', () => {
  assert.strictEqual(W.framePeak(Float32Array.from([0.1, -0.7, 0.3])), Float32Array.from([0.7])[0]);
  assert.strictEqual(W.framePeak(new Float32Array(4)), 0);
  assert.strictEqual(W.framePeak(null), 0);
});

t('PeakHold keeps the peak for half a second, then follows the audio down', () => {
  const h = new W.PeakHold();
  assert.strictEqual(W.HOLD_MS, 500);
  assert.strictEqual(h.note(0.9, 1000), 0.9);
  assert.strictEqual(h.note(0.1, 1300), 0.9, 'held inside 500 ms');
  assert.strictEqual(h.note(0.95, 1400), 0.95, 'a louder peak takes over at once');
  assert.strictEqual(h.note(0.1, 1950), 0.1, 'after the hold it follows the audio');
});

t('inputLevel: no audio shows nothing (the no-audio line speaks)', () => {
  for (const p of [0, -1, NaN, undefined]) {
    const v = W.inputLevel(p);
    assert.strictEqual(v.state, 'none');
    assert.strictEqual(v.text, '');
  }
});

t('inputLevel: a normal input reads in dBFS', () => {
  const v = W.inputLevel(0.125); // -18 dBFS
  assert.strictEqual(v.state, 'ok');
  assert.strictEqual(v.db, -18);
  assert.strictEqual(v.text, 'Input -18 dBFS');
  assert.match(v.title, /going into the modem/);
  assert.strictEqual(W.inputLevel(0.5).state, 'ok', '-6 dBFS is fine');
  assert.strictEqual(W.inputLevel(1e-9).db, -90, 'floor at -90');
});

t('inputLevel: at or above -3 dBFS the input is too high, with what to do', () => {
  assert.strictEqual(W.HOT_DBFS, -3);
  const v = W.inputLevel(0.71); // -3 dBFS
  assert.strictEqual(v.state, 'hot');
  assert.strictEqual(v.text, 'Input too high');
  assert.match(v.title, /^Input -3 dBFS\. /);
  assert.match(v.title, /Turn down the radio’s USB or data audio output level, or the sound device’s input level/);
  assert.match(v.title, /hear a clear channel/);
  const c = W.inputLevel(1.4); // clipped/over: still 0 dBFS
  assert.strictEqual(c.db, 0);
  assert.strictEqual(c.state, 'hot');
});

t('the mail window shows the input level from the shared rule', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'winlink-popout.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'winlink-popout.js'), 'utf8');
  assert.ok(html.includes('id="wl-wf-input"'), 'popout html has the input readout');
  assert.ok(js.includes('WinlinkWfAudio.inputLevel('), 'popout js asks the shared rule');
  assert.ok(js.includes('new WinlinkWfAudio.PeakHold('), 'popout js holds the peak with the shared rule');
  const css = (html.match(/\.wl-input[^{]*\{[^}]*\}/g) || []).join(' ');
  assert.ok(css, 'the readout has its style');
  assert.ok(!/#[0-9a-fA-F]{3,6}/.test(css), 'the readout uses theme tokens, never a fixed colour');
});

t('wireInput: ECHOCAT gets the same reading, null with no audio (#669)', () => {
  assert.deepStrictEqual(W.wireInput(0.125), { inputDb: -18, inputHot: false });
  assert.deepStrictEqual(W.wireInput(0.71), { inputDb: -3, inputHot: true });
  assert.deepStrictEqual(W.wireInput(1.4), { inputDb: 0, inputHot: true });
  for (const p of [0, -1, NaN, undefined, null]) assert.deepStrictEqual(W.wireInput(p), { inputDb: null, inputHot: false });
  for (const pk of [0.001, 0.05, 0.3, 0.7, 0.71, 0.9, 1]) {
    const v = W.inputLevel(pk), w = W.wireInput(pk);
    assert.strictEqual(w.inputDb, v.db, 'same dB as the mail window');
    assert.strictEqual(w.inputHot, v.state === 'hot', 'same too-high rule as the mail window');
  }
});

t('the ECHOCAT broadcast carries the input level from the rule (#669)', () => {
  const fs = require('fs');
  const path = require('path');
  const P = require('../lib/echocat-protocol');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const pub = main.slice(main.indexOf('function winlinkSpectrumPublish('));
  const body = pub.slice(0, pub.indexOf('\n}'));
  assert.ok(/broadcastWinlinkSpectrum\(\{[^}]*\.\.\.WinlinkWfAudio\.wireInput\(inputPeak\) \}\)/.test(body), 'the spectrum message spreads wireInput');
  assert.ok(main.includes('winlinkSpectrumPublish(m, _winlinkRemoteInHold.peak)'), 'main-audio routes pass the held peak');
  assert.ok(main.includes('if (!winlinkTxActive) _winlinkRemoteInHold.note(WinlinkWfAudio.framePeak(pcm), Date.now());'), 'held from the same frames, not while transmitting');
  assert.ok(main.includes("ipcMain.on('winlink-spectrum-mags', (_e, arr, inputPeak) => {"), 'the window route carries its peak on the same message');
  assert.ok(main.includes('winlinkSpectrumPublish(Float32Array.from(arr, Number), Number(inputPeak) || 0)'), 'and publishes it');
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'winlink-popout.js'), 'utf8');
  assert.ok(js.includes('window.api.spectrumMags(Array.from(wfMags), inHold.peak)'), 'the window sends its held peak with the mags');
  // The wire: a frame with the level validates; null (no audio) and an older shack's frame without it do too.
  const base = { type: 'winlink-spectrum', bins: [0, 1], busy: false, peakDb: 3, lo: 0.4, hi: 0.6, label: 'ARDOP' };
  const row = P.MESSAGES['winlink-spectrum'];
  assert.ok(row.fields.inputDb && row.fields.inputHot, 'declared in lib/echocat-protocol.js');
  assert.strictEqual(row.fields.inputDb.required, false);
  assert.strictEqual(row.fields.inputHot.required, false);
  for (const m of [{ ...base, ...W.wireInput(0.125) }, { ...base, ...W.wireInput(0.9) }, { ...base, ...W.wireInput(0) }, base]) {
    assert.deepStrictEqual(P.validate(m, P.Dir.S2C), { ok: true }, JSON.stringify(m));
  }
});

console.log(`winlink-wf-audio: ${pass} passed`);
