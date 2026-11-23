'use strict';
// #753: the CW sideband per rig. Automatic (the default) is POTACAT's rule
// before #753 on every band; Always CW-U / Always CW-L fix it on every band.
// Every CW mode choice goes through lib/cw-sideband.js.

const test = require('node:test');
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');

const CwSideband = require('../lib/cw-sideband');
const { getModel } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { FlrigCodec } = require('../lib/codecs/flrig-codec');
const { CommanderCodec } = require('../lib/codecs/commander-codec');
const { YaesuLegacyCodec } = require('../lib/codecs/yaesu-legacy-codec');
const { toTciMode } = require('../lib/tci-rig');

const root = path.join(__dirname, '..');
const BANDS = { '160 m': 1830000, '40 m': 7030000, '20 m': 14030000 };

// ── Each codec as a function: (request, currentReverse, hz) -> 'upper' | 'lower' ──

function kenwoodWire(modelName) {
  return (request, rev, hz) => {
    const out = [];
    const c = new KenwoodCodec(getModel(modelName), (d) => out.push(String(d)));
    c._lastRawMd = rev ? 7 : 3;
    c.setMode(request, hz);
    const md = out.join('').match(/(?:MD0?|OM0)([0-9A-F]);/);
    assert.ok(md, `${modelName}: no mode command in ${JSON.stringify(out)}`);
    return md[1] === '7' ? 'lower' : md[1] === '3' ? 'upper' : 'other:' + md[1];
  };
}

function civWire(request, rev, hz) {
  const frames = [];
  const c = new CivCodec(getModel('IC-7300'), (b) => frames.push(Buffer.from(b)));
  c._lastModeByte = rev ? 0x07 : 0x03;
  c.setMode(request, hz);
  const f = frames.find((b) => b.length >= 6 && b[4] === 0x06);
  assert.ok(f, 'CI-V: no 06 frame');
  return f[5] === 0x07 ? 'lower' : f[5] === 0x03 ? 'upper' : 'other';
}

function rigctldWire(request, rev, hz) {
  const out = [];
  const c = new RigctldCodec({ brand: 'Hamlib', protocol: 'rigctld', caps: {}, cw: {} }, (d) => out.push(String(d)));
  c._lastMode = rev ? 'CWR' : 'CW';
  c.setMode(request, hz);
  const m = out.join('').match(/^M (\S+)/m);
  assert.ok(m, 'rigctld: no M line');
  return m[1] === 'CWR' ? 'lower' : m[1] === 'CW' ? 'upper' : 'other';
}

function flrigWire(request, rev, hz) {
  const calls = [];
  const c = new FlrigCodec({ brand: 'flrig', protocol: 'flrig', caps: {}, cw: {} }, () => {});
  c._call = (kind, method, params) => calls.push({ method, params });
  c._radioModes = ['LSB', 'USB', 'CW-U', 'CW-L', 'DATA-U'];
  c._lastMode = rev ? 'CWR' : 'CW';
  c.setMode(request, hz);
  const set = calls.find((x) => x.method === 'rig.set_mode');
  assert.ok(set, 'flrig: no set_mode');
  const name = JSON.stringify(set.params);
  return /CW-L/.test(name) ? 'lower' : /CW-U/.test(name) ? 'upper' : 'other';
}

function commanderWire(request, rev, hz) {
  const out = [];
  const c = new CommanderCodec({ brand: 'DXLab', protocol: 'commander', caps: {}, cw: {} }, (d) => out.push(String(d)));
  c._lastMode = rev ? 'CWR' : 'CW';
  c.setMode(request, hz);
  const s = out.join('');
  assert.ok(/CmdSetMode/i.test(s), 'Commander: no CmdSetMode');
  return /CW-R/.test(s) ? 'lower' : /CW/.test(s) ? 'upper' : 'other';
}

function legacyWire(request, rev, hz) {
  const ops = [];
  const c = new YaesuLegacyCodec(getModel('FT-817/818'), () => {});
  c._enqueue = (op, bytes) => ops.push(bytes);
  c._lastModeByte = rev ? 0x03 : 0x02;
  c.setMode(request, hz);
  const b = ops.find((x) => Array.isArray(x));
  assert.ok(b, 'FT-817: no set-mode');
  return b[0] === 0x03 ? 'lower' : b[0] === 0x02 ? 'upper' : 'other';
}

function tciWire(request, rev, hz) {
  const m = toTciMode(request, hz, true, rev);
  return m === 'CWL' ? 'lower' : m === 'CWU' ? 'upper' : 'other:' + m;
}

const FAMILIES = {
  'Yaesu serial (FT-710)': kenwoodWire('FT-710'),
  'Kenwood serial (TS-590SG)': kenwoodWire('TS-590S/SG'),
  'Kenwood OM (TS-890S)': kenwoodWire('TS-890S'),
  'Elecraft (K3/K3S)': kenwoodWire('K3/K3S'),
  'Icom CI-V (IC-7300)': civWire,
  'Hamlib rigctld': rigctldWire,
  flrig: flrigWire,
  'DXLab Commander': commanderWire,
  'FT-817/818': legacyWire,
  TCI: tciWire,
};

// ── The one decision ───────────────────────────────────────────────────

test('sidebandFor: Automatic keeps today\'s rule, Always fixes the sideband', () => {
  assert.strictEqual(CwSideband.sidebandFor({ setting: 'band', currentReverse: false }), 'upper');
  assert.strictEqual(CwSideband.sidebandFor({ setting: 'band', currentReverse: true }), 'lower');
  assert.strictEqual(CwSideband.sidebandFor({ setting: undefined, currentReverse: true }), 'lower');
  for (const rev of [false, true]) {
    assert.strictEqual(CwSideband.sidebandFor({ setting: 'upper', currentReverse: rev }), 'upper');
    assert.strictEqual(CwSideband.sidebandFor({ setting: 'lower', currentReverse: rev }), 'lower');
  }
});

test('settingOf: a rig with no setting (every rig before #753) is Automatic', () => {
  assert.strictEqual(CwSideband.settingOf(null), 'band');
  assert.strictEqual(CwSideband.settingOf({}), 'band');
  assert.strictEqual(CwSideband.settingOf({ cwSideband: 'nonsense' }), 'band');
  assert.strictEqual(CwSideband.settingOf({ cwSideband: 'upper' }), 'upper');
  assert.strictEqual(CwSideband.settingOf({ cwSideband: 'lower' }), 'lower');
});

test('requestFor: only CW changes; Automatic leaves CW as it was', () => {
  assert.strictEqual(CwSideband.requestFor('CW', 'band'), 'CW');
  assert.strictEqual(CwSideband.requestFor('CW', 'upper'), 'CWU');
  assert.strictEqual(CwSideband.requestFor('CW', 'lower'), 'CWR');
  assert.strictEqual(CwSideband.requestFor('cw', 'lower'), 'CWR');
  for (const m of ['USB', 'LSB', 'SSB', 'FT8', 'DIGU', 'FM', 'AM', 'RTTY', '', null]) {
    assert.strictEqual(CwSideband.requestFor(m, 'lower'), m);
    assert.strictEqual(CwSideband.requestFor(m, 'upper'), m);
  }
});

// ── Every family, every band ───────────────────────────────────────────

for (const [fam, wire] of Object.entries(FAMILIES)) {
  test(`${fam}: Automatic on 160 / 40 / 20 m is unchanged (normal CW, a reverse the operator set stays)`, () => {
    for (const [band, hz] of Object.entries(BANDS)) {
      const req = CwSideband.requestFor('CW', 'band');
      assert.strictEqual(wire(req, false, hz), 'upper', `${band} from normal`);
      assert.strictEqual(wire(req, true, hz), 'lower', `${band} from reverse`);
    }
  });
  test(`${fam}: Always CW-U on 160 / 40 / 20 m`, () => {
    for (const [band, hz] of Object.entries(BANDS)) {
      const req = CwSideband.requestFor('CW', 'upper');
      assert.strictEqual(wire(req, false, hz), 'upper', band);
      assert.strictEqual(wire(req, true, hz), 'upper', `${band} from reverse`);
    }
  });
  test(`${fam}: Always CW-L on 160 / 40 / 20 m`, () => {
    for (const [band, hz] of Object.entries(BANDS)) {
      const req = CwSideband.requestFor('CW', 'lower');
      assert.strictEqual(wire(req, false, hz), 'lower', `${band} from normal`);
      assert.strictEqual(wire(req, true, hz), 'lower', band);
    }
  });
}

test('the codecs still parse both CW modes as CW (the rest of POTACAT reads CW)', () => {
  const k = new KenwoodCodec(getModel('FT-710'), () => {});
  assert.strictEqual(k.modeNameForMapping(k.resolveMode('CWR')), 'CW');
  assert.strictEqual(k.modeNameForMapping(k.resolveMode('CWU')), 'CW');
});

// ── The names per family ───────────────────────────────────────────────

test('names: a Yaesu says CW-U / CW-L; Icom, Kenwood, Elecraft and the rest CW / CW-R', () => {
  assert.deepStrictEqual(CwSideband.choices('Yaesu').map((c) => c.label),
    ['Automatic (default)', 'Always CW-U', 'Always CW-L']);
  for (const brand of ['Icom', 'Kenwood', 'Elecraft', '', undefined]) {
    assert.deepStrictEqual(CwSideband.choices(brand).map((c) => c.label),
      ['Automatic (default)', 'Always CW', 'Always CW-R (reverse)'], String(brand));
  }
  assert.deepStrictEqual(CwSideband.choices('Yaesu').map((c) => c.value), ['band', 'upper', 'lower']);
});

// ── Shown only where the link can set both ─────────────────────────────

test('the question shows only for radio types that can set both CW modes', () => {
  for (const t of ['serialcat', 'icom', 'civ-tcp', 'icom-network', 'yaesu-lan', 'hamlib', 'rigctldnet', 'flrig', 'dxlab-commander', 'tci']) {
    assert.strictEqual(CwSideband.appliesToRadioType(t), true, t);
  }
  for (const t of ['flex', 'tcpcat', 'k4network', 'nocat', '', undefined]) {
    assert.strictEqual(CwSideband.appliesToRadioType(t), false, String(t));
  }
});

// ── RigController carries the rig's setting to every CW mode send ──────

function done(rc) {
  for (const tm of rc._pendingTimers) clearTimeout(tm);
  rc._pendingTimers = [];
  rc._stopPolling();
  if (rc._codec && rc._codec.removeAllListeners) rc._codec.removeAllListeners();
}

function controllerWith(modelName, tune) {
  const { RigController } = require('../lib/rig-controller');
  const out = [];
  const model = Object.assign({}, getModel(modelName), { tune });
  const codec = new KenwoodCodec(model, (d) => out.push(String(d)));
  const t = new EventEmitter(); t.connect = () => {}; t.disconnect = () => {}; t.write = () => {};
  const rc = new RigController(model, t, codec);
  rc.connected = true;
  return { rc, codec, out };
}

test('RigController: Always CW-R sends MD7 on a Kenwood in CW even with no mode re-send', () => {
  const { rc, codec, out } = controllerWith('TS-590S/SG', { modeBeforeFreq: true, modeAfterFreq: false, alwaysResendMode: false });
  codec._lastRawMd = 3; rc._lastParsedMode = 'CW';
  rc.setCwSideband('lower');
  rc.tune(7030000, 'CW');
  assert.ok(out.some((s) => s.includes('MD7;')), JSON.stringify(out));
  done(rc);
});

test('RigController: Automatic in CW leaves a Kenwood alone, as before', () => {
  const { rc, codec, out } = controllerWith('TS-590S/SG', { modeBeforeFreq: true, modeAfterFreq: false, alwaysResendMode: false });
  codec._lastRawMd = 7; rc._lastParsedMode = 'CW';
  rc.tune(14030000, 'CW');
  assert.ok(!out.some((s) => /MD\d;/.test(s)), JSON.stringify(out));
  done(rc);
});

test('RigController: a mode-only CW set (VFO button, restore) follows the setting', () => {
  const { rc, codec, out } = controllerWith('FT-710');
  codec._lastRawMd = 7;
  rc.setCwSideband('upper');
  rc.setModeOnly('CW', 7030000, { noAnchor: true });
  assert.ok(out.some((s) => s.includes('MD03;')), JSON.stringify(out));
  done(rc);
});

// ── Wiring ─────────────────────────────────────────────────────────────

test('wiring: main applies the rig\'s setting to CAT and TCI tunes', () => {
  const main = readSrc(path.join(root, 'main.js'));
  assert.ok(/require\('\.\/lib\/cw-sideband'\)/.test(main), 'main.js requires lib/cw-sideband');
  assert.ok(/cat\.setCwSideband\(CwSideband\.settingOf\(/.test(main), 'connect applies the rig setting to RigController');
  assert.ok(/tciRig\.tune\(freqHz, CwSideband\.requestFor\(mode, CwSideband\.settingOf\(/.test(main), 'TCI tunes carry the setting');
});

test('wiring: RigController routes tune and mode-only sets through _cwModeOut', () => {
  const rc = readSrc(path.join(root, 'lib/rig-controller.js'));
  assert.ok(/CwSideband\.requestFor\(/.test(rc));
  const tune = rc.slice(rc.indexOf('  tune(frequencyHz'), rc.indexOf('  tune(frequencyHz') + 800);
  assert.ok(/this\._cwModeOut\(mode\)/.test(tune), 'tune');
  const only = rc.slice(rc.indexOf('  setModeOnly('), rc.indexOf('  setModeOnly(') + 600);
  assert.ok(/this\._cwModeOut\(mode\)/.test(only), 'setModeOnly');
});

test('wiring: the rig editor shows, loads and saves the setting', () => {
  const html = readSrc(path.join(root, 'renderer/index.html'));
  const app = readSrc(path.join(root, 'renderer/app.js'));
  assert.ok(/<select id="set-cw-sideband"/.test(html), 'select in the rig editor');
  assert.ok(/<script src="\.\.\/lib\/cw-sideband\.js"><\/script>/.test(html), 'module loaded in the page');
  assert.ok(/CwSideband\.appliesToRadioType\(type\)/.test(app), 'row hidden where unsupported');
  assert.ok(/rig\.cwSideband = rigCwSideband/.test(app), 'edit saves it');
  assert.ok(/cwSideband: rigCwSideband/.test(app), 'new rig saves it');
});
