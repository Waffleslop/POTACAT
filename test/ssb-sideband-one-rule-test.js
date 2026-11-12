#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// #445: the VFO window's band buttons and type-to-tune kept the old sideband
// (20 m USB carried over to 40 m on an IC-7300 MK II). A band jump in voice
// SSB now takes the band's sideband with the rule spot clicks use, and that
// rule lives in ONE place, lib/ssb-sideband.js.
//
// Pinned here:
//   - the pure rule: every band edge, 60 m, each non-SSB mode untouched,
//     an unknown mode untouched, DATA on, a running digital session
//   - one copy of the 10 MHz / 60 m thresholds in the whole app
//   - the VFO window and the main window's band bar ask for it; the dial and
//     the wheel do not
//   - main's bandJumpMode with a fake rig, through the one CAT dispatcher
//     (RigController.tune) to the radio's own mode command on Icom CI-V,
//     Kenwood/Yaesu/Elecraft, rigctld and flrig; Flex maps LSB/USB as it does
//     for spots
//   - ECHOCAT: Web band buttons and typed frequencies send pickSideband, the
//     server passes it to main, main applies the same helper; a paired
//     laptop forwards it to the shack
// Run: node test/ssb-sideband-one-rule-test.js
require('./ws-stub-if-missing');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const SB = require('../lib/ssb-sideband');

const ROOT = path.join(__dirname, '..');
const R = (p) => readSrc(path.join(ROOT, p)).replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

// ---------------------------------------------------------------- the rule
test('ssbSideband: LSB below 10 MHz, USB from 10 MHz, 60 m USB (every edge)', () => {
  const cases = [
    [1800000, 'LSB'], [1999999, 'LSB'], [3500000, 'LSB'], [3999999, 'LSB'],
    [5249999, 'LSB'], [5250000, 'USB'], [5258500, 'USB'], [5330500, 'USB'], [5357000, 'USB'],
    [5403500, 'USB'], [5406500, 'USB'], [5449999, 'USB'], [5450000, 'LSB'],
    [7000000, 'LSB'], [7300000, 'LSB'], [9999999, 'LSB'], [10000000, 'USB'], [10150000, 'USB'],
    [14000000, 'USB'], [18068000, 'USB'], [21000000, 'USB'], [24890000, 'USB'],
    [28000000, 'USB'], [50000000, 'USB'], [144200000, 'USB'],
  ];
  for (const [hz, want] of cases) assert.strictEqual(SB.ssbSideband(hz), want, hz + ' Hz');
});

test('rig-utils, the codecs and voice-data-mode use that same function', () => {
  assert.strictEqual(require('../lib/rig-utils').ssbSideband, SB.ssbSideband);
  assert.strictEqual(require('../lib/codecs/kenwood-codec').ssbSideband, SB.ssbSideband);
  for (const f of ['civ-codec', 'flrig-codec', 'rigctld-codec', 'yaesu-legacy-codec', 'kenwood-codec']) {
    assert.ok(/const \{ ssbSideband \} = require\('\.\.\/ssb-sideband'\);/.test(R('lib/codecs/' + f + '.js')), f);
  }
  assert.ok(/require\('\.\/ssb-sideband'\)/.test(R('lib/voice-data-mode.js')));
  assert.ok(/require\('\.\/ssb-sideband'\)/.test(R('lib/sstv-manager.js')));
});

test('band jump in voice SSB: the band decides (USB on 20 m -> LSB on 40 m, and back)', () => {
  assert.strictEqual(SB.bandJumpSideband({ mode: 'USB' }, 7074000), 'LSB', '20 m USB to 40 m');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'USB' }, 3750000), 'LSB', 'to 80 m');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'USB' }, 1900000), 'LSB', 'to 160 m');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'LSB' }, 14250000), 'USB', '40 m LSB to 20 m');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'LSB' }, 5357000), 'USB', '40 m LSB to 60 m');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'USB' }, 5357000), null, 'already USB on 60 m: nothing to send');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'LSB' }, 7200000), null, 'already right: nothing to send');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'usb' }, 7200000), 'LSB', 'case does not matter');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'SSB' }, 7200000), 'LSB');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'SSB' }, 21200000), 'USB');
});

test('every other mode is left alone, and so is an unknown one', () => {
  const others = ['CW', 'CW-R', 'CWR', 'AM', 'FM', 'WFM', 'NFM', 'RTTY', 'RTTY-R', 'RTTYR',
    'USB-D', 'LSB-D', 'USB-D1', 'DIGU', 'DIGL', 'PKTUSB', 'PKTLSB', 'DATA-U', 'DATA-L', 'DATA',
    'FT8', 'FT4', 'PSK', 'PSK31', 'JS8', 'FREEDV-RADEV1', 'DV', 'C4FM', 'D-STAR'];
  for (const m of others) {
    assert.strictEqual(SB.bandJumpSideband({ mode: m }, 7074000), null, m + ' on 40 m');
    assert.strictEqual(SB.bandJumpSideband({ mode: m }, 14074000), null, m + ' on 20 m');
  }
  for (const m of ['', null, undefined]) assert.strictEqual(SB.bandJumpSideband({ mode: m }, 7074000), null, 'unknown: ' + m);
  assert.strictEqual(SB.bandJumpSideband(null, 7074000), null);
  assert.strictEqual(SB.bandJumpSideband({ mode: 'USB' }, 0), null, 'no frequency');
  assert.strictEqual(SB.bandJumpSideband({ mode: 'USB' }, NaN), null);
});

test('USB with DATA on (Icom 1A 06, Kenwood DA1) is data: left alone, unless the rig sends voice as DATA', () => {
  assert.strictEqual(SB.bandJumpSideband({ mode: 'USB', dataOn: true }, 7074000), null);
  assert.strictEqual(SB.bandJumpSideband({ mode: 'USB', dataOn: true, voiceAsData: true }, 7200000), 'LSB');
});

test('a running FT8/FreeDV/JS8 session in plain USB is left alone', () => {
  assert.strictEqual(SB.bandJumpSideband({ mode: 'USB', digitalBusy: true }, 7074000), null);
});

// ----------------------------------------------------- one copy, guarded
function sourceFiles() {
  const out = ['main.js'];
  for (const f of fs.readdirSync(ROOT)) if (/^preload.*\.js$/.test(f)) out.push(f);
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { if (!/_native$|^ft2$|node_modules|vendor/.test(e.name)) walk(rel); continue; }
      if (/\.js$/.test(e.name)) out.push(rel);
    }
  };
  walk('lib');
  for (const f of fs.readdirSync(path.join(ROOT, 'renderer'))) if (/\.(js|html)$/.test(f)) out.push('renderer/' + f);
  return out;
}
test('the 10 MHz / 60 m sideband thresholds appear in one place only (lib/ssb-sideband.js)', () => {
  const tenMhz = /\b10000000\b|10_000_000|\b10e6\b|\b1e7\b|[<>]=? ?10000\b|[<>]=? ?10(\.0)?\b(?! ?[*%])/;
  const sideband = /['"](USB|LSB|usb|lsb)['"]/;
  const sixtyM = /\b5_?250_?000\b|\b5_?300_?000\b|\b5_?450_?000\b|\b5250\b|\b5450\b|\b5_?410_?000\b/;
  const bandSet = /lsbBands|LSB_BANDS|'160m'[^\n]*'80m'[^\n]*'40m'[^\n]*(LSB|lsb)/;
  const hits = [];
  for (const f of sourceFiles()) {
    if (f === 'lib/ssb-sideband.js') continue;
    const lines = R(f).split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').trim();
      if (!code || code.startsWith('*') || code.startsWith('/*')) return;
      if ((tenMhz.test(code) && sideband.test(code)) || (sixtyM.test(code) && sideband.test(code)) || bandSet.test(code)) {
        hits.push(f + ':' + (i + 1) + '  ' + code.slice(0, 140));
      }
    });
  }
  assert.deepStrictEqual(hits, [], 'a second copy of the sideband rule:\n' + hits.join('\n'));
  const one = R('lib/ssb-sideband.js');
  assert.ok(/USB_FROM_HZ = 10000000/.test(one) && /SIXTY_M_LO_HZ = 5250000/.test(one) && /SIXTY_M_HI_HZ = 5450000/.test(one));
});

// --------------------------------------------------- the VFO window
test('VFO window: band buttons and type-to-tune ask for the band\'s sideband; dial and wheel do not', () => {
  const html = R('renderer/vfo-popout.html');
  assert.ok(/function tuneJumpFromPopout\(freqKhz\) \{[\s\S]{0,200}window\.api\.tuneByBand\(freqKhz\);/.test(html));
  assert.ok(/if \(vfoLocked\) return;\n\s+tuneJumpFromPopout\(b\.freq\);/.test(html), 'band button');
  assert.ok(/if \(!khz\) return;\n\s+tuneJumpFromPopout\(khz\);/.test(html), 'type-to-tune Go (typed, pasted, recent)');
  const dial = html.slice(html.indexOf('function processDelta('), html.indexOf('canvas.addEventListener(\'mousedown\''));
  assert.ok(/tuneFromPopout\(currentFreqHz \/ 1000\)/.test(dial) && !/tuneJumpFromPopout/.test(dial), 'the dial keeps the mode');
  const wheel = html.slice(html.indexOf('function handleFreqWheel('), html.indexOf('canvas.addEventListener(\'wheel\''));
  assert.ok(/tuneFromPopout\(currentFreqHz \/ 1000\)/.test(wheel) && !/tuneJumpFromPopout/.test(wheel), 'the wheel keeps the mode');
  const pre = R('preload-vfo-popout.js');
  assert.ok(/tuneByBand: \(frequency\) => ipcRenderer\.send\('tune', \{ frequency, pickSideband: true \}\)/.test(pre));
});

test('main window band bar: voice SSB or unknown goes to main to decide; other modes as before', () => {
  const app = R('renderer/app.js');
  const i = app.indexOf("bandButtonsEl.addEventListener('click'");
  const blk = app.slice(i, app.indexOf('\n});', i));
  assert.ok(/if \(!curMode \|\| curMode === 'USB' \|\| curMode === 'LSB' \|\| curMode === 'SSB'\) window\.api\.tuneByBand\(String\(freq\)\);/.test(blk));
  assert.ok(/else window\.api\.tune\(String\(freq\), curMode\);/.test(blk));
  assert.ok(/tuneByBand: \(frequency\) => ipcRenderer\.send\('tune', \{ frequency, pickSideband: true/.test(R('preload.js')));
});

// ------------------------------------- main glue, with a fake rig, to the dispatcher
const MAIN = R('main.js');
function bandJumpModeWith(ctx) {
  const i = MAIN.indexOf('function bandJumpMode(');
  assert.ok(i > 0, 'main.js has bandJumpMode');
  const src = MAIN.slice(i, MAIN.indexOf('\n}\n', i) + 2);
  const logs = [];
  const sandbox = Object.assign({
    SsbSideband: SB, FreqDots: require('../lib/freq-dots'), sendCatLog: (m) => logs.push(m),
    cat: null, _currentMode: '', ft8Engine: null, freedvEngine: null, js8Active: () => false,
  }, ctx);
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.bandJumpMode = bandJumpMode;', sandbox);
  return { bandJumpMode: sandbox.bandJumpMode, logs };
}

test('main reads the rig: its mode, its DATA flag, voice-as-DATA, a running session', () => {
  const plain = { _codec: { _dataOn: false } };
  assert.strictEqual(bandJumpModeWith({ cat: plain, _currentMode: 'USB' }).bandJumpMode('7074'), 'LSB');
  assert.strictEqual(bandJumpModeWith({ cat: plain, _currentMode: 'LSB' }).bandJumpMode('14250'), 'USB');
  assert.strictEqual(bandJumpModeWith({ cat: plain, _currentMode: 'CW' }).bandJumpMode('7030'), undefined);
  assert.strictEqual(bandJumpModeWith({ cat: plain, _currentMode: '' }).bandJumpMode('7074'), undefined, 'unknown mode');
  assert.strictEqual(bandJumpModeWith({ cat: { _codec: { _dataOn: true } }, _currentMode: 'USB' }).bandJumpMode('7074'), undefined, 'IC-7300 USB-D reads USB + DATA');
  assert.strictEqual(bandJumpModeWith({ cat: { _codec: { _dataOn: true }, _voiceSentAsData: true }, _currentMode: 'USB' }).bandJumpMode('7200'), 'LSB');
  assert.strictEqual(bandJumpModeWith({ cat: plain, _currentMode: 'USB', ft8Engine: {} }).bandJumpMode('7074'), undefined);
  assert.strictEqual(bandJumpModeWith({ cat: plain, _currentMode: 'USB', freedvEngine: {} }).bandJumpMode('7074'), undefined);
  assert.strictEqual(bandJumpModeWith({ cat: plain, _currentMode: 'USB', js8Active: () => true }).bandJumpMode('7074'), undefined);
  assert.strictEqual(bandJumpModeWith({ cat: null, _currentMode: 'USB' }).bandJumpMode('7200'), 'LSB', 'Flex Direct (no CAT link) reads its slice mode');
  const { bandJumpMode, logs } = bandJumpModeWith({ cat: plain, _currentMode: 'USB' });
  bandJumpMode('7200');
  assert.ok(/band jump in USB: LSB for 7\.200/.test(logs.join('\n')), 'the log says why');
});

test('the desktop tune IPC and the ECHOCAT tune both pass the band sideband to tuneRadio, mode-less only', () => {
  assert.ok(/ipcMain\.on\('tune', \(_e, \{ frequency, mode, bearing, slicePort, origin, pickSideband \}\) =>/.test(MAIN));
  assert.ok(/tuneRadio\(frequency, mode \|\| \(pickSideband && bandJumpMode\(frequency\)\) \|\| mode, bearing, \{ origin \}\);/.test(MAIN));
  assert.ok(/remoteServer\.on\('tune', \(\{ freqKhz, mode, bearing, channelId, pickSideband \}\) =>/.test(MAIN));
  assert.ok(/tuneRadio\(freqKhz, mode \|\| \(pickSideband && bandJumpMode\(freqKhz\)\) \|\| mode, bearing, \{ clearXit: !mode \}\);/.test(MAIN));
  assert.ok(/remoteClient\.sendTune\(\{ frequency: Math\.round\(parseFloat\(frequency\) \* 1000\), mode, bearing, pickSideband: !mode && !!pickSideband \}\);/.test(MAIN), 'a paired laptop forwards it to the shack');
});

test('Flex: LSB and USB go to the slice as themselves (the spot path\'s mapping)', () => {
  const m = MAIN.match(/const ssbSide = SsbSideband\.ssbSideband\(freqHz\);/g) || [];
  assert.strictEqual(m.length, 2, 'both SmartSDR tune paths use the one rule for SSB');
  assert.ok((MAIN.match(/mode === 'USB' \? 'USB' : \(mode === 'LSB' \? 'LSB' : null\)/g) || []).length >= 3);
});

// Through the one CAT dispatcher to the radio, the way tuneRadio calls it.
const { RigController } = require('../lib/rig-controller');
const { RIG_MODELS } = require('../lib/rig-models');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { FlrigCodec } = require('../lib/codecs/flrig-codec');

function controller(model, makeCodec) {
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = makeCodec(model, (d) => writes.push(Buffer.isBuffer(d) ? d.toString('hex') : String(d)));
  const rig = new RigController(model, transport, codec);
  rig.connected = true;
  rig._lastReadOkMs = Date.now();
  const modes = [];
  const orig = codec.setMode.bind(codec);
  codec.setMode = (m, hz) => { modes.push(m); return orig(m, hz); };
  return { rig, codec, writes, modes };
}
function jumpThrough(model, makeCodec, currentMode) {
  const h = controller(model, makeCodec);
  h.rig._lastParsedMode = currentMode;
  const { bandJumpMode } = bandJumpModeWith({ cat: { _codec: h.codec }, _currentMode: currentMode });
  const mode = '' || bandJumpMode('7074.000') || '';
  h.rig.tune(7074000, mode, {});
  for (const t of h.rig._pendingTimers) clearTimeout(t);
  h.rig._pendingTimers = [];
  return h;
}
const RIGS = [
  ['Icom CI-V (IC-7300 MK II)', RIG_MODELS['IC-7300 MK II'], (m, w) => new CivCodec(m, w)],
  ['Kenwood (TS-590S/SG)', RIG_MODELS['TS-590S/SG'], (m, w) => new KenwoodCodec(m, w)],
  ['Yaesu (FT-710)', RIG_MODELS['FT-710'], (m, w) => new KenwoodCodec(m, w)],
  ['Elecraft (K3/K3S)', RIG_MODELS['K3/K3S'], (m, w) => new KenwoodCodec(m, w)],
  ['rigctld/Hamlib', { brand: 'Hamlib', protocol: 'rigctld' }, (m, w) => new RigctldCodec(m, w)],
  ['flrig', { brand: 'flrig', protocol: 'flrig' }, (m, w) => new FlrigCodec(m, w)],
];
test('20 m USB, 40 m band button: each radio family gets LSB through RigController.tune', () => {
  for (const [name, model, make] of RIGS) {
    assert.ok(model, name + ' model');
    const h = jumpThrough(model, make, 'USB');
    assert.deepStrictEqual(h.modes, ['LSB'], name + ': setMode(LSB)');
    assert.strictEqual(h.rig._requestedMd && h.rig._requestedMd.mode, 'LSB', name);
  }
});
test('20 m CW, 40 m band button: no mode command on any radio family', () => {
  for (const [name, model, make] of RIGS) {
    const h = jumpThrough(model, make, 'CW');
    assert.deepStrictEqual(h.modes, [], name);
  }
});
test('the mode command on the wire is the radio\'s own LSB', () => {
  const ic = controller(RIG_MODELS['IC-7300 MK II'], (m, w) => new CivCodec(m, w));
  ic.codec.setMode('LSB', 7074000);
  assert.ok(ic.writes.some((h) => /^fefe[0-9a-f]{2}e00600/.test(h)), 'CI-V 06 00 (LSB): ' + ic.writes.join(' '));
  const kw = controller(RIG_MODELS['TS-590S/SG'], (m, w) => new KenwoodCodec(m, w));
  kw.codec.setMode('LSB', 7074000);
  assert.ok(kw.writes.some((s) => /MD1;/.test(s)), 'Kenwood MD1: ' + kw.writes.join(' '));
  const ys = controller(RIG_MODELS['FT-710'], (m, w) => new KenwoodCodec(m, w));
  ys.codec.setMode('LSB', 7074000);
  assert.ok(ys.writes.some((s) => /MD01;/.test(s)), 'Yaesu MD01: ' + ys.writes.join(' '));
  const hl = controller({ brand: 'Hamlib', protocol: 'rigctld' }, (m, w) => new RigctldCodec(m, w));
  hl.codec.setMode('LSB', 7074000);
  assert.ok(hl.writes.some((s) => /^\+?M LSB\b|\bM LSB\b/.test(s)), 'rigctld M LSB: ' + hl.writes.join(' | '));
});

// ---------------------------------------------------------------- ECHOCAT
test('ECHOCAT Web: band buttons, the keypad and the typed box send pickSideband; dial steps do not', () => {
  const js = R('renderer/remote.js');
  assert.ok(/function dpTune\(freqKhz, pickSideband\)/.test(js));
  assert.ok(/if \(pickSideband\) tuneMsg\.pickSideband = true;/.test(js));
  assert.ok(/if \(khz > 0\) dpTune\(khz, true\);/.test(js), 'band quick-tune');
  assert.ok(/const val = parseFloat\(dpInput\);\n\s+dpTune\(val, true\);/.test(js), 'keypad Go');
  assert.ok(/freqKhz: val\.toString\(\), mode: '', pickSideband: true \}/.test(js), 'typed frequency box');
  assert.ok(!/dpTune\(newFreq, true\)|dpTune\(next, true\)/.test(js), 'dial and arrow steps keep the mode');
});

test('ECHOCAT server: pickSideband reaches main only as a strict true', () => {
  const { RemoteServer } = require('../lib/remote-server');
  const rs = new RemoteServer();
  const ws = { _authenticated: true, readyState: 1, send: () => {} };
  rs._client = ws;
  const got = [];
  rs.on('tune', (t) => got.push(t));
  rs._handleMessage(ws, { type: 'tune', freqKhz: '7074.000', mode: '', pickSideband: true }, {});
  rs._lastTuneTime = 0;
  rs._handleMessage(ws, { type: 'tune', freqKhz: '7075.000', mode: '' }, {});
  rs._lastTuneTime = 0;
  rs._handleMessage(ws, { type: 'tune', freqKhz: '7076.000', mode: '', pickSideband: 'yes' }, {});
  assert.deepStrictEqual(got.map((t) => t.pickSideband), [true, false, false]);
  const proto = require('../lib/echocat-protocol');
  assert.ok(proto.MESSAGES.tune.fields.pickSideband, 'registered on the wire');
});

test('a paired laptop forwards pickSideband to the shack, mode-less only', () => {
  const { RemoteClient } = require('../lib/remote-client');
  const c = Object.create(RemoteClient.prototype);
  const sent = [];
  c._send = (m) => sent.push(m);
  c.sendTune({ frequency: 7074000, pickSideband: true });
  c.sendTune({ frequency: 7074000, mode: 'CW', pickSideband: true });
  c.sendTune({ frequency: 7074000 });
  assert.deepStrictEqual(sent.map((m) => m.pickSideband), [true, undefined, undefined]);
});

(async () => {
  console.log('SSB sideband by band, one rule (#445)');
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
