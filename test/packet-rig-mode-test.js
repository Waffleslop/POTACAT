#!/usr/bin/env node
'use strict';
// GitHub #128 (N5XHI, FT-857D): a Winlink packet session tuned plain FM, and
// only an Icom was then moved to its FM data mode. A radio that takes rear or
// USB audio only in its packet mode sent no tone. Each rig now has "Packet
// mode on the radio": Automatic, FM (voice) or FM data, resolved by one
// function (lib/packet-rig-mode.js).
//
// The rule this file holds: Automatic is what POTACAT did before the setting
// existed, for every family. A family gains a default only with a source.
// Run: node test/packet-rig-mode-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const P = require('../lib/packet-rig-mode');
const RigFamily = require('../lib/rig-family');
const WinlinkModes = require('../lib/winlink-modes');
const WinlinkOutcome = require('../lib/winlink-outcome');
const { PacketLinkStory } = require('../lib/direwolf-agw-monitor');
const { resolveSetupNotes } = require('../lib/rig-setup-notes');
const { RIG_MODELS } = require('../lib/rig-models');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { YaesuLegacyCodec, MODES: LEGACY_MODES, MODE_PARSE: LEGACY_PARSE } = require('../lib/codecs/yaesu-legacy-codec');
const { FlrigCodec, MODE_CANDIDATES } = require('../lib/codecs/flrig-codec');
const { MODE_TOKENS: COMMANDER_TOKENS } = require('../lib/codecs/commander-codec');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  const done = (e) => { if (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); } else { pass++; console.log('  ok  ' + name); } };
  try { const r = fn(); if (r && r.then) pending.push(r.then(() => done(), done)); else done(); }
  catch (e) { done(e); }
}
const ROOT = path.join(__dirname, '..');
const main = readSrc(path.join(ROOT, 'main.js'));
const html = readSrc(path.join(ROOT, 'renderer', 'index.html'));
const app = readSrc(path.join(ROOT, 'renderer', 'app.js'));
function fnSrc(src, name) {
  let i = src.indexOf(`async function ${name}(`);
  if (i < 0) i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0;
  for (let k = src.indexOf(') {', i) + 2; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}

// Every kind of rig the editor can make: [name, editor radio type, model].
const RIGS = [
  ['Icom on CI-V (IC-7100)', 'icom', 'IC-7100'],
  ['Icom on CI-V, no model picked', 'icom', ''],
  ['Icom on a raw CI-V TCP bridge', 'civ-tcp', ''],
  ['Icom Network', 'icom-network', 'IC-705'],
  ['Icom behind Hamlib (IC-7100)', 'hamlib', 'IC-7100'],
  ['Icom behind rigctld Network', 'rigctldnet', 'IC-7100'],
  ['Icom behind flrig', 'flrig', 'IC-7100'],
  ['Icom behind DXLab Commander', 'dxlab-commander', 'IC-7100'],
  ['Yaesu FT-857 (legacy CAT)', 'serialcat', 'FT-857'],
  ['Yaesu FT-817/818 (legacy CAT)', 'serialcat', 'FT-817/818'],
  ['Yaesu FT-897 (legacy CAT)', 'serialcat', 'FT-897'],
  ['Yaesu FT-991/991A', 'serialcat', 'FT-991/991A'],
  ['Yaesu FT-710', 'serialcat', 'FT-710'],
  ['Yaesu behind Hamlib (FT-857)', 'hamlib', 'FT-857'],
  ['Hamlib, no model picked', 'hamlib', ''],
  ['Yaesu behind flrig', 'flrig', 'FT-991/991A'],
  ['Yaesu LAN (SCU-LAN10)', 'yaesu-lan', 'FT-710'],
  ['Kenwood TS-2000', 'serialcat', 'TS-2000'],
  ['Serial CAT, no model picked', 'serialcat', ''],
  ['IP radio (TCP CAT)', 'tcpcat', ''],
  ['K4 Remote', 'k4network', ''],
  ['FlexRadio', 'flex', ''],
  ['DXLab Commander', 'dxlab-commander', ''],
  ['No CAT control', 'nocat', ''],
];
function rigIn(radioType, model, choice) {
  const info = model ? RIG_MODELS[model] : null;
  if (model) assert.ok(info, 'the model table has ' + model);
  return { choice, family: RigFamily.familyFromRadioType(radioType), brand: info && info.brand, protocol: info && info.protocol };
}

// What POTACAT did before the setting, written out from the old code:
//   icom = detectRigType() === 'icom' || rig.brand === 'Icom'
//   an Icom was sent DIGFM once; every other radio stayed in FM.
// DIGFM is a mode only the CI-V and rigctld codecs know (checked below), so an
// Icom behind flrig or Commander stayed in FM as well.
function before(radioType, model) {
  const info = model ? RIG_MODELS[model] : null;
  const icom = ['icom', 'civ-tcp', 'icom-network'].includes(radioType) || !!(info && info.brand === 'Icom');
  const codecKnowsDigfm = ['icom', 'civ-tcp', 'icom-network', 'hamlib', 'rigctldnet'].includes(radioType);
  return icom && codecKnowsDigfm ? 'DIGFM' : null;
}

console.log('Automatic is today\'s behaviour, for every family');
for (const [name, type, model] of RIGS) {
  test(`${name}: Automatic sends ${before(type, model) || 'FM only'}, as before`, () => {
    for (const choice of [undefined, null, '', 'auto', 'nonsense']) {
      const r = P.resolvePacketRigMode(rigIn(type, model, choice));
      assert.strictEqual(r.choice, 'auto');
      assert.strictEqual(r.dataMode, before(type, model), `${name} with ${JSON.stringify(choice)}`);
      assert.strictEqual(r.want, before(type, model) ? 'fmdata' : 'fm');
      assert.strictEqual(r.byHand, false, 'Automatic never asks the operator to set a mode');
    }
  });
}
test('only an Icom gets FM data on Automatic: no family default was added without a source', () => {
  const withData = RIGS.filter(([, type, model]) => P.resolvePacketRigMode(rigIn(type, model)).want === 'fmdata').map((r) => r[0]);
  assert.deepStrictEqual(withData, ['Icom on CI-V (IC-7100)', 'Icom on CI-V, no model picked', 'Icom on a raw CI-V TCP bridge', 'Icom Network', 'Icom behind Hamlib (IC-7100)', 'Icom behind rigctld Network']);
});

console.log('the two explicit choices');
for (const [name, type, model] of RIGS) {
  test(`${name}: FM (voice) sends no data mode on any radio`, () => {
    const r = P.resolvePacketRigMode(rigIn(type, model, 'fm'));
    assert.strictEqual(r.want, 'fm'); assert.strictEqual(r.dataMode, null); assert.strictEqual(r.byHand, false); assert.strictEqual(r.note, '');
  });
}
const FM_DATA = {
  icom: 'DIGFM', 'civ-tcp': 'DIGFM', 'icom-network': 'DIGFM', hamlib: 'DIGFM', rigctldnet: 'DIGFM', flrig: 'PKTFM',
};
for (const [name, type, model] of RIGS) {
  const legacy = type === 'serialcat' && model && RIG_MODELS[model].protocol === 'yaesu-legacy';
  const want = FM_DATA[type] || (legacy ? 'PKTFM' : null);
  test(`${name}: FM data ${want ? 'is sent as ' + want : 'is the operator\'s to set, and POTACAT says so'}`, () => {
    const r = P.resolvePacketRigMode(rigIn(type, model, 'fmdata'));
    assert.strictEqual(r.want, 'fmdata');
    assert.strictEqual(r.dataMode, want);
    assert.strictEqual(r.byHand, !want);
    if (!want) assert.ok(/^Set the radio to its FM data mode yourself/.test(r.note), r.note);
    assert.ok(r.source, 'every row names where its mode comes from');
  });
}

console.log('each mode sent is one the codec really has');
test('rigctld: DIGFM goes out as Hamlib\'s PKTFM', () => {
  const out = [];
  const c = new RigctldCodec({ brand: 'Yaesu', model: 'FT-857' }, (l) => out.push(l));
  c.setMode('DIGFM', 145630000);
  assert.ok(out.some((l) => /^M PKTFM\b/.test(l)), out.join('|'));
});
test('Yaesu legacy: PKTFM is mode byte 0C, which reads back as FM (so it cannot be confirmed)', () => {
  assert.strictEqual(LEGACY_MODES.PKTFM, 0x0C);
  assert.strictEqual(LEGACY_PARSE[0x0C], 'FM');
  assert.strictEqual(P.LINKS['yaesu-legacy'].confirm, false);
  const c = new YaesuLegacyCodec({ brand: 'Yaesu', protocol: 'yaesu-legacy' }, () => {});
  assert.deepStrictEqual(c.resolveMode('PKTFM', 145630000), { mode817: 0x0C });
});
test('FT-817/818/857/897 behind Hamlib: FM data is not confirmed, so FM read back is never called "not a data mode" (#300)', () => {
  for (const model of ['FT-817/818', 'FT-857', 'FT-897']) {
    for (const type of ['hamlib', 'rigctldnet']) {
      const r = P.resolvePacketRigMode(rigIn(type, model, 'fmdata'));
      assert.strictEqual(r.dataMode, 'DIGFM', `${model}/${type}`);
      assert.strictEqual(r.confirm, false, `${model}/${type}`);
      assert.strictEqual(r.radioName, 'PKT', `${model}/${type}`);
      assert.strictEqual(r.note, 'This radio reports PKT as FM, so POTACAT cannot confirm it: check the radio\'s display during the session.');
      const said = P.sentText({ resolved: r, state: 'sent', sent: 'DIGFM', report: { mode: 'FM', data: false } });
      assert.ok(!/not a data mode/.test(said), said);
      assert.ok(/this radio reports PKT as FM, so it is not confirmed$/.test(said), said);
    }
  }
  // Every other radio behind Hamlib is still confirmed by its own report.
  for (const model of ['IC-7100', 'FT-991/991A', '']) assert.strictEqual(P.resolvePacketRigMode(rigIn('hamlib', model, 'fmdata')).confirm, true, model || '(no model)');
});
test('flrig: PKTFM picks the radio\'s own FM data name; DIGFM is a name it does not know', () => {
  assert.deepStrictEqual(MODE_CANDIDATES.PKTFM.slice(0, 3), ['FM-D', 'DATA-FM', 'PKT-FM']);
  const c = new FlrigCodec({}, () => {});
  assert.strictEqual(c.resolveMode('PKTFM', 0), 'PKTFM');
  assert.strictEqual(c.resolveMode('DIGFM', 0), null, 'so an Icom behind flrig stayed in FM before, and Automatic keeps it there');
});
test('Commander and the Kenwood/Yaesu text codec have no FM data mode: by hand', () => {
  assert.strictEqual(COMMANDER_TOKENS.DIGFM, undefined); assert.strictEqual(COMMANDER_TOKENS.PKTFM, undefined);
  const kw = readSrc(path.join(ROOT, 'lib', 'codecs', 'kenwood-codec.js'));
  const tables = kw.slice(kw.indexOf('const KENWOOD_MODES'), kw.indexOf('// Mode parse tables'));
  assert.ok(!/DIGFM|PKTFM/.test(tables), 'add the mode there with its source before making it a row here');
  for (const link of ['yaesu', 'kenwood', 'commander', 'flex', 'none']) assert.strictEqual(P.LINKS[link].dataMode, null, link);
});

console.log('the key-down');
test('outside packet and VARA FM an Icom is forced to DATA, as before', () => {
  assert.deepStrictEqual(P.keyDownOpts({ icom: true, resolved: null }), { forceDataMode: true });
  assert.deepStrictEqual(P.keyDownOpts({ icom: false, resolved: null }), { forceDataMode: false });
});
test('an Icom in FM data keeps the forced-DATA key-down; nothing else swaps the mode on a frame', () => {
  const r = (type, model, choice) => P.resolvePacketRigMode(rigIn(type, model, choice));
  assert.deepStrictEqual(P.keyDownOpts({ icom: true, resolved: r('icom', 'IC-7100') }), { forceDataMode: true });
  assert.deepStrictEqual(P.keyDownOpts({ icom: true, resolved: r('hamlib', 'IC-7100') }), { forceDataMode: true });
  assert.deepStrictEqual(P.keyDownOpts({ icom: true, resolved: r('icom', 'IC-7100', 'fm') }), { forceDataMode: false, noDataSwap: true });
  assert.deepStrictEqual(P.keyDownOpts({ icom: false, resolved: r('serialcat', 'FT-857', 'fmdata') }), { forceDataMode: false, noDataSwap: true });
  assert.deepStrictEqual(P.keyDownOpts({ icom: false, resolved: r('serialcat', 'TS-2000') }), { forceDataMode: false, noDataSwap: true });
});
test('main.js: the shim keys with those options, and handleRemotePtt honours noDataSwap', () => {
  const shim = main.slice(main.indexOf('setPtt: (on) => {'), main.indexOf('function winlinkUnkeyNow('));
  assert.ok(/const pttMode = PacketRigMode\.keyDownOpts\(\{ icom, resolved: winlinkPacketRigMode\(winlinkState\.session\.mode\) \}\);/.test(shim));
  assert.ok(/handleRemotePtt\(true, \{ audio: true, \.\.\.pttMode, emission: 'DATA', txKind: 'winlink' \}\)/.test(shim));
  assert.ok(/\(settings\.ssbOverData \|\| forceData\) && !opts\.noDataSwap/.test(fnSrc(main, 'handleRemotePtt')));
});

console.log('session start: tune, then the mode, once');
// The real function from main.js, run against a fake radio.
function runEnter({ resolved, catUp = true, report = null, brand = 'Yaesu', tunedAt = 1000 }) {
  const sent = [], log = [];
  const sb = {
    cat: catUp ? { connected: true, setModeOnly: (m, hz, o) => sent.push({ m, hz, o }) } : null,
    pttModeReport: () => report,
    getActiveRigModel: () => ({ brand }),
    winlinkLog: (l) => log.push(l),
    setTimeout: (fn) => { fn(); return 0; },
    Date, Promise,
    _winlinkSessionSeq: 7, _winlinkDataAskedFor: -1, _modeSuppressUntil: 0, _currentFreqHz: 145630000,
    _winlinkRadioMode: { resolved, noCat: false, sent: '', state: '' }, _winlinkUnreportedDataMode: '',
  };
  vm.createContext(sb);
  vm.runInContext(fnSrc(main, 'winlinkEnterFmDataBeforeDial') + '\nthis.run = winlinkEnterFmDataBeforeDial;', sb);
  return sb.run('packet', resolved, tunedAt).then(() => ({ sent, log, askedFor: sb._winlinkDataAskedFor, note: sb._winlinkRadioMode, unreported: sb._winlinkUnreportedDataMode }));
}
test('Icom on Automatic: DIGFM once, no frequency write, the same log line as before', async () => {
  const r = await runEnter({ resolved: P.resolvePacketRigMode(rigIn('icom', 'IC-7100')), brand: 'Icom' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.sent)), [{ m: 'DIGFM', hz: 145630000, o: { noAnchor: true } }]);
  assert.strictEqual(r.askedFor, 7, 'the key-down sees this session already asked (#300)');
  assert.deepStrictEqual(r.log, ['FM -> DIGFM for this session, asked once before the first frame (an Icom takes modem audio in its data mode)']);
  assert.strictEqual(r.note.state, 'sent'); assert.strictEqual(r.note.sent, 'DIGFM');
  assert.strictEqual(r.unreported, '', 'an Icom reports FM-D; its return is the tune it always was');
});
test('FT-857 set to FM data: PKTFM once, and the log names the choice', async () => {
  const r = await runEnter({ resolved: P.resolvePacketRigMode(rigIn('serialcat', 'FT-857', 'fmdata')) });
  assert.deepStrictEqual(r.sent.map((s) => s.m), ['PKTFM']);
  assert.ok(/^FM -> PKTFM for this session, asked once before the first frame \(Packet mode on the radio: FM data \(PKT\), chosen for this rig\)$/.test(r.log[0]), r.log[0]);
  assert.strictEqual(r.unreported, 'PKTFM', 'remembered: this radio reads PKT back as FM, so the return must name the mode');
});
test('FT-857 on Automatic, an Icom set to FM (voice), a by-hand radio: nothing is sent', async () => {
  for (const resolved of [P.resolvePacketRigMode(rigIn('serialcat', 'FT-857')), P.resolvePacketRigMode(rigIn('icom', 'IC-7100', 'fm')), P.resolvePacketRigMode(rigIn('serialcat', 'FT-991/991A', 'fmdata'))]) {
    const r = await runEnter({ resolved });
    assert.deepStrictEqual(r.sent, []); assert.deepStrictEqual(r.log, []);
  }
});
test('a radio already in its data mode is sent nothing; a mode name from before the FM tune does not count', async () => {
  const flrig = P.resolvePacketRigMode(rigIn('flrig', 'FT-991/991A', 'fmdata'));
  let r = await runEnter({ resolved: flrig, report: { mode: 'PKTFM', data: true, at: 2000 }, tunedAt: 1000 });
  assert.deepStrictEqual(r.sent, []); assert.strictEqual(r.note.state, 'already');
  r = await runEnter({ resolved: flrig, report: { mode: 'PKTUSB', data: true, at: 500 }, tunedAt: 1000 });
  assert.deepStrictEqual(r.sent.map((s) => s.m), ['PKTFM'], 'PKTUSB was the HF mode the session just left');
  r = await runEnter({ resolved: P.resolvePacketRigMode(rigIn('icom', 'IC-7100')), brand: 'Icom', report: { mode: 'FM', data: true, at: 500 } });
  assert.deepStrictEqual(r.sent, [], 'an Icom\'s DATA flag is its own report, as before');
});
test('the radio link down: nothing sent, and the summary will say so', async () => {
  const r = await runEnter({ resolved: P.resolvePacketRigMode(rigIn('icom', 'IC-7100')), catUp: false });
  assert.deepStrictEqual(r.sent, []); assert.strictEqual(r.note.state, 'link-down');
});
test('main.js: the session tunes FM first, then asks for the mode, then Pat dials; a by-hand radio keeps its mode', () => {
  const s = fnSrc(main, 'winlinkStartSession');
  const tune = s.indexOf("{ origin: 'Winlink session' }");
  const enter = s.indexOf('await winlinkEnterFmDataBeforeDial(mode, pm, tunedAt);');
  const dial = s.indexOf('await patClient.connect(url)');
  assert.ok(tune > 0 && enter > tune && dial > enter, 'after the QSY, before Pat dials');
  assert.ok(/await winlinkEnterFmDataBeforeDial\(mode, pm, tunedAt\);\n\s*if \(!live\(\)\) throw cancelled\(\);/.test(s), 'a stopped attempt goes no further');
  assert.ok(/tuneRadio\(Number\(dialKhz\), WinlinkModes\.isFmMode\(mode\) \? \(pm && pm\.byHand \? undefined : 'FM'\) : 'DIGU'/.test(s));
  assert.ok(/winlinkLog\(`packet mode on the radio: \$\{pm\.label\}/.test(s), 'the choice is in the log at every start');
  assert.ok(/const pm = winlinkPacketRigMode\(mode\);/.test(s));
  const pick = fnSrc(main, 'winlinkPreviewQsy');
  assert.ok(/pickPm && pickPm\.byHand \? undefined : 'FM'/.test(pick), 'a gateway pick leaves a by-hand radio\'s mode alone too');
});
test('main.js: one resolver call, fed the active rig\'s choice, family and model', () => {
  const f = fnSrc(main, 'winlinkPacketRigMode');
  assert.ok(/if \(!WinlinkModes\.isFmMode\(mode\)\) return null;/.test(f), 'packet and VARA FM only');
  assert.ok(/PacketRigMode\.resolvePacketRigMode\(\{ choice: rig && rig\.packetMode, family, brand: model && model\.brand, protocol: model && model\.protocol \}\)/.test(f));
  assert.strictEqual((main.match(/resolvePacketRigMode\(/g) || []).length, 2, 'the session and the rig editor; nothing else decides a packet mode');
});

console.log('the mode comes back at the end, as it always did');
test('the return dial carries the mode the radio was in, and the restore tunes to it', () => {
  const log = [], tuned = [], modes = [];
  const sb = {
    winlinkSessionActive: () => false, _atuTuneEpisode: null, winlinkLog: (l) => log.push(l),
    winlinkDialText: (d) => `${(d.freqHz / 1e6).toFixed(4)} MHz ${d.mode}`,
    tuneRadio: (khz, mode, _b, o) => tuned.push({ khz, mode, origin: o.origin }),
    cat: { connected: true, setModeOnly: (m, hz, o) => modes.push({ m, hz, noAnchor: o.noAnchor }) },
    setTimeout: (fn) => { fn(); return 0; },
    _winlinkUnreportedDataMode: '',
  };
  vm.createContext(sb);
  vm.runInContext(fnSrc(main, 'winlinkReturnModeByName') + '\n' + fnSrc(main, 'winlinkRestoreDial') + '\nthis.run = winlinkRestoreDial;', sb);
  sb.run({ freqHz: 146820000, mode: 'FM', from: 'at Connect' });
  assert.deepStrictEqual(tuned, [{ khz: 146820, mode: 'FM', origin: 'Winlink return' }]);
  sb.run({ freqHz: 14074000, mode: 'DIGU' });
  assert.strictEqual(tuned[1].mode, 'DIGU', 'an FT8 operator comes back in data, after a packet session in FM data too');
  assert.deepStrictEqual(modes, [], 'a radio that reports its data mode needs nothing more: the tune itself changes the mode, as for an Icom today');
  // FT-857 after FM data: PKT reads back as FM, so the tune to FM would carry no mode command.
  sb._winlinkUnreportedDataMode = 'PKTFM';
  sb.run({ freqHz: 146820000, mode: 'FM' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(modes)), [{ m: 'FM', hz: 146820000, noAnchor: true }], 'FM sent by name, once');
  assert.ok(log.includes('the radio reports PKTFM as FM, so FM is sent again by name'));
  sb.run({ freqHz: 146820000, mode: 'FM' });
  assert.strictEqual(modes.length, 1, 'only after a session that sent it');
  assert.ok(/winlinkReturnModeByName\(r\);/.test(fnSrc(main, 'winlinkReturnBeforeQuit')), 'the same when POTACAT closes');
});
test('why the by-name return is needed: the rig controller skips a mode it believes is unchanged', () => {
  const rc = readSrc(path.join(ROOT, 'lib', 'rig-controller.js'));
  assert.ok(/this\._codec\.modeNameForMapping\(resolved\) !== this\._lastParsedMode/.test(rc));
  const c = new YaesuLegacyCodec({ brand: 'Yaesu', protocol: 'yaesu-legacy' }, () => {});
  assert.strictEqual(c.modeNameForMapping(c.resolveMode('PKTFM', 0)), c.modeNameForMapping(c.resolveMode('FM', 0)), 'PKT and FM are one mode to the controller');
});

console.log('the log and the session summary line');
test('the summary says the choice, what was sent and what the radio reports', () => {
  const icom = P.resolvePacketRigMode(rigIn('icom', 'IC-7100'));
  assert.strictEqual(P.sentText({ resolved: icom, state: 'sent', sent: 'DIGFM', report: { mode: 'FM', data: true } }),
    'FM data (FM-D), Automatic; DIGFM sent once after the FM tune; the radio reports its data mode (FM)');
  const hamlib = P.resolvePacketRigMode(rigIn('hamlib', 'IC-7100'));
  assert.strictEqual(P.sentText({ resolved: hamlib, state: 'sent', sent: 'DIGFM', report: { mode: 'FM', data: false } }),
    'FM data (PKTFM), Automatic; DIGFM sent once after the FM tune; the radio reports FM, not a data mode', 'NA4DQ\'s IC-7100 on Hamlib (#300), in one line');
  const ft857 = P.resolvePacketRigMode(rigIn('serialcat', 'FT-857', 'fmdata'));
  assert.strictEqual(P.sentText({ resolved: ft857, state: 'sent', sent: 'PKTFM', report: { mode: 'FM', data: false } }),
    'FM data (PKT), chosen for this rig; PKTFM sent once after the FM tune; this radio reports PKT as FM, so it is not confirmed');
  assert.strictEqual(P.sentText({ resolved: P.resolvePacketRigMode(rigIn('serialcat', 'FT-857')) }), 'FM (voice), Automatic; FM sent with the tune');
  assert.strictEqual(P.sentText({ resolved: P.resolvePacketRigMode(rigIn('serialcat', 'TS-2000', 'fmdata')) }), 'FM data, set on the radio by the operator; no mode sent');
  assert.strictEqual(P.sentText({ resolved: P.resolvePacketRigMode(rigIn('nocat', '', 'fm')), noCat: true }), 'FM (voice), chosen for this rig; no CAT control, nothing sent');
  assert.strictEqual(P.sentText({ resolved: icom, state: 'link-down' }), 'FM data (FM-D), Automatic; not sent, the radio link was down; the radio reported no mode');
  assert.strictEqual(P.sentText({}), '');
});
test('summaryLine carries it as "radio mode:", and only for a session that has one', () => {
  const base = { outcome: { kind: 'done' }, mode: 'packet', gateway: 'KJ4AJP-10', dialKhz: 145630, ranMs: 60000, connected: true };
  const line = WinlinkOutcome.summaryLine({ ...base, radioMode: 'FM data (FM-D), Automatic; DIGFM sent once after the FM tune; the radio reports its data mode (FM)' });
  assert.ok(/; radio mode: FM data \(FM-D\), Automatic; DIGFM sent once after the FM tune; the radio reports its data mode \(FM\)/.test(line), line);
  assert.ok(!/radio mode:/.test(WinlinkOutcome.summaryLine(base)));
  assert.ok(/radioMode: winlinkRadioModeText\(\),/.test(fnSrc(main, 'winlinkSettleOutcome')));
});

console.log('Dire Wolf in the summary and in Report a Bug (#300)');
const FRAMES = [
  'rx 1:Fm KJ4AJP-10 To NA4DQ <DM F=1 >[16:16:47]',
  'rx 1:Fm KJ4AJP-10 To NA4DQ <UA F=1 >[16:16:49]',
  'rx 1:Fm KJ4AJP-10 To NA4DQ <I S0 R0 pid=F0 Len=21 P=0 >[16:16:55] [21 bytes]',
  'rx 1:Fm KJ4AJP-10 To NA4DQ <RR R0 P=1 >[16:17:00]',
  'rx 1:Fm KJ4AJP-10 To NA4DQ <RR R0 P=1 >[16:17:05]',
  'rx 1:Fm KJ4AJP-10 To NA4DQ <I S1 R0 pid=F0 Len=14 P=0 >[16:17:17] [14 bytes]',
  'rx 1:Fm KJ4AJP-10 To NA4DQ <RR R0 P=1 >[16:17:24]',
];
test('NA4DQ\'s 22:16 session: the gateway connected, polled, and never took a data frame of ours', () => {
  const s = new PacketLinkStory();
  FRAMES.forEach((f) => s.noteFrame(f));
  const snap = s.snapshot();
  assert.strictEqual(snap.stateText, 'heard 7 frames (1 DM, 2 I, 3 RR, 1 UA); the gateway acknowledged none of our data frames (its count stayed at R0); it polled 3 times; last heard RR R0 P=1');
  assert.strictEqual(snap.end, null, 'the DM answered our first connect request; the link went on');
  assert.strictEqual(snap.connected, true);
});
test('#455: connected, but no greeting (I frame) decoded: the summary blames the greeting, not our data frames', () => {
  // W5AUY-10-like session (made-up calls): UA, RR and DISC heard, never an I frame.
  const s = new PacketLinkStory();
  ['rx 1:Fm GW1XYZ-10 To N0CALL <UA F=1 >[1]', 'rx 1:Fm GW1XYZ-10 To N0CALL <RR R0 P=1 >[2]', 'rx 1:Fm GW1XYZ-10 To N0CALL <RR R0 P=1 >[3]', 'rx 1:Fm GW1XYZ-10 To N0CALL <DISC P=1 >[4]'].forEach((f) => s.noteFrame(f));
  const text = s.snapshot().stateText;
  assert.ok(/the gateway's greeting never decoded here \(heard only short frames\)/.test(text), text);
  assert.ok(/look at the receive level and the path/.test(text), text);
  assert.ok(!/acknowledged none of our data frames/.test(text), 'we never sent one');
  assert.ok(text.length <= 240, `fits the summary's modem state (${text.length})`);
  // An I frame before the link came up does not count as the greeting.
  const pre = new PacketLinkStory();
  ['rx 1:Fm G To M <I S0 R0 pid=F0 Len=5 P=0 >[0]', 'rx 1:Fm G To M <UA F=1 >[1]', 'rx 1:Fm G To M <RR R0 P=1 >[2]'].forEach((f) => pre.noteFrame(f));
  assert.ok(/greeting never decoded here/.test(pre.snapshot().stateText));
  // Never connected: no greeting sentence (there was no link to greet on).
  const no = new PacketLinkStory();
  ['rx 1:Fm G To M <DM F=1 >[1]'].forEach((f) => no.noteFrame(f));
  assert.ok(!/greeting/.test(no.snapshot().stateText), no.snapshot().stateText);
});
test('a gateway that takes our frames, then hangs up', () => {
  const s = new PacketLinkStory();
  ['rx 1:Fm G To M <UA F=1 >[1]', 'rx 1:Fm G To M <RR R3 F=1 >[2]', 'rx 1:Fm G To M <DISC P=1 >[3]', 'tx 1:Fm M To G <UI >[4]', 'not a frame'].forEach((f) => s.noteFrame(f));
  const snap = s.snapshot();
  assert.ok(/the gateway's acknowledgement count reached R3/.test(snap.stateText), snap.stateText);
  assert.deepStrictEqual(snap.end, { by: 'gateway', text: 'it sent DISC', state: '' });
  assert.strictEqual(WinlinkOutcome.endedByText({ modemEnd: snap.end, mode: 'packet' }), 'the gateway (it sent DISC)');
  assert.strictEqual(new PacketLinkStory().snapshot().stateText, 'Dire Wolf heard no frame from the gateway');
});
test('main.js: a packet session has a link story, fed by the monitor, and the frames reach Report a Bug', () => {
  assert.ok(/mode === 'packet' \? new DirewolfAgwMonitor\.PacketLinkStory\(\) : null;/.test(main));
  const mon = fnSrc(main, 'winlinkAgwMonitorStart');
  assert.ok(/_winlinkLinkStory\.noteFrame\(text\);/.test(mon));
  assert.ok(/direwolfRingPush\(`heard: \$\{text\}`\);/.test(mon), 'Dire Wolf\'s stdout arrives late or never; the monitor lines go in the same block');
  const line = WinlinkOutcome.summaryLine({ outcome: { kind: 'done' }, mode: 'packet', modemState: 'x'.repeat(300) });
  assert.ok(line.includes('last modem state: ' + 'x'.repeat(240) + ';'), 'room for the packet story');
});

console.log('the rig editor: the choice round-trips');
test('the select offers the three choices, labelled from the module', () => {
  const row = html.slice(html.indexOf('id="rig-packet-mode"'), html.indexOf('id="rig-lan-voice-ssb"'));
  assert.ok(row.includes(`<label>${P.SETTING_LABEL}:`), 'label');
  const opts = [...row.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(opts, [['auto', 'Automatic'], ['fm', 'FM (voice)'], ['fmdata', 'FM data']]);
  assert.deepStrictEqual(opts, P.CHOICES.map((c) => [c, P.LABELS[c]]));
  assert.ok(row.includes(P.SETTING_HELP.replace(/&/g, '&amp;')), 'help text is the module\'s');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(row));
});
test('save writes rig.packetMode for fm / fmdata and removes it for Automatic; open reads it back', () => {
  // The editor's own expressions, run on values.
  const saveExpr = /const rigPacketMode = (packetModeEl && \(packetModeEl\.value === 'fm' \|\| packetModeEl\.value === 'fmdata'\) \? packetModeEl\.value : '');/.exec(app);
  assert.ok(saveExpr, 'the save expression');
  const save = new Function('packetModeEl', 'return ' + saveExpr[1]);
  const loadExpr = /packetModeEl\.value = (rig\.packetMode === 'fm' \|\| rig\.packetMode === 'fmdata' \? rig\.packetMode : 'auto');/.exec(app);
  assert.ok(loadExpr, 'the load expression');
  const load = new Function('rig', 'return ' + loadExpr[1]);
  assert.ok(app.includes("if (rigPacketMode) rig.packetMode = rigPacketMode; else delete rig.packetMode;"), 'edit an existing rig');
  assert.ok(app.includes("...(rigPacketMode ? { packetMode: rigPacketMode } : {}),"), 'a new rig');
  for (const choice of P.CHOICES) {
    const stored = save({ value: choice });
    const rig = JSON.parse(JSON.stringify(stored ? { id: 'r', packetMode: stored } : { id: 'r' })); // settings.json and back
    assert.strictEqual(load(rig), choice, choice + ' comes back as itself');
    assert.strictEqual(P.resolvePacketRigMode({ choice: rig.packetMode, family: 'icom' }).choice, choice);
    assert.strictEqual('packetMode' in rig, choice !== 'auto', 'Automatic is the absence of the key');
  }
  assert.strictEqual(save({ value: 'junk' }), ''); assert.strictEqual(load({ packetMode: 'junk' }), 'auto'); assert.strictEqual(load({}), 'auto');
  assert.ok(app.includes("{ const v = document.getElementById('set-packet-mode'); if (v) v.value = 'auto'; }"), 'a new rig starts on Automatic');
});
test('the editor asks main what the choice means for the rig being edited', () => {
  assert.ok(/getPacketRigMode: \(q\) => ipcRenderer\.invoke\('get-packet-rig-mode', q\),/.test(readSrc(path.join(ROOT, 'preload.js'))));
  assert.ok(/ipcMain\.handle\('get-packet-rig-mode'/.test(main));
  assert.ok(/window\.api\.getPacketRigMode\(\{ model: rigSetupModelName\(\), radioType: getSelectedRadioType\(\), choice: sel\.value \}\)/.test(app));
  assert.strictEqual(P.editorNote(rigIn('icom', 'IC-7100')), 'Automatic on this radio: FM data (FM-D).');
  assert.strictEqual(P.editorNote(rigIn('serialcat', 'FT-857')), 'Automatic on this radio: FM (voice).');
  assert.strictEqual(P.editorNote(rigIn('serialcat', 'FT-857', 'fmdata')), 'This radio reports PKT as FM, so POTACAT cannot confirm it: check the radio\'s display during the session.');
  assert.strictEqual(P.editorNote(rigIn('serialcat', 'TS-2000', 'fmdata')), 'Set the radio to its FM data mode yourself: POTACAT has no command for it on this radio, and leaves the radio\'s mode alone.');
  assert.strictEqual(P.editorNote(rigIn('icom', 'IC-7100', 'fm')), '');
});

console.log('setup notes and the mode list');
test('FT-817/818, FT-857 and FT-897 get the packet tip, with its source and no menu path', () => {
  for (const model of ['FT-817/818', 'FT-857', 'FT-897']) for (const radioType of ['serialcat', 'hamlib', 'rigctldnet']) {
    const n = resolveSetupNotes({ model, modelInfo: RIG_MODELS[model], radioType, platform: 'win32' }).find((x) => x.id === 'yaesu-legacy-packet-pkt');
    assert.ok(n, `${model}/${radioType}: rigctld users see the tip too (#300)`); assert.strictEqual(n.level, 'tip'); assert.ok(/#128/.test(n.source));
    assert.ok(n.steps[0].includes(`"${P.SETTING_LABEL}" to ${P.LABELS.fmdata}`), 'names the setting as the editor shows it');
    assert.ok(!n.steps.some((s) => /MENU|No\.? ?\d|→/.test(s)), 'no radio menu path: none was checked against the manual');
  }
  assert.ok(!resolveSetupNotes({ model: 'FT-710', modelInfo: RIG_MODELS['FT-710'], radioType: 'serialcat', platform: 'win32' }).some((x) => x.id === 'yaesu-legacy-packet-pkt'));
  assert.ok(!resolveSetupNotes({ model: 'FT-857', modelInfo: RIG_MODELS['FT-857'], radioType: 'flrig', platform: 'win32' }).some((x) => x.id === 'yaesu-legacy-packet-pkt'), 'not behind flrig: flrig picks its own name for the mode');
});
test('an IC-7100 on Hamlib is told that the CI-V connection takes FM-D (#300)', () => {
  const has = (radioType) => resolveSetupNotes({ model: 'IC-7100', modelInfo: RIG_MODELS['IC-7100'], radioType, platform: 'win32' }).some((x) => x.id === 'ic7100-packet-civ');
  assert.ok(has('hamlib') && has('rigctldnet')); assert.ok(!has('icom'));
  assert.ok(html.includes('> Other Rig (Hamlib)</label>') && html.includes('> Icom (CI-V)</label>'), 'the note names the editor\'s own labels');
});
test('the packet mode note appears in the mode list only when the operator has something to set', () => {
  const base = { rigFamily: 'serial', ardopSocketAudio: true, direwolfFound: true, ardopFound: true, varaFm: { enabled: true, port: 8310 }, platform: 'win32' };
  const byHand = P.resolvePacketRigMode(rigIn('serialcat', 'TS-2000', 'fmdata')).note;
  const withNote = WinlinkModes.winlinkModesFor({ ...base, fmModeNote: byHand });
  assert.strictEqual(withNote.find((m) => m.id === 'packet').note, byHand);
  assert.strictEqual(withNote.find((m) => m.id === 'varafm').note, byHand);
  assert.strictEqual(withNote.find((m) => m.id === 'ardop').note, '', 'HF modes are not FM');
  assert.strictEqual(WinlinkModes.winlinkModesFor(base).find((m) => m.id === 'packet').note, '');
  const noCat = WinlinkModes.winlinkModesFor({ ...base, rigFamily: 'none', fmModeNote: byHand });
  assert.ok(/^No CAT control/.test(noCat.find((m) => m.id === 'packet').note), 'the no-CAT line already says to set the radio by hand');
  assert.ok(/fmModeNote: \(\(\) => \{ const pm = winlinkPacketRigMode\('packet'\); return pm && pm\.byHand && family !== 'none' \? pm\.note : ''; \}\)\(\),/.test(main));
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
