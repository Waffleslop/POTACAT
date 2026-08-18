#!/usr/bin/env node
'use strict';
/**
 * Static scan of main.js's JS8 wiring (native era).
 *
 * JS8 went native in 2026-08 (docs/js8-native-plan.md): the modem is
 * compiled in, the engine runs under JTCAT, and the whole bridge layer —
 * TCP client, ini patcher, launcher, slice creator, virtual-audio-cable
 * windows — was deleted. These guards pin the invariants of that
 * architecture, the first of which is that the bridge stays deleted: its
 * failure modes (dead carriers from misrouted cables, half-configured
 * DAX, one-API-client-at-a-time) all rode in on "just one more require".
 *
 * WHY STATIC: there is no runtime test for main.js wiring without an
 * Electron main process. Precedent: test/protocol-demux-parity-test.js.
 *
 * Run: node test/js8call-main-wiring-test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

/** Comments and string literals blanked to spaces, byte offsets preserved. */
function blankNonCode(src) {
  const out = src.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

const SRC = blankNonCode(RAW);

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function fnBody(name) {
  const at = SRC.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' not found — was it renamed?');
  let depth = 0, start = -1;
  for (let i = at; i < SRC.length; i++) {
    if (SRC[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (SRC[i] === '}') { depth--; if (depth === 0) return RAW.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

// ── the bridge stays deleted ─────────────────────────────────────────────────

test('main.js requires none of the deleted bridge modules', () => {
  for (const mod of ['js8call-client', 'js8call-config', 'js8call-process',
    'js8call-slice', 'js8call-audio', 'js8call-audio-bridge']) {
    assert.ok(!RAW.includes("require('./lib/" + mod + "')"),
      'main.js must not require lib/' + mod + ' — the bridge is deleted, not resting');
  }
  // The two survivors, by design:
  assert.ok(RAW.includes("require('./lib/js8call-threads')"),
    'the conversation layer survived the bridge and must stay');
  assert.ok(RAW.includes("require('./lib/js8-rx-assembler')"),
    'the RX assembler replaces the bridge and must stay');
});

test('the bridge windows and processes are gone', () => {
  for (const sym of ['js8AudioWin', 'js8Client', 'js8Proc', 'launchJs8Call',
    'applyJs8Setup', 'planJs8Setup', 'js8KeyForTx', 'js8SliceIndex']) {
    const re = new RegExp('\\b' + sym + '\\b');
    assert.ok(!re.test(SRC), sym + ' is bridge-era and must not reappear in code');
  }
});

test('the retired settings are actively migrated away', () => {
  for (const key of ['enableJs8Call', 'js8AudioBridge', 'js8AudioRxDevice',
    'js8AudioTxDevice', 'js8Port', 'js8RigName', 'js8Path']) {
    assert.ok(RAW.includes("'" + key + "'"),
      'the migration list must name ' + key + ' so old profiles get cleaned');
  }
});

// ── the engine wiring ────────────────────────────────────────────────────────

test('a mode-family switch rebuilds the slice', () => {
  // Ft8Engine.setMode coerces unknown strings to FT8 — switching to or from
  // JS8/PSK31 without a rebuild silently lands on FT8.
  const at = RAW.indexOf("ipcMain.on('jtcat-set-mode'");
  assert.ok(at > 0, 'jtcat-set-mode handler missing');
  const seg = RAW.slice(at, at + 800);
  assert.ok(/familyOf|isPsk/.test(seg), 'the handler must classify mode families');
  assert.ok(seg.includes("'JS8'"), 'JS8 must be its own family');
  assert.ok(seg.includes('startJtcat(mode)'), 'a family change must rebuild');
});

test('startJtcat wires js8-rx and clears stale listeners', () => {
  const body = fnBody('startJtcat');
  assert.ok(body.includes("removeAllListeners('js8-rx')"),
    'stale js8-rx listeners from the previous cycle must be removed');
  assert.ok(body.includes("on('js8-rx'"), 'js8-rx must reach js8HandleRx');
  assert.ok(body.includes('js8HandleRx'), 'the RX consumer must be the shared one');
});

test('js8Transmit routes through the engine and refuses honestly', () => {
  const body = fnBody('js8Transmit');
  assert.ok(body.includes('js8Engine()'), 'must resolve the live engine');
  assert.ok(body.includes('setTxText'), 'TX goes through the frame queue');
  assert.ok(body.includes('composeDirected'), 'main owns the addressing rules');
  assert.ok(/refuse\(/.test(body), 'refusals must carry a reason');
  assert.ok(!body.includes('sendCatFrequency'),
    'JS8 must never drive the dial — it rides the rig where it is tuned');
});

// ── the heartbeat scheduler is attended-only ─────────────────────────────────

test('the heartbeat watchdog stops an unattended scheduler', () => {
  // Frame-building moved to js8QueueHeartbeat (shared with the manual HB
  // button); the SCHEDULER tick (js8HbTick) still owns the Part-97 gate.
  const body = fnBody('js8HbTick');
  assert.ok(body.includes('JS8_HB_WATCHDOG_MS'),
    'the 30-minute attended check is the Part-97 line and must gate every tick');
  assert.ok(body.includes('js8SetHeartbeat(false)'),
    'an expired watchdog must stop the scheduler, not just skip a beat');
  // The watchdog must gate BEFORE the tick reaches the queue helper.
  assert.ok(body.indexOf('JS8_HB_WATCHDOG_MS') < body.indexOf('js8QueueHeartbeat'),
    'watchdog before transmission, not after');
});

test('the heartbeat never preempts a message in flight', () => {
  // The refuse-if-busy guard lives in the shared queue builder, so BOTH the
  // scheduler and the manual button honor it.
  const body = fnBody('js8QueueHeartbeat');
  assert.ok(body.includes('txQueueLength') && body.includes('_txActive'),
    'a queued or in-flight message outranks any heartbeat');
});

test('the manual HB button is momentary and repeatable, not a toggle', () => {
  // Casey 2026-08-09: "let me manually send a HB as many times as I want."
  const body = fnBody('js8SendHeartbeatNow');
  assert.ok(body.includes('js8QueueHeartbeat'), 'sends via the shared builder');
  assert.ok(body.includes('_swrTripped'),
    'a tripped SWR guard must say why, not look like the button did nothing');
  assert.ok(body.includes('js8HbLastActivity'), 'a press is operator activity');
});

test('the heartbeat enable is session-only', () => {
  // Persisting the switch would re-arm automatic transmissions on the next
  // launch with nobody at the radio.
  const body = fnBody('js8SetHeartbeat');
  assert.ok(!/settings\.[A-Za-z]*[Hh]eartbeat[A-Za-z]*\s*=\s*js8HbEnabled/.test(body) &&
            !body.includes('js8HeartbeatOn'),
    'the on/off switch must not be persisted (the interval may be)');
});

test('operator actions pet the heartbeat watchdog', () => {
  // Sending a message and reading a thread are the operator being present.
  const sendAt = RAW.indexOf("ipcMain.handle('js8call-send'");
  assert.ok(sendAt > 0);
  assert.ok(RAW.slice(sendAt, sendAt + 400).includes('js8HbLastActivity'),
    'sending must stamp operator activity');
});

// ── the phone is a peer, not a second implementation ─────────────────────────

test('every remote JS8 handler reuses the popout path', () => {
  // remoteServer.on('js8-send') must call js8Transmit, not re-implement it;
  // same for heartbeat and lifecycle. Two implementations of "send" is how
  // the phone and the desktop end up addressing the same message differently.
  const at = RAW.indexOf("remoteServer.on('js8-start'");
  assert.ok(at > 0, 'remote js8-start handler missing');
  const seg = RAW.slice(at, at + 6000);   // widened as the remote handler block grew (idle-rx, sms, mail)
  for (const call of ['startJtcat(\'JS8\')', 'js8SetHeartbeat', 'js8Transmit',
    'js8Threads.setOpen', 'stopJtcat()']) {
    assert.ok(seg.includes(call), 'remote JS8 handlers must reuse ' + call);
  }
  assert.ok(seg.includes('sendJs8SendResult'),
    'refusals must ride back to the phone, not vanish');
});

test('remote sends and reads pet the heartbeat watchdog too', () => {
  const at = RAW.indexOf("remoteServer.on('js8-send'");
  assert.ok(at > 0);
  assert.ok(RAW.slice(at, at + 400).includes('js8HbLastActivity'),
    'a phone send is operator activity');
});

test('the push choke points reach both surfaces', () => {
  for (const fn of ['js8PushStatus', 'js8PushThreads', 'js8PushHeard']) {
    const body = fnBody(fn);
    assert.ok(/remoteServer/.test(body),
      fn + ' must broadcast to the phone — one payload, every surface');
  }
});

test('the band tune is one shared function with the right side effects', () => {
  const body = fnBody('js8TuneBand');
  assert.ok(body.includes("tuneRadio(freqKhz, 'DIGU')"), 'digital tune like every digi mode');
  assert.ok(body.includes('_jtcatExpectedDialHz'),
    'the pre-TX dial guard must anchor to the new dial or JS8 TX gets blocked');
  assert.ok(body.includes('Js8RxAssembler'),
    'half a message from the old band must not greet the new one');
  // Both surfaces call it — no second tune implementation.
  const ipcAt = RAW.indexOf("ipcMain.handle('js8-set-band'");
  const remAt = RAW.indexOf("remoteServer.on('js8-set-band'");
  assert.ok(ipcAt > 0 && remAt > 0);
  assert.ok(RAW.slice(ipcAt, ipcAt + 300).includes('js8TuneBand'));
  assert.ok(RAW.slice(remAt, remAt + 300).includes('js8TuneBand'));
});

// ── status honesty ───────────────────────────────────────────────────────────

test('js8PushStatus reports the engine, not a socket', () => {
  const body = fnBody('js8PushStatus');
  assert.ok(body.includes('js8Engine()'));
  assert.ok(body.includes('txQueue'), 'the queue length is what the popout shows');
});

// ── open = start, close = stop (the JTCAT model) ─────────────────────────────

test('opening the JS8 window auto-starts it; closing stops it', () => {
  const body = fnBody('openJs8Popout');
  // Open = start, gated on a callsign and on not already running.
  assert.ok(/did-finish-load[\s\S]*startJtcat\('JS8'\)/.test(body),
    'opening the window must auto-start JS8 (Casey: the manual Start was not easy)');
  assert.ok(/!js8Engine\(\)\s*&&\s*settings\.myCallsign/.test(body),
    'auto-start must be gated on not-running AND a callsign being set');
  // Close = stop, unless a remote client may be driving JS8.
  assert.ok(/on\('closed'[\s\S]*stopJtcat\(\)/.test(body),
    'closing the window must stop JS8 and free the radio');
  assert.ok(/on\('closed'[\s\S]*hasClient/.test(body),
    'stop-on-close must be skipped when a remote client may be using JS8');
});

// ── HB ACK auto-reply is attended + guarded (it is automatic TX) ─────────────

test('JS8 starts and stops the shared JTCAT audio feeder', () => {
  assert.ok(RAW.includes('function startJs8AudioFeed()'),
    'JS8 needs its own audio-feeder request, not just a running engine');
  assert.ok(RAW.includes("webContents.send('jtcat-start-for-js8')"),
    'JS8 start must ask the desktop renderer to start JTCAT audio capture');
  assert.ok(RAW.includes("webContents.send('jtcat-stop-for-js8')"),
    'JS8 stop must release the JS8-owned audio capture');
  assert.ok(/ipcMain\.handle\('js8-start'[\s\S]*startJtcat\('JS8'\)[\s\S]*startJs8AudioFeed\(\)/.test(RAW),
    'desktop JS8 Start must start both the engine and the audio feeder');
  assert.ok(/remoteServer\.on\('js8-start'[\s\S]*startJtcat\('JS8'\); startJs8AudioFeed\(\)/.test(RAW),
    'remote JS8 Start must start both the engine and the audio feeder');
  assert.ok(PRELOAD.includes("onJtcatStartForJs8") && PRELOAD.includes("jtcat-start-for-js8"),
    'preload must expose the JS8 audio-start request to the desktop renderer');
  assert.ok(PRELOAD.includes("onJtcatStopForJs8") && PRELOAD.includes("jtcat-stop-for-js8"),
    'preload must expose the JS8 audio-stop request to the desktop renderer');
  assert.ok(RENDERER.includes('jtcatJs8AudioActive'),
    'renderer must track JS8 ownership separately from desktop/remote JTCAT');
  assert.ok(/onJtcatStartForJs8[\s\S]*jtcatJs8AudioActive\s*=\s*true[\s\S]*startJtcatAudio\(\)/.test(RENDERER),
    'renderer must start the shared audio capture when JS8 asks for it');
  assert.ok(/onJtcatStopForJs8[\s\S]*jtcatJs8AudioActive\s*=\s*false[\s\S]*stopJtcatAudio\(\)/.test(RENDERER),
    'renderer must stop only JS8-owned audio when JS8 releases it');
});

test('HB ACK auto-reply is guarded and session-only', () => {
  const body = fnBody('js8MaybeAckHeartbeat');
  // Casey 2026-08-10: HB ACK replies until turned OFF — response-to-
  // interrogation, not beaconing, so NO idle self-disarm. Session-only stays.
  assert.ok(!body.includes('JS8_HB_WATCHDOG_MS'),
    'HB ACK must not self-disarm on idle — it replies until the operator turns it off');
  assert.ok(body.includes('_swrTripped'), 'never ACK into a tripped SWR match');
  assert.ok(body.includes('js8HbAcked'), 'ACK a given station at most once per window');
  assert.ok(body.includes('_txActive') && body.includes('txQueueLength'),
    'never ACK while already transmitting');
  assert.ok(body.includes('settings.myCallsign'), 'never ACK our own heartbeat');
  // Session-only: the enable must never be persisted (would re-arm automatic TX
  // on the next launch with nobody at the radio).
  assert.ok(!/settings\.[A-Za-z]*[Hh]bAck/.test(RAW),
    'HB ACK enable must be session-only, never written to settings');
});

console.log(`\nJS8 main wiring: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
