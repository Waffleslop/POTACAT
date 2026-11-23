#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// #712: the call in progress goes to N3FJP's entry window (its lookup and
// dupe check), not only the logged contact. Commands from N3FJP's API page,
// https://www.n3fjp.com/help/api.html: UPDATE TXTENTRYCALL writes the Call
// box, ACTION CALLTAB tabs out of it, ACTION CLEAR empties the window. This
// path never logs (no ENTER, no ADDADIFRECORD).
// Run: node test/n3fjp-call-in-progress-test.js
const assert = require('assert');
const path = require('path');
const C = require('../lib/n3fjp-call-in-progress');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const root = path.join(__dirname, '..');
const src = (f) => readSrc(path.join(root, f)).replace(/\r\n/g, '\n');
const main = src('main.js');
const app = src('renderer/app.js');
const preload = src('preload.js');
const html = src('renderer/index.html');

/** A fake clock + timers, so the debounce runs without waiting. */
function rig(opts = {}) {
  let t = 1000000;
  let timers = [];
  let id = 0;
  const sent = [];
  const state = { enabled: opts.enabled !== false, fail: false, skip: false };
  const cip = new C.CallInProgress({
    isEnabled: () => state.enabled,
    send: (job) => { sent.push(job); if (state.fail) return Promise.reject(new Error('ECONNREFUSED')); return Promise.resolve(state.skip ? { skipped: true } : undefined); },
    now: () => t,
    setTimer: (fn, ms) => { const h = { id: ++id, at: t + ms, fn }; timers.push(h); return h; },
    clearTimer: (h) => { timers = timers.filter(x => x !== h); },
  });
  const advance = async (ms) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
      await new Promise(r => setImmediate(r));
    }
    t = end;
    await new Promise(r => setImmediate(r));
  };
  return { cip, sent, state, advance, calls: () => sent.filter(j => j.kind === 'call').map(j => j.call) };
}

// --- The command text, against N3FJP's API page ---

test('the call goes in as UPDATE TXTENTRYCALL then ACTION CALLTAB, each ended with CR+LF', () => {
  assert.deepStrictEqual(C.callCommands('w1aw'), [
    '<CMD><UPDATE><CONTROL>TXTENTRYCALL</CONTROL><VALUE>W1AW</VALUE></CMD>\r\n',
    '<CMD><ACTION><VALUE>CALLTAB</VALUE></CMD>\r\n',
  ]);
  assert.deepStrictEqual(C.clearCommands(), ['<CMD><ACTION><VALUE>CLEAR</VALUE></CMD>\r\n']);
});

test('nothing on this path logs: no ENTER, no ADDADIFRECORD', () => {
  const all = C.callCommands('K3SBP/P').concat(C.clearCommands()).join('');
  assert.ok(!/ENTER\b/.test(all.replace(/TXTENTRYCALL/g, '')));
  assert.ok(!/ADDADIFRECORD/.test(all));
  const lib = src('lib/n3fjp-call-in-progress.js').replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/<VALUE>ENTER</.test(lib) && !/ADDADIFRECORD/.test(lib), 'the module builds no logging command');
});

test('only a whole call is sent; a partial, a comma list or markup is cleaned or dropped', () => {
  assert.strictEqual(C.cleanCall(' k3sbp '), 'K3SBP');
  assert.strictEqual(C.cleanCall('VE3/K3SBP/P'), 'VE3/K3SBP/P');
  assert.strictEqual(C.cleanCall('K3SBP, W1AW'), 'K3SBP');
  assert.strictEqual(C.cleanCall('K3'), '');
  assert.strictEqual(C.cleanCall('KKK'), '');
  assert.strictEqual(C.cleanCall('W1AW</VALUE>'), '');
  assert.strictEqual(C.cleanCall(''), '');
  assert.deepStrictEqual(C.callCommands('K3'), []);
});

// --- The setting ---

test('wanted only with the setting on, logbook sending on, and the logbook N3FJP', () => {
  assert.strictEqual(C.wanted({ n3fjpCallInProgress: true, sendToLogbook: true, logbookType: 'n3fjp' }), true);
  assert.strictEqual(C.wanted({ sendToLogbook: true, logbookType: 'n3fjp' }), false, 'default is off');
  assert.strictEqual(C.wanted({ n3fjpCallInProgress: true, sendToLogbook: false, logbookType: 'n3fjp' }), false);
  assert.strictEqual(C.wanted({ n3fjpCallInProgress: true, sendToLogbook: true, logbookType: 'log4om' }), false);
  assert.strictEqual(C.wanted(null), false);
});

test('off sends nothing', async () => {
  const r = rig({ enabled: false });
  r.cip.note('W1AW', 'spot');
  r.cip.note('K3SBP', 'typed');
  r.cip.note('N0CALL', 'jtcat');
  await r.advance(5000);
  assert.deepStrictEqual(r.sent, []);
});

test('turned off while a send waits: nothing goes', async () => {
  const r = rig();
  r.cip.note('W1AW', 'typed');
  r.state.enabled = false;
  await r.advance(5000);
  assert.deepStrictEqual(r.sent, []);
});

// --- The debounce ---

test('typing is debounced: one send of the finished call, after the pause', async () => {
  const r = rig();
  for (const part of ['K3S', 'K3SB', 'K3SBP']) { r.cip.note(part, 'typed'); await r.advance(200); }
  assert.deepStrictEqual(r.calls(), [], 'nothing while typing');
  await r.advance(C.TYPED_DELAY_MS);
  assert.deepStrictEqual(r.calls(), ['K3SBP']);
  assert.deepStrictEqual(r.sent[0].commands, C.callCommands('K3SBP'));
});

test('a pick goes sooner than typing, and only the latest of quick picks is sent', async () => {
  assert.ok(C.PICK_DELAY_MS < C.TYPED_DELAY_MS);
  const r = rig();
  r.cip.note('W1AW', 'spot');
  await r.advance(100);
  r.cip.note('K3SBP', 'spot');
  await r.advance(C.PICK_DELAY_MS);
  assert.deepStrictEqual(r.calls(), ['K3SBP']);
});

test('the same call is not sent twice in a row; a different one and back again is', async () => {
  const r = rig();
  r.cip.note('W1AW', 'jtcat'); await r.advance(1000);
  r.cip.note('W1AW', 'jtcat'); await r.advance(1000);
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  assert.deepStrictEqual(r.calls(), ['W1AW']);
  r.cip.note('K3SBP', 'spot'); await r.advance(1000);
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  assert.deepStrictEqual(r.calls(), ['W1AW', 'K3SBP', 'W1AW']);
});

test('typing away and back before the pause sends nothing new', async () => {
  const r = rig();
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  r.cip.note('W1AWX', 'typed'); await r.advance(100);
  r.cip.note('W1AW', 'typed'); await r.advance(2000);
  assert.deepStrictEqual(r.calls(), ['W1AW']);
});

// --- N3FJP not there ---

test('not connected sends nothing: after a refused connection nothing is tried for a while, quietly', async () => {
  const r = rig();
  r.state.fail = true;
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  assert.strictEqual(r.sent.length, 1, 'one quiet attempt');
  r.cip.note('K3SBP', 'spot'); await r.advance(1000);
  r.cip.note('N0CALL', 'typed'); await r.advance(2000);
  assert.strictEqual(r.sent.length, 1, 'nothing more while N3FJP is down');
  r.state.fail = false;
  await r.advance(C.DOWN_MS);
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  assert.deepStrictEqual(r.calls(), ['W1AW', 'W1AW'], 'tried again later, and the failed call was not counted as sent');
});

test('a failed QSO send or log pull also counts as not connected', async () => {
  const r = rig();
  r.cip.reachable(false);
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  assert.deepStrictEqual(r.sent, []);
  r.cip.reachable(true);
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  assert.deepStrictEqual(r.calls(), ['W1AW']);
});

test('a queued send that went stale reached nothing, so the call can go again', async () => {
  const r = rig();
  r.state.skip = true;
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  r.state.skip = false;
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  assert.deepStrictEqual(r.calls(), ['W1AW', 'W1AW']);
  assert.strictEqual(r.cip.isCurrent('w1aw'), true);
  assert.strictEqual(r.cip.isCurrent('K3SBP'), false);
});

// --- After the contact is logged ---

test('logging the call POTACAT put there clears N3FJP\'s entry window; another call is left alone', async () => {
  const r = rig();
  r.cip.note('W1AW', 'jtcat'); await r.advance(1000);
  assert.strictEqual(r.cip.logged('K3SBP'), false);
  assert.strictEqual(r.cip.logged('W1AW'), true);
  await r.advance(10);
  assert.deepStrictEqual(r.sent.map(j => j.kind), ['call', 'clear']);
  assert.deepStrictEqual(r.sent[1].commands, C.clearCommands());
});

test('the QSO\'s own late state (JTCAT 73) does not put a logged call back; a new spot pick does', async () => {
  const r = rig();
  r.cip.note('W1AW', 'jtcat'); await r.advance(1000);
  r.cip.logged('W1AW'); await r.advance(10);
  r.cip.note('W1AW', 'jtcat'); await r.advance(1000);
  r.cip.note('W1AW', 'typed'); await r.advance(1000);
  assert.deepStrictEqual(r.calls(), ['W1AW']);
  r.cip.note('W1AW', 'spot'); await r.advance(1000);
  assert.deepStrictEqual(r.calls(), ['W1AW', 'W1AW']);
});

test('a call logged before its debounced send went is not sent at all', async () => {
  const r = rig();
  r.cip.note('W1AW', 'typed');
  r.cip.logged('W1AW');
  await r.advance(5000);
  assert.deepStrictEqual(r.sent, []);
});

// --- Wiring ---

test('main: one CallInProgress, enabled by wanted(settings), sent through the one N3FJP queue', () => {
  assert.ok(/const N3fjpCip = require\('\.\/lib\/n3fjp-call-in-progress'\);/.test(main));
  const block = main.slice(main.indexOf('const n3fjpCip = new N3fjpCip.CallInProgress('), main.indexOf('const n3fjpCip = new N3fjpCip.CallInProgress(') + 900);
  assert.ok(block.length > 100, 'instance exists');
  assert.ok(/isEnabled: \(\) => N3fjpCip\.wanted\(settings\)/.test(block));
  assert.ok(/n3fjpQueue\(/.test(block), 'shares the queue with QSO sends and the pull');
  assert.ok(/!n3fjpCip\.isCurrent\(job\.call\)/.test(block), 'a stale call is skipped');
  assert.ok(/sendN3fjpCommands\(job\.commands/.test(block));
});

test('main: the socket writes only the commands it is given and does not wait 5 s on a closed N3FJP', () => {
  const fn = main.slice(main.indexOf('function sendN3fjpCommands('), main.indexOf('function sendN3fjpCommands(') + 1500);
  assert.ok(fn.length > 100);
  assert.ok(!/ADDADIFRECORD|ENTER/.test(fn));
  assert.ok(/sock\.setTimeout\(1500\)/.test(fn));
});

test('trigger: a call typed in any log field (log dialog, Log pop-out, banner, Activator, ECHOCAT) reaches it through setTypedCall', () => {
  const fn = main.slice(main.indexOf('function setTypedCall('), main.indexOf('function setTypedCall(') + 700);
  assert.ok(/n3fjpCip\.note\(now, 'typed'\)/.test(fn));
  // every typed-call field reports to setTypedCall
  assert.ok(/ipcMain\.on\('log-popout-callsign'[\s\S]{0,300}setTypedCall\(from, call\)/.test(main));
  assert.ok(/remoteServer\.on\('typed-call'[^\n]*setTypedCall\(/.test(main));
  for (const tag of ['main:log', 'main:banner', 'main:activator']) assert.ok(app.includes(`reportLogCallsign(`) && app.includes(`'${tag}'`), tag);
});

test('trigger: the JTCAT QSO partner, on the desktop and on ECHOCAT', () => {
  for (const name of ['function popoutBroadcastQso(', 'function remoteJtcatBroadcastQso(']) {
    const fn = main.slice(main.indexOf(name), main.indexOf(name) + 600);
    assert.ok(/n3fjpCip\.note\([^)]*\.call, 'jtcat'\)/.test(fn), name);
  }
});

test('trigger: a spot pick from the renderer, through one IPC and one preload entry', () => {
  assert.ok(/ipcMain\.on\('n3fjp-call-in-progress', \(_e, call\) => n3fjpCip\.note\(call, 'spot'\)\)/.test(main));
  assert.ok(/n3fjpCallInProgress: \(call\) => ipcRenderer\.send\('n3fjp-call-in-progress', call\)/.test(preload));
  assert.ok(/function n3fjpPick\(spot\)/.test(app));
});

test('trigger sites in the main window: row click, arrow keys, map popup, Bandspread, Log dialog', () => {
  const near = (anchor, len = 600) => { const i = app.indexOf(anchor); assert.ok(i >= 0, anchor); return app.slice(i, i + len); };
  // spot table row click
  assert.ok(/n3fjpPick\(s\)/.test(near('// A normal (single) click is a tune action')), 'row click');
  // arrow-key step through the table
  assert.ok(/n3fjpPick\(spot\)/.test(near("if (!isSpotSkipped(filtered[idx])) { spot = filtered[idx]; break; }")), 'arrow keys');
  // map popup Tune
  assert.ok(/n3fjpPick\(match\)/.test(near("container.querySelectorAll('.tune-btn')", 1000)), 'map popup');
  // Bandspread click
  assert.ok(/n3fjpPick\(match\)/.test(near('window.api.onBandspreadTunedSpot((payload)', 700)), 'bandspread');
  // Log dialog opened on a station
  assert.ok(/n3fjpPick\(spot\)/.test(near('function openLogPopup(spot) {', 400)), 'log dialog');
});

test('scan does not send: it is not the operator picking a station', () => {
  const i = app.indexOf('const spot = list[scanIndex];');
  assert.ok(i >= 0);
  assert.ok(!/n3fjpPick/.test(app.slice(i, i + 500)));
});

test('a QSO sent to N3FJP tells the module (clear after logging, reachability)', () => {
  const i = main.indexOf('function sendN3fjpTcp(');
  const b = main.slice(i, main.indexOf('function n3fjpQueue(', i));
  assert.ok(/n3fjpCip\.logged\(qsoData\.callsign\)/.test(b));
  assert.ok(/n3fjpCip\.reachable\(true\)/.test(b) && /n3fjpCip\.reachable\(false\)/.test(b));
});

// --- Settings UI ---

test('settings: a checkbox under the N3FJP options, loaded and saved, off unless ticked', () => {
  const box = html.slice(html.indexOf('<div id="logbook-n3fjp-config"'), html.indexOf('<div id="logbook-log4om-config"'));
  assert.ok(/<input type="checkbox" id="set-n3fjp-call-in-progress">\s*Send the call in progress to N3FJP/.test(box));
  assert.ok(/setN3fjpCallInProgress\.checked = s\.n3fjpCallInProgress === true/.test(app));
  assert.ok(/n3fjpCallInProgress: !!\(setN3fjpCallInProgress && setN3fjpCallInProgress\.checked\)/.test(app));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
