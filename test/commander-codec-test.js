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
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { TcpTransport } = require('../lib/transport');
const {
  CommanderCodec, commanderModel, probeCommander, commanderMessage, readFields, checkMessage,
  khzText, hzFromReply, MAX_FIELD_LEN,
} = require('../lib/codecs/commander-codec');
const CS = require('../lib/commander-sequences');
const RigFamily = require('../lib/rig-family');
const { GENERIC_CAPS, RIG_MODELS, getModel, getTuneQuirks } = require('../lib/rig-models');
const { radioTypeFromCatTarget } = require('../lib/rig-setup-notes');
const { cwPaddleAvailability } = require('../lib/cw-paddle-availability');

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
  assert.deepStrictEqual(CS.capsFromSequences({ 'nb-on': 'A', 'nb-off': 'B', 'atu-tune': 'T' }),
    { nb: true, atu: true });
  assert.deepStrictEqual(CS.capsFromSequences({ 'nb-on': '  ', 'nb-off': '' }), {});
  assert.deepStrictEqual(CS.capsFromSequences(null), {});
  assert.strictEqual(CS.sequenceRef('#0'), null, 'Commander numbers its sequences from 1');
  assert.strictEqual(CS.sequenceRef('#33'), null);
  assert.deepStrictEqual(CS.sequenceRef(' #1 '), { command: 'seqindex', value: '0' });
});

test('Power is a pair too: power on alone makes no Power button (its off would do nothing)', () => {
  assert.deepStrictEqual(CS.capsFromSequences({ 'power-on': 'ON' }), {});
  assert.deepStrictEqual(CS.capsFromSequences({ 'power-off': 'OFF' }), {});
  assert.deepStrictEqual(CS.capsFromSequences({ 'power-on': 'ON', 'power-off': 'OFF' }), { power: true });
});

test('sequence names must be plain ASCII: a name that is not is dropped, and the codec says why', () => {
  assert.strictEqual(CS.sequenceRef('Réglage'), null);
  assert.deepStrictEqual(CS.cleanSequences({ 'atu-tune': 'Réglage', 'nb-on': 'NB1' }), { 'nb-on': 'NB1' });
  const { c, writes, events } = codec({ sequences: { 'atu-tune': 'Réglage' } });
  assert.strictEqual(c.startTune(), false);
  assert.deepStrictEqual(writes, []);
  assert.ok(events.some((e) => e[0] === 'log' && /not plain ASCII/.test(e[1])), 'logged');
});

test('CW text that is not plain ASCII is refused with a log line, not sent with a wrong length', () => {
  const { c, writes, events } = codec();
  c.sendCwText('CQ DE F5ÉÉ');
  assert.deepStrictEqual(writes, []);
  assert.ok(events.some((e) => e[0] === 'log' && /plain ASCII/.test(e[1])));
});

// --- the reply parser is bounded ---

test('a garbled huge length is skipped, and the next reply still reads', () => {
  const { c, events } = codec();
  c.onData('<CmdFreq:99999999>14,010.500<CmdMode:2>CW');
  assert.deepStrictEqual(events.filter((e) => e[0] === 'mode'), [['mode', 'CW']]);
  assert.ok(c._buf.length < 64, 'nothing left waiting');
  assert.ok(events.some((e) => e[0] === 'log' && /over 1024 bytes/.test(e[1])), 'said so once');
});

test('a declared length up to 1024 is still waited for; one byte more is not', () => {
  const r1 = readFields(`<X:${MAX_FIELD_LEN}>abc`, () => {});
  assert.ok(r1.rest.startsWith('<X:'), 'still arriving');
  const r2 = readFields(`<X:${MAX_FIELD_LEN + 1}>abc`, () => {});
  assert.strictEqual(r2.rest, '');
  assert.strictEqual(r2.oversized, true);
});

test('the buffer stays bounded on endless garbage (16 KB cap)', () => {
  const { c, events } = codec();
  for (let i = 0; i < 40; i++) c.onData(Buffer.alloc(1024, 0x41)); // 40 KB of 'A', no '<'
  assert.strictEqual(c._buf.length, 0);
  c.onData('<CmdMode:3>USB');
  assert.deepStrictEqual(events.filter((e) => e[0] === 'mode'), [['mode', 'USB']]);
});

test('a reconnect clears a half-received field (probeCaps runs at every connect)', () => {
  const { c, events } = codec();
  c.onData('<CmdFreq:10>14,0');          // the socket dropped here
  c.probeCaps();                          // the next session starts
  c.onData('<CmdFreq:10>21,230.000');
  assert.deepStrictEqual(events.filter((e) => e[0] === 'frequency'), [['frequency', 21230000]]);
});

test('lengths are bytes: a multi-byte character, split across two reads, does not shift the framing', () => {
  const { c, events } = codec();
  const value = Buffer.from('é OK', 'utf8');           // 5 bytes, 4 characters
  const wire = Buffer.concat([Buffer.from(`<CmdX:${value.length}>`), value, Buffer.from('<CmdMode:3>LSB')]);
  const cut = wire.indexOf(0xc3) + 1;                    // between the two bytes of é
  c.onData(wire.subarray(0, cut));
  c.onData(wire.subarray(cut));
  assert.deepStrictEqual(events.filter((e) => e[0] === 'mode'), [['mode', 'LSB']]);
});

// --- a hand-typed custom command goes through the same parser ---

test('a custom command with a miscounted length is not sent, and the log gives the right framing', () => {
  const { c, writes, events } = codec();
  c.sendRaw('<command:10>CmdSetFreq<parameters:16><xcvrfreq:5>21230');
  assert.deepStrictEqual(writes, []);
  const line = events.find((e) => e[0] === 'log')[1];
  assert.ok(line.includes('<command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230'), line);
  c.sendRaw('<command:10>CmdSetFreq<parameters:17><xcvrfreq:4>21230');
  assert.deepStrictEqual(writes, [], 'an inner parameter length is checked too');
});

test('checkMessage accepts the document\'s examples, and bare cwchars text', () => {
  for (const m of [
    '<command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230',
    '<command:8>CmdSplit<parameters:8><1:3>off',
    '<command:5>CmdTX<parameters:0>',
    '<command:7>cwchars<parameters:16>testing de aa6yq',
  ]) assert.strictEqual(checkMessage(m), null, m);
  assert.ok(checkMessage('<command:10>CmdSetFreq<parameters:99><xcvrfreq:5>21230').problem);
  // The document's CmdSetFreqMode example says <parameters:56>, but its
  // parameters are 58 bytes: exactly the hand-counting slip this check exists
  // for. (The codec never sends CmdSetFreqMode; this is the custom-CAT path.)
  const doc = checkMessage('<command:14>CmdSetFreqMode<parameters:56><xcvrfreq:5>14080<xcvrmode:4>RTTY<preservesplitanddual:1>N');
  assert.strictEqual(doc.corrected, '<command:14>CmdSetFreqMode<parameters:58><xcvrfreq:5>14080<xcvrmode:4>RTTY<preservesplitanddual:1>N');
  assert.ok(/ASCII/.test(checkMessage('<command:7>cwchars<parameters:3>déf').problem));
});

test('the split TX frequency is set only while Commander reports split on (with split off it would move the dial)', () => {
  const { c, writes, events } = codec();
  assert.strictEqual(c.setFrequencyOther(14025000), false);
  assert.deepStrictEqual(writes, []);
  assert.ok(events.some((e) => e[0] === 'log' && /split is off/.test(e[1])));
  c.onData('<CmdSplit:2>ON');
  assert.strictEqual(c.setFrequencyOther(14025500), true);
  assert.deepStrictEqual(writes, ['<command:12>CmdSetTXFreq<parameters:19><xcvrfreq:7>14025.5']);
});

test('a CW paddle over Commander is the bare-PTT case (CmdTX), unless a CW key port is set', () => {
  assert.deepStrictEqual(cwPaddleAvailability({ transportType: 'dxlab-commander', protocol: 'commander', paddleKey: false }),
    { available: false, reason: 'txrx-ptt-only' });
  assert.deepStrictEqual(cwPaddleAvailability({ transportType: 'dxlab-commander', protocol: 'commander', hasKeyPort: true }),
    { available: true, reason: null });
});

// --- the radio behind Commander: a picked Radio Model ---

test('a picked Radio Model lends its bands and power range; the controls stay Commander\'s', () => {
  const picked = Object.values(RIG_MODELS).find((m) => m && Array.isArray(m.bands) && m.maxPower && m.maxPower !== 100)
    || { ...RIG_MODELS['FT-891'], bands: ['40m', '20m'], maxPower: 10, minPower: 1 };
  const m = commanderModel(picked, { sequences: { 'atu-tune': 'TUNE' }, decimal: ',' });
  assert.deepStrictEqual(m.bands, picked.bands);
  assert.strictEqual(m.maxPower, picked.maxPower);
  assert.strictEqual(m.protocol, 'commander');
  assert.strictEqual(m.caps.atu, true, 'the mapped sequence');
  assert.ok(!m.caps.rfgain && !m.caps.txpower && !m.caps.nb, 'not the radio\'s own controls');
  assert.deepStrictEqual(m.cw, GENERIC_CAPS.commander.cw);
  assert.deepStrictEqual(m.commander, { decimal: ',', sequences: { 'atu-tune': 'TUNE' } });
  // Nothing about talking to that radio directly, and not its brand (main
  // takes Icom-only paths on brand === 'Icom').
  const icom = commanderModel({ ...RIG_MODELS['IC-7300'], pollIntervalMs: 30000, connectDelay: 900, notes: ['x'] });
  assert.strictEqual(icom.brand, 'DXLab');
  assert.strictEqual(icom.pollIntervalMs, undefined);
  assert.strictEqual(icom.connectDelay, undefined);
  assert.strictEqual(icom.notes, undefined);
  assert.strictEqual(icom.civAddr, undefined);
  const none = commanderModel(null);
  assert.strictEqual(none.brand, 'DXLab');
  assert.deepStrictEqual(none.caps, GENERIC_CAPS.commander.caps);
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

// --- against a fake Commander on a real TCP socket ---
// Real TcpTransport + RigController + CommanderCodec, the way
// test/flrig-codec-test.js drives flrig. The fake frames replies the way
// Commander's reference prints them: one self-naming ADIF field, no terminator.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 5000, step = 20) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await wait(step); } return pred(); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function fakeCommander({ freqKhz = '14,074.000', mode = 'DATA-U', silent = false } = {}) {
  const st = { freqKhz, mode, split: 'OFF', tx: 'OFF', received: [], connections: 0, socks: new Set() };
  const reply = {
    cmdgetfreq: () => `<CmdFreq:${st.freqKhz.length}>${st.freqKhz}`,
    cmdsendmode: () => `<CmdMode:${st.mode.length}>${st.mode}`,
    cmdsendsplit: () => `<CmdSplit:${st.split.length}>${st.split}`,
    cmdsendtx: () => `<CmdTX:${st.tx.length}>${st.tx}`,
  };
  const server = net.createServer((sock) => {
    st.connections++;
    st.socks.add(sock);
    sock.on('close', () => st.socks.delete(sock));
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const r = readFields(buf, (name, value) => {
        if (name.toLowerCase() !== 'command') { st.received[st.received.length - 1].params = value; return; }
        st.received.push({ command: value, params: undefined }); // the parameters field follows
      });
      buf = r.rest;
      if (silent) return;
      // Answer every complete command in arrival order.
      for (const msg of st.received.filter((m) => !m.answered && m.params !== undefined)) {
        msg.answered = true;
        const k = msg.command.toLowerCase();
        if (k === 'cmdsetmode') st.mode = msg.params.replace(/^<1:\d+>/, '');
        if (k === 'cmdsplit') st.split = /on/i.test(msg.params) ? 'ON' : 'OFF';
        if (reply[k]) sock.write(reply[k]());
      }
    });
  });
  return {
    st,
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    send: (bytes) => { for (const s of st.socks) s.write(bytes); },
    dropClients: () => { for (const s of st.socks) s.destroy(); },
    close: () => new Promise((r) => { for (const s of st.socks) s.destroy(); server.close(() => r()); }),
    commands: () => st.received.map((m) => m.command),
  };
}

function liveRig(port) {
  const transport = new TcpTransport();
  const model = commanderModel(null, { sequences: { 'atu-tune': 'TUNE' } });
  const codec = new CommanderCodec(model, (d) => transport.write(d));
  const rig = new RigController(model, transport, codec);
  const seen = { status: [], freq: [], mode: [] };
  rig.on('status', (s) => seen.status.push(!!s.connected));
  rig.on('frequency', (hz) => seen.freq.push(hz));
  rig.on('mode', (m) => seen.mode.push(m));
  rig.connect({ host: '127.0.0.1', port });
  return { rig, codec, transport, seen };
}

test('TCP: connects, polls, reads the radio, and a tune sends mode then frequency', async () => {
  const port = await freePort();
  const fake = fakeCommander();
  await fake.listen(port);
  const { rig, seen } = liveRig(port);
  try {
    assert.ok(await until(() => seen.freq.includes(14074000) && seen.mode.includes('PKTUSB')), `read: ${JSON.stringify(seen)}`);
    assert.ok(fake.commands().includes('CmdRX'), 'the connect-time PTT-off safety reached Commander');
    const before = fake.st.received.length;
    rig.tune(7200000, 'SSB', {});
    assert.ok(await until(() => fake.commands().slice(before).includes('CmdSetFreq')), 'tuned');
    const tuned = fake.st.received.slice(before).filter((m) => /^CmdSet(Mode|Freq)$/.test(m.command));
    assert.deepStrictEqual(tuned.map((m) => [m.command, m.params]), [['CmdSetMode', '<1:3>LSB'], ['CmdSetFreq', '<xcvrfreq:4>7200']]);
    rig.startTune();
    assert.ok(await until(() => fake.st.received.some((m) => m.command === 'seqname' && m.params === '<1:4>TUNE')), 'mapped ATU sequence');
  } finally { rig.disconnect(); await fake.close(); }
});

test('TCP: Commander closing the socket shows disconnected, then the link comes back on its own', async () => {
  const port = await freePort();
  const fake = fakeCommander();
  await fake.listen(port);
  const { rig, seen } = liveRig(port);
  try {
    assert.ok(await until(() => seen.freq.length > 0), 'first session read');
    fake.dropClients();
    assert.ok(await until(() => seen.status.includes(false)), 'reported down');
    assert.ok(await until(() => fake.st.connections >= 2, 6000), 'TcpTransport reconnected');
    const n = seen.freq.length;
    assert.ok(await until(() => seen.freq.length > n), 'reading again after the reconnect');
    assert.strictEqual(seen.status[seen.status.length - 1], true);
  } finally { rig.disconnect(); await fake.close(); }
});

test('TCP: a half-sent field before the drop does not eat the first reply of the next session', async () => {
  const port = await freePort();
  const fake = fakeCommander({ freqKhz: '21,230.000' });
  await fake.listen(port);
  const { rig, codec, seen } = liveRig(port);
  try {
    assert.ok(await until(() => fake.st.socks.size === 1 && rig.connected));
    fake.send('<CmdFreq:10>14,0');                       // then the link drops mid-field
    assert.ok(await until(() => codec._buf.startsWith('<CmdFreq:10>')), 'partial field buffered');
    fake.dropClients();
    assert.ok(await until(() => fake.st.connections >= 2, 6000), 'reconnected');
    assert.ok(await until(() => seen.freq.includes(21230000)), `first reply of the new session read: ${JSON.stringify(seen.freq)}`);
    assert.ok(!seen.freq.some((hz) => hz !== 21230000), 'no frequency stitched from the two sessions');
  } finally { rig.disconnect(); await fake.close(); }
});

test('TCP: an oversized length and a split multi-byte character from the server leave the link reading', async () => {
  const port = await freePort();
  const fake = fakeCommander({ freqKhz: '.000' });         // no frequency yet, so only the injected bytes count
  await fake.listen(port);
  const { rig, seen } = liveRig(port);
  try {
    assert.ok(await until(() => fake.st.socks.size === 1 && rig.connected));
    fake.send('<CmdFreq:99999999>junk');
    const value = Buffer.from('ü!', 'utf8');            // 3 bytes
    const tail = Buffer.concat([Buffer.from(`<CmdNote:${value.length}>`), value, Buffer.from('<CmdFreq:10>18,100.000')]);
    const cut = tail.indexOf(0xc3) + 1;
    fake.send(tail.subarray(0, cut));
    await wait(30);
    fake.send(tail.subarray(cut));
    assert.ok(await until(() => seen.freq.includes(18100000)), `read past both: ${JSON.stringify(seen.freq)}`);
  } finally { rig.disconnect(); await fake.close(); }
});

test('Test Connection names each case: nothing listening, no radio, a silent port, or the radio', async () => {
  const closed = await freePort();
  const r1 = await probeCommander({ port: closed, timeoutMs: 1500 });
  assert.strictEqual(r1.ok, false);
  assert.ok(/nothing is listening/.test(r1.error) && /Base Port \+ 2/.test(r1.error), r1.error);

  const p2 = await freePort(); const noRadio = fakeCommander({ freqKhz: '.000', mode: '' }); await noRadio.listen(p2);
  const r2 = await probeCommander({ port: p2 });
  await noRadio.close();
  assert.deepStrictEqual([r2.ok, r2.noRadio], [true, true]);

  const p3 = await freePort(); const silent = fakeCommander({ silent: true }); await silent.listen(p3);
  const r3 = await probeCommander({ port: p3, timeoutMs: 600 });
  await silent.close();
  assert.strictEqual(r3.ok, false);
  assert.ok(/did not answer like DXLab Commander/.test(r3.error), r3.error);

  const p4 = await freePort(); const live = fakeCommander({ freqKhz: '7,074.000', mode: 'DATA-U' }); await live.listen(p4);
  const r4 = await probeCommander({ port: p4 });
  await live.close();
  assert.deepStrictEqual([r4.ok, r4.noRadio, r4.freqHz, r4.mode], [true, false, 7074000, 'PKTUSB']);
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

test('the review\'s wiring spots: picked model, Test Connection, descriptions, shared list, station setup', () => {
  const main = read('main.js');
  assert.ok(/commanderModel\(explicit,/.test(main), 'getActiveRigModel borrows the picked Radio Model');
  assert.ok(/ipcMain\.handle\('test-commander'/.test(main) && /probeCommander\(/.test(main), 'test-commander handler');
  assert.ok(/no radio \(frequency \.000\)/.test(main), 'the no-radio case has its own words');
  const migr = main.slice(main.indexOf('function describeTargetForMigration'), main.indexOf('function migrateRigSettings'));
  assert.ok(migr.includes("'dxlab-commander'"), 'describeTargetForMigration');
  assert.ok(read('preload.js').includes("testCommander: (config) => ipcRenderer.invoke('test-commander', config)"));
  assert.ok(/id="dxlab-commander-test-btn"/.test(read('renderer/index.html')), 'the Test Connection button');
  const app = read('renderer/app.js');
  assert.ok(/\['flrig', 'dxlab-commander', 'rigctldnet'\]\.includes\(getSelectedRadioType\(\)\)/.test(app),
    'picking a Radio Model keeps the Commander connection');
  assert.ok(/window\.api\.testCommander\(/.test(app), 'the button calls test-commander');
  assert.ok(/'dxlab-commander': 'DXLab Commander'/.test(read('lib/station-setup.js')), 'station-setup "through" wording');
  const { describeRigTarget } = { describeRigTarget: null };
  assert.ok(/target\.type === 'dxlab-commander'\) \{\s*return `DXLab Commander on/.test(app), 'describeRigTarget (what the rig list and bug reports print)');
  void describeRigTarget;
});

test('the codec has no TX-hint state left over (nothing read it)', () => {
  const src = read('lib/codecs/commander-codec.js');
  assert.ok(!/setTxHint|_txHint/.test(src));
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
