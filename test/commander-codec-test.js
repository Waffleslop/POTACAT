#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';
// DXLab Commander as a rig type. Commander's TCP interface ("Commander TCPIP
// Messages", dxlabsuite.com) is ADIF-framed and narrow: frequency, mode, split,
// PTT and CW text, plus `seqname`/`seqindex` to run a command sequence the
// operator built in Commander. The wire strings below are the examples that
// document prints, character for character.
//
// Run: node test/commander-codec-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { CommanderCodec, commanderMessage, khzText, hzFromReply } = require('../lib/codecs/commander-codec');
const CS = require('../lib/commander-sequences');
const RigFamily = require('../lib/rig-family');
const { GENERIC_CAPS, getModel, getTuneQuirks } = require('../lib/rig-models');
const { radioTypeFromCatTarget } = require('../lib/rig-setup-notes');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function codec(commander) {
  const writes = [];
  const model = { ...GENERIC_CAPS.commander, commander: commander || {} };
  const c = new CommanderCodec(model, (d) => { writes.push(String(d)); return true; });
  const events = [];
  for (const ev of ['frequency', 'frequencyOther', 'mode', 'split', 'ptt', 'log']) c.on(ev, (...a) => events.push([ev, ...a]));
  return { c, writes, events };
}

console.log('DXLab Commander rig type');

// --- the wire format, from the document's own examples ---

test('messages match the examples in the Commander document', () => {
  assert.strictEqual(commanderMessage('CmdSetFreq', [['xcvrfreq', '21230']]),
    '<command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230');
  assert.strictEqual(commanderMessage('CmdSetMode', [['1', 'CW']]),
    '<command:10>CmdSetMode<parameters:7><1:2>CW');
  assert.strictEqual(commanderMessage('CmdSplit', [['1', 'on']]), '<command:8>CmdSplit<parameters:7><1:2>on');
  assert.strictEqual(commanderMessage('CmdSplit', [['1', 'off']]), '<command:8>CmdSplit<parameters:8><1:3>off');
  assert.strictEqual(commanderMessage('CmdTX', []), '<command:5>CmdTX<parameters:0>');
  assert.strictEqual(commanderMessage('CmdRX', []), '<command:5>CmdRX<parameters:0>');
  assert.strictEqual(commanderMessage('CmdGetFreq', []), '<command:10>CmdGetFreq<parameters:0>');
  assert.strictEqual(commanderMessage('seqindex', [['1', '0']]), '<command:8>seqindex<parameters:6><1:1>0');
  assert.strictEqual(commanderMessage('seqindex', [['1', '31']]), '<command:8>seqindex<parameters:7><1:2>31');
  // cwchars is the one command whose parameter is bare text.
  assert.strictEqual(commanderMessage('cwchars', 'testing de aa6yq'), '<command:7>cwchars<parameters:16>testing de aa6yq');
});

test('seqname is framed by its real length (the document prints 8 for a 7-letter command)', () => {
  assert.strictEqual(commanderMessage('seqname', [['1', 'NR']]), '<command:7>seqname<parameters:7><1:2>NR');
});

test('frequencies go out in kHz: whole kHz bare, a fraction in the rig\'s decimal style', () => {
  assert.strictEqual(khzText(14080000, '.'), '14080');
  assert.strictEqual(khzText(14074500, '.'), '14074.5');
  assert.strictEqual(khzText(14074500, ','), '14074,5');
  assert.strictEqual(khzText(7032100, '.'), '7032.1');
  assert.strictEqual(khzText(7032123, '.'), '7032.123');
  assert.strictEqual(hzFromReply('14,010.500'), 14010500);
  assert.strictEqual(hzFromReply('.000'), 0, 'a radio that has not reported its frequency');
});

// --- reading replies ---

test('a reply parses by its declared length, however the bytes arrive', () => {
  const { c, events } = codec();
  const reply = '<CmdFreq:10>14,010.500';
  c.onData(Buffer.from(reply.slice(0, 7)));
  c.onData(Buffer.from(reply.slice(7, 15)));
  assert.strictEqual(events.filter((e) => e[0] === 'frequency').length, 0, 'not complete yet');
  c.onData(Buffer.from(reply.slice(15)));
  assert.deepStrictEqual(events.filter((e) => e[0] === 'frequency'), [['frequency', 14010500]]);
});

test('several replies in one chunk, with junk between them, are all read', () => {
  const { c, events } = codec();
  c.onData(Buffer.from('xx<CmdFreq:10>14,010.500\r\n<CmdMode:2>CW<CmdTX:3>OFF<CmdSplit:2>ON'));
  assert.deepStrictEqual(events.filter((e) => e[0] !== 'log'), [
    ['frequency', 14010500], ['mode', 'CW'], ['ptt', false], ['split', true],
  ]);
});

test('unreported frequency (.000) and an empty mode are ignored, not emitted as zero', () => {
  const { c, events } = codec();
  c.onData('<CmdFreq:4>.000<CmdMode:0>');
  assert.deepStrictEqual(events, []);
});

test('Commander modes map to the tokens the rest of POTACAT already understands', () => {
  const { c, events } = codec();
  for (const m of ['CW-R', 'DATA-U', 'DATA-L', 'RTTY-R', 'WBFM', 'USB']) c.onData(`<CmdMode:${m.length}>${m}`);
  assert.deepStrictEqual(events.map((e) => e[1]), ['CWR', 'PKTUSB', 'PKTLSB', 'RTTYR', 'WFM', 'USB']);
});

test('the split TX frequency is reported only while split is on', () => {
  const { c, events } = codec();
  c.onData('<CmdTXFreq:10>14,011.500');
  assert.strictEqual(events.filter((e) => e[0] === 'frequencyOther').length, 0);
  c.onData('<CmdSplit:2>ON<CmdTXFreq:10>14,011.500');
  assert.deepStrictEqual(events.filter((e) => e[0] === 'frequencyOther'), [['frequencyOther', 14011500]]);
});

// --- sending ---

test('tune commands: frequency, and mode by POTACAT name (SSB picks the sideband by frequency)', () => {
  const { c, writes } = codec();
  c.setFrequency(14074000);
  c.setMode('FT8', 14074000);
  c.setMode('SSB', 7200000);
  c.setMode('SSB', 14250000);
  c.setMode('DIGL', 14074000);
  assert.deepStrictEqual(writes, [
    '<command:10>CmdSetFreq<parameters:17><xcvrfreq:5>14074',
    '<command:10>CmdSetMode<parameters:11><1:6>DATA-U',
    '<command:10>CmdSetMode<parameters:8><1:3>LSB',
    '<command:10>CmdSetMode<parameters:8><1:3>USB',
    '<command:10>CmdSetMode<parameters:11><1:6>DATA-L',
  ]);
});

test('a CW spot does not pull a rig out of CW-R', () => {
  const { c, writes } = codec();
  c.onData('<CmdMode:4>CW-R');
  c.setMode('CW', 14030000);
  assert.ok(/<1:4>CW-R$/.test(writes[0]), writes[0]);
});

test('PTT, split, CW text and the poll go out as Commander commands', () => {
  const { c, writes } = codec();
  c.setTransmit(true); c.setTransmit(false); c.setSplit(true); c.getVfoSplit();
  c.onData('<CmdSplit:2>ON');
  c.getVfoSplit();
  c.getFrequency(); c.getMode(); c.getPtt();
  c.sendCwText('CQ POTA\n');
  assert.deepStrictEqual(writes.map((w) => w.match(/>(\w+)</)[1]), [
    'CmdTX', 'CmdRX', 'CmdSplit', 'CmdSendSplit',
    'CmdSendSplit', 'CmdGetTXFreq', 'CmdGetFreq', 'CmdSendMode', 'CmdSendTX', 'cwchars',
  ]);
  assert.ok(writes[writes.length - 1].endsWith('<parameters:7>CQ POTA'), writes[writes.length - 1]);
});

test('a custom CAT command passes through only when it is a Commander message', () => {
  const { c, writes, events } = codec();
  c.sendRaw('<command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230\n');
  assert.deepStrictEqual(writes, ['<command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230']);
  c.sendRaw('FA00014074000;');
  assert.strictEqual(writes.length, 1, 'a Kenwood string must not reach Commander');
  assert.ok(events.some((e) => e[0] === 'log' && /ADIF messages/.test(e[1])));
});

// --- the controls Commander only reaches through a user-defined sequence ---

test('a mapped control runs its Commander sequence, by name or by number', () => {
  const { c, writes } = codec({ sequences: { 'nb-on': 'NBON', 'nb-off': '#3', 'atu-tune': 'TUNE' } });
  assert.notStrictEqual(c.setNb(true), false);
  c.setNb(false);
  c.startTune();
  assert.deepStrictEqual(writes, [
    '<command:7>seqname<parameters:9><1:4>NBON',
    '<command:8>seqindex<parameters:6><1:1>2',
    '<command:7>seqname<parameters:9><1:4>TUNE',
  ]);
});

test('an unmapped control sends nothing, says so once, and returns false', () => {
  const { c, writes, events } = codec();
  assert.strictEqual(c.setNoiseReduction(true), false);
  assert.strictEqual(c.setNoiseReduction(false), false);
  assert.strictEqual(c.setCompressor(true), false);
  assert.deepStrictEqual(writes, []);
  const warned = events.filter((e) => e[0] === 'log' && /Noise reduction/.test(e[1]));
  assert.strictEqual(warned.length, 1, 'the warning is not repeated');
});

test('controls Commander has no command for never write anything', () => {
  const { c, writes } = codec();
  c.setRfGain(50); c.setTxPower(50); c.setFilterWidth(500); c.setVfo('B'); c.swapVfo(); c.setCwSpeed(20);
  c.vfoCopyAB(); c.vfoCopyBA(); c.stopTune(); c.setPowerState(true);
  assert.deepStrictEqual(writes, []);
});

test('sequence slots: a toggle unlocks only when both its on and off are named', () => {
  assert.deepStrictEqual(CS.capsFromSequences({ 'nb-on': 'A' }), {});
  assert.deepStrictEqual(CS.capsFromSequences({ 'nb-on': 'A', 'nb-off': 'B', 'atu-tune': 'T', 'power-off': 'X' }),
    { nb: true, atu: true, power: true });
  assert.deepStrictEqual(CS.capsFromSequences({ 'nb-on': '  ', 'nb-off': '' }), {});
  assert.deepStrictEqual(CS.capsFromSequences(null), {});
  assert.strictEqual(CS.sequenceRef('#0'), null, 'Commander numbers its sequences from 1');
  assert.strictEqual(CS.sequenceRef('#33'), null);
  assert.deepStrictEqual(CS.sequenceRef(' #1 '), { command: 'seqindex', value: '0' });
});

// --- the rig type end to end ---

test('the type maps consistently: radio "dxlab-commander" <-> catTarget <-> family "commander"', () => {
  assert.strictEqual(RigFamily.familyFromRadioType('dxlab-commander'), 'commander');
  assert.strictEqual(RigFamily.familyFromCatTarget({ type: 'dxlab-commander' }), 'commander');
  assert.strictEqual(RigFamily.rigFamily({ catTarget: { type: 'dxlab-commander', host: '127.0.0.1', port: 52002 } }), 'commander');
  assert.strictEqual(radioTypeFromCatTarget({ type: 'dxlab-commander' }), 'dxlab-commander');
  assert.deepStrictEqual(RigFamily.audioSourcesFor('commander').map((o) => o.value), ['dax'], 'a local sound card only');
});

test('the model starts with no panel controls, keeps split, and hides what Commander cannot do', () => {
  const m = getModel(null, 'commander');
  assert.strictEqual(m.protocol, 'commander');
  assert.strictEqual(m.caps.split, true);
  for (const k of ['nb', 'atu', 'rfgain', 'txpower', 'filter', 'power', 'vfo']) assert.ok(!m.caps[k], `caps.${k} must be off`);
  assert.deepStrictEqual(getTuneQuirks(m), m.tune);
  assert.strictEqual(m.tune.modeAfterFreq, false, 'no band-recall resend');
});

test('RigController drives the codec: poll reads, tune sends mode then frequency, mapped controls work', async () => {
  const transport = new EventEmitter();
  const writes = [];
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = (d) => { writes.push(String(d)); return true; };
  const model = { ...GENERIC_CAPS.commander, commander: { sequences: { 'atu-tune': 'TUNE' } } };
  const cdc = new CommanderCodec(model, (d) => transport.write(d));
  const rig = new RigController(model, transport, cdc);
  rig.connected = true;
  rig._target = { host: '127.0.0.1', port: 52002 };
  rig._lastReadOkMs = Date.now();
  const got = [];
  rig.on('frequency', (hz) => got.push(['f', hz]));
  rig.on('mode', (m) => got.push(['m', m]));
  rig._startPolling();
  await new Promise((r) => setTimeout(r, 1100)); // the first poll tick lands one interval after the start
  rig._stopPolling();
  const names = () => writes.map((w) => w.match(/>(\w+)</)[1]);
  assert.ok(['CmdGetFreq', 'CmdSendMode', 'CmdSendTX', 'CmdSendSplit'].every((n) => names().includes(n)), 'polled: ' + names().join(','));
  transport.emit('data', Buffer.from('<CmdFreq:10>14,074.000<CmdMode:6>DATA-U'));
  assert.deepStrictEqual(got, [['f', 14074000], ['m', 'PKTUSB']]);

  writes.length = 0;
  rig.tune(7200000, 'SSB', {});
  await new Promise((r) => setTimeout(r, 450));
  rig._stopPolling();
  rig.disconnect();
  const tuned = writes.filter((w) => /CmdSet(Mode|Freq)/.test(w));
  assert.deepStrictEqual(tuned, [
    '<command:10>CmdSetMode<parameters:8><1:3>LSB',
    '<command:10>CmdSetFreq<parameters:16><xcvrfreq:4>7200',
  ], 'one mode, one frequency, nothing resent');
});

test('RigController survives every unguarded control on a Commander rig (nothing throws, nothing is sent)', () => {
  const transport = new EventEmitter();
  const writes = [];
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = (d) => { writes.push(String(d)); return true; };
  const model = { ...GENERIC_CAPS.commander, commander: {} };
  const rig = new RigController(model, transport, new CommanderCodec(model, (d) => transport.write(d)));
  rig.connected = true;
  const logs = [];
  rig.on('log', (m) => logs.push(m));
  rig.setNb(true); rig.setRfGain(40); rig.setTxPower(20); rig.setFilterWidth(500); rig.setVfo('B'); rig.swapVfo();
  rig.setPowerState(true); rig.startTune(); rig.stopTune(); rig.setAtuEnabled(true); rig.setAtuEnabled(false);
  rig.setNoiseReduction(true); rig.setAutoNotch(true); rig.setCompressor(true); rig.vfoCopyAB(); rig.vfoCopyBA();
  rig.setPreamp(true); rig.setAttenuator(true); rig.setAfGain(30);
  assert.deepStrictEqual(writes, []);
  assert.ok(logs.length > 0, 'the operator is told why nothing happened');
  rig.disconnect();
});

// --- wiring: every place the type has to be known ---

test('the type is wired through main, the rig editor and the welcome wizard', () => {
  const main = read('main.js');
  assert.ok(/target\.type === 'dxlab-commander'/.test(main), 'connectCat branch');
  assert.ok(/new CommanderCodec\(/.test(main));
  assert.ok(/rigType === 'commander'/.test(main), 'getActiveRigModel overlay');
  assert.ok(/target\.type === 'dxlab-commander'\) return 'commander'/.test(main), 'detectRigType');
  const html = read('renderer/index.html');
  assert.ok(/name="radio-type" value="dxlab-commander"/.test(html));
  assert.ok(/name="welcome-radio-type" value="dxlab-commander"/.test(html));
  assert.ok(/id="set-dxlab-commander-port"[^>]*value="52002"/.test(html), 'the editor defaults to 52002');
  assert.ok(/id="welcome-dxlab-commander-port"[^>]*value="52002"/.test(html), 'the wizard defaults to 52002');
  assert.ok(/commander-sequences\.js/.test(html), 'the renderer loads the shared slot table');
  const app = read('renderer/app.js');
  assert.ok(/radioType === 'dxlab-commander'/.test(app) && /type === 'dxlab-commander'/.test(app));
  assert.ok(/currentTarget\.type === 'dxlab-commander'/.test(app), 'the editor loads a saved Commander rig');
  assert.strictEqual(CS.DEFAULT_PORT, 52002);
});

test('the test is registered in the npm test chain and in CI', () => {
  assert.ok(read('scripts/run-tests.js').includes("'test/commander-codec-test.js'"), 'scripts/run-tests.js');
  assert.ok(read('.github/workflows/test.yml').includes('node test/commander-codec-test.js'), '.github/workflows/test.yml');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message || e).split('\n')[0]); }
  }
  console.log(`\nDXLab Commander: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
