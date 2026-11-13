#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// #463 (and #125): when macOS refuses POTACAT the microphone, every audio
// input delivers exact digital zero (the listen test reads -120 dBFS) and the
// refusal went only to the console. lib/mac-mic-access.js is the one rule for
// saying so; this pins it and its wiring.
// Run: node test/mac-mic-access-test.js
const assert = require('assert');
const path = require('path');
const M = require('../lib/mac-mic-access');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const NOISE = new Float32Array([0.001, -0.002, 0.0005]);
const ZEROS = new Float32Array(128);

console.log('macOS microphone access');

test('never on Windows or Linux, whatever the status or the silence', () => {
  for (const platform of ['win32', 'linux', '', undefined]) {
    for (const status of ['denied', 'restricted', 'not-determined', null]) {
      const v = M.micVerdict({ platform, status, silentMs: 1e6, heardSound: false });
      assert.strictEqual(v.say, false, `${platform}/${status}`);
    }
  }
});
test("macOS 'denied' or 'restricted': say it at once, naming the place to fix it", () => {
  for (const status of ['denied', 'restricted']) {
    const v = M.micVerdict({ platform: 'darwin', status, silentMs: 0 });
    assert.strictEqual(v.say, true);
    assert.strictEqual(v.reason, 'denied');
    assert.ok(v.message.includes('System Settings > Privacy & Security > Microphone'));
    assert.ok(/turn on POTACAT, then restart POTACAT/.test(v.message));
  }
});
test('macOS granted and sound arriving: nothing to say', () => {
  assert.strictEqual(M.micVerdict({ platform: 'darwin', status: 'granted', silentMs: 0, heardSound: true }).say, false);
  assert.strictEqual(M.micVerdict({ platform: 'darwin', status: 'granted', silentMs: 1e6, heardSound: true }).say, false);
});
test('macOS exact zeros since the start, for SILENT_MS: say it (the status can be stale)', () => {
  assert.strictEqual(M.micVerdict({ platform: 'darwin', status: 'granted', silentMs: M.SILENT_MS - 1 }).say, false);
  const v = M.micVerdict({ platform: 'darwin', status: 'granted', silentMs: M.SILENT_MS });
  assert.strictEqual(v.say, true);
  assert.strictEqual(v.reason, 'silence');
  assert.ok(v.message.includes('System Settings > Privacy & Security > Microphone'));
});
test('the listen test passes its own 3 s window', () => {
  assert.strictEqual(M.micVerdict({ platform: 'darwin', silentMs: 3000, minSilentMs: 3000 }).say, true);
  assert.strictEqual(M.micVerdict({ platform: 'darwin', silentMs: 2000, minSilentMs: 3000 }).say, false);
});
test('the copy is plain: no emoji, short sentences', () => {
  for (const m of Object.values(M.MESSAGES)) {
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(m), 'no emoji');
    assert.ok(m.length < 240, 'short');
  }
});
test('hasSound: exact zero only; a peak number or a buffer', () => {
  assert.strictEqual(M.hasSound(0), false);
  assert.strictEqual(M.hasSound(1e-9), true);
  assert.strictEqual(M.hasSound(NaN), false);
  assert.strictEqual(M.hasSound(ZEROS), false);
  assert.strictEqual(M.hasSound(NOISE), true);
  assert.strictEqual(M.hasSound([0, 0, -0.00001]), true);
  assert.strictEqual(M.hasSound(null), false);
});
test("describeMicStatus: '' off macOS; DENIED names the place", () => {
  assert.strictEqual(M.describeMicStatus('win32', 'denied'), '');
  assert.strictEqual(M.describeMicStatus('darwin', 'granted'), 'granted');
  assert.ok(/DENIED.*Privacy & Security > Microphone/.test(M.describeMicStatus('darwin', 'denied')));
  assert.strictEqual(M.describeMicStatus('darwin', 'not-determined'), 'not asked yet');
  assert.strictEqual(M.describeMicStatus('darwin', null), 'could not be read');
});

console.log('SilenceWatch');
test("zeros from the start: 'silent' once after SILENT_MS, then 'sound' once when sound comes", () => {
  const w = new M.SilenceWatch(0);
  const evs = [];
  for (let t = 0; t <= 20000; t += 100) { const e = w.note(ZEROS, t); if (e) evs.push([e, t]); }
  assert.deepStrictEqual(evs.map((x) => x[0]), ['silent']);
  assert.ok(evs[0][1] >= M.SILENT_MS && evs[0][1] < M.SILENT_MS + 200);
  assert.ok(w.silentFor(20000) >= 20000);
  assert.strictEqual(w.note(NOISE, 20100), 'sound');
  assert.strictEqual(w.note(ZEROS, 40000), null);
  assert.strictEqual(w.silentFor(40000), 0);
});
test('a capture that once heard sound is never judged again (a radio silent while it transmits)', () => {
  const w = new M.SilenceWatch(0);
  assert.strictEqual(w.note(NOISE, 100), null);
  for (let t = 200; t <= 300000; t += 100) assert.strictEqual(w.note(ZEROS, t), null);
});
test('peaks work too (the ECHOCAT bridge and the Winlink bridge send a peak)', () => {
  const w = new M.SilenceWatch(0);
  assert.strictEqual(w.note(0, 1000), null);
  assert.strictEqual(w.note(0, M.SILENT_MS), 'silent');
  assert.strictEqual(w.note(0.02, M.SILENT_MS + 1000), 'sound');
});
test('started() judges a rebuilt capture afresh', () => {
  const w = new M.SilenceWatch(0);
  w.note(NOISE, 10);
  w.started(50000);
  assert.strictEqual(w.note(ZEROS, 50000 + M.SILENT_MS - 1), null);
  assert.strictEqual(w.note(ZEROS, 50000 + M.SILENT_MS), 'silent');
});

console.log('MicNoticeLedger');
test('once per session per surface; cleared only when it was showing', () => {
  const l = new M.MicNoticeLedger();
  assert.strictEqual(l.show('jtcat'), true);
  assert.strictEqual(l.show('jtcat'), false);
  assert.strictEqual(l.show('sstv'), true);
  assert.strictEqual(l.clear('jtcat'), true);
  assert.strictEqual(l.clear('jtcat'), false);
  assert.strictEqual(l.show('jtcat'), false, 'not again this session');
  assert.strictEqual(l.clear('winlink'), false);
});

test('wiring: main logs it, puts it in Report a Bug, and every capture feeds the one rule', () => {
  const read = (p) => readSrc(path.join(__dirname, '..', p)).replace(/\r\n/g, '\n');
  const main = read('main.js');
  assert.ok(/require\('\.\/lib\/mac-mic-access'\)/.test(main));
  assert.ok(/macMicLog\('at startup', macMicStatus\(\)\)/.test(main), 'startup log');
  assert.ok(/micAccess: MacMicAccess\.describeMicStatus\(process\.platform, macMicStatus\(\)\)/.test(main), 'bug report');
  assert.ok(/ipcMain\.handle\('mac-mic-capture-start'/.test(main) && /ipcMain\.on\('mac-mic-silence'/.test(main));
  assert.ok(/macMicCaptureStart\('echocat'\)/.test(main), 'ECHOCAT start');
  assert.ok(/macMicCaptureStart\('winlink'\)/.test(main) && /macMicNotice\('winlink'/.test(main), 'Winlink modem audio');
  // askForMediaAccess lives in one place.
  assert.strictEqual((main.match(/askForMediaAccess\(/g) || []).length, 1);
  assert.ok(/\*\*macOS microphone access:\*\* /.test(read('renderer/app.js')), 'bug report line');
  const tag = /<script src="\.\.\/lib\/mac-mic-access\.js"><\/script>/;
  for (const h of ['renderer/index.html', 'renderer/jtcat-popout.html', 'renderer/sstv-popout.html', 'renderer/remote-audio.html']) {
    assert.ok(tag.test(read(h)), h + ' loads it');
  }
  assert.strictEqual((read('renderer/app.js').match(/jtcatMicNote\(/g) || []).length, 3, 'main-window JTCAT: both capture paths');
  assert.strictEqual((read('renderer/jtcat-popout.js').match(/popoutMicNote\(/g) || []).length, 3, 'JTCAT window: both capture paths');
  assert.ok(/sstvMicNote\(e\.data\)/.test(read('renderer/sstv-popout.js')));
  assert.ok(/MacMicAccess\.SilenceWatch/.test(read('renderer/remote-audio.html')));
  assert.ok(/MacMicAccess\.micVerdict/.test(read('renderer/station-setup.js')), 'listen test');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
