// A packet (AX.25) Winlink link ends cleanly, and a call that opens on a link
// the gateway still holds is ended and never retried (#300: NA4DQ's IC-7100 on
// 2 m to KJ4AJP-10; every call for 15 minutes after a dirty end got FRMR, then
// UA, and never a greeting).
// The rules are lib/packet-link-close.js; the words lib/winlink-outcome.js;
// the retry rule lib/winlink-auto-retry.js; main.js holds the end and logs.
// Run: node test/packet-link-close-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const L = require('../lib/packet-link-close');
const O = require('../lib/winlink-outcome');
const R = require('../lib/winlink-auto-retry');
const M = require('../lib/direwolf-agw-monitor');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js')).replace(/\r\n/g, '\n');
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let depth = 0;
  for (let k = src.indexOf(') {', i) + 2; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}

// Monitor lines exactly as lib/direwolf-agw-monitor.js describes them (from Dire Wolf's own text).
const GW = 'KJ4AJP-10', ME = 'NA4DQ';
const rx = (kind, rest = '', from = GW, to = ME) => {
  const f = { datakind: kind === 'I' ? 'I' : 'S', data: Buffer.from(` 1:Fm ${from} To ${to} <${kind}${rest} >[16:17:00]\r\0`, 'latin1') };
  return M.describeMonitorFrame(f);
};
const watch = () => new L.PacketLinkWatch({ gateway: GW, mycall: ME });

console.log('the monitor line, taken apart');
test('parseMonitorText reads the direction, the calls and the frame kind', () => {
  assert.deepStrictEqual(L.parseMonitorText(rx('UA', ' pid=F0 Len=0 F=1')), { dir: 'rx', from: GW, to: ME, kind: 'UA', rest: ' pid=F0 Len=0 F=1 ' });
  assert.strictEqual(L.parseMonitorText(rx('RR', ' R0 P=1')).kind, 'RR');
  assert.strictEqual(L.parseMonitorText('rx 1:Fm KJ4AJP-10 To NA4DQ Via W4XYZ-1* <FRMR F=1 >').kind, 'FRMR');
  assert.strictEqual(L.parseMonitorText('direwolf monitor: listening'), null);
  assert.strictEqual(L.parseMonitorText(''), null);
});

console.log('NA4DQ\'s stuck link: FRMR, then UA, and never a greeting');
test('FRMR before any greeting is a held link, at once', () => {
  const w = watch();
  w.noteFrame(rx('FRMR', ' F=1'), 1000);
  assert.deepStrictEqual(w.stuck(1000), { stuck: true, why: 'frmr' });
});
test('UA and no greeting for GREETING_WAIT_MS is a held link; a greeting in time is not', () => {
  const w = watch();
  w.noteFrame(rx('UA', ' F=1'), 1000);
  assert.strictEqual(w.stuck(1000 + L.GREETING_WAIT_MS - 1).stuck, false);
  w.noteFrame(rx('RR', ' R0 P=1'), 5000); // the gateway polling the old link is not a greeting
  assert.deepStrictEqual(w.stuck(1000 + L.GREETING_WAIT_MS), { stuck: true, why: 'no-greeting' });
  const ok = watch();
  ok.noteFrame(rx('UA', ' F=1'), 1000);
  ok.noteFrame(rx('I', ' R0 S0 pid=F0 Len=40'), 3000);
  assert.strictEqual(ok.stuck(60000).stuck, false, 'a greeting: the link is good');
  ok.noteFrame(rx('FRMR', ' F=1'), 70000);
  assert.strictEqual(ok.stuck(70000).stuck, false, 'an FRMR after the greeting is not the held link');
});
test('frames from other stations, or from the gateway to someone else, are not this link', () => {
  const w = watch();
  w.noteFrame(rx('FRMR', '', 'W4ABC-10'), 1000);
  w.noteFrame(rx('FRMR', '', GW, 'K4OTHER'), 1000);
  w.noteFrame(rx('UA', '', GW, 'K4OTHER'), 1000);
  assert.strictEqual(w.stuck(99999).stuck, false);
  assert.strictEqual(w.up, false);
  const ssid = watch();
  ssid.noteFrame(rx('UA', '', GW, 'NA4DQ-7'), 1000);
  assert.strictEqual(ssid.up, true, 'this station with an SSID is still this station');
});
test('a call that never connected (no UA) is not called a held link, nor a gateway that refused it (DM)', () => {
  const w = watch();
  assert.strictEqual(w.stuck(10 * 60000).stuck, false);
  w.noteFrame(rx('DM', ' F=1'), 1000);
  assert.strictEqual(w.stuck(10 * 60000).stuck, false);
  assert.strictEqual(w.needsClose({}), false);
});

console.log('the clean close: Dire Wolf stays up until the gateway answers our DISC');
test('a link that is up needs closing; one the gateway ended, or that never came up, does not', () => {
  const w = watch();
  assert.strictEqual(w.needsClose({}), false, 'never up');
  assert.strictEqual(w.needsClose({ patConnected: true }), true, 'Pat said connected: closed even if the monitor missed the UA');
  w.noteFrame(rx('UA', ' F=1'), 1000);
  assert.strictEqual(w.needsClose({}), true);
  w.noteFrame(rx('I', ' R0 S0'), 2000);
  w.noteFrame(rx('DISC', ' P=1'), 9000);
  assert.strictEqual(w.needsClose({ patConnected: true }), false, 'the gateway ended it');
  const done = watch();
  done.noteFrame(rx('UA', ' F=1'), 1000);
  done.noteFrame(rx('UA', ' F=1'), 50000); // the answer to Pat's own DISC at the end of a finished exchange
  assert.strictEqual(done.needsClose({ patConnected: true }), false, 'Pat already closed it');
});
test('UA or DM after our disconnect ends the wait; nothing ends it at CLOSE_WAIT_MS', () => {
  for (const kind of ['UA', 'DM']) {
    const w = watch();
    w.noteFrame(rx('UA', ' F=1'), 1000);
    w.beginClose(10000);
    assert.deepStrictEqual(w.closeState(10500), { done: false, by: '', ms: 500 });
    w.noteFrame(rx(kind, ' F=1'), 11200);
    assert.deepStrictEqual(w.closeState(11250), { done: true, by: kind, ms: 1250 });
  }
  const w = watch();
  w.noteFrame(rx('UA', ' F=1'), 1000);
  w.beginClose(10000);
  w.noteFrame(rx('RR', ' R3 P=1'), 12000); // still polling: not an answer
  assert.strictEqual(w.closeState(10000 + L.CLOSE_WAIT_MS - 1).done, false);
  assert.deepStrictEqual(w.closeState(10000 + L.CLOSE_WAIT_MS), { done: true, by: 'timeout', ms: L.CLOSE_WAIT_MS });
  assert.strictEqual(L.CLOSE_WAIT_MS, 10000, 'about 10 s, as decided');
});
test('a link Pat had closed before the monitor saw its UA: the first UA after we ask is the answer', () => {
  const w = watch();
  w.beginClose(5000); // the monitor missed the connect UA; Pat said connected
  w.noteFrame(rx('UA', ' F=1'), 5600);
  assert.deepStrictEqual(w.closeState(5600), { done: true, by: 'UA', ms: 600 });
});
test('the gateway\'s own DISC: Dire Wolf is given time to send its UA before it stops', () => {
  const w = watch();
  w.noteFrame(rx('UA', ' F=1'), 1000);
  w.beginClose(10000);
  w.noteFrame(rx('DISC', ' P=1'), 10200);
  assert.strictEqual(w.closeState(10200 + L.DISC_LINGER_MS - 1).done, false);
  assert.deepStrictEqual(w.closeState(10200 + L.DISC_LINGER_MS), { done: true, by: 'DISC', ms: 200 + L.DISC_LINGER_MS });
});
test('closeFirst: packet only, never after a cause that must stop transmitting at once, never on a second Stop', () => {
  assert.strictEqual(L.closeFirst({ mode: 'packet', cause: null }), true, 'Pat failed, or the session finished');
  for (const k of ['operator', 'stall', 'cap', 'stuck-link', 'internal']) assert.strictEqual(L.closeFirst({ mode: 'packet', cause: { kind: k } }), true, k);
  for (const k of ['closing', 'turned-off', 'swr', 'ptt-refused', 'tx-failsafe', 'modem-stopped', 'pat-stopped', 'audio-device', 'audio-stopped', 'preempted']) {
    assert.strictEqual(L.closeFirst({ mode: 'packet', cause: { kind: k } }), false, k);
  }
  assert.strictEqual(L.closeFirst({ mode: 'packet', cause: { kind: 'operator' }, force: true }), false);
  for (const mode of ['ardop', 'vara', 'varafm', 'mercury', 'telnet']) assert.strictEqual(L.closeFirst({ mode, cause: null }), false, mode + ' unchanged');
  for (const k of L.END_AT_ONCE) assert.ok(O.CAUSE_KINDS.includes(k), k + ' is a cause with a sentence');
});
test('the log lines say who answered, how long it took, and what is left', () => {
  assert.strictEqual(L.closeLogText({ by: 'UA', ms: 1234, gateway: 'kj4ajp-10' }), 'packet: KJ4AJP-10 answered our disconnect (UA) after 1.2 s: the link is closed, Dire Wolf stops now');
  assert.ok(/did not answer our disconnect in 10\.0 s: Dire Wolf stops anyway, and KJ4AJP-10 may hold the link for a while$/.test(L.closeLogText({ by: 'timeout', ms: 10000, gateway: GW })));
  assert.ok(/a second Stop/.test(L.closeLogText({ by: 'forced', ms: 300, gateway: GW })));
  assert.ok(/FRMR/.test(L.stuckLogText({ why: 'frmr', gateway: GW })));
  assert.ok(/no greeting in 20 s/.test(L.stuckLogText({ why: 'no-greeting', gateway: GW })));
});

console.log('the words, and no automatic retry');
test('the held link says what it is and what to do, and nothing else', () => {
  const o = O.describeOutcome({ state: 'error', mode: 'packet', gateway: GW, dialed: true, connected: true, cause: { kind: 'stuck-link', detail: 'frmr' }, queued: 2, outbox: 2, received: 0 });
  assert.strictEqual(o.text, 'The gateway is still holding the last link. Wait a few minutes, then try again.');
  assert.strictEqual(o.kind, 'stuck-link');
  assert.strictEqual(o.retry, false);
  assert.strictEqual(o.errorKind, 'stopped', 'a word every surface already knows');
  assert.ok(/still holding the last link/.test(O.summaryLine({ outcome: o, mode: 'packet', gateway: GW, dialKhz: 145630, connected: true })));
});
test('a held link is never retried, and the log says why', () => {
  const o = O.describeOutcome({ state: 'error', mode: 'packet', gateway: GW, dialed: true, connected: true, cause: { kind: 'stuck-link' } });
  const d = R.shouldRetry({ outcome: o, mode: 'packet', gateway: GW, dialKhz: 145630, origin: 'mail window', enabled: true });
  assert.deepStrictEqual(d, { retry: false, why: 'the gateway is still holding the last link, so a retry now would meet the same link' });
});

console.log('main.js: the end is held for the close, and ARDOP/VARA/telnet are unchanged');
test('every packet monitor frame reaches the watch, made fresh for each session', () => {
  assert.ok(/if \(_winlinkPacketWatch\) _winlinkPacketWatch\.noteFrame\(text, Date\.now\(\)\);/.test(fnBody(main, 'winlinkAgwMonitorStart')));
  const r = fnBody(main, 'winlinkPacketReset');
  assert.ok(/_winlinkPacketWatch = mode === 'packet' \? new PacketLinkClose\.PacketLinkWatch\(\{ gateway: winlinkState\.session\.gateway, mycall: settings\.myCallsign \}\) : null;/.test(r));
  assert.ok(/_winlinkPacketClosed = false;/.test(r));
  assert.ok(/winlinkOutcomeReset\(mode\);\n {2}winlinkPacketReset\(mode\);/.test(main), 'with the outcome, at every session start');
});
test('winlinkEndSession holds a packet end before anything is torn down', () => {
  const end = fnBody(main, 'winlinkEndSession');
  const hold = end.indexOf('if (winlinkPacketHoldEnd(state, text, received)) return;');
  assert.ok(hold > 0, 'the hold');
  for (const later of ['clearTimeout(_winlinkCapTimer)', 'winlinkAudio.key(false)', 'killDirewolf()', "releaseRadio('winlink')", '_winlinkShimArmed = false']) {
    assert.ok(end.indexOf(later) > hold, later + ' comes after the hold');
  }
});
test('the hold asks Pat for a CLEAN disconnect, only for packet, only for a link that is up, and caps the wait', () => {
  const h = fnBody(main, 'winlinkPacketHoldEnd');
  assert.ok(/s\.mode !== 'packet'/.test(h) && /_winlinkPacketClosed/.test(h), 'packet only, once per session');
  assert.ok(/PacketLinkClose\.closeFirst\(\{ mode: s\.mode, cause: _winlinkCause \}\)/.test(h));
  assert.ok(/w\.needsClose\(\{ patConnected: _winlinkPatConnected \}\)/.test(h));
  assert.ok(/patClient\.disconnect\(false\)/.test(h) && !/disconnect\(true\)/.test(h), 'clean');
  assert.ok(/setInterval\(winlinkPacketCloseTick, 200\)/.test(h));
  assert.ok(/w\.closeState\(Date\.now\(\)\)/.test(fnBody(main, 'winlinkPacketCloseTick')));
  const fin = fnBody(main, 'winlinkPacketCloseFinish');
  assert.ok(fin.indexOf('_winlinkPacketClosed = true;') < fin.indexOf('winlinkEndSession(...p.args);'), 'the real end follows, and is not held again');
});
test('Stop: the first press closes cleanly; a second press, or a cause that must stop now, forces it', () => {
  const a = fnBody(main, 'winlinkAbortSession');
  const second = a.indexOf('if (winlinkPacketAbortWhileClosing(why, cause)) return;');
  assert.ok(second > 0 && second < a.indexOf('winlinkLog(`aborting the session'), 'checked first');
  const w = fnBody(main, 'winlinkPacketAbortWhileClosing');
  assert.ok(/if \(!_winlinkPacketClose\) return false;/.test(w));
  assert.ok(/if \(k === 'operator' \|\| PacketLinkClose\.END_AT_ONCE\.includes\(k\)\) \{[\s\S]*?patClient\.disconnect\(true\)[\s\S]*?winlinkPacketCloseFinish\('forced'\);/.test(w));
  // ARDOP, VARA, telnet: the dirty disconnect and the 6 s backstop, as before.
  assert.ok(/if \(!winlinkPacketHoldEnd\('error', `Stopped: \$\{why\}`, 0\)\) \{\n\s*if \(patClient\) patClient\.disconnect\(true\)\.catch\(\(\) => \{\}\);\n[^\n]*\n\s*setTimeout\(\(\) => \{ if \(winlinkSessionActive\(\)\) winlinkEndSession\('error', `Stopped: \$\{why\}`\); \}, 6000\);/.test(a));
});
test('quitting or turning Winlink off never waits for the gateway', () => {
  const d = fnBody(main, 'disconnectWinlink');
  const f = d.indexOf("if (_winlinkPacketClose) winlinkPacketCloseFinish('forced');");
  assert.ok(f > 0 && f < d.indexOf('winlinkEndSession('));
  assert.ok(d.indexOf('_winlinkPacketClosed = true;') < d.indexOf('winlinkEndSession('));
});
test('a call on a held link is ended with its own cause, once a second, packet sessions only', () => {
  const t = fnBody(main, 'winlinkPacketTimerStart');
  assert.ok(/w\.stuck\(Date\.now\(\)\)/.test(t));
  assert.ok(/winlinkAbortSession\('the gateway is still holding the last link', \{ kind: 'stuck-link', detail: v\.why \}\)/.test(t));
  assert.ok(/if \(mode === 'packet'\) winlinkPacketTimerStart\(\);/.test(main));
  assert.ok(/clearInterval\(_winlinkPacketTimer\); _winlinkPacketTimer = null;/.test(fnBody(main, 'winlinkEndSession')));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
