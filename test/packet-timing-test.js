#!/usr/bin/env node
'use strict';
// GitHub #257 (NA4DQ, IC-7100 on rigctld, 1200-baud packet through the
// bundled Dire Wolf, 1.13.10): the gateway answered but the exchange failed.
//  - direwolf.conf hard-coded TXDELAY 300 ms and TXTAIL 10 (100 ms) with no
//    setting; a CAT-keyed radio (Dire Wolf -> shim -> rigctld -> CI-V) comes
//    on air well after Dire Wolf starts its preamble.
//  - after Dire Wolf's T 0, POTACAT held PTT another 250 ms before its own T 0.
//  - "Dire Wolf decoded nothing" was logged after Pat had logged
//    "Connected to KJ4AJP-10", which needs a decoded UA.
// Run: node test/packet-timing-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const D = require('../lib/direwolf-process');
const S = require('../lib/ptt-mode-swap');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const html = readSrc(path.join(root, 'renderer', 'index.html'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0;
  const j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}
const conf = (o) => D.buildDirewolfConfig({ mycall: 'NA4DQ', audioPort: 51234, shimPort: 4540, ...o }).split('\n');

console.log('direwolf.conf TX timing');
test('defaults are the reporter\'s working values: TXDELAY 500 ms, TXTAIL 200 ms', () => {
  assert.strictEqual(D.DIREWOLF_DEFAULTS.txDelayMs, 500);
  assert.strictEqual(D.DIREWOLF_DEFAULTS.txTailMs, 200);
  const lines = conf({});
  assert.ok(lines.includes('TXDELAY 50'), 'TXDELAY is in 10 ms units');
  assert.ok(lines.includes('TXTAIL 20'));
  assert.ok(!lines.includes('TXTAIL 10'), 'the old hard-coded tail is gone');
});
test('a setting overrides both', () => {
  const lines = conf({ txDelayMs: 800, txTailMs: 300 });
  assert.ok(lines.includes('TXDELAY 80') && lines.includes('TXTAIL 30'));
  assert.strictEqual(lines.filter((l) => /^TXDELAY /.test(l)).length, 1);
  assert.strictEqual(lines.filter((l) => /^TXTAIL /.test(l)).length, 1);
});
test('TX delay is clamped to 50..1000 ms in 10 ms steps; blank or junk is the default', () => {
  assert.strictEqual(D.clampTxDelayMs(10), 50);
  assert.strictEqual(D.clampTxDelayMs(5000), 1000);
  assert.strictEqual(D.clampTxDelayMs(456), 460);
  for (const v of [undefined, null, '', 'abc', 0, -100, NaN]) assert.strictEqual(D.clampTxDelayMs(v), 500, String(v));
  assert.strictEqual(D.clampTxDelayMs('700'), 700, 'a string from a settings file');
});
test('TX tail is clamped to 10..500 ms in 10 ms steps; blank or junk is the default', () => {
  assert.strictEqual(D.clampTxTailMs(3), 10);
  assert.strictEqual(D.clampTxTailMs(9999), 500);
  assert.strictEqual(D.clampTxTailMs(144), 140);
  for (const v of [undefined, null, '', 'abc', 0, -5]) assert.strictEqual(D.clampTxTailMs(v), 200, String(v));
  assert.ok(conf({ txDelayMs: 1e6, txTailMs: 1e6 }).includes('TXDELAY 100'));
  assert.ok(conf({ txDelayMs: 1e6, txTailMs: 1e6 }).includes('TXTAIL 50'));
});
test('packetTiming reads the profile settings', () => {
  assert.deepStrictEqual(D.packetTiming({}), { txDelayMs: 500, txTailMs: 200 });
  assert.deepStrictEqual(D.packetTiming(null), { txDelayMs: 500, txTailMs: 200 });
  assert.deepStrictEqual(D.packetTiming({ winlinkPacketTxDelayMs: 650, winlinkPacketTxTailMs: 150 }), { txDelayMs: 650, txTailMs: 150 });
});
test('spawnDirewolf passes the settings to the config and logs the values used', () => {
  const sd = main.slice(main.indexOf('async function spawnDirewolf('), main.indexOf('\nfunction killArdop'));
  assert.ok(/_direwolfTiming = DirewolfProcess\.packetTiming\(settings\);/.test(sd));
  assert.ok(/txDelayMs: _direwolfTiming\.txDelayMs, txTailMs: _direwolfTiming\.txTailMs/.test(sd));
  assert.ok(/winlinkLog\(`direwolf: TXDELAY \$\{_direwolfTiming\.txDelayMs\} ms, TXTAIL \$\{_direwolfTiming\.txTailMs\} ms/.test(sd));
  assert.ok(sd.indexOf('packetTiming(settings)') < sd.indexOf('buildDirewolfConfig('), 'computed before the config is written');
});

console.log('settings wiring (Settings > Station > Winlink)');
test('two number inputs beside Packet speed, in the Winlink fieldset on the Station tab, with a help line', () => {
  const fs = html.indexOf('id="winlink-fieldset"');
  const open = html.lastIndexOf('<fieldset', fs);
  assert.ok(/data-settings-tab="station"/.test(html.slice(open, fs + 30)));
  const end = html.indexOf('</fieldset>', fs);
  const box = html.slice(fs, end);
  assert.ok(box.includes('<legend>Winlink (email over radio)</legend>'));
  assert.ok(/Packet TX delay:\s*<input type="number" id="set-winlink-packet-txdelay" min="50" max="1000" step="10" value="500"/.test(box));
  assert.ok(/Packet TX tail:\s*<input type="number" id="set-winlink-packet-txtail" min="10" max="500" step="10" value="200"/.test(box));
  assert.ok(box.indexOf('set-winlink-packet-modem') < box.indexOf('set-winlink-packet-txdelay'), 'next to Packet speed');
  assert.ok(/if the gateway misses your first frame[^<]*raise the TX delay/.test(box), 'the help line says when to raise it');
});
test('app.js loads and saves both through the normal settings object', () => {
  assert.ok(/const setWinlinkPacketTxDelay = document\.getElementById\('set-winlink-packet-txdelay'\);/.test(app));
  assert.ok(/const setWinlinkPacketTxTail = document\.getElementById\('set-winlink-packet-txtail'\);/.test(app));
  assert.ok(/setWinlinkPacketTxDelay\.value = packetTimingMs\(s\.winlinkPacketTxDelayMs, 500, 50, 1000\)/.test(app), 'loaded');
  assert.ok(/setWinlinkPacketTxTail\.value = packetTimingMs\(s\.winlinkPacketTxTailMs, 200, 10, 500\)/.test(app), 'loaded');
  assert.ok(/winlinkPacketTxDelayMs: packetTimingMs\(setWinlinkPacketTxDelay\.value, 500, 50, 1000\)/.test(app), 'saved');
  assert.ok(/winlinkPacketTxTailMs: packetTimingMs\(setWinlinkPacketTxTail\.value, 200, 10, 500\)/.test(app), 'saved');
});
test('the renderer clamps exactly as lib/direwolf-process.js does', () => {
  const body = fnBody(app, 'packetTimingMs');
  // eslint-disable-next-line no-new-func
  const packetTimingMs = new Function(`${body}; return packetTimingMs;`)();
  for (const v of ['', 'x', '0', '-3', '7', '45', '456', '1000', '1200', '9999']) {
    assert.strictEqual(packetTimingMs(v, 500, 50, 1000), D.clampTxDelayMs(v), `delay ${v}`);
    assert.strictEqual(packetTimingMs(v, 200, 10, 500), D.clampTxTailMs(v), `tail ${v}`);
  }
});
test('they are profile settings (per radio, like Packet speed), not machine-local', () => {
  const local = main.slice(main.indexOf("'winlinkPatPath',"), main.indexOf("'winlinkWaterfallShown',"));
  assert.ok(!/winlinkPacketTx/.test(local));
});

console.log('PTT hold after Dire Wolf unkeys');
test('packet: the hold is only the part of POTACAT\'s pipeline the TXTAIL does not cover', () => {
  assert.strictEqual(D.packetUnkeyDrainMs(250, 200), 50, 'sound-card bridge, default tail');
  assert.strictEqual(D.packetUnkeyDrainMs(120, 200), 0, 'Flex / Icom Network, default tail');
  assert.strictEqual(D.packetUnkeyDrainMs(250, 100), 150, 'a short tail keeps more of the hold');
  assert.strictEqual(D.packetUnkeyDrainMs(250, 10), 240);
  assert.strictEqual(D.packetUnkeyDrainMs(250, 0), 250, 'no tail: the full hold');
});
test('ARDOP / VARA / Mercury keep the full hold; only a packet session with Dire Wolf\'s timing shortens it', () => {
  assert.ok(/const WINLINK_UNKEY_DRAIN_BRIDGE_MS = 250;/.test(main), 'bridge hold unchanged');
  assert.ok(/const WINLINK_UNKEY_DRAIN_IP_MS = 120;/.test(main), 'IP hold unchanged');
  const f = fnBody(main, 'winlinkUnkeyDrainMs');
  // Run the function against fakes: mode decides, nothing else.
  // eslint-disable-next-line no-new-func
  const run = (mode, ip, timing) => new Function('winlinkIpAudioRoute', 'winlinkState', '_direwolfTiming', 'DirewolfProcess',
    'WINLINK_UNKEY_DRAIN_IP_MS', 'WINLINK_UNKEY_DRAIN_BRIDGE_MS', `${f}; return winlinkUnkeyDrainMs();`)(
    () => ip, { session: { mode } }, timing, D, 120, 250);
  const t = { txDelayMs: 500, txTailMs: 200 };
  assert.strictEqual(run('ardop', false, t), 250);
  assert.strictEqual(run('ardop', true, t), 120);
  assert.strictEqual(run('vara', false, t), 250);
  assert.strictEqual(run('varafm', false, t), 250);
  assert.strictEqual(run('mercury', false, t), 250);
  assert.strictEqual(run('packet', false, t), 50);
  assert.strictEqual(run('packet', true, t), 0);
  assert.strictEqual(run('packet', false, null), 250, 'no Dire Wolf timing known: the full hold');
});
test('the shim still schedules PTT-off through winlinkUnkeyDrainMs', () => {
  assert.ok(/_winlinkUnkeyTimer = setTimeout\(\(\) => \{ _winlinkUnkeyTimer = null; winlinkUnkeyNow\(\); \}, winlinkUnkeyDrainMs\(\)\);/.test(main));
});
test('rigctld: the T 0 is written the moment it is asked for, never queued behind a poll', () => {
  const out = [];
  const c = new RigctldCodec({ brand: 'Icom', model: 'IC-7100' }, (l) => out.push(l));
  c.getFrequency(); c.getMode(); c.setTransmit(false);
  assert.strictEqual(out[out.length - 1], 'T 0\n', 'written synchronously, after only what was already sent');
});

console.log('packet keys through the Winlink DATA hold (#187), not a per-over mode flip');
test('the shim keys every modem, packet included, as txKind winlink', () => {
  const shim = main.slice(main.indexOf('setPtt: (on) => {'), main.indexOf('function winlinkUnkeyNow('));
  assert.ok(/handleRemotePtt\(true, \{ audio: true, forceDataMode: icom, emission: 'DATA', txKind: 'winlink' \}\)/.test(shim));
  assert.ok(!/session\.mode === 'packet'/.test(shim), 'no packet-only branch around the key-down');
});
test('replay of the 22:10:45-22:11:59 attempt (15 overs from FM): one FM -> DIGFM, no "Restoring FM"', () => {
  assert.strictEqual(S.dataFormOf('FM'), 'DIGFM');
  let data = false;
  const cmds = [];
  for (let i = 0; i < 15; i++) {
    const plan = S.sessionDataPlan({ hold: true, inData: data });
    if (plan !== 'keep') { cmds.push('DIGFM'); data = true; }
    if (plan === 'switch-restore') { cmds.push('FM'); data = false; }
  }
  assert.deepStrictEqual(cmds, ['DIGFM']);
});

console.log('"Dire Wolf decoded nothing" never contradicts Pat');
test('the verdict: nothing on either count and no connect', () => {
  assert.strictEqual(D.packetDecodedNothing({ stdoutHeard: 0, monitorHeard: 0, patConnected: false }), true);
  assert.strictEqual(D.packetDecodedNothing({ stdoutHeard: 0, monitorHeard: 0, patConnected: true }), false, 'the 1.13.10 log');
  assert.strictEqual(D.packetDecodedNothing({ stdoutHeard: 2, monitorHeard: 0 }), false);
  assert.strictEqual(D.packetDecodedNothing({ stdoutHeard: 0, monitorHeard: 3 }), false);
  assert.strictEqual(D.packetDecodedNothing(), true);
});
test('Pat\'s connect line, as in the log; the dial and hang-up lines are not connects', () => {
  assert.strictEqual(D.patLineSaysConnected('2026/11/05 16:11:04 Connected to KJ4AJP-10 (AX.25)'), true);
  assert.strictEqual(D.patLineSaysConnected('2026/11/05 16:10:45 Connecting to KJ4AJP-10 (ax25+agwpe)...'), false);
  assert.strictEqual(D.patLineSaysConnected('2026/11/05 15:57:15 Unable to establish connection to remote: *** DISCONNECTED From Station KJ4AJP-10'), false);
  assert.strictEqual(D.patLineSaysConnected('2026/11/05 16:11:58 Exchange failed: connection lost'), false);
  assert.strictEqual(D.patLineSaysConnected('Disconnected to nowhere'), false);
});
test('main.js: the flag is cleared at session start, set from Pat\'s output, /ws log and status, and read by the verdict', () => {
  assert.ok(/_winlinkPatConnected = false;\n  if \(radio\) _winlinkPreviewReturnTo = null;/.test(fnBody(main, 'winlinkStartSession')), 'cleared per session');
  assert.ok(/winlinkLog\(`pat: \$\{line\}`\);\n\s*if \(DirewolfProcess\.patLineSaysConnected\(line\)\) _winlinkPatConnected = true;/.test(main), 'Pat stdout (where the 1.13.10 line came from)');
  const ev = fnBody(main, 'winlinkOnPatEvent');
  assert.ok(/if \(ev\.connected\) _winlinkPatConnected = true;/.test(ev), 'Pat /ws status');
  assert.ok(/if \(DirewolfProcess\.patLineSaysConnected\(ev\.text\)\) _winlinkPatConnected = true;/.test(ev), 'Pat /ws log line');
  assert.ok(/DirewolfProcess\.packetDecodedNothing\(\{ stdoutHeard: _direwolfHeard, monitorHeard: _direwolfMonitorHeard, patConnected: _winlinkPatConnected \}\)/.test(main));
});

console.log(`\npacket timing (#257): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
