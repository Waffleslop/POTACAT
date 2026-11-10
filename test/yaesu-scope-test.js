#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
const { readSrc } = require('./_src');
//
// lib/yaesu-scope.js — the FT-710's band scope over USB, everything that is
// pure: frame bytes, the helper's stdout stream, the CAT replies that give
// the axis its meaning, and the words shown when the helper cannot run.
//
// The frame layout comes from published write-ups, not a capture of our own
// — the first real capture from an FT-710 goes under test/fixtures/ and
// gets its own section here. Until then these tests pin the CONTRACT the
// rest of POTACAT is built against, so a layout correction is one place.
//
// Run:  node test/yaesu-scope-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/yaesu-scope');

let pass = 0;
let fail = 0;
const failures = [];
function check(msg, fn) {
  try { fn(); pass++; } catch (err) {
    fail++;
    failures.push(msg);
    console.log(`  \u2717 ${msg}\n      ${err.message}`);
  }
}
function section(name) { console.log(`\n=== ${name} ===`); }

function ramp() {
  const a = new Uint8Array(S.BINS);
  for (let i = 0; i < S.BINS; i++) a[i] = i % 256;
  return a;
}

section('Frame bytes');

check('a built frame is 4096 bytes and ends on the sync pattern', () => {
  const f = S.buildScopeFrame({ wf1: ramp() });
  assert.strictEqual(f.length, 4096);
  assert.ok(S.isFrameAligned(f));
  assert.deepStrictEqual([...f.subarray(4092)], [0xff, 0x01, 0xee, 0x01]);
});

check('spectrum bytes are inverted on the wire and restored by the parser', () => {
  const f = S.buildScopeFrame({ wf1: ramp() });
  assert.strictEqual(f[0], 0xff, 'level 0 is 0xFF on the wire');
  assert.strictEqual(f[255], 0x00, 'level 255 is 0x00 on the wire');
  const p = S.parseScopeFrame(f);
  assert.deepStrictEqual([...p.wf1], [...ramp()]);
  assert.strictEqual(p.wf1.length, 850);
  assert.strictEqual(p.wf2.length, 850);
  assert.ok(p.aligned);
});

check('WF2 and the metadata block come out of their own offsets', () => {
  const wf2 = new Uint8Array(S.BINS).fill(7);
  const meta = Buffer.alloc(150, 0xa5);
  const p = S.parseScopeFrame(S.buildScopeFrame({ wf2, meta }));
  assert.ok(p.wf2.every((v) => v === 7));
  assert.ok(p.wf1.every((v) => v === 0));
  assert.strictEqual(p.meta.length, 150);
  assert.ok(p.meta.every((v) => v === 0xa5));
});

check('a frame that does not end on the sync pattern is flagged, not thrown', () => {
  const f = S.buildScopeFrame({});
  f[4095] = 0x00;
  const p = S.parseScopeFrame(f);
  assert.strictEqual(p.aligned, false);
});

check('the wrong length is refused loudly', () => {
  assert.throws(() => S.parseScopeFrame(Buffer.alloc(4000)), /4096/);
});

section('Helper stdout stream');

function wire(frames, kind = 0) {
  return Buffer.concat(frames.flatMap((f, i) => [S.frameHeader({ seq: i + 1, kind }), f]));
}

check('frames are delivered whole across arbitrary chunk boundaries', () => {
  const frames = [S.buildScopeFrame({ wf1: ramp() }), S.buildScopeFrame({ wf2: ramp() })];
  const bytes = wire(frames);
  const got = [];
  const st = new S.YaesuScopeStream();
  st.on('frame', (fr) => got.push(fr));
  for (let i = 0; i < bytes.length; i += 1000) st.feed(bytes.subarray(i, i + 1000));
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].seq, 1);
  assert.strictEqual(got[1].seq, 2);
  assert.deepStrictEqual([...got[0].wf1], [...ramp()]);
  assert.deepStrictEqual([...got[1].wf2], [...ramp()]);
  assert.strictEqual(st.frames, 2);
});

check('one byte at a time works too', () => {
  const bytes = wire([S.buildScopeFrame({})]);
  const st = new S.YaesuScopeStream();
  let n = 0;
  st.on('frame', () => n++);
  for (let i = 0; i < bytes.length; i++) st.feed(bytes.subarray(i, i + 1));
  assert.strictEqual(n, 1);
});

check('garbage before the first header is skipped and reported', () => {
  const bytes = Buffer.concat([Buffer.from('hello from a chatty helper\n'), wire([S.buildScopeFrame({})])]);
  const st = new S.YaesuScopeStream();
  let n = 0; let skipped = 0;
  st.on('frame', () => n++);
  st.on('resync', (k) => { skipped += k; });
  st.feed(bytes);
  assert.strictEqual(n, 1);
  assert.strictEqual(skipped, 27);
  assert.strictEqual(st.skipped, 27);
});

check('a torn frame resyncs on the next header instead of shifting every later frame', () => {
  const good = S.buildScopeFrame({ wf1: ramp() });
  const bytes = Buffer.concat([
    S.frameHeader({ seq: 1 }), good.subarray(0, 100),   // truncated
    S.frameHeader({ seq: 2 }), good,
  ]);
  const st = new S.YaesuScopeStream();
  const got = [];
  st.on('frame', (fr) => got.push(fr));
  st.feed(bytes);
  // The first header is complete but its payload is short: the parser waits
  // for 4096 bytes, sees header 2 inside them... so it reads a misaligned
  // frame. What matters is that it RECOVERS: the aligned count tells the
  // diagnostics, and the stream keeps flowing afterwards.
  const more = wire([good]);
  st.feed(more);
  assert.ok(got.length >= 1);
  assert.ok(got[got.length - 1].aligned, 'the stream must be back in sync by the next clean frame');
});

check('the synth kind rides through the header', () => {
  const st = new S.YaesuScopeStream();
  let kind = null;
  st.on('frame', (fr) => { kind = fr.kind; });
  st.feed(wire([S.buildScopeFrame({})], 1));
  assert.strictEqual(kind, 1);
});

section('Downsampling for a small screen keeps the peaks');

check('a single-bin carrier survives an 850 → 200 reduction', () => {
  const bins = new Uint8Array(850);
  bins[423] = 250;
  const out = S.downsampleBins(bins, 200);
  assert.strictEqual(out.length, 200);
  assert.strictEqual(Math.max(...out), 250);
});

check('width larger than the source is clamped', () => {
  const out = S.downsampleBins(new Uint8Array(850).fill(3), 5000);
  assert.strictEqual(out.length, 850);
});

section('Display noise floor (the first FT-710 owner\'s request)');

const Axis = require('../lib/scope-axis');

check('floor 0 returns the bins untouched', () => {
  const b = new Uint8Array([0, 10, 100, 255]);
  assert.strictEqual(Axis.applyFloor(b, 0), b);
});

check('levels at or below the floor go black, the rest stretches back to full scale', () => {
  const out = Axis.applyFloor(new Uint8Array([0, 50, 51, 153, 255]), 51);
  assert.strictEqual(out[0], 0);
  assert.strictEqual(out[1], 0);
  assert.strictEqual(out[2], 0);
  assert.strictEqual(out[3], 128, '153 is half way from the floor to full scale');
  assert.strictEqual(out[4], 255, 'full scale stays full scale');
});

check('the floor is clamped so a stray value cannot divide by zero', () => {
  const out = Axis.applyFloor(new Uint8Array([255]), 9999);
  assert.strictEqual(out[0], 255);
  assert.strictEqual(Axis.applyFloor(new Uint8Array([200]), -5)[0], 200);
});

section('Tap snapping — one rule for every client');

check('the step follows the span: 10 / 50 / 100 / 500 Hz', () => {
  assert.strictEqual(Axis.snapTapHz(14074123, 10000), 14074120);
  assert.strictEqual(Axis.snapTapHz(14074123, 50000), 14074100);
  assert.strictEqual(Axis.snapTapHz(14074123, 200000), 14074100);
  assert.strictEqual(Axis.snapTapHz(14074249, 1000000), 14074000);
  assert.strictEqual(Axis.snapTapHz(14074251, 1000000), 14074500);
});

section('Mobile handoff follow-ups (2026-09-21)');

check('1. the remote scope-state is an explicit field list — never helperPath', () => {
  const mainSrc = readSrc(path.join(__dirname, '..', 'main.js'));
  // The function body only: the helpers after it talk about frames in their comments.
  const start = mainSrc.indexOf('function yaesuScopeRemotePayload');
  const fn = start < 0 ? '' : mainSrc.slice(start, mainSrc.indexOf('\n}', start) + 2);
  assert.ok(fn.length > 0, 'yaesuScopeRemotePayload missing');
  assert.ok(!/\.\.\.yaesuScopeState\b/.test(fn) && !/helperPath|frames|misaligned/.test(fn), 'remote payload must not spread the local state');
  assert.ok(mainSrc.includes('remoteServer.broadcastScopeState(yaesuScopeRemotePayload())'), 'broadcast must use the remote payload');
  assert.ok(!mainSrc.includes('remoteServer.broadcastScopeState(payload)'), 'the local payload must never go to the wire');
});

check('2. a client disconnect clears the remote subscription and stops an unwatched helper', () => {
  const mainSrc = readSrc(path.join(__dirname, '..', 'main.js'));
  const i = mainSrc.indexOf("remoteServer.on('client-disconnected'");
  assert.ok(i > 0);
  const body = mainSrc.slice(i, i + 900);
  assert.ok(body.includes('yaesuScopeRemoteWants = false'), 'flag not cleared on disconnect');
  assert.ok(body.includes("stopYaesuScope('ECHOCAT client disconnected')"), 'helper not stopped on disconnect');
});

check('3. a Guest Pass cannot turn SCU-LAN10 on, and is told why', () => {
  const serverSrc = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  const mainSrc = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(serverSrc.includes("this.emit('scope-enable-radio', { guest: !!ws._passSession })"));
  const i = mainSrc.indexOf("remoteServer.on('scope-enable-radio'");
  const body = mainSrc.slice(i, i + 1400);
  assert.ok(/if \(guest\)[\s\S]*YAESU_SCOPE_GUEST_DIAG[\s\S]*return;[\s\S]*yaesuScopeEnableOnRadio\(\);/.test(body), 'guest branch must refuse with the guest diag before the real enable');
  // ...and the card is a property of the SESSION, not the press: the remote
  // payload substitutes it whenever the honest card would ask for Enable,
  // so a QSY re-broadcast cannot un-say it (mobile review, 2026-09-21).
  const pay = mainSrc.slice(mainSrc.indexOf('function yaesuScopeRemotePayload'), mainSrc.indexOf('function yaesuScopeBroadcastState'));
  // One card per source: an Icom guest is told about the radio's scope, an FT-710 guest about SCU-LAN10.
  assert.ok(/yaesuScopeRemoteIsGuest && asksForEnable\) \? \(s\.source === 'icom' \? ICOM_SCOPE_GUEST_DIAG : YAESU_SCOPE_GUEST_DIAG\) : s\.diag/.test(pay), 'remote payload must substitute the guest diag for a guest session');
  assert.ok(serverSrc.includes("this.emit('scope-subscribe', { on: !!msg.on, guest: !!ws._passSession })"), 'subscribe must carry the guest flag');
  const d = mainSrc.indexOf("remoteServer.on('client-disconnected'");
  assert.ok(mainSrc.slice(d, d + 1000).includes('yaesuScopeRemoteIsGuest = false'), 'guest flag must clear on disconnect');
});

check('4. the synthetic signal advertises nativeScope on any rig and re-broadcasts rig state', () => {
  const mainSrc = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(mainSrc.includes("if (yaesuScopeSynth && !caps.nativeScope) caps.nativeScope = 'synthetic';"));
  const i = mainSrc.indexOf("ipcMain.on('scope-set-synth'");
  assert.ok(mainSrc.slice(i, i + 700).includes('broadcastRigState()'), 'rig state not re-broadcast when the switch flips');
});

section('CAT replies');

check('SS span reply → Hz', () => {
  const r = S.parseSsReply('SS0530000;');
  assert.deepStrictEqual({ p2: r.p2, p3: r.p3 }, { p2: 5, p3: '3' });
  assert.strictEqual(S.spanHzFromCode(r.p3), 10000);
  assert.strictEqual(S.spanHzFromCode('9'), 1000000);
  assert.strictEqual(S.spanHzFromCode('x'), null);
});

check('SS mode reply → anchor, including the hex A for W/F FIX NORMAL', () => {
  assert.strictEqual(S.modeFromCode(S.parseSsReply('SS0640000').p3).anchor, 'center');
  assert.strictEqual(S.modeFromCode('7').anchor, 'cursor');
  assert.strictEqual(S.modeFromCode('A').anchor, 'fix');
  assert.strictEqual(S.modeFromCode('a').anchor, 'fix');
  assert.strictEqual(S.modeFromCode('C'), null, 'C is neither set nor answered');
});

check('SS mode reply: the EXPAND answers 5/8/B (FT-710, 2026-10-22/27)', () => {
  // The radio answers 5/8/B for the modes set with 3/6/9; 8 and B used to
  // decode to nothing, leaving the anchor at center and click-to-tune on.
  for (const [code, anchor, setWith] of [['5', 'center', '3'], ['8', 'cursor', '6'], ['B', 'fix', '9']]) {
    const m = S.modeFromCode(S.parseSsReply('SS06' + code + '0000').p3);
    assert.deepStrictEqual({ anchor: m.anchor, display: m.display, expand: m.expand }, { anchor, display: 'W/F', expand: true }, code);
    // Set with 3/6/9, which decode to the same mode.
    assert.strictEqual(m.setWith, setWith, code);
    const set = S.modeFromCode(m.setWith);
    assert.deepStrictEqual({ anchor: set.anchor, display: set.display, expand: set.expand }, { anchor, display: 'W/F', expand: true }, setWith);
  }
  assert.strictEqual(S.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: S.modeFromCode('8').anchor }).known, false);
  assert.strictEqual(S.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: S.modeFromCode('B').anchor }).known, false);
});

check('SS speed reply → STOP is recognised', () => {
  assert.strictEqual(S.speedFromCode(S.parseSsReply('SS0050000').p3), 'STOP');
  assert.strictEqual(S.speedFromCode('2'), 'FAST1');
});

check('EX reply → menu and value', () => {
  assert.deepStrictEqual(S.parseExReply('EX0301261;'), { menu: '030126', value: '1' });
  assert.deepStrictEqual(S.parseExReply('EX0301260'), { menu: '030126', value: '0' });
  assert.strictEqual(S.parseExReply('FA014074000;'), null);
});

check('replies that are not SS are refused', () => {
  assert.strictEqual(S.parseSsReply('ST1;'), null);
  assert.strictEqual(S.parseSsReply(''), null);
  assert.strictEqual(S.parseSsReply(null), null);
});

check('SS sets carry P4-P7 as 0000; the FT-710 refuses the short SS056; (2026-10-29)', () => {
  assert.strictEqual(S.write.span('6'), 'SS0560000;');
  assert.strictEqual(S.write.mode('3'), 'SS0630000;');
  for (const code of Object.keys(S.SPAN_HZ_BY_CODE)) {
    assert.deepStrictEqual(S.parseSsReply(S.write.span(code)), { p2: 5, p3: code, rest: '0000' }, code);
  }
  for (const code of Object.keys(S.MODE_BY_CODE)) {
    assert.deepStrictEqual(S.parseSsReply(S.write.mode(code)), { p2: 6, p3: code, rest: '0000' }, code);
  }
});

section('Axis');

check('CENTER mode: VFO ± span/2, first bin at the low edge, last at the high edge', () => {
  const ax = S.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'center' });
  assert.ok(ax.known);
  assert.strictEqual(ax.startHz, 14069000);
  assert.strictEqual(ax.endHz, 14079000);
  assert.strictEqual(S.binToHz(ax, 0), 14069000);
  assert.ok(Math.abs(S.binToHz(ax, 849) - 14079000) < 1e-6);
  assert.ok(Math.abs(S.hzToBin(ax, 14074000) - 424.5) < 1e-9, 'the VFO sits mid-scope');
});

check('CURSOR and FIX modes are assumed, not known', () => {
  assert.strictEqual(S.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'cursor' }).known, false);
  assert.strictEqual(S.scopeAxis({ centerHz: 14074000, spanHz: 10000, anchor: 'fix' }).known, false);
});

check('PAN (a panadapter that reports its own centre and span) is known; one label for every screen', () => {
  assert.strictEqual(S.scopeAxis({ centerHz: 14100000, spanHz: 200000, anchor: 'pan' }).known, true);
  assert.strictEqual(S.scopeAxis({ centerHz: 0, spanHz: 200000, anchor: 'pan' }).known, false, 'no centre reported yet');
  const A = require('../lib/scope-axis');
  assert.strictEqual(A.anchorLabel('pan'), 'PANADAPTER');
  assert.strictEqual(A.anchorLabel('fix'), 'FIX (axis assumed)');
  assert.strictEqual(A.anchorLabel('center'), 'CENTER');
});

check('a frequency outside the window maps to null', () => {
  const ax = S.scopeAxis({ centerHz: 14074000, spanHz: 10000 });
  assert.strictEqual(S.hzToBin(ax, 14000000), null);
  assert.strictEqual(S.hzToBin(ax, 15000000), null);
});

check('no span yet → nothing is known and nothing maps', () => {
  const ax = S.scopeAxis({ centerHz: 14074000, spanHz: 0 });
  assert.strictEqual(ax.known, false);
  assert.strictEqual(S.hzToBin(ax, 14074000), null);
});

section('Helper exit codes say which piece is missing');

check('every documented code has a headline, and blockers carry an action', () => {
  for (const code of Object.keys(S.HELPER_EXIT)) {
    const d = S.describeHelperExit(Number(code));
    assert.ok(d.headline, `code ${code} has no headline`);
    if (d.severity === 'blocker') assert.ok(d.action, `blocker ${code} has no action`);
  }
});

check('the missing-library case names LibFT4222 and where to get it', () => {
  const d = S.describeHelperExit(2);
  assert.strictEqual(d.key, 'no-library');
  assert.ok(/LibFT4222/.test(d.headline));
  assert.ok(/ftdichip\.com/.test(d.action));
});

check('the silent-bridge case names the SCU-LAN10 menu item, not the dongle', () => {
  const d = S.describeHelperExit(5);
  assert.ok(/SCU-LAN10/.test(d.detail));
  assert.ok(/do not need the SCU-LAN10 box/i.test(d.detail));
  assert.ok(/EX0301261/.test(d.action));
});

check('a signal kill is informational, an unknown code is an error', () => {
  assert.strictEqual(S.describeHelperExit(null, { signal: 'SIGTERM' }).severity, 'info');
  assert.strictEqual(S.describeHelperExit(42).severity, 'error');
});

check('only a mid-stream read error is worth an automatic restart', () => {
  assert.ok(S.helperExitIsTransient(6));
  assert.ok(!S.helperExitIsTransient(2), 'a missing library does not fix itself');
  assert.ok(!S.helperExitIsTransient(5), 'a menu item does not flip itself');
});

section('Finding and launching the helper');

check('an explicit path wins, then packaged, then the two dev locations', () => {
  const list = S.helperPathCandidates({
    settings: { yaesuScopeHelperPath: '/x/helper' }, isPackaged: true,
    resourcesPath: '/res', appDir: '/app', platform: 'linux',
  });
  assert.deepStrictEqual(list.map((p) => p.replace(/\\/g, '/')), [
    '/x/helper', '/res/bin/yaesu-scope', '/app/assets/yaesu-scope/yaesu-scope', '/app/helpers/yaesu-scope/build/yaesu-scope',
  ]);
});

check('Windows gets the .exe', () => {
  const list = S.helperPathCandidates({ appDir: 'C:/app', platform: 'win32' });
  assert.ok(list.every((p) => p.endsWith('yaesu-scope.exe')));
});

check('fps is clamped and synth is opt-in', () => {
  assert.deepStrictEqual(S.helperArgs({ fps: 500 }), ['--fps', '60']);
  assert.deepStrictEqual(S.helperArgs({ fps: 0 }), ['--fps', '1']);
  assert.deepStrictEqual(S.helperArgs({ fps: 10, synth: true }), ['--fps', '10', '--synth']);
});

section('Source guards');

const helperSrc = readSrc(path.join(__dirname, '..', 'helpers', 'yaesu-scope', 'yaesu-scope.c'));

check('the helper opens the bridge by FTDI description "FT4222 A"', () => {
  assert.ok(helperSrc.includes('"FT4222 A"'));
});

check('the helper loads LibFT4222 at runtime rather than linking it', () => {
  assert.ok(/LoadLibrary|dlopen/.test(helperSrc), 'no dynamic load');
  assert.ok(!/#include\s*[<"](ftd2xx|LibFT4222|libft4222)\.h/.test(helperSrc), 'FTDI headers must not be required to build');
});

check('the helper exit codes match the JS table', () => {
  for (const [code, d] of Object.entries(S.HELPER_EXIT)) {
    if (code === '0') continue;
    const re = new RegExp(`EXIT_${d.key.toUpperCase().replace(/-/g, '_')}\\s*=?\\s*${code}\\b`);
    assert.ok(re.test(helperSrc), `helper does not define exit ${code} (${d.key})`);
  }
});

check('the helper uses the SPI setup the FT-710 bridge is known to accept', () => {
  // wfview's values, which the radio has been read with for years:
  // single-line SPI, clock/64, idle high, leading edge, slave select 1, 24 MHz.
  assert.ok(/SPI_IO_SINGLE\s*=\s*1/.test(helperSrc));
  assert.ok(/CLK_DIV_64\s*=\s*6/.test(helperSrc));
  assert.ok(/CLK_IDLE_HIGH\s*=\s*1/.test(helperSrc));
  assert.ok(/CLK_LEADING\s*=\s*0/.test(helperSrc));
  assert.ok(/SYS_CLK_24\s*=\s*1/.test(helperSrc));
});

section('Wiring guards (main, server, protocol, packaging)');

const mainSrc = readSrc(path.join(__dirname, '..', 'main.js'));
const serverSrc = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
const protoSrc = readSrc(path.join(__dirname, '..', 'lib', 'echocat-protocol.js'));
const pkg = JSON.parse(readSrc(path.join(__dirname, '..', 'package.json')));
const releaseYml = readSrc(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'));
const modelsSrc = readSrc(path.join(__dirname, '..', 'lib', 'rig-models.js'));

check('main.js decodes frames through lib/yaesu-scope.js and centres the axis from the ONE frequency sink', () => {
  assert.ok(mainSrc.includes("require('./lib/yaesu-scope')"));
  assert.ok(mainSrc.includes('new YaesuScope.YaesuScopeStream()'));
  // sendCatFrequency is where every QSY path funnels; the scope must hang off it, not off one caller.
  const i = mainSrc.indexOf("sstvPopoutWin.webContents.send('cat-frequency', hz);");
  assert.ok(i > 0 && mainSrc.slice(i, i + 400).includes('yaesuScopeNoteFrequency(hz)'));
});

check('the helper stops BEFORE the CAT link is torn down at quit (SCU-LAN10 restore needs the link)', () => {
  const stop = mainSrc.indexOf("stopYaesuScope('app quit')");
  const catDown = mainSrc.indexOf('cat.disconnect();', stop);
  assert.ok(stop > 0, 'gracefulCleanup does not stop the scope');
  assert.ok(catDown > stop, 'stopYaesuScope must run before cat.disconnect() in gracefulCleanup');
});

check('SCU-LAN10 is only ever CHANGED by the operator\'s button, and put back', () => {
  // The write comes from YaesuScope.scuLanEnablePlan, only after the radio reads OFF (#113 item 7).
  assert.strictEqual((mainSrc.match(/EX0301261;/g) || []).length, 0, 'main.js never sends EX0301261; itself');
  assert.strictEqual((mainSrc.match(/cat\.sendRaw\(plan\.write\)/g) || []).length, 1, 'exactly one place turns SCU-LAN10 on');
  assert.strictEqual(S.scuLanEnablePlan('0').write, 'EX0301261;');
  assert.ok(mainSrc.includes("cat.sendRaw('EX0301260;')"), 'and one place turns it back off');
  assert.ok(!/EX040101|EX040200/.test(mainSrc), 'the write-ups\' EX0401xx commands are MY CALL on this radio — never send them');
});

check('a start while the stopped helper still holds the FT4222 waits for its exit (Ride1226 tab switch)', () => {
  const start = mainSrc.slice(mainSrc.indexOf('function startYaesuScope() {'), mainSrc.indexOf('function stopYaesuScope(why) {'));
  assert.ok(/yaesuScopeStopping && yaesuScopeStopping\.exitCode === null[\s\S]{0,200}yaesuScopeStartAfterExit = true;[\s\S]{0,80}return;/.test(start), 'start must defer while the old helper lives');
  assert.ok(start.indexOf('yaesuScopeStopping &&') < start.indexOf('spawn(helperPath'), 'the wait comes before the spawn');
  const stop = mainSrc.slice(mainSrc.indexOf('function stopYaesuScope(why) {'), mainSrc.indexOf('function yaesuScopeOnFrame('));
  assert.ok(stop.includes('yaesuScopeStopping = proc;') && stop.includes("proc.once('exit'"), 'stop records the exiting helper');
  assert.ok(stop.includes("if (!proc || why === 'app quit') scuLanOff();"), 'SCU-LAN10 off at once on quit, after the exit otherwise');
});

check('the pop-out opener defines isMac locally (a ReferenceError here is a modal crash dialog)', () => {
  const i = mainSrc.indexOf('let openScopePopout = () => {');
  assert.ok(i > 0);
  assert.ok(mainSrc.slice(i, i + 300).includes("const isMac = process.platform === 'darwin';"));
});

check('the FT-710 model declares the scope transport and no other model does yet', () => {
  assert.strictEqual((modelsSrc.match(/nativeScope: 'yaesu-ft4222'/g) || []).length, 1);
});

check('ECHOCAT: capability, demux, broadcasts, and the frame stream kept out of the push log', () => {
  assert.ok(/capabilities: \[[^\]]*'scope'[^\]]*\]/.test(serverSrc), 'hello does not advertise scope');
  assert.ok(serverSrc.includes("case 'scope-subscribe':") && serverSrc.includes("case 'scope-enable-radio':"));
  assert.ok(serverSrc.includes('broadcastScopeFrame(payload)') && serverSrc.includes('broadcastScopeState(state)'));
  assert.ok(/PUSH_LOG_EXCLUDED = new Set\(\[[^\]]*'scope-frame'/.test(serverSrc), 'scope-frame would flood the connect-window log');
  assert.ok(serverSrc.includes("'scope-axis.js'"), 'the web page must inline lib/scope-axis.js');
  for (const t of ['scope-subscribe', 'scope-frame', 'scope-state', 'scope-enable-radio']) assert.ok(protoSrc.includes(`'${t}':`), `protocol lacks ${t}`);
});

check('the helper is staged into resources/bin by electron-builder and built by every release job', () => {
  const entry = (pkg.build.extraResources || []).find((e) => e.from === 'assets/yaesu-scope');
  assert.ok(entry && entry.to === 'bin', 'package.json extraResources lacks assets/yaesu-scope → bin');
  const builds = (releaseYml.match(/helpers\/yaesu-scope\/yaesu-scope\.c/g) || []).length;
  assert.strictEqual(builds, 5, `expected the helper compiled in 5 release jobs (win, mac×2, linux×2), found ${builds}`);
});

check('the idle CAT pause never fires while the band scope is watched (N8VCL: scope stuck on 75 m)', () => {
  const tick = mainSrc.slice(mainSrc.indexOf('function startIdlePauseTimer()'), mainSrc.indexOf('function stopIdlePauseTimer()'));
  assert.ok(/if \(yaesuScopeWanted\(\)\) return;/.test(tick), 'startIdlePauseTimer lacks the yaesuScopeWanted() guard');
  assert.ok(tick.indexOf('yaesuScopeWanted()') < tick.indexOf('cat.pausePolling()'), 'the guard must come before the pause');
});

// ── GitHub #126: the helper goes quiet and the desktop never notices ─────────
// ride1226's 2026-11-06 log (FT-710, ECHOCAT 1.5.4, desktop 1.13.10):
//   03:08:10.535 spawn → 03:08:10.758 frames flowing
//   03:08:43.782 Power off → 03:08:44.425 "20 consecutive read failures"
//   ...then NO "helper exited" line, and no restart after the 03:08:51
//   power-on; frames only came back after a new spawn at 03:09:27. The
//   02:31 log shows ECHOCAT subscribing with no spawn at all: startYaesuScope
//   returns at `if (yaesuScopeProc) return;` for a helper that sends nothing.
const T = (hms) => { const [h, m, s] = hms.split(':'); return ((+h * 60 + +m) * 60 + +s) * 1000; };

check('#126: the helper\'s read-failure line is recognised as fatal', () => {
  assert.strictEqual(typeof S.isHelperFatalLine, 'function');
  assert.ok(S.isHelperFatalLine('yaesu-scope: 20 consecutive read failures (status 10, got 0 bytes)'));
  assert.ok(!S.isHelperFatalLine('yaesu-scope: opened "FT4222 A" — SPI single, 24 MHz/64, idle high, leading edge, SS1'));
  assert.ok(!S.isHelperFatalLine(''));
});

check('#126: a helper that reported the bridge lost and did not exit is stalled (ride1226 03:08:44)', () => {
  assert.strictEqual(typeof S.helperStallReason, 'function');
  const base = { spawnedAt: T('03:08:10.535'), lastFrameAt: T('03:08:43.700'), fatalAt: T('03:08:44.425') };
  assert.strictEqual(S.helperStallReason({ ...base, now: T('03:08:45.000') }), null, 'give it a moment to exit on its own');
  assert.ok(S.helperStallReason({ ...base, now: T('03:08:48.000') }), 'still alive 3.5 s after its fatal line');
});

check('#126: a helper that was streaming and went silent is stalled; a healthy or just-started one is not', () => {
  const live = { spawnedAt: T('03:08:10.535'), lastFrameAt: T('03:08:43.700'), fatalAt: 0 };
  assert.strictEqual(S.helperStallReason({ ...live, now: T('03:08:44.000') }), null);
  assert.strictEqual(S.helperStallReason({ ...live, now: T('03:08:50.000') }), null, 'a few quiet seconds are not a stall');
  assert.ok(S.helperStallReason({ ...live, now: T('03:09:00.000') }), '16 s with no frame at all');
  // Never streamed yet: the helper's own first-frame timeout decides (exit 5/7).
  assert.strictEqual(S.helperStallReason({ spawnedAt: T('03:08:10.535'), lastFrameAt: 0, fatalAt: 0, now: T('03:08:40.000') }), null);
});

check('#126: "no FT4222 device" right after the radio powers back on is retried; otherwise it stays a blocker', () => {
  assert.strictEqual(typeof S.helperExitShouldRetry, 'function');
  assert.strictEqual(S.helperExitShouldRetry(6, {}), true, 'read error was always transient');
  assert.strictEqual(S.helperExitShouldRetry(3, {}), false, 'no device with no power event: the SCU-LAN10/driver card');
  assert.strictEqual(S.helperExitShouldRetry(3, { sinceRadioBackMs: 4000 }), true, 'the FT4222 enumerates seconds after PS1');
  assert.strictEqual(S.helperExitShouldRetry(3, { sinceRadioBackMs: 60000 }), false);
  assert.strictEqual(S.helperExitShouldRetry(2, { sinceRadioBackMs: 1000 }), false, 'a missing library is not fixed by power');
});

check('#126: main.js supervises the helper — kills a stalled one and restarts it as a transient exit', () => {
  const start = mainSrc.slice(mainSrc.indexOf('function startYaesuScope()'), mainSrc.indexOf('function stopYaesuScope('));
  assert.ok(start.includes('YaesuScope.helperFatalExitCode(yaesuScopeStderr)'), 'stderr fatal line not noted (on the whole stderr, a chunk can cut a line)');
  assert.ok(start.includes('YaesuScope.helperExitShouldRetry('), 'exit handler must use helperExitShouldRetry');
  assert.ok(/_stalled/.test(start), 'a killed-for-stall helper must restart, not read as a clean stop');
  assert.ok(mainSrc.includes('YaesuScope.helperStallReason('), 'no watchdog calls helperStallReason');
});

// #320 (ride1226 2026-11-10, FT-710): the scope was opened with the radio off;
// the helper printed "could not open" and returned 3 but stayed alive until
// Retry closed its stdin (14:44:02 to 14:44:58), so the power-on restart at
// 14:44:05 found it running and did nothing.
check('#320: a helper that said "could not open" and has not exited is killed and read as exit 3', () => {
  const said = 'yaesu-scope: could not open "FT4222 A" (FT_STATUS 2) — radio off, not on this USB port, driver missing, or another program has it\n';
  assert.strictEqual(S.helperFatalExitCode(said), 3);
  assert.strictEqual(S.helperFatalExitCode('yaesu-scope: 20 consecutive read failures (status 10, got 0 bytes)\n'), 6);
  assert.strictEqual(S.helperFatalExitCode('yaesu-scope: opened "FT4222 A" — SPI single'), 0);
  assert.strictEqual(S.helperFatalExitCode(''), 0);
  // Two pipe chunks, as ride1226's log printed them: judged on the whole stderr.
  assert.strictEqual(S.helperFatalExitCode('yaesu-scope: 20 consecutive read failures (s' + 'tatus 10, got 0 bytes)'), 6);
  assert.ok(S.isHelperFatalLine(said), 'an open failure is a line the helper exits after');
  const fatalAt = T('14:44:02.918');
  assert.strictEqual(S.helperStallReason({ now: T('14:44:04.000'), fatalAt, fatalCode: 3 }), null, 'a moment to exit on its own');
  const why = S.helperStallReason({ now: T('14:44:06.000'), fatalAt, fatalCode: 3 });
  assert.ok(/could not open the bridge/.test(why), why);
  assert.ok(/reported the bridge lost/.test(S.helperStallReason({ now: T('14:44:06.000'), fatalAt })), 'read failures keep their wording');
  // The kill reads as 3, which is retried only while the radio is coming back:
  // power-on at 14:44:05.863, kill about 3 s after the line.
  assert.strictEqual(S.helperExitShouldRetry(3, { sinceRadioBackMs: 1000 }), true);
  const start = mainSrc.slice(mainSrc.indexOf('function startYaesuScope()'), mainSrc.indexOf('function stopYaesuScope('));
  assert.ok(start.includes('code = proc._fatalCode || 6'), 'a watchdog kill reads as the exit its last line named');
  assert.ok(start.includes('fatalCode: proc._fatalCode'), 'the watchdog says which fault');
  assert.ok(/if \(proc\._fatalCode !== 3\) yaesuScopeStallKills\+\+/.test(start), 'a failed open spends the ordinary budget, not the stall budget');
});

check('#320: the Windows helper reads its stdin with ReadFile, so exit() is never stuck behind the C runtime stdin lock', () => {
  const c = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'yaesu-scope', 'yaesu-scope.c'), 'utf8');
  const win = c.slice(c.indexOf('static unsigned __stdcall stdin_watch('), c.indexOf('static void start_stdin_watch(void) { _beginthreadex'));
  assert.ok(win.includes('ReadFile(GetStdHandle(STD_INPUT_HANDLE)'), 'the watcher reads the raw handle');
  assert.ok(!/fread\(/.test(win), 'fread holds the CRT stdin lock that exit() flushes under');
});

check('#126: the scope restarts when the radio comes back (power-on, link restored), not only on Retry', () => {
  const fn = mainSrc.indexOf('function yaesuScopeNoteRadioBack(');
  assert.ok(fn > 0, 'yaesuScopeNoteRadioBack missing');
  const powerOn = mainSrc.slice(mainSrc.indexOf("case 'power-on': {"), mainSrc.indexOf("case 'power-off': {"));
  assert.ok(powerOn.includes('yaesuScopeNoteRadioBack('), 'power-on does not tell the scope');
  const restored = mainSrc.indexOf("sendCatLog('[CAT] Radio link restored.');");
  assert.ok(mainSrc.slice(restored, restored + 400).includes('yaesuScopeNoteRadioBack('), 'link restored does not tell the scope');
});

check('#126: no silence verdict while transmitting — the FT-710 may pause its scope in TX', () => {
  const live = { lastFrameAt: T('03:08:43.700'), fatalAt: 0 };
  assert.strictEqual(S.helperStallReason({ ...live, now: T('03:09:30.000'), transmitting: true }), null, 'a long over or tune is not a stall');
  // The fatal-line rule is not TX-gated: a helper that said the bridge is gone is gone.
  assert.ok(S.helperStallReason({ lastFrameAt: T('03:08:43.700'), fatalAt: T('03:08:44.425'), now: T('03:08:48.000'), transmitting: true }));
});

check('#126: no silence verdict within the post-TX grace, and the 15 s clock restarts at TX end', () => {
  const lastFrameAt = T('03:08:00.000');
  const lastTxEndAt = T('03:09:00.000');           // a 60 s over, frames paused throughout
  assert.strictEqual(S.helperStallReason({ now: T('03:09:03.000'), lastFrameAt, lastTxEndAt }), null, 'inside the 5 s grace');
  assert.strictEqual(S.helperStallReason({ now: T('03:09:10.000'), lastFrameAt, lastTxEndAt }), null, '10 s after TX end: clock restarted at key-up');
  assert.ok(S.helperStallReason({ now: T('03:09:16.000'), lastFrameAt, lastTxEndAt }), '16 s after key-up with still no frame');
});

check('#126: the watchdog-kill budget resets after a healthy minute of streaming', () => {
  assert.strictEqual(typeof S.stallKillsAfterHealthy, 'function');
  assert.strictEqual(S.stallKillsAfterHealthy({ kills: 3, streamingSince: T('03:00:00.000'), now: T('03:00:30.000') }), 3, '30 s is not long enough');
  assert.strictEqual(S.stallKillsAfterHealthy({ kills: 3, streamingSince: T('03:00:00.000'), now: T('03:01:00.000') }), 0, 'a healthy minute clears it');
  assert.strictEqual(S.stallKillsAfterHealthy({ kills: 3, streamingSince: 0, now: T('03:01:00.000') }), 3, 'not streaming: nothing to reset');
});

check('#126: main.js feeds TX state into the watchdog and keeps a separate kill budget', () => {
  const start = mainSrc.slice(mainSrc.indexOf('function startYaesuScope()'), mainSrc.indexOf('function stopYaesuScope('));
  assert.ok(/transmitting:\s*\w+/.test(start) && start.includes('lastTxEndAt'), 'helperStallReason gets no TX input');
  assert.ok(start.includes('yaesuScopeTxNow()'), 'the watchdog does not read the TX state');
  assert.ok(start.includes('YaesuScope.stallKillsAfterHealthy('), 'kill budget never resets');
  assert.ok(/yaesuScopeStallKills\s*</.test(start), 'stall restarts are not bounded by their own budget');
  const at = mainSrc.indexOf('function yaesuScopeTxNow(');
  assert.ok(at > 0, 'yaesuScopeTxNow missing');
  const tx = mainSrc.slice(at, at + 400);
  assert.ok(tx.includes('_isEffectivelyTransmitting()') && tx.includes('cat._transmitting'), 'TX state must cover desktop/ECHOCAT PTT, CW and the rig-reported TX');
});

check('#126: every stop and every silent start says why in the log', () => {
  const stop = mainSrc.slice(mainSrc.indexOf('function stopYaesuScope('), mainSrc.indexOf('function yaesuScopeOnFrame('));
  assert.ok(/sendCatLog\('\[Scope\] stop/.test(stop), 'stopYaesuScope logs nothing about why');
  const start = mainSrc.slice(mainSrc.indexOf('function startYaesuScope()'), mainSrc.indexOf('function stopYaesuScope('));
  const at = start.indexOf('if (yaesuScopeProc)');
  assert.ok(start.slice(at, at + 400).includes('sendCatLog('), 'start with a helper already running returns silently');
  const sub = mainSrc.slice(mainSrc.indexOf("remoteServer.on('scope-subscribe'"), mainSrc.indexOf("remoteServer.on('scope-digital-view'"));
  assert.ok(sub.includes('sendCatLog('), 'ECHOCAT scope-subscribe is not logged');
});

console.log('\n' + '='.repeat(52));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('All tests passed.');
