'use strict';
// Rig presets (lib/rig-presets.js): named TX power / RF gain / AF gain sets,
// applied by a tap or when the rig's mode moves into an assigned family.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RP = require('../lib/rig-presets');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

console.log('rig-presets: families');
test('rig modes map to the five families, VFO/memory names to none', () => {
  assert.strictEqual(RP.modeFamily('USB'), 'ssb');
  assert.strictEqual(RP.modeFamily('lsb'), 'ssb');
  assert.strictEqual(RP.modeFamily('CW'), 'cw');
  assert.strictEqual(RP.modeFamily('CWR'), 'cw');
  assert.strictEqual(RP.modeFamily('USB-D'), 'digital');
  assert.strictEqual(RP.modeFamily('USB-D2'), 'digital');
  assert.strictEqual(RP.modeFamily('DIGU'), 'digital');
  assert.strictEqual(RP.modeFamily('PKTUSB'), 'digital');
  assert.strictEqual(RP.modeFamily('RTTY'), 'digital');
  assert.strictEqual(RP.modeFamily('FT8'), 'digital');
  assert.strictEqual(RP.modeFamily('FREEDV-RADEV1'), 'digital');
  assert.strictEqual(RP.modeFamily('FM'), 'fm');
  assert.strictEqual(RP.modeFamily('AM'), 'am');
  assert.strictEqual(RP.modeFamily(''), null);
  assert.strictEqual(RP.modeFamily('MEM-12'), null);
  assert.strictEqual(RP.modeFamily(undefined), null);
});

console.log('rig-presets: sanitize');
test('junk is dropped, ids are minted, out-of-range levels are removed, unknown keys ride through', () => {
  const list = RP.sanitizePresets([
    { name: ' FT8 ', txPower: 60, rfGain: '50', afGain: 0, extra: 'kept' },
    { name: 'Bad power', txPower: 9000, rfGain: 120 },
    { name: '' },
    null, 'x', [],
    { id: 'dup', name: 'A' }, { id: 'dup', name: 'B' },
  ]);
  assert.strictEqual(list.length, 4);
  assert.strictEqual(list[0].name, 'FT8');
  assert.ok(list[0].id);
  assert.deepStrictEqual([list[0].txPower, list[0].rfGain, list[0].afGain], [60, 50, 0]);
  assert.strictEqual(list[0].extra, 'kept');
  assert.strictEqual(list[1].txPower, undefined, 'a 9000 W level is dropped, never sent');
  assert.strictEqual(list[1].rfGain, undefined);
  assert.strictEqual(list[2].id, 'dup');
  assert.notStrictEqual(list[3].id, 'dup', 'a duplicate id gets a fresh one');
});
test('byMode keeps only known families and existing presets', () => {
  const presets = [{ id: 'a', name: 'A' }];
  const m = RP.sanitizeByMode({ rig1: { ssb: 'a', digital: 'gone', bogus: 'a' }, '*': { cw: 'a' }, junk: null }, presets);
  assert.deepStrictEqual(m, { rig1: { ssb: 'a' }, '*': { cw: 'a' } });
  assert.deepStrictEqual(RP.sanitizeByMode(null), {});
});

console.log('rig-presets: per rig');
test('a preset saved for one rig is not offered on another; any-rig presets are', () => {
  const presets = [{ id: 'a', name: 'A', rigId: 'r1' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', rigId: 'r2' }];
  assert.deepStrictEqual(RP.presetsForRig(presets, 'r1').map(p => p.id), ['a', 'b']);
  assert.deepStrictEqual(RP.presetsForRig(presets, null).map(p => p.id), ['b']);
  assert.deepStrictEqual(RP.byModeForRig({ r1: { ssb: 'a' }, '*': { ssb: 'b' } }, 'r1'), { ssb: 'a' });
  assert.deepStrictEqual(RP.byModeForRig({ '*': { ssb: 'b' } }, 'r1'), { ssb: 'b' }, 'falls back to the any-rig map');
});

console.log('rig-presets: commands');
test('one dispatcher command per level the preset holds and the rig takes', () => {
  const p = { id: 'x', name: 'X', txPower: 60, rfGain: 50, afGain: 0 };
  assert.deepStrictEqual(RP.presetCommands(p).map(c => c.action), ['set-tx-power', 'set-rf-gain', 'set-af-gain']);
  assert.deepStrictEqual(RP.presetCommands(p, { txpower: true, rfgain: false, afgain: true }).map(c => c.action), ['set-tx-power', 'set-af-gain']);
  assert.deepStrictEqual(RP.presetCommands({ id: 'y', name: 'Y' }), [], 'an empty preset sends nothing');
  assert.strictEqual(RP.presetCommands(p)[2].value, 0, 'AF 0 is a real level, not "unset"');
});
test('describePreset names the levels and the ones this rig cannot set', () => {
  const p = { id: 'x', name: 'X', txPower: 60, rfGain: 50, afGain: 0 };
  assert.strictEqual(RP.describePreset(p).text, '60 W · RF 50% · AF 0%');
  const d = RP.describePreset(p, { txpower: true, rfgain: true, afgain: false });
  assert.strictEqual(d.text, '60 W · RF 50%');
  assert.deepStrictEqual(d.skipped, ['AF 0%']);
});

console.log('rig-presets: snapshot');
test('a snapshot takes only levels the radio reported; power 0 is unknown', () => {
  const p = RP.snapshotPreset('Now', { txPower: 100, rfGain: 80, afGain: null }, { rigId: 'r1' });
  assert.deepStrictEqual([p.name, p.rigId, p.txPower, p.rfGain, p.afGain], ['Now', 'r1', 100, 80, undefined]);
  assert.strictEqual(RP.snapshotPreset('Zero', { txPower: 0, rfGain: 10 }).txPower, undefined);
  assert.strictEqual(RP.snapshotPreset('  ', {}), null);
});

console.log('rig-presets: mode decision');
const presets = [{ id: 'dig', name: 'FT8', txPower: 60, rfGain: 50, afGain: 0 }, { id: 'voice', name: 'SSB', txPower: 100 }];
const byMode = { '*': { digital: 'dig', ssb: 'voice' } };
const base = { presets, byMode, rigId: 'r1' };
test('the first mode seen never moves levels', () => {
  assert.strictEqual(RP.decideModePreset({ ...base, mode: 'USB-D', prevFamily: null }).reason, 'first');
});
test('USB → USB-D applies the digital preset; USB → LSB applies nothing', () => {
  const d = RP.decideModePreset({ ...base, mode: 'USB-D', prevFamily: 'ssb' });
  assert.strictEqual(d.reason, 'apply');
  assert.strictEqual(d.apply.id, 'dig');
  assert.strictEqual(d.family, 'digital');
  assert.strictEqual(RP.decideModePreset({ ...base, mode: 'LSB', prevFamily: 'ssb' }).reason, 'same');
});
test('a family with no preset assigned changes the tracked family and applies nothing', () => {
  const d = RP.decideModePreset({ ...base, mode: 'CW', prevFamily: 'ssb' });
  assert.strictEqual(d.reason, 'unassigned');
  assert.strictEqual(d.family, 'cw');
});
test('a mode change under a key-down is deferred and the family is NOT advanced (SSB-over-DATA PTT)', () => {
  const d = RP.decideModePreset({ ...base, mode: 'USB-D', prevFamily: 'ssb', transmitting: true });
  assert.strictEqual(d.reason, 'transmitting');
  assert.strictEqual(d.family, 'ssb');
  // After the unkey the rig is back in USB: same family, nothing applied.
  assert.strictEqual(RP.decideModePreset({ ...base, mode: 'USB', prevFamily: d.family }).reason, 'same');
});
test('a VFO/memory name keeps the previous family', () => {
  const d = RP.decideModePreset({ ...base, mode: 'MEM-3', prevFamily: 'ssb' });
  assert.strictEqual(d.reason, 'no-family');
  assert.strictEqual(d.family, 'ssb');
});
test('a laptop driving a shack applies nothing (the shack applies its own)', () => {
  assert.strictEqual(RP.decideModePreset({ ...base, mode: 'USB-D', prevFamily: 'ssb', remote: true }).reason, 'remote');
});
test('a preset saved for another rig is not applied on this one', () => {
  const d = RP.decideModePreset({ presets: [{ id: 'dig', name: 'X', rigId: 'r2', txPower: 5 }], byMode: { '*': { digital: 'dig' } }, rigId: 'r1', mode: 'USB-D', prevFamily: 'ssb' });
  assert.strictEqual(d.reason, 'unassigned');
});

console.log('rig-presets: main.js wiring guards');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
test('sendCatMode hands every mode to the preset decision (the one mode sink)', () => {
  const i = mainSrc.indexOf('function sendCatMode(mode)');
  assert.ok(i > 0);
  const body = mainSrc.slice(i, mainSrc.indexOf('\n}\n', i));
  assert.ok(/rigPresetOnMode\(mode\)/.test(body), 'sendCatMode calls rigPresetOnMode(mode)');
});
test('a pending preset is flushed before JTCAT keys, on both TX paths', () => {
  const n = (mainSrc.match(/rigPresetFlushPending\(\)/g) || []).length;
  assert.ok(n >= 2, `expected the flush at both tx-start guards, found ${n}`);
  const single = mainSrc.indexOf('jtcatNoteTxPowerForMode(modeForTx');
  assert.ok(single > 0);
  assert.ok(mainSrc.lastIndexOf('rigPresetFlushPending()', single) > single - 600, 'flush sits just before the single-slice power note');
});
test('the dispatcher has set-af-gain and rigctld gets a 0-1 fraction', () => {
  const i = mainSrc.indexOf("case 'set-af-gain'");
  assert.ok(i > 0);
  const body = mainSrc.slice(i, i + 1200);
  assert.ok(/rigType === 'rigctld'/.test(body) && /value \/ 100/.test(body));
  assert.ok(/setSliceAudioLevel/.test(body), 'a Flex takes audio_level, never audio_mute (that kills the DAX tap)');
});
test('rigPresets and rigPresetByMode are machine-global settings', () => {
  const i = mainSrc.indexOf('const GLOBAL_KEYS = new Set([');
  const block = mainSrc.slice(i, mainSrc.indexOf(']);', i));
  assert.ok(/'rigPresets'/.test(block) && /'rigPresetByMode'/.test(block));
});
test('presets reach every client at connect and on change', () => {
  assert.ok(/remoteServer\.sendRigPresets\(/.test(mainSrc));
  const srv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  assert.ok(/case 'apply-rig-preset'/.test(srv) && /case 'rig-presets-update'/.test(srv));
  assert.ok(/'rig-presets'/.test(srv.slice(srv.indexOf('capabilities: ['), srv.indexOf('capabilities: [') + 4000)), 'hello advertises rig-presets');
  const proto = require('../lib/echocat-protocol');
  ['rig-presets', 'rig-presets-update', 'apply-rig-preset', 'rig-preset-applied'].forEach(t => assert.ok(proto.isKnownType(t), t + ' registered'));
  assert.ok(/type: 'rig-preset-applied'/.test(mainSrc), 'every apply is announced to the devices');
  assert.ok(/byMode: \(msg\.byMode[^\n]*: undefined/.test(srv), 'a missing byMode passes through as undefined, never {} (that wiped the assignments)');
});
test('the JTCAT flush applies although the engine already flagged TX (PTT is not keyed yet)', () => {
  const i = mainSrc.indexOf('function rigPresetFlushPending()');
  const body = mainSrc.slice(i, i + 600);
  assert.ok(/rigPresetSettle\(true\)/.test(body), 'flush forces the settle');
  const j = mainSrc.indexOf('function rigPresetSettle(force)');
  assert.ok(j > 0 && /!force && rigPresetTransmitting\(\)/.test(mainSrc.slice(j, j + 800)));
});

console.log('rig-presets: fields beyond levels (2026-10-24)');
test('switches, AGC and the RX filter sanitize to their kinds; junk is dropped, absent means left alone', () => {
  const [p] = RP.sanitizePresets([{ name: 'Digi', nb: 'off', nr: false, comp: 0, anf: 'maybe', agc: 'FAST', filterWidth: '3000', vox: 'on', preamp: true, att: 'x', txPower: 60 }]);
  assert.strictEqual(p.nb, false); assert.strictEqual(p.nr, false); assert.strictEqual(p.comp, false);
  assert.strictEqual(p.anf, undefined, 'junk switch dropped');
  assert.strictEqual(p.agc, 'fast'); assert.strictEqual(p.filterWidth, 3000); assert.strictEqual(p.vox, true); assert.strictEqual(p.preamp, true);
  assert.strictEqual(p.att, undefined);
  assert.strictEqual(RP.sanitizePresets([{ name: 'x', filterWidth: 10 }])[0].filterWidth, undefined, 'a width under 50 Hz is not a filter');
});
test('one dispatcher command per included setting the rig takes; a switch rides as a boolean, AGC as its word', () => {
  const p = { name: 'Digi', txPower: 60, nb: false, nr: false, comp: false, agc: 'fast', filterWidth: 3000, vox: true };
  const cmds = RP.presetCommands(p, { txpower: true, nb: true, nr: true, comp: false, agc: true, filter: true, vox: true });
  assert.deepStrictEqual(cmds.map(c => [c.action, c.value]), [['set-tx-power', 60], ['set-filter-width', 3000], ['set-nb', false], ['set-nr', false], ['set-agc', 'fast'], ['set-vox', true]]);
  const d = RP.describePreset(p, { txpower: true, nb: true, nr: true, agc: true, filter: true, vox: true });
  assert.strictEqual(d.text, '60 W · Filter 3 kHz · NB off · NR off · AGC fast · VOX on');
  assert.deepStrictEqual(d.skipped, ['Comp off']);
});
test('a snapshot takes every reported setting the radio has, in its kind', () => {
  const p = RP.snapshotPreset('Now', { txPower: 50, nb: true, nr: 0, agc: 'slow', filterWidth: 2400, afGain: 30, comp: 'on' });
  assert.deepStrictEqual({ txPower: p.txPower, nb: p.nb, nr: p.nr, agc: p.agc, filterWidth: p.filterWidth, afGain: p.afGain, comp: p.comp }, { txPower: 50, nb: true, nr: false, agc: 'slow', filterWidth: 2400, afGain: 30, comp: true });
});

console.log('rig-presets: band + mode rules');
const presets2 = [{ id: 'hunt', name: 'Hunting' }, { id: 'h20', name: 'Hunting 20' }, { id: 'dig', name: 'FT8' }];
test('rules sanitize: known bands and families only, a preset that exists, never "any band + any mode"', () => {
  const r = RP.sanitizeRules({ '*': [
    { bands: ['20M', '99m'], families: ['SSB'], presetId: 'h20' },
    { bands: [], families: [], presetId: 'hunt' },
    { bands: ['40m'], families: [], presetId: 'gone' },
    { bands: ['40m'], presetId: 'hunt' },
  ] }, presets2);
  assert.deepStrictEqual(r['*'], [{ bands: ['20m'], families: ['ssb'], presetId: 'h20' }, { bands: ['40m'], families: [], presetId: 'hunt' }]);
});
test('the first matching rule wins; the family select is the fallback; no match = nothing', () => {
  const rules = { '*': [{ bands: ['20m'], families: ['ssb'], presetId: 'h20' }, { bands: ['40m'], families: [], presetId: 'hunt' }] };
  const byMode = { '*': { ssb: 'hunt', digital: 'dig' } };
  assert.deepStrictEqual(RP.matchTrigger({ band: '20m', family: 'ssb', rules, byMode }).presetId, 'h20');
  assert.deepStrictEqual(RP.matchTrigger({ band: '40m', family: 'cw', rules, byMode }).presetId, 'hunt', 'any-mode band rule');
  assert.deepStrictEqual(RP.matchTrigger({ band: '17m', family: 'ssb', rules, byMode }).presetId, 'hunt', 'fallback to the family');
  assert.strictEqual(RP.matchTrigger({ band: '17m', family: 'cw', rules, byMode }).presetId, null);
  assert.strictEqual(RP.matchTrigger({ band: '', family: 'ssb', rules, byMode }).presetId, 'hunt', 'unknown band skips band rules');
});
test('a band change under a band rule applies; the same preset on another band does not re-apply', () => {
  const rules = { '*': [{ bands: ['20m'], families: ['ssb'], presetId: 'h20' }] };
  const byMode = { '*': { ssb: 'hunt' } };
  const common = { presets: presets2, byMode, rules, mode: 'USB', prevFamily: 'ssb' };
  // 40 m SSB (Hunting) → 20 m SSB: the match changes to Hunting 20
  let d = RP.decideModePreset({ ...common, band: '20m', prevMatchId: 'hunt' });
  assert.strictEqual(d.reason, 'apply'); assert.strictEqual(d.apply.id, 'h20'); assert.strictEqual(d.via, 'rule');
  // 20 m → 17 m SSB: back to the family's Hunting
  d = RP.decideModePreset({ ...common, band: '17m', prevMatchId: 'h20' });
  assert.strictEqual(d.reason, 'apply'); assert.strictEqual(d.apply.id, 'hunt'); assert.strictEqual(d.via, 'family');
  // 17 m → 40 m SSB: Hunting again, nothing to do
  assert.strictEqual(RP.decideModePreset({ ...common, band: '40m', prevMatchId: 'hunt' }).reason, 'same');
  // the first dial of the session is never an occasion
  assert.strictEqual(RP.decideModePreset({ ...common, band: '20m', prevFamily: null }).reason, 'first');
});
test('wiring: band changes reach the decision from the one frequency sink; rules are a machine-global setting; two surfaces mount the one editor', () => {
  const i = mainSrc.indexOf('function sendCatFrequency(hz)');
  assert.ok(/rigPresetOnBand\(\)/.test(mainSrc.slice(i, i + 3000)), 'sendCatFrequency calls rigPresetOnBand');
  assert.ok(/'rigPresetRules'/.test(mainSrc.slice(mainSrc.indexOf('const GLOBAL_KEYS = new Set(['), mainSrc.indexOf(']);', mainSrc.indexOf('const GLOBAL_KEYS = new Set([')))));
  assert.ok(/prevMatchId: _rigPresetMatchId/.test(mainSrc) && /rules: settings\.rigPresetRules/.test(mainSrc));
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/rigPresetsMount\(document\.getElementById\('rig-preset-root'\)\);/.test(app) && /rigPresetsMount\(document\.getElementById\('settings-preset-root'\)\);/.test(app));
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('data-tab="profiles">Profiles</button>') && html.includes('data-settings-tab="profiles"') && html.includes('id="settings-preset-root"'));
  const proto = require('../lib/echocat-protocol');
  assert.ok(proto.isKnownType('rig-presets'));
});

test('Monitor (K8IKO): MON on/off and level are preset fields, sent only to a rig that takes them', () => {
  const p = RP.sanitizePresets([{ name: 'FT8', mon: false, monLevel: 40 }])[0];
  assert.strictEqual(p.mon, false);
  assert.strictEqual(p.monLevel, 40);
  assert.deepStrictEqual(RP.presetCommands(p, { mon: true, monLevel: true }), [
    { action: 'set-mon', value: false, field: 'mon' },
    { action: 'set-mon-level', value: 40, field: 'monLevel' },
  ]);
  assert.deepStrictEqual(RP.presetCommands(p, { mon: false, monLevel: false }), []);
  assert.strictEqual(RP.describePreset(p, { mon: true, monLevel: true }).text, 'MON off · MON 40%');
  assert.deepStrictEqual(RP.describePreset(p, {}).skipped, ['MON off', 'MON 40%']);
  assert.strictEqual(RP.sanitizePresets([{ name: 'x', monLevel: 150 }])[0].monLevel, undefined);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/case 'set-mon': \{/.test(main) && /case 'set-mon-level': \{/.test(main), 'the dispatcher verbs the fields name');
});

console.log(`\nrig-presets: ${passed} passed`);
