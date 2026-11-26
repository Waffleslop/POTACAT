#!/usr/bin/env node
'use strict';
/**
 * Per-rig "where is your sound card interface plugged in?" (GitHub #153,
 * lib/rig-audio-jack.js): the one rule for whether a transmission puts the
 * radio in a DATA mode.
 *   - Microphone jack: never DATA, on any path (FT8, FT4, WSPR, PSK, JS8,
 *     FreeDV, SSTV, Winlink HF and packet, voice), and the log says why.
 *   - Data jack (default, every rig before #153): today's behaviour, with the
 *     global JTCAT / SSB-over-DATA settings as the fallback; the tick box,
 *     once set, decides voice macros and ECHOCAT voice, Yaesu included.
 * Nothing transmits here.
 *
 * Run: node test/rig-audio-jack-test.js
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const J = require('../lib/rig-audio-jack');
const { plainSsbForDigital } = require('../lib/plain-ssb-for-digital');
const PacketRigMode = require('../lib/packet-rig-mode');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('=== the rig\'s setting ===');
t('a rig with no setting is on the data jack', () => {
  assert.strictEqual(J.jackOf({ id: 'r' }, 'serial'), 'data');
  assert.strictEqual(J.jackOf(null), 'data');
  assert.strictEqual(J.jackOf({ audioJack: 'banana' }, 'serial'), 'data');
});
t('mic jack on a sound-card radio', () => {
  for (const fam of ['serial', 'icom', 'hamlib', 'rigctld', 'flrig', 'commander', 'generic']) {
    assert.strictEqual(J.jackOf({ audioJack: 'mic' }, fam), 'mic', fam);
  }
});
t('a network or no-CAT radio has no jack: always data', () => {
  for (const fam of ['flex', 'tci', 'icom-network', 'yaesu-lan', 'none']) {
    assert.strictEqual(J.jackOf({ audioJack: 'mic' }, fam), 'data', fam);
  }
});
t('the tick box: unset follows the global, set is the rig\'s own', () => {
  assert.strictEqual(J.voiceSwitchOf({}), null);
  assert.strictEqual(J.voiceSwitchOf({ voiceDataSwitch: true }), true);
  assert.strictEqual(J.voiceSwitchOf({ voiceDataSwitch: false }), false);
  assert.strictEqual(J.voiceSwitchOf({ voiceDataSwitch: 'yes' }), null);
});

console.log('=== tunes: every digital path, mic jack vs data jack ===');
const DIGITAL_TUNES = [
  ['FT8', 'FT8 / JTCAT', 'USB'], ['FT4', 'FT4', 'USB'], ['FT2', 'FT2', 'USB'],
  ['WSPR', 'WSPR', 'USB'], ['PSK31', 'PSK', 'USB'], ['JS8', 'JS8', 'USB'], ['JTTY', 'JTTY', 'USB'],
  ['DIGU', 'WSPR hop / APRS 30 m / DIGU tune', 'USB'], ['PKTUSB', 'PKTUSB', 'USB'], ['DIGL', 'DIGL', 'LSB'],
];
for (const [mode, what, voice] of DIGITAL_TUNES) {
  t(`${what}: mic jack -> ${voice}, with the log line`, () => {
    const r = J.tuneMode(mode, { jack: 'mic', useDataMode: true });
    assert.strictEqual(r.mode, voice);
    assert.ok(/sound card interface is on the microphone jack/.test(r.log), r.log);
    assert.ok(r.log.startsWith(`[tune] ${mode} -> ${voice}:`), r.log);
  });
  t(`${what}: data jack, global on -> unchanged (today)`, () => {
    const r = J.tuneMode(mode, { jack: 'data', useDataMode: true });
    assert.strictEqual(r.mode, mode);
    assert.strictEqual(r.log, '');
  });
}
t('Winlink HF (purpose winlink): mic jack -> USB; data jack keeps DIGU even with the JTCAT setting off', () => {
  assert.strictEqual(J.tuneMode('DIGU', { jack: 'mic', purpose: 'winlink' }).mode, 'USB');
  assert.strictEqual(J.tuneMode('DIGU', { jack: 'data', useDataMode: false, purpose: 'winlink' }).mode, 'DIGU');
});
t('FreeDV (DIGU/DIGL from its own setting): mic jack -> USB/LSB; data jack left to its own setting', () => {
  assert.strictEqual(J.tuneMode('DIGU', { jack: 'mic', freedv: true }).mode, 'USB');
  assert.strictEqual(J.tuneMode('DIGL', { jack: 'mic', freedv: true }).mode, 'LSB');
  assert.strictEqual(J.tuneMode('DIGU', { jack: 'data', useDataMode: false, freedv: true }).mode, 'DIGU');
});
t('packet FM data names: mic jack -> FM', () => {
  assert.strictEqual(J.tuneMode('DIGFM', { jack: 'mic' }).mode, 'FM');
  assert.strictEqual(J.tuneMode('PKTFM', { jack: 'mic' }).mode, 'FM');
});
t('voice, CW, FM, AM and no mode are never touched', () => {
  for (const m of ['USB', 'LSB', 'CW', 'FM', 'AM', 'SSB']) {
    assert.strictEqual(J.tuneMode(m, { jack: 'mic' }).mode, m, m);
    assert.strictEqual(J.tuneMode(m, { jack: 'mic' }).log, '', m);
  }
  assert.strictEqual(J.tuneMode(undefined, { jack: 'mic' }).mode, undefined);
});
t('the global fallback when unset: data jack with "DATA mode for FT8" off is exactly plainSsbForDigital, same log', () => {
  for (const m of ['FT8', 'FT4', 'DIGU', 'DIGL', 'PSK31', 'WSPR', 'CW', 'USB']) {
    const r = J.tuneMode(m, { useDataMode: false });
    assert.strictEqual(r.mode, plainSsbForDigital(m, { useDataMode: false }), m);
    if (r.mode !== m) assert.strictEqual(r.log, `[tune] ${m} -> ${r.mode}: "Switch radio to DATA mode (PKTUSB) for FT8 / FT4 (JTCAT)" is off`);
  }
});
t('TCI data flag: the global on a data jack, off on a mic jack', () => {
  assert.strictEqual(J.digitalUsesData({ jack: 'data', useDataMode: true }), true);
  assert.strictEqual(J.digitalUsesData({ jack: 'data', useDataMode: false }), false);
  assert.strictEqual(J.digitalUsesData({ jack: 'mic', useDataMode: true }), false);
});

console.log('=== packet and Voice in DATA mode ===');
t('packet: mic jack runs plain FM even when the choice is FM data or Automatic on an Icom', () => {
  assert.strictEqual(J.packetChoice('fmdata', 'mic'), 'fm');
  assert.strictEqual(J.packetChoice(undefined, 'mic'), 'fm');
  const r = PacketRigMode.resolvePacketRigMode({ choice: J.packetChoice(undefined, 'mic'), family: 'icom', brand: 'Icom', protocol: 'civ' });
  assert.strictEqual(r.want, 'fm');
  assert.deepStrictEqual(PacketRigMode.keyDownOpts({ icom: true, resolved: r }), { forceDataMode: false, noDataSwap: true });
});
t('packet: data jack keeps the choice (Automatic still FM-D on an Icom)', () => {
  assert.strictEqual(J.packetChoice('fmdata', 'data'), 'fmdata');
  assert.strictEqual(J.packetChoice(undefined, 'data'), undefined);
  assert.strictEqual(PacketRigMode.resolvePacketRigMode({ choice: J.packetChoice(undefined, 'data'), family: 'icom', brand: 'Icom', protocol: 'civ' }).want, 'fmdata');
});
t('Voice in DATA mode applies only on the data jack', () => {
  assert.strictEqual(J.voiceAsDataOn({ voiceAsData: true }, 'data'), true);
  assert.strictEqual(J.voiceAsDataOn({ voiceAsData: true }, 'mic'), false);
  assert.strictEqual(J.voiceAsDataOn({}, 'data'), false);
});

console.log('=== key-downs: SSTV, Winlink, voice macros, ECHOCAT voice ===');
// What handleRemotePtt did before #153, for the "unchanged when unset" check.
function before({ ssbOverData, forced, yaesu, freedvRunning, voiceAsData }) {
  const forceData = !!forced;
  const yaesuVoice = !forceData && !!yaesu && !freedvRunning;
  const voiceInData = !forceData && !!voiceAsData;
  return { swap: (!!ssbOverData || forceData) && !yaesuVoice && !voiceInData, yaesuWarn: !!ssbOverData && !forceData && yaesuVoice };
}
function after(o) {
  const p = J.pttDataPlan(o);
  return { swap: p.want && !p.yaesuVoice && !p.voiceInData, yaesuWarn: p.yaesuSkip, plan: p };
}
t('unset (data jack, no tick box): every combination decides exactly as before', () => {
  for (const ssbOverData of [false, true]) for (const forced of [false, true]) for (const yaesu of [false, true])
    for (const freedvRunning of [false, true]) for (const voiceAsData of [false, true]) {
      const o = { ssbOverData, forced, yaesu, freedvRunning, voiceAsData };
      const b = before(o);
      const a = after({ jack: 'data', voiceSwitch: null, ...o });
      assert.strictEqual(a.swap, b.swap, JSON.stringify(o));
      assert.strictEqual(a.yaesuWarn, b.yaesuWarn, JSON.stringify(o));
      assert.strictEqual(a.plan.forceData, forced, JSON.stringify(o));
      assert.strictEqual(a.plan.micSkip, false);
    }
});
t('SSTV / Winlink on an Icom (forced): data jack switches, mic jack does not and logs it', () => {
  const d = J.pttDataPlan({ jack: 'data', forced: true });
  assert.ok(d.want && d.forceData);
  const m = J.pttDataPlan({ jack: 'mic', forced: true });
  assert.strictEqual(m.want, false);
  assert.strictEqual(m.forceData, false);
  assert.strictEqual(m.micSkip, true);
});
t('voice macro / ECHOCAT voice, tick box ON: switches on the data jack, Yaesu included', () => {
  const y = J.pttDataPlan({ jack: 'data', voiceSwitch: true, ssbOverData: false, yaesu: true });
  assert.ok(y.want && !y.yaesuVoice && !y.yaesuSkip, JSON.stringify(y));
  assert.ok(/switch voice to DATA/.test(y.reason));
  const i = J.pttDataPlan({ jack: 'data', voiceSwitch: true, ssbOverData: false, yaesu: false });
  assert.ok(i.want && !i.yaesuVoice);
});
t('voice macro / ECHOCAT voice, tick box OFF: no switch even with the global SSB-over-DATA on', () => {
  const p = J.pttDataPlan({ jack: 'data', voiceSwitch: false, ssbOverData: true, yaesu: false });
  assert.strictEqual(p.want, false);
  assert.strictEqual(p.yaesuSkip, false);
  // ... but a forced path (SSTV on an Icom) still switches: the tick box is about voice.
  assert.strictEqual(J.pttDataPlan({ jack: 'data', voiceSwitch: false, forced: true }).want, true);
});
t('voice, mic jack: never switches, tick box or global; logs only when a switch would have happened', () => {
  for (const vs of [null, true, false]) {
    const p = J.pttDataPlan({ jack: 'mic', voiceSwitch: vs, ssbOverData: true, yaesu: false });
    assert.strictEqual(p.want, false);
  }
  assert.strictEqual(J.pttDataPlan({ jack: 'mic', ssbOverData: true }).micSkip, true);
  assert.strictEqual(J.pttDataPlan({ jack: 'mic', ssbOverData: false }).micSkip, false);
});
t('Voice in DATA mode rig with the tick box on: already in DATA, no second switch', () => {
  const p = J.pttDataPlan({ jack: 'data', voiceSwitch: true, voiceAsData: true });
  assert.strictEqual(p.voiceInData, true);
});

console.log('=== the log lines ===');
t('mic jack key-down log names the jack, where to change it, and the mode', () => {
  const s = J.micJackPttLog({ txKind: 'sstv', forced: true, mode: 'USB' });
  assert.strictEqual(s, '[PTT] staying in USB: this rig\'s sound card interface is on the microphone jack (Settings > Radio, Edit the rig), so SSTV goes out without a switch to a DATA mode');
  assert.ok(/so Winlink goes out/.test(J.micJackPttLog({ txKind: 'winlink', forced: true, mode: 'USB' })));
  assert.ok(/so voice goes out/.test(J.micJackPttLog({ mode: 'LSB' })));
  assert.ok(/staying in its voice mode/.test(J.micJackPttLog({})));
});
t('mic jack tune log', () => {
  assert.strictEqual(J.micJackTuneLog('ft8', 'USB'), '[tune] FT8 -> USB: this rig\'s sound card interface is on the microphone jack (Settings > Radio, Edit the rig), so POTACAT does not switch the radio to a DATA mode');
});

console.log('=== the editor\'s words ===');
t('the Icom warning is in the microphone-jack help, plainly', () => {
  assert.ok(/Icom/.test(J.HELP_MIC));
  assert.ok(/silent carrier/.test(J.HELP_MIC));
  assert.ok(/SSTV and Winlink/.test(J.HELP_MIC));
  for (const s of [J.QUESTION, J.CHOICE_DATA, J.CHOICE_MIC, J.HELP_DATA, J.HELP_MIC, J.VOICE_SWITCH_LABEL, J.VOICE_SWITCH_HELP]) {
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(s), 'no emoji');
  }
});
t('the question shows for sound-card radio types only', () => {
  for (const rt of ['serialcat', 'icom', 'civ-tcp', 'hamlib', 'rigctldnet', 'flrig', 'dxlab-commander', 'tcpcat']) assert.ok(J.appliesToRadioType(rt), rt);
  for (const rt of ['flex', 'tci', 'icom-network', 'yaesu-lan', 'nocat']) assert.ok(!J.appliesToRadioType(rt), rt);
});

console.log('=== wiring: every DATA-mode decision goes through the rule ===');
const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
function fnBody(sig) {
  const at = MAIN.indexOf(sig);
  assert.ok(at >= 0, 'missing ' + sig);
  return MAIN.slice(at, MAIN.indexOf('\n}\n', at));
}
t('activeRigAudioJack resolves the active rig through RigAudioJack.jackOf with its family', () => {
  const b = fnBody('function activeRigAudioJack(');
  assert.ok(/RigAudioJack\.jackOf\(rig, family\)/.test(b));
  assert.ok(/RigFamily\.rigFamily\(rig\)/.test(b));
  assert.ok(/RigAudioJack\.voiceSwitchOf\(rig\)/.test(b));
});
t('tuneRadio: the digital tune goes through RigAudioJack.tuneMode; PlainSsbForDigital is not called in main', () => {
  const b = fnBody('function tuneRadio(');
  assert.ok(/RigAudioJack\.tuneMode\(mode, \{ jack: activeRigAudioJack\(\)\.jack/.test(b));
  assert.ok(!/PlainSsbForDigital/.test(MAIN));
});
t('tciRigTune: the data flag goes through RigAudioJack.digitalUsesData', () => {
  const b = fnBody('function tciRigTune(');
  assert.ok(/dataMode: RigAudioJack\.digitalUsesData\(/.test(b));
});
t('winlinkPacketRigMode: the choice goes through RigAudioJack.packetChoice', () => {
  const b = fnBody('function winlinkPacketRigMode(');
  assert.ok(/choice: RigAudioJack\.packetChoice\(rig && rig\.packetMode, jack\)/.test(b));
  assert.strictEqual((MAIN.match(/PacketRigMode\.resolvePacketRigMode\(/g) || []).length, 2, 'session resolver + the editor note only');
});
t('Voice in DATA mode at connect goes through RigAudioJack.voiceAsDataOn', () => {
  assert.ok(/cat\.setVoiceAsData\(vOn\)/.test(MAIN));
  assert.ok(/const vOn = RigAudioJack\.voiceAsDataOn\(vRig, vJack\)/.test(MAIN));
  assert.ok(!/cat\.setVoiceAsData\(!!\(vRig && vRig\.voiceAsData\)\)/.test(MAIN));
});
t('handleRemotePtt: the DATA switch is decided by RigAudioJack.pttDataPlan only', () => {
  const b = fnBody('function handleRemotePtt(');
  assert.ok(/RigAudioJack\.pttDataPlan\(\{/.test(b));
  assert.ok(/const forceData = _dataPlanJack\.forceData;/.test(b));
  assert.ok(/if \(state && _dataPlanJack\.want && !opts\.noDataSwap && !yaesuVoice && !voiceInData && audioActive && \(!ft8Engine \|\| forceData\)\) \{/.test(b));
  assert.ok(!/const forceData = !!opts\.forceDataMode/.test(b), 'no second forced-DATA source');
  assert.ok(!/settings\.ssbOverData \|\| forceData/.test(b), 'the global is read by the rule only');
  assert.ok(!/_voiceRig\.voiceAsData/.test(b));
  assert.ok(/RigAudioJack\.micJackPttLog\(/.test(b), 'the mic-jack skip is logged');
  assert.ok(/_dataPlanJack\.micSkip && !opts\.noDataSwap && audioActive && \(!ft8Engine \|\| opts\.forceDataMode\)/.test(b),
    'logged only where a switch would have happened (never for FT8 with the engine running)');
  assert.ok(/_dataPlanJack\.reason/.test(b), 'the switch says why');
});
t('the emission handed to the licence and Guest Pass checks is still what goes out (from the caller, not the jack)', () => {
  const b = fnBody('function handleRemotePtt(');
  assert.ok(/const pttEmission = opts\.emission \|\| \(opts\.forceDataMode \? 'DATA' : null\);/.test(b));
  assert.ok(b.indexOf('const pttEmission') < b.indexOf('RigAudioJack.pttDataPlan'), 'decided before the jack rule');
  assert.ok(/ownTxPrivilegeRefused\(pttEmission \|\| _currentMode, opts\.freqHz\)/.test(b));
});
t('no other main.js line reads ssbOverData or decides the FT8 DATA flag', () => {
  const ssb = MAIN.split('\n').filter((l) => /settings\.ssbOverData/.test(l));
  assert.strictEqual(ssb.length, 1, ssb.join('\n'));
  assert.ok(/RigAudioJack|ssbOverData: !!settings\.ssbOverData/.test(ssb[0]));
  const jt = MAIN.split('\n').filter((l) => /settings\.jtcatUseDataMode/.test(l) && !/^\s*\/\//.test(l));
  for (const l of jt) assert.ok(/RigAudioJack\.(tuneMode|digitalUsesData)|jtcatUseDataMode: settings\.jtcatUseDataMode !== false,$/.test(l.trim()), l);
});
t('ECHOCAT is told the jack (read-only) next to jtcatUseDataMode', () => {
  assert.ok(/rigAudioJack: activeRigAudioJack\(\)\.jack,/.test(MAIN));
});

console.log('=== the rig editor ===');
const HTML = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
const APP = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
t('index.html loads the rule before app.js', () => {
  const at = HTML.indexOf('<script src="../lib/rig-audio-jack.js"></script>');
  assert.ok(at > 0);
  assert.ok(at < HTML.indexOf('<script src="app.js"></script>'));
});
t('one question, two choices, the tick box under the data jack, the help with the Icom warning', () => {
  assert.ok(HTML.includes('id="rig-audio-jack"'));
  assert.ok(HTML.includes(J.QUESTION));
  assert.ok(/<input type="radio" name="rig-audio-jack" id="set-audio-jack-data" value="data"/.test(HTML));
  assert.ok(/<input type="radio" name="rig-audio-jack" id="set-audio-jack-mic" value="mic"/.test(HTML));
  assert.ok(HTML.includes(J.CHOICE_DATA) && HTML.includes(J.CHOICE_MIC));
  assert.ok(HTML.includes(J.HELP_DATA.replace(/'/g, '&rsquo;')) || HTML.includes(J.HELP_DATA));
  assert.ok(HTML.includes(J.HELP_MIC.replace(/'/g, '&rsquo;')) || HTML.includes(J.HELP_MIC));
  assert.ok(HTML.includes(J.VOICE_SWITCH_LABEL));
  const d = HTML.indexOf('id="set-audio-jack-data"'), box = HTML.indexOf('id="set-voice-data-switch"'), m = HTML.indexOf('id="set-audio-jack-mic"');
  assert.ok(d < box && box < m, 'the tick box sits under the data-jack choice');
});
t('app.js saves the jack per rig (absent = data jack) and the tick box only once set', () => {
  assert.ok(/if \(rigAudioJack === 'mic'\) rig\.audioJack = 'mic'; else delete rig\.audioJack;/.test(APP));
  assert.ok(/if \(typeof rigVoiceDataSwitch === 'boolean'\) rig\.voiceDataSwitch = rigVoiceDataSwitch; else delete rig\.voiceDataSwitch;/.test(APP));
  // A new rig: the record is built by lib/rig-record.js (shared with the first run).
  assert.ok(/audioJack: rigAudioJack,/.test(APP));
  assert.ok(/\.\.\.\(v\.audioJack === 'mic' \? \{ audioJack: 'mic' \} : \{\}\)/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'rig-record.js'), 'utf8')));
  assert.ok(/RigAudioJack\.appliesToRadioType\(type\)/.test(APP), 'shown for sound-card radios only');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
