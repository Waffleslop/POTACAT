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

console.log(`winlink-wf-audio: ${pass} passed`);
