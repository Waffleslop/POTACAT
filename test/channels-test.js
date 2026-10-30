#!/usr/bin/env node
'use strict';
/**
 * Channels: the saved frequency chart (Casey 2026-10-30; lists from KL4XQ and
 * KC8DHX). The starter catalog, the operator's edits, CHIRP CSV both ways,
 * and the wiring that puts the tab beside Landmarks on every surface.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/channels');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/channels.json'), 'utf8'));

console.log('The starter catalog (data/channels.json)');
check('every entry is usable, ids unique, every entry grouped, modes known', () => {
  assert.deepStrictEqual(C.validateCatalog(catalog), []);
  assert.ok(catalog.channels.length >= 100, 'entries: ' + catalog.channels.length);
});
check('the channels a user asked for are there, with the right frequencies', () => {
  const by = Object.fromEntries(catalog.channels.map((c) => [c.id, c]));
  assert.strictEqual(by['air-guard'].khz, 121500);
  assert.strictEqual(by['frs-gmrs-1'].khz, 462562.5);
  assert.strictEqual(by['frs-gmrs-8'].mode, 'NFM');
  assert.strictEqual(by['gmrs-rpt-15'].offsetKhz, 5000);
  assert.strictEqual(by['murs-4'].khz, 154570);
  assert.strictEqual(by['marine-16'].khz, 156800);
  assert.ok(/distress/i.test(by['marine-16'].note));
  assert.strictEqual(by['interop-vcall10'].khz, 155752.5);
  assert.strictEqual(by['ems-med-1'].khz, 463000);
});
check('nothing personal is bundled: no callsign-named repeaters', () => {
  for (const c of catalog.channels) assert.ok(!/^[AKNW][A-Z]?\d[A-Z]{1,3}$/.test(c.name), c.name);
});

console.log('The operator\'s chart');
check('first use seeds every starter channel as the operator\'s own copy', () => {
  const s = C.reconcile(undefined, catalog);
  assert.strictEqual(s.list.length, catalog.channels.length);
  assert.ok(s.list.every((c) => c.src === 'starter'));
  assert.strictEqual(s.seeded, catalog.version);
});
check('delete a starter channel and it stays gone through a catalog update; Restore brings it back', () => {
  let s = C.reconcile(undefined, catalog);
  s = C.remove(s, 'frs-gmrs-3');
  assert.ok(!s.list.some((c) => c.id === 'frs-gmrs-3'));
  const newer = { ...catalog, version: catalog.version + 1, channels: catalog.channels.concat([{ id: 'new-one', name: 'New', khz: 146520, mode: 'FM', group: 'Test' }]) };
  s = C.reconcile(s, newer);
  assert.ok(!s.list.some((c) => c.id === 'frs-gmrs-3'), 'deleted stays deleted');
  assert.ok(s.list.some((c) => c.id === 'new-one'), 'a new catalog entry is appended');
  s = C.restoreStarter(s, newer);
  assert.ok(s.list.some((c) => c.id === 'frs-gmrs-3'));
});
check('reorder, edit and add', () => {
  let s = C.reconcile(undefined, catalog);
  const last = s.list[s.list.length - 1].id;
  s = C.move(s, last, 0);
  assert.strictEqual(s.list[0].id, last);
  s = C.upsert(s, { id: last, name: 'Renamed', khz: s.list[0].khz, mode: 'AM', group: 'Mine' });
  assert.strictEqual(s.list[0].name, 'Renamed');
  assert.strictEqual(s.list[0].mode, 'AM');
  s = C.upsert(s, { name: 'KL3K', khz: 147510, mode: 'FM', tone: '123.0', group: 'Repeaters' });
  assert.strictEqual(s.list[s.list.length - 1].name, 'KL3K');
  assert.ok(/^ch_/.test(s.list[s.list.length - 1].id));
});
check('bad input is dropped or clipped, never thrown', () => {
  assert.strictEqual(C.sanitizeChannel({ name: 'x' }), null);
  assert.strictEqual(C.sanitizeChannel({ khz: -5 }), null);
  const c = C.sanitizeChannel({ khz: 146520, mode: 'c4fm', name: 'a'.repeat(100), offsetKhz: 'junk' });
  assert.strictEqual(c.mode, 'DIG'); assert.strictEqual(c.name.length, 40); assert.strictEqual(c.offsetKhz, 0);
  assert.deepStrictEqual(C.sanitizeSaved('nope'), { v: 1, list: [], removed: [], seeded: 0 });
});
check('tune modes: FM-shaped modes tune FM, the rest as themselves', () => {
  assert.strictEqual(C.tuneMode('NFM'), 'FM');
  assert.strictEqual(C.tuneMode('DIG'), 'FM');
  assert.strictEqual(C.tuneMode('AM'), 'AM');
  assert.strictEqual(C.tuneMode('USB'), 'USB');
});

console.log('CHIRP CSV');
const KC8DHX = 'Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,URCALL,RPT1CALL,RPT2CALL,DVCODE\n'
  + '0,Air Gaurd,121.500000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,AM,5.00,,5.0W,,,,,\n'
  + '55,GMRS 550/15R,462.550000,+,5.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,S,5.0W,,,,,\n'
  + '81,SEA 16,156.800000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,S,5.0W,"International Distress, Safety and Calling.  Ships required to carry radio, USCG, and most coast stations maintain a listening watch on this channel.",,,,\n'
  + '11,FRS 1,462.562500,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,NFM,5.00,S,5.0W,,,,,\n';
const KL4XQ = 'Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,URCALL,RPT1CALL,RPT2CALL,DVCODE\n'
  + '1,KL3K,145.150000,-,0.600000,Tone,123.0,88.5,023,NN,023,Tone->Tone,FM,5.00,,50W,,,,,\n'
  + '8,,146.640000,-,0.600000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,50W,,,,,\n'
  + '26,KL7CC,147.570000,+,300.000000,Tone,103.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,50W,,,,,\n'
  + '28,KL4GR,443.400000,+,5.000000,,88.5,88.5,023,NN,023,Tone->Tone,DIG,5.00,S,50W,,,,,\n'
  + '42,BCV-WX,135.550000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,AM,25.00,S,,,,,,\n';
check('KC8DHX\'s export: frequencies, duplex offsets, modes, and a quoted comment with commas', () => {
  const r = C.parseChirpCsv(KC8DHX, { group: 'Scanner' });
  assert.strictEqual(r.reason, null);
  assert.strictEqual(r.channels.length, 4);
  const [guard, gmrs, sea16, frs1] = r.channels;
  assert.strictEqual(guard.khz, 121500); assert.strictEqual(guard.mode, 'AM'); assert.strictEqual(guard.offsetKhz, 0);
  assert.strictEqual(gmrs.khz, 462550); assert.strictEqual(gmrs.offsetKhz, 5000);
  assert.ok(/Ships required to carry radio, USCG/.test(sea16.note));
  assert.strictEqual(frs1.khz, 462562.5); assert.strictEqual(frs1.mode, 'NFM');
  assert.ok(r.channels.every((c) => c.group === 'Scanner' && c.src === 'chirp'));
});
check('KL4XQ\'s export: tones, a negative offset, a nameless row, a 300 MHz split, DIG', () => {
  const r = C.parseChirpCsv(KL4XQ);
  assert.strictEqual(r.channels.length, 5);
  const [kl3k, noname, kl7cc, kl4gr, wx] = r.channels;
  assert.strictEqual(kl3k.tone, '123.0'); assert.strictEqual(kl3k.offsetKhz, -600);
  assert.strictEqual(noname.name, '146.64 MHz'); assert.strictEqual(noname.tone, '');
  assert.strictEqual(kl7cc.offsetKhz, 300000);
  assert.strictEqual(kl4gr.mode, 'DIG');
  assert.strictEqual(wx.mode, 'AM');
});
check('not a CHIRP file: a reason, no channels', () => {
  assert.ok(/Frequency column/.test(C.parseChirpCsv('a,b,c\n1,2,3\n').reason));
  assert.ok(/empty/.test(C.parseChirpCsv('').reason));
});
check('export round-trips through CHIRP\'s columns', () => {
  const list = C.parseChirpCsv(KL4XQ).channels.concat(C.parseChirpCsv(KC8DHX).channels);
  const csv = C.toChirpCsv(list);
  assert.strictEqual(csv.split('\n')[0], C.CHIRP_HEADER.join(','));
  const back = C.parseChirpCsv(csv).channels;
  assert.strictEqual(back.length, list.length);
  for (let i = 0; i < list.length; i++) {
    assert.strictEqual(back[i].khz, list[i].khz, list[i].name);
    assert.strictEqual(back[i].offsetKhz, list[i].offsetKhz, list[i].name);
    assert.strictEqual(back[i].tone, list[i].tone, list[i].name);
    assert.strictEqual(back[i].mode, list[i].mode, list[i].name);
    assert.strictEqual(back[i].note, list[i].note, list[i].name);
  }
});

console.log('Wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const view = fs.readFileSync(path.join(ROOT, 'renderer/channels-view.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const rs = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');
const web = fs.readFileSync(path.join(ROOT, 'renderer/remote.js'), 'utf8');
const webHtml = fs.readFileSync(path.join(ROOT, 'renderer/remote.html'), 'utf8');
check('the tab sits beside Landmarks in the Directory, with its own group filter, Add, Import, Export and Restore', () => {
  assert.ok(/id="dirv-tab-channels"/.test(html) && /id="dirv-channels-container"/.test(html));
  for (const id of ['chn-group-filter', 'chn-add', 'chn-import', 'chn-export', 'chn-restore', 'chn-body', 'chn-editor']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(/channels: \[dirvTabChannels, dirvChannelsContainer\]/.test(app));
  assert.ok(/window\.ChannelsView\.render\(search\)/.test(app));
});
check('a click tunes through the one tune path with the channel\'s tune mode', () => {
  assert.ok(/tuneFn\(String\(c\.khz\), C\.tuneMode\(c\.mode\)\)/.test(view));
  assert.ok(/tune: \(khz, mode\) => window\.api\.tune\(khz, mode\)/.test(app));
});
check('edits go through main (channels-save) so ECHOCAT follows; the chart rides every directory push', () => {
  for (const ch of ['channels-get', 'channels-save', 'channels-import-csv', 'channels-export-csv']) assert.ok(main.includes(`ipcMain.handle('${ch}'`), ch);
  assert.ok((main.match(/\.\.\.channelsPayload\(\)/g) || []).length >= 3, 'window push, ECHOCAT push, get-directory');
  assert.ok(/channels: data\.channels \|\| \[\],/.test(rs));
  for (const fn of ['channelsGet', 'channelsSave', 'channelsImportCsv', 'channelsExportCsv']) assert.ok(preload.includes(fn + ':'), fn);
});
check('the import refuses a huge file and reports what it added, skipped and already had', () => {
  const h = main.slice(main.indexOf("ipcMain.handle('channels-import-csv'"), main.indexOf("ipcMain.handle('channels-export-csv'"));
  assert.ok(/5 \* 1024 \* 1024/.test(h) && /Channels\.parseChirpCsv\(text, \{ group \}\)/.test(h) && /return \{ added, dupes, skipped: parsed\.skipped, group \}/.test(h));
});
check('ECHOCAT Web has the tab and tunes from it', () => {
  assert.ok(/data-dtab="channels"/.test(webHtml));
  assert.ok(/function renderDirChannels\(search\)/.test(web) && /if \(Array\.isArray\(msg\.channels\)\) directoryChannels = msg\.channels;/.test(web));
  assert.ok(/type: 'tune', freqKhz: String\(c\.khz\), mode: channelTuneMode\(c\.mode\)/.test(web));
});
check('channels.css uses theme variables only', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer/channels.css'), 'utf8');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css), 'hex colour in channels.css');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
