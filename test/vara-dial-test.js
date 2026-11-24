// The first VARA call after POTACAT starts, and what counts as a virtual cable.
//
// Report (macOS, VARA HF under Wine, the radio's USB sound card opened by VARA
// itself): after every restart of POTACAT the first Winlink call over VARA
// ended at once with "<gateway> did not answer". Setting both "Audio between
// VARA and the radio" boxes to the radio's sound card made one call work (the
// radio then stayed keyed); setting them back made every later call work until
// the next restart.
//
// What the code says (lib/vara-dial.js):
//  - "did not answer" at once is Pat's line for a refused TCP connection to
//    VARA, read as a gateway that did not answer. No call was made.
//  - Pat keeps VARA's port once a session has connected, so only the first
//    call after a start has to open it. POTACAT's own checks of the port leave
//    VARA not listening for a moment; the both-boxes setting only added the
//    seconds it takes to open two more sound devices.
//  - The dial is therefore repeated, a bounded number of times, and only while
//    nothing was sent to VARA and nothing was keyed.
//  - A box set to the radio's own sound card is not a cable.
// Run: node test/vara-dial-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const D = require('../lib/vara-dial');
const V = require('../lib/vara-process');
const WinlinkPat = require('../lib/winlink-pat');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js')).replace(/\r\n/g, '\n');
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const j = src.indexOf('\nfunction ', i + 10);
  const k = src.indexOf('\nasync function ', i + 10);
  const end = [j, k].filter((n) => n > 0).sort((a, b) => a - b)[0];
  return src.slice(i, end || i + 8000);
}

const CMD_REFUSED = "2026/11/16 21:34:47 vara initialization failed: couldn't connect to VARA command port: dial tcp 127.0.0.1:8300: connect: connection refused";
const DATA_REFUSED = "2026/11/23 10:02:11 vara initialization failed: couldn't connect to VARA data port: dial tcp 127.0.0.1:8301: connect: connection refused";

/** A stand-in for Pat in front of a VARA that refuses the first `refuse` connections. */
function fakePat({ refuse = 0, line = CMD_REFUSED, otherError = null } = {}) {
  const st = { calls: 0, pending: null, slept: [], redials: [] };
  return {
    st,
    connect: async () => {
      st.calls++;
      if (st.calls <= refuse) { st.pending = D.patVaraPortRefusal(line); throw Object.assign(new Error('connect: HTTP 500 — Session failure {"NumReceived":0}'), { status: 500 }); }
      if (otherError) throw otherError;
      return 2;
    },
    takeRefusal: () => { const r = st.pending; st.pending = null; return r; },
    sleep: async (ms) => { st.slept.push(ms); },
    onRedial: (i) => st.redials.push(i),
  };
}
const base = (p, over = {}) => ({ mode: 'vara', connect: p.connect, takeRefusal: p.takeRefusal, sleep: p.sleep, onRedial: p.onRedial, live: () => true, keyed: () => false, connected: () => false, ...over });

console.log('Pat\'s line for a refused VARA port');
test('the command port and the data port are both recognised, with Pat\'s own reason', () => {
  assert.deepStrictEqual(D.patVaraPortRefusal(CMD_REFUSED), { port: 'command', why: 'dial tcp 127.0.0.1:8300: connect: connection refused' });
  assert.strictEqual(D.patVaraPortRefusal(DATA_REFUSED).port, 'data');
  assert.strictEqual(D.patVaraPortRefusal('Unable to establish connection to remote: connect timeout'), null);
  assert.strictEqual(D.patVaraPortRefusal('Connected to N5TW (varahf)'), null);
  assert.strictEqual(D.patVaraPortRefusal(''), null);
});
test('that line is what POTACAT used to read as "the gateway did not answer"', () => {
  // The cause of the wrong sentence: "connection refused" is in the no-answer rule.
  assert.strictEqual(WinlinkPat.classifyPatLine(CMD_REFUSED), 'no-answer');
  assert.strictEqual(WinlinkPat.classifyPatLine(DATA_REFUSED), 'no-answer');
});
test('a refused data port also means Pat does not hold VARA', () => {
  assert.ok(V.patLineSaysVaraRefused(CMD_REFUSED));
  assert.ok(V.patLineSaysVaraRefused(DATA_REFUSED));
  assert.ok(!V.patLineSaysVaraRefused('connected to N5TW'));
});

console.log('one refusal, two pipes');
test('the same line arriving by Pat\'s output and by its log is one refusal', () => {
  const n = new D.RefusalNotes();
  assert.strictEqual(n.take(), null);
  n.note('output', { port: 'command', why: '' });
  assert.strictEqual(n.take().port, 'command');
  n.note('log', { port: 'command', why: '' }); // the second copy, later
  assert.strictEqual(n.take(), null);
  n.note('log', { port: 'data', why: '' });    // the next dial's refusal, by the log first
  assert.strictEqual(n.take().port, 'data');
  n.note('output', { port: 'data', why: '' });
  assert.strictEqual(n.take(), null);
  n.note('output', null);
  assert.strictEqual(n.take(), null);
  n.note('log', { port: 'command', why: '' }); n.reset();
  assert.strictEqual(n.take(), null);
});
test('a refusal line that arrives during a call that then keyed the radio is not that call\'s ending', async () => {
  const p = fakePat({ otherError: Object.assign(new Error('connect: HTTP 500 — Session failure'), { status: 500 }) });
  const connect = async () => { try { return await p.connect(); } finally { p.st.pending = D.patVaraPortRefusal(CMD_REFUSED); } };
  let err = null;
  try { await D.dialWithRedial(base(p, { connect, keyed: () => true })); } catch (e) { err = e; }
  assert.strictEqual(p.st.calls, 1);
  assert.strictEqual(err.varaRefused, undefined);
});

console.log('when a refused dial is placed again');
test('only VARA, only a refused connection, only a live attempt', () => {
  const r = { port: 'command', why: '' };
  assert.deepStrictEqual(D.shouldRedial({ mode: 'vara', refusal: r, redials: 0, live: true }), { redial: true, waitMs: 500 });
  assert.strictEqual(D.shouldRedial({ mode: 'varafm', refusal: r, redials: 1, live: true }).waitMs, 1000);
  assert.strictEqual(D.shouldRedial({ mode: 'ardop', refusal: r, live: true }).redial, false);
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: null, live: true }).redial, false);
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, live: false }).redial, false);
});
test('never after the radio was keyed, never after a link came up', () => {
  const r = { port: 'command', why: '' };
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, live: true, keyed: true }).redial, false);
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, live: true, connected: true }).redial, false);
});
test('bounded: three more dials, 3.5 s of waiting in all', () => {
  const r = { port: 'command', why: '' };
  assert.deepStrictEqual([...D.REDIAL_WAITS_MS], [500, 1000, 2000]);
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, redials: 2, live: true }).waitMs, 2000);
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, redials: 3, live: true }).redial, false);
});

console.log('the dial');
test('a VARA that answers the first time is dialled once, with no wait', async () => {
  const p = fakePat();
  assert.strictEqual(await D.dialWithRedial(base(p)), 2);
  assert.strictEqual(p.st.calls, 1);
  assert.deepStrictEqual(p.st.slept, []);
});
test('the first call after a start: refused once, placed again 500 ms later, and it goes through', async () => {
  const p = fakePat({ refuse: 1 });
  assert.strictEqual(await D.dialWithRedial(base(p)), 2);
  assert.strictEqual(p.st.calls, 2);
  assert.deepStrictEqual(p.st.slept, [500]);
  assert.deepStrictEqual(p.st.redials.map((x) => [x.dial, x.of, x.waitMs, x.refusal.port]), [[2, 4, 500, 'command']]);
});
test('refused on the data port is the same case', async () => {
  const p = fakePat({ refuse: 2, line: DATA_REFUSED });
  assert.strictEqual(await D.dialWithRedial(base(p)), 2);
  assert.deepStrictEqual(p.st.slept, [500, 1000]);
  assert.strictEqual(p.st.redials[0].refusal.port, 'data');
});
test('refused every time: four dials, then the error says so', async () => {
  const p = fakePat({ refuse: 99 });
  let err = null;
  try { await D.dialWithRedial(base(p)); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(p.st.calls, 4);
  assert.deepStrictEqual(p.st.slept, [500, 1000, 2000]);
  assert.strictEqual(err.varaRefused.port, 'command');
  assert.strictEqual(err.varaDials, 4);
});
test('any other failure is thrown as it came and never dialled again', async () => {
  const p = fakePat({ otherError: Object.assign(new Error('connect: HTTP 500 — Session failure'), { status: 500 }) });
  let err = null;
  try { await D.dialWithRedial(base(p, { keyed: () => true })); } catch (e) { err = e; }
  assert.strictEqual(p.st.calls, 1);
  assert.strictEqual(err.varaRefused, undefined);
  assert.deepStrictEqual(p.st.slept, [], 'a call that keyed the radio ends without a wait');
});
test('a call that failed with nothing keyed waits one moment for Pat\'s line, then ends', async () => {
  const p = fakePat({ otherError: new Error('connect: HTTP 500 — Session failure') });
  let err = null;
  try { await D.dialWithRedial(base(p)); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(p.st.calls, 1);
  assert.deepStrictEqual(p.st.slept, [D.REFUSAL_GRACE_MS]);
});
test('Pat\'s line may arrive just after its HTTP reply', async () => {
  const p = fakePat({ refuse: 1 });
  let late = null;
  const connect = async () => { try { return await p.connect(); } catch (e) { late = p.st.pending; p.st.pending = null; throw e; } };
  const sleep = async (ms) => { p.st.slept.push(ms); if (late) { p.st.pending = late; late = null; } };
  assert.strictEqual(await D.dialWithRedial(base(p, { connect, sleep })), 2);
  assert.deepStrictEqual(p.st.slept, [D.REFUSAL_GRACE_MS, 500]);
});
test('a refusal logged before this dial is not this dial\'s', async () => {
  const p = fakePat({ otherError: new Error('connect: HTTP 500 — Session failure') });
  p.st.pending = D.patVaraPortRefusal(CMD_REFUSED); // left from an earlier attempt
  let err = null;
  try { await D.dialWithRedial(base(p)); } catch (e) { err = e; }
  assert.strictEqual(p.st.calls, 1);
  assert.strictEqual(err.varaRefused, undefined);
});
test('Stop during the wait: no further dial', async () => {
  const p = fakePat({ refuse: 99 });
  let alive = true;
  const sleep = async (ms) => { p.st.slept.push(ms); if (ms === 500) alive = false; };
  let err = null;
  try { await D.dialWithRedial(base(p, { sleep, live: () => alive })); } catch (e) { err = e; }
  assert.strictEqual(p.st.calls, 1);
  assert.strictEqual(err.varaStopped, true);
});
test('another modem is never dialled twice', async () => {
  const p = fakePat({ refuse: 99 });
  let err = null;
  try { await D.dialWithRedial(base(p, { mode: 'ardop' })); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(p.st.calls, 1);
  assert.deepStrictEqual(p.st.slept, []);
});

console.log('#1040: the first call after a start, both ways it can end at once');
const TIMEOUT_LINE = '2026/11/23 10:02:11 Unable to establish connection to remote: connect timeout';
test('Pat\'s word for a call VARA ended is "connect timeout", whenever it came', () => {
  assert.deepStrictEqual(D.patVaraCallEnded(TIMEOUT_LINE), { ended: true, why: 'connect timeout' });
  assert.strictEqual(D.patVaraCallEnded(CMD_REFUSED), null);
  assert.strictEqual(D.patVaraCallEnded('Connected to N5TW (varahf)'), null);
  assert.strictEqual(WinlinkPat.classifyPatLine(TIMEOUT_LINE), 'no-answer', 'and POTACAT read it as no answer');
});
test('the threshold: an ended call is placed again only within 5 s of the dial, never keyed, no link', () => {
  const r = { ended: true, why: 'connect timeout' };
  assert.strictEqual(D.QUICK_END_MS, 5000);
  assert.deepStrictEqual(D.shouldRedial({ mode: 'vara', refusal: r, msSinceDial: 12, live: true }), { redial: true, waitMs: 500 });
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, msSinceDial: 5000, live: true }).redial, true);
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, msSinceDial: 5001, live: true }).redial, false);
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, live: true }).redial, false, 'no time known: not placed again');
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, msSinceDial: 12, live: true, keyed: true }).redial, false);
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, msSinceDial: 12, live: true, connected: true }).redial, false);
  assert.strictEqual(D.shouldRedial({ mode: 'vara', refusal: r, msSinceDial: 12, live: true, redials: 3 }).redial, false, 'the same cap as a refused port');
  assert.strictEqual(D.shouldRedial({ mode: 'ardop', refusal: r, msSinceDial: 12, live: true }).redial, false);
});
/**
 * A stand-in for VARA's command port as it behaves under Wine: one client at a
 * time, and not listening again until `relistenMs` after a client leaves.
 */
function fakeVaraPort(relistenMs) {
  const net = require('net');
  const st = { port: 0, accepted: 0, closed: false };
  let srv = null;
  const listen = () => new Promise((resolve) => {
    if (st.closed) return resolve();
    srv = net.createServer((sock) => {
      st.accepted++;
      srv.close(); // one client at a time
      sock.on('error', () => {});
      sock.on('close', () => { setTimeout(listen, relistenMs); });
    });
    srv.on('error', () => {});
    srv.listen(st.port, '127.0.0.1', () => { st.port = srv.address().port; resolve(); });
  });
  return { st, listen, close: () => { st.closed = true; try { srv.close(); } catch {} } };
}
/** Pat's first step on a first call: open VARA's command port; its line when that is refused. */
function patOpensPort(port, notes) {
  const net = require('net');
  return () => new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.on('connect', () => { resolve({ sock }); });
    sock.on('error', (e) => {
      notes.note('log', D.patVaraPortRefusal(`vara initialization failed: couldn't connect to VARA command port: dial tcp 127.0.0.1:${port}: connect: connection ${e.code === 'ECONNREFUSED' ? 'refused' : e.code}`));
      reject(Object.assign(new Error('connect: HTTP 500 — Session failure {"NumReceived":0}'), { status: 500 }));
    });
  });
}
test('real sockets: VARA is not listening again yet right after POTACAT\'s port check; the first dial is refused and the redial gets through', async () => {
  const vara = fakeVaraPort(700);
  await vara.listen();
  // POTACAT's own check, with the settle 1.14.7 gave a port that answered at once (150 ms).
  const accept = await V.waitForPortAccept(vara.st.port, { intervalMs: 50, settleMinMs: 150 });
  assert.ok(accept.ok && accept.tries === 1);
  const notes = new D.RefusalNotes();
  const redials = [];
  let calls = 0;
  const open = patOpensPort(vara.st.port, notes);
  const got = await D.dialWithRedial({
    mode: 'vara', connect: () => { calls++; return open(); }, takeRefusal: () => notes.take(),
    live: () => true, keyed: () => false, connected: () => false, onRedial: (i) => redials.push(i), graceMs: 20,
  });
  got.sock.destroy(); vara.close();
  assert.ok(calls >= 2, 'the first dial was refused: ' + calls);
  assert.strictEqual(redials[0].refusal.port, 'command');
  assert.strictEqual(redials[0].waitMs, 500);
  assert.ok(calls <= 4);
});
test('real sockets: with the one-second settle the same VARA takes the first dial', async () => {
  const vara = fakeVaraPort(700);
  await vara.listen();
  const accept = await V.waitForPortAccept(vara.st.port, { intervalMs: 50 });
  assert.ok(accept.ok && accept.settleMs >= 1000);
  const notes = new D.RefusalNotes();
  let calls = 0;
  const open = patOpensPort(vara.st.port, notes);
  const got = await D.dialWithRedial({
    mode: 'vara', connect: () => { calls++; return open(); }, takeRefusal: () => notes.take(),
    live: () => true, keyed: () => false, connected: () => false, graceMs: 20,
  });
  got.sock.destroy(); vara.close();
  assert.strictEqual(calls, 1);
});
/** A stand-in for Pat whose first `ended` calls come back as "connect timeout" after `afterMs`. */
function fakePatEnded({ ended = 1, afterMs = 12, keyedByCall = false } = {}) {
  const st = { calls: 0, slept: [], redials: [], clock: 1000, keyed: false };
  const notes = new D.RefusalNotes();
  return {
    st,
    opts: (over = {}) => ({
      mode: 'vara',
      connect: async () => {
        st.calls++;
        if (st.calls <= ended) {
          if (keyedByCall) st.keyed = true; // VARA called: the radio transmitted
          st.clock += afterMs;
          notes.note('log', D.patVaraCallEnded(TIMEOUT_LINE));
          notes.note('output', D.patVaraCallEnded(TIMEOUT_LINE));
          throw Object.assign(new Error('connect: HTTP 500 — Session failure {"NumReceived":0}'), { status: 500 });
        }
        return 3;
      },
      takeRefusal: () => notes.take(),
      sleep: async (ms) => { st.slept.push(ms); st.clock += ms; },
      now: () => st.clock,
      live: () => true, keyed: () => st.keyed, connected: () => false,
      onRedial: (i) => st.redials.push(i),
      ...over,
    }),
  };
}
test('VARA answers the first CONNECT with DISCONNECTED at once ("connect timeout" in 12 ms, never keyed): placed again, and it goes through', async () => {
  const p = fakePatEnded({ ended: 1, afterMs: 12 });
  assert.strictEqual(await D.dialWithRedial(p.opts()), 3);
  assert.strictEqual(p.st.calls, 2);
  assert.deepStrictEqual(p.st.slept, [500]);
  assert.strictEqual(p.st.redials[0].refusal.ended, true);
  assert.strictEqual(p.st.redials[0].msSinceDial, 12);
  const t = D.redialLogText({ mode: 'vara', where: '127.0.0.1:8300', ...p.st.redials[0], sinceCheckMs: 1010 });
  assert.ok(/VARA HF at 127\.0\.0\.1:8300 ended Pat's call 12 ms after it was asked for, 1010 ms after POTACAT's own check of that port \(Pat: connect timeout\)\. The radio was never keyed, so nothing was transmitted\. Calling again in 500 ms \(try 2 of 4\)/.test(t), t);
});
test('ended at once every time: four dials, then VARA is named, not the gateway', async () => {
  const p = fakePatEnded({ ended: 99 });
  let err = null;
  try { await D.dialWithRedial(p.opts()); } catch (e) { err = e; }
  assert.strictEqual(p.st.calls, 4);
  assert.deepStrictEqual(p.st.slept, [500, 1000, 2000]);
  assert.strictEqual(err.varaEnded.ended, true);
  assert.strictEqual(err.varaDials, 4);
  assert.strictEqual(err.varaRefused, undefined);
  const t = D.endedText({ mode: 'vara', where: '127.0.0.1:8300', dials: 4 });
  assert.ok(/VARA HF at 127\.0\.0\.1:8300 ended the call at once 4 times, before the radio was keyed, so nothing was transmitted/.test(t), t);
  assert.ok(!/did not answer/.test(t));
});
test('a real no-answer (the radio transmitted, "connect timeout" after 70 s) is never placed again', async () => {
  const p = fakePatEnded({ ended: 99, afterMs: 70000, keyedByCall: true });
  let err = null;
  try { await D.dialWithRedial(p.opts()); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(p.st.calls, 1);
  assert.deepStrictEqual(p.st.slept, [], 'no wait, no redial');
  assert.strictEqual(err.varaEnded, undefined, 'it stays a gateway that did not answer');
  assert.strictEqual(err.varaDials, undefined);
});
test('keyed and over within a second is still a call: never placed again', async () => {
  const p = fakePatEnded({ ended: 99, afterMs: 800, keyedByCall: true });
  let err = null;
  try { await D.dialWithRedial(p.opts()); } catch (e) { err = e; }
  assert.strictEqual(p.st.calls, 1);
  assert.strictEqual(err.varaEnded, undefined);
});
test('never keyed but 70 s long (a meter that missed the key-down must not matter): not placed again', async () => {
  const p = fakePatEnded({ ended: 99, afterMs: 70000 });
  let err = null;
  try { await D.dialWithRedial(p.opts()); } catch (e) { err = e; }
  assert.strictEqual(p.st.calls, 1);
  assert.deepStrictEqual(p.st.slept, []);
  assert.strictEqual(err.varaEnded, undefined);
});
test('VARA went on with the call during the wait (the radio keyed): no second CONNECT on top of it', async () => {
  const p = fakePatEnded({ ended: 99, afterMs: 12 });
  const o = p.opts();
  const sleep = async (ms) => { p.st.slept.push(ms); if (ms === 500) p.st.keyed = true; };
  let err = null;
  try { await D.dialWithRedial({ ...o, sleep }); } catch (e) { err = e; }
  assert.strictEqual(p.st.calls, 1);
  assert.strictEqual(err.varaWentOn, true);
});

console.log('the words');
test('the log line for a redial says nothing was transmitted and how long after POTACAT\'s check', () => {
  const t = D.redialLogText({ mode: 'vara', where: '127.0.0.1:8300', refusal: D.patVaraPortRefusal(CMD_REFUSED), dial: 2, of: 4, waitMs: 500, sinceCheckMs: 153.4 });
  assert.ok(/VARA HF at 127\.0\.0\.1:8300 refused Pat's connection to its command port, 153 ms after POTACAT's own check of that port/.test(t), t);
  assert.ok(/nothing was transmitted\. Calling again in 500 ms \(try 2 of 4\)/.test(t), t);
});
test('refused every time is never worded as a gateway that did not answer', () => {
  const t = D.refusedText({ mode: 'vara', where: '127.0.0.1:8300', refusal: { port: 'command', why: '' }, dials: 4 });
  assert.ok(/VARA HF at 127\.0\.0\.1:8300 refused the connection to its command port 4 times, so no call was made and nothing was transmitted/.test(t), t);
  assert.ok(!/did not answer/.test(t));
  assert.ok(/VARA FM/.test(D.refusedText({ mode: 'varafm', where: 'x', refusal: { port: 'data', why: '' }, dials: 1 })));
});
test('a call that ends within 5 s with nothing keyed gets one line for the bug report', () => {
  const t = D.fastFailText({ mode: 'vara', where: '127.0.0.1:8300', msSinceDial: 12, msSinceCheck: 160, keyed: false, connected: false, patLine: 'Unable to establish connection to remote: connect timeout', route: 'direct' });
  assert.ok(/the call ended 12 ms after Pat was asked to place it, 160 ms after POTACAT's check of the port, and the radio was never keyed \(audio: direct\)\. Pat's reason: Unable to establish connection to remote: connect timeout/.test(t), t);
  assert.strictEqual(D.fastFailText({ mode: 'vara', msSinceDial: 12, keyed: true }), '');
  assert.strictEqual(D.fastFailText({ mode: 'vara', msSinceDial: 90000, keyed: false }), '');
  assert.strictEqual(D.fastFailText({ mode: 'ardop', msSinceDial: 12, keyed: false }), '');
});

console.log('what counts as a virtual cable');
const RADIO = { inputId: 'radio-in', outputId: 'radio-out' };
test('two virtual cables are carried', () => {
  assert.deepStrictEqual(D.cableRoute({ cable: { inputId: 'cable-a', outputId: 'cable-b' }, radio: RADIO }), { use: true, half: false, loop: [] });
  assert.strictEqual(D.cableRouteText(D.cableRoute({ cable: { inputId: 'cable-a', outputId: 'cable-b' }, radio: RADIO })), '');
});
test('both boxes on None: no cable, nothing said', () => {
  const r = D.cableRoute({ cable: null, radio: RADIO });
  assert.deepStrictEqual(r, { use: false, half: false, loop: [] });
  assert.strictEqual(D.cableRouteText(r), '');
});
test('the reported setting (From VARA = the radio, To VARA = None) is no cable, at launch and after a save alike', () => {
  const r = D.cableRoute({ cable: { inputId: 'radio-in', outputId: '' }, radio: RADIO });
  assert.strictEqual(r.use, false);
  assert.deepStrictEqual(r.loop, ['From VARA']);
  assert.ok(/From VARA in Settings > Station > Winlink is set to this radio's own sound card/.test(D.cableRouteText(r)));
  const half = D.cableRoute({ cable: { inputId: 'cable-a', outputId: '' }, radio: RADIO });
  assert.deepStrictEqual(half, { use: false, half: true, loop: [] });
  assert.ok(/only one of From VARA and To VARA is set/.test(D.cableRouteText(half)));
});
test('both boxes on the radio\'s own sound card is a loop, never carried', () => {
  const r = D.cableRoute({ cable: { inputId: 'radio-in', outputId: 'radio-out' }, radio: RADIO });
  assert.strictEqual(r.use, false);
  assert.deepStrictEqual(r.loop, ['From VARA', 'To VARA']);
  assert.ok(/From VARA and To VARA .* are set to this radio's own sound card, which is not a virtual cable/.test(D.cableRouteText(r)));
  assert.strictEqual(D.cableRoute({ cable: { inputId: 'cable-a', outputId: 'radio-out' }, radio: RADIO }).use, false);
});
test('Flex Direct and Icom Network have no sound card here: their cables are never taken for a loop', () => {
  assert.strictEqual(D.cableRoute({ cable: { inputId: 'radio-in', outputId: 'radio-out' }, radio: RADIO, ipAudio: true }).use, true);
});
test('a radio with no device chosen never matches an empty box', () => {
  assert.deepStrictEqual(D.cableRoute({ cable: { inputId: 'cable-a', outputId: 'cable-b' }, radio: { inputId: '', outputId: '' } }).loop, []);
});

console.log('main.js wiring');
test('Pat is asked to call through dialWithRedial, with the session\'s own liveness and key state', () => {
  const s = fnBody(main, 'winlinkStartSession');
  assert.ok(/await VaraDial\.dialWithRedial\(\{/.test(s));
  assert.ok(!/const received = await patClient\.connect\(url\);/.test(s), 'the bare connect is gone');
  const i = s.indexOf('VaraDial.dialWithRedial({');
  const call = s.slice(i, i + 1400);
  assert.ok(/connect: async \(\) => \{ _winlinkDialAt = Date\.now\(\); return await patClient\.connect\(url\); \}/.test(call));
  assert.ok(/takeRefusal: \(\) => _winlinkVaraRefusals\.take\(\)/.test(call));
  assert.ok(/live,/.test(call));
  assert.ok(/keyed: \(\) => _winlinkKeyDowns > 0/.test(call));
  assert.ok(/connected: \(\) => _winlinkPatConnected/.test(call));
});
test('a key-down is counted where the radio is keyed, and the count starts at zero each attempt', () => {
  const shim = fnBody(main, 'startWinlinkShim');
  assert.ok(/winlinkTxActive = true;\s*_winlinkTxBurst\.keyDown\(\);\s*modemBridgeOver\(true\);\s*_winlinkKeyDowns\+\+;/.test(shim));
  const start = fnBody(main, 'winlinkStartSession');
  const reset = start.indexOf('_winlinkKeyDowns = 0;');
  assert.ok(reset > 0 && reset < start.indexOf('VaraDial.dialWithRedial({'));
  assert.ok(/_winlinkKeyDowns = 0;\s*_winlinkVaraRefusals\.reset\(\);/.test(start));
});
test('Pat\'s refusal line is noted from both of its pipes and is never worded as no answer', () => {
  const ev = fnBody(main, 'winlinkOnPatEvent');
  assert.ok(/const refused = VaraDial\.patVaraPortRefusal\(ev\.text\);[\s\S]{0,420}?if \(refused\) \{\s*_winlinkVaraRefusals\.note\('log', refused\);[\s\S]{0,260}?_patHoldsVara\[_patVaraKind\] = null;\s*\}\s*else if \(ev\.class === 'login-failed'\)/.test(ev));
  assert.ok(/_winlinkVaraRefusals\.note\('output', VaraDial\.patVaraPortRefusal\(line\) \|\| VaraDial\.patVaraCallEnded\(line\)\)/.test(fnBody(main, 'spawnPat')));
});
test('"connect timeout" is noted for the dial, and still reads as no answer when the dial does not take it', () => {
  const ev = fnBody(main, 'winlinkOnPatEvent');
  const note = ev.indexOf("_winlinkVaraRefusals.note('log', VaraDial.patVaraCallEnded(ev.text));");
  assert.ok(note > 0);
  assert.ok(note < ev.indexOf("else if (ev.class === 'no-answer')"), 'the no-answer wording is not skipped for it');
  const s = fnBody(main, 'winlinkStartSession');
  assert.ok(/if \(e && e\.varaEnded\) \{\s*_winlinkSessionError = VaraDial\.endedText\(/.test(s));
  assert.ok(/if \(e && e\.varaWentOn\) \{[\s\S]{0,260}?patClient\.disconnect\(true\)/.test(s), 'a call that went on the air after all is ended, never repeated');
});
test('refused every time ends as a modem that is not answering, with POTACAT\'s own sentence', () => {
  const s = fnBody(main, 'winlinkStartSession');
  assert.ok(/if \(e && e\.varaRefused\) \{\s*_winlinkSessionError = VaraDial\.refusedText\(/.test(s));
  assert.ok(/_winlinkSessionErrorKind = 'transport-down';/.test(s));
});
test('a redial clears what the refused dial left behind', () => {
  const s = fnBody(main, 'winlinkStartSession');
  const i = s.indexOf('onRedial:');
  const body = s.slice(i, i + 900);
  assert.ok(/_winlinkSessionError = ''; _winlinkSessionErrorKind = '';/.test(body));
  assert.ok(/winlinkLog\(VaraDial\.redialLogText\(/.test(body));
  assert.ok(/winlinkSessionTouch\(\)/.test(body));
});
test('the cable is one decision, used everywhere: both boxes set and neither the radio\'s own sound card', () => {
  const c = fnBody(main, 'winlinkCableConfigured');
  assert.ok(/return winlinkCableRoute\(\)\.use;/.test(c));
  const r = fnBody(main, 'winlinkCableRoute');
  assert.ok(/VaraDial\.cableRoute\(\{ cable: winlinkCableDevices\(\), radio: modemBridgeDevices\(\), ipAudio: winlinkIpAudioRoute\(\) \}\)/.test(r));
  const ready = fnBody(main, 'winlinkVaraAudioReady');
  assert.ok(/VaraDial\.cableRouteText\(winlinkCableRoute\(\)\)/.test(ready), 'a box that is set and not used is said in the log');
});
test('the time since POTACAT\'s own check of the port is kept for the log', () => {
  const ready = fnBody(main, 'winlinkVaraReady');
  assert.ok(/_winlinkVaraCheckedAt = Date\.now\(\) - \(accept\.settleMs \|\| 0\);/.test(ready));
  assert.ok(ready.indexOf('_winlinkVaraCheckedAt = 0;') < ready.indexOf('held by Pat from the last session'), 'a port Pat already holds was not checked');
});
test('no PTT is asserted by the audio bridge: the cable\'s audio reaches the radio only while Pat holds PTT', () => {
  const i = main.indexOf("ipcMain.on('modem-bridge-cable-rx'");
  assert.ok(i > 0);
  const h = main.slice(i, i + 700);
  assert.ok(/if \(!winlinkTxActive\) return;/.test(h));
  assert.ok(!/handleRemotePtt/.test(h));
});
test('the radio is unkeyed when a session ends, however it ends, and a stuck key ends the session', () => {
  const end = fnBody(main, 'winlinkEndSession');
  assert.ok(/if \(winlinkTxActive\) \{ winlinkTxActive = false; try \{ handleRemotePtt\(false\); \} catch \{\} \}/.test(end));
  assert.ok(end.indexOf('handleRemotePtt(false)') < end.indexOf('stopModemBridgeCable()'), 'PTT off before the cable closes');
  const fs2 = fnBody(main, 'armWinlinkTxFailsafe');
  assert.ok(/handleRemotePtt\(false\)/.test(fs2) && /winlinkAbortSession\(/.test(fs2));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
