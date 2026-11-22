// A busy channel (#296): "Keep waiting" stays chosen, Stop really stops Pat's
// wait, the no-progress watchdog does not call the wait a stall, and every
// surface is told how long it has waited.
//
// Pat's rule (v1.0.0 app/connect.go onBusyChannel): it waits up to 5 minutes
// for the channel to clear; a prompt answer of "abort" or the deadline ends
// the call, any other answer starts it on the busy channel. POTACAT sends
// that other answer ("continue") only for the operator's own Call anyway
// (Casey, 2026-11-09), never by itself.
// Run: node test/winlink-busy-wait-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const popout = readSrc(path.join(root, 'renderer', 'winlink-popout.js'));
const remote = readSrc(path.join(root, 'renderer', 'remote.js'));
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j < 0 ? i + 4000 : j);
}

console.log('winlink busy wait (#296)');

test('the prompt carries when it began and Pat\'s 5-minute limit; each push adds how long it has waited', () => {
  assert.ok(/const WINLINK_BUSY_WAIT_SEC = 300;/.test(main), 'Pat\'s own limit');
  assert.ok(/prompt: \{ id: ev\.id, kind: ev\.prompt, message: ev\.message, at: Date\.now\(\), \.\.\.\(busyWait \? \{ limitSec: WINLINK_BUSY_WAIT_SEC \} : \{\}\) \}/.test(main));
  assert.ok(/if \(s\.prompt && s\.prompt\.at\) s\.prompt = \{ \.\.\.s\.prompt, waitedSec:/.test(fnBody(main, 'winlinkSessionView')), 'waitedSec is main\'s clock, so a phone needs none');
  assert.ok(/const s = winlinkSessionView\(\);/.test(fnBody(main, 'winlinkSessionPush')));
});

test('the state push carries the same session as the session push, so the busy text never flickers', () => {
  // Casey 2026-11-11: the busy prompt "blinks with more text after it". The
  // state push sent the raw session (no waitedSec) between session pushes.
  assert.ok(/snap\.session = winlinkSessionView\(\);\s*return snap;/.test(fnBody(main, 'winlinkPayload')));
  assert.ok(!/winlinkPopoutSend\('winlink-session', \{ \.\.\.winlinkState\.session/.test(main), 'no raw session goes to the mail window');
});

test('the log line for a busy channel says how loud the radio audio is', () => {
  assert.ok(/the channel is busy — waiting up to \$\{WINLINK_BUSY_WAIT_SEC \/ 60\} minutes[^`]*\$\{winlinkRxLevelText\(\)\}/.test(main));
  const lvl = fnBody(main, 'winlinkRxLevelText');
  assert.ok(/no radio audio is reaching the modem/.test(lvl) && /db >= -3/.test(lvl), 'silent and clipped feeds are both named');
});

test('Stop answers the pending busy prompt with "abort" before the disconnect, and clears it', () => {
  const abort = fnBody(main, 'winlinkAbortSession');
  const answer = abort.indexOf("patClient.respondPrompt(pending.id, 'abort')");
  const disc = abort.indexOf('patClient.disconnect(true)');
  assert.ok(answer > 0 && disc > answer, 'prompt first, then disconnect');
  assert.ok(/pending\.kind === 'busy-channel'/.test(abort), 'only the busy wait: a password or activation prompt is not answered for the operator');
  assert.ok(/state: 'disconnecting', text: `Stopping — \$\{why\}`, prompt: null/.test(abort));
  assert.ok(!/respondPrompt\([^)]*'continue'/.test(main), 'POTACAT never tells Pat to call on a busy channel by itself');
});

test('the no-progress watchdog does not end a session that is waiting for a clear channel', () => {
  const i = main.indexOf('_winlinkWatchdog = setInterval(');
  const dog = main.slice(i, i + 700);
  const touch = dog.indexOf('if (winlinkWaitingForClearChannel()) winlinkSessionTouch();');
  const check = dog.indexOf('WINLINK_NO_PROGRESS_MS) winlinkAbortSession(');
  assert.ok(touch > 0 && check > touch, 'the wait counts as activity, checked first');
  assert.ok(/p\.kind === 'busy-channel' && winlinkSessionActive\(\)/.test(fnBody(main, 'winlinkWaitingForClearChannel')));
  assert.ok(/_winlinkCapTimer = setTimeout\(\(\) => winlinkAbortSession\(/.test(main), 'the session cap still runs');
});

test('"Keep waiting" is remembered per prompt on the mail window and on ECHOCAT Web', () => {
  assert.ok(/pr\.classList\.toggle\('show', !!p && !\(p\.kind === 'busy-channel' && p\.id === keptWaitingFor\)\);/.test(popout));
  assert.ok(/onclick = function \(\) \{ keptWaitingFor = p\.id; pr\.classList\.remove\('show'\); \};/.test(popout));
  assert.ok(/pr\.classList\.toggle\('hidden', !p \|\| \(p\.kind === 'busy-channel' && p\.id === mailKeptWaitingFor\)\);/.test(remote));
  assert.ok(/if \(busy\) \{ mailKeptWaitingFor = p\.id; pr\.classList\.add\('hidden'\); \}/.test(remote));
  assert.ok(!/onclick = function \(\) \{ pr\.classList\.remove\('show'\); \};/.test(popout), 'the bare hide is gone');
});

test('both surfaces say how long it has waited and when the call is dropped, in the same words', () => {
  const words = "'; the call starts by itself when it clears and is dropped at '";
  assert.ok(popout.includes(words) && remote.includes(words));
  assert.ok(/Math\.min\(p\.waitedSec, p\.limitSec\)/.test(popout) && /Math\.min\(p\.waitedSec, p\.limitSec\)/.test(remote));
  assert.ok(/'Give up'/.test(popout) && /'Give up'/.test(remote) && /value: busy \? 'abort' : 'decline'/.test(remote));
});

test('Call anyway is the operator\'s decision: one button per surface, logged, and nothing else gets past', () => {
  const ans = fnBody(main, 'winlinkAnswerPrompt');
  assert.ok(/s\.prompt\.kind === 'busy-channel' && value !== 'abort'/.test(ans) && /if \(value !== 'continue'\) return false;/.test(ans), 'a busy prompt takes abort or continue, nothing else');
  assert.ok(/the operator chose to call on a channel the modem reads as busy/.test(ans), 'logged with the wait and the audio level');
  assert.ok(/\$\('wl-prompt-go'\)\.onclick = function \(\) \{ window\.api\.answerPrompt\(p\.id, 'continue'\); \};/.test(popout));
  assert.ok(/\$\('wl-prompt-go'\)\.style\.display = 'none';/.test(popout), 'hidden for every other prompt');
  assert.ok(/id="wl-prompt-go" style="display:none"/.test(readSrc(path.join(root, 'renderer', 'winlink-popout.html'))));
  assert.ok(/mailEl\('mail-p-go'\)\.onclick = function \(\) \{ mailSend\(\{ type: 'winlink-prompt', id: p\.id, value: 'continue' \}\); \};/.test(remote));
  const words = "Call anyway only if you have listened and it is clear.";
  assert.ok(popout.includes(words) && remote.includes(words), 'the same caution on both');
  assert.ok(!/respondPrompt\([^)]*'continue'/.test(main), 'main never writes the answer itself: it only passes on what the operator chose');
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/winlink-busy-wait-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
