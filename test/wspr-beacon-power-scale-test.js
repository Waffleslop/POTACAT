'use strict';
// WSPR beacon power on each rig's own scale — GitHub #521.
//
// Reports, 24-31 Oct 2026 (three operators, Discord bug-reports): a KX3 +
// KXPA100 set to 20 W beaconed at 110 W (an amplifier went into protection),
// a G90 set to 5 W sent 20 W, and after the 29 Oct fix the KX3 was forced to
// 11 W whatever was entered. The scale bugs behind those (rigctld's 0..1
// RFPOWER against the wrong full scale) were fixed in 4223647d / 25bd310e /
// b845bb00 and are pinned again here end to end. What #521 adds is the
// beacon's own rule (lib/wspr-beacon-power.js planFrame): the entered level,
// clamped to the rig and rounded DOWN to the link's step so no codec rounds
// it up; nothing entered = the radio's power is left alone.
//
// Each case runs the planned level through the real codec and checks the
// bytes, so "the radio is never set above what was entered" is shown on the
// wire, not only in watts.
// Run: node test/wspr-beacon-power-scale-test.js

const assert = require('assert');
const B = require('../lib/wspr-beacon-power');
const { getModel } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { SmartSdrClient } = require('../lib/smartsdr');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

// The range main.js builds (wsprPowerRange) for a model on a link.
function rangeFor(link, model, extra = {}) {
  return B.powerRange({
    link, maxW: link === 'flex' ? 100 : model.maxPower, minW: model.minPower,
    powerScale: model.powerScale, ...extra,
  });
}
function plan(enteredW, radioW, range) {
  return B.planFrame({ enteredW, radioW, range });
}

// Codec harnesses: the bytes each link would send for `watts`.
function kenwoodWire(modelName, watts) {
  const out = [];
  new KenwoodCodec(getModel(modelName), (d) => out.push(String(d))).setTxPower(watts);
  return out.join('');
}
function civWire(modelName, watts) {
  const out = [];
  new CivCodec(getModel(modelName), (b) => out.push(Buffer.from(b).toString('hex'))).setTxPower(watts);
  return out.join('');
}
function rigctldWire(model, watts, hamlibMw) {
  const out = [];
  const c = new RigctldCodec(model, (d) => out.push(String(d)));
  if (hamlibMw) {
    c._pending.push({ kind: 'power2mw', ts: Date.now() });
    c._parseLine('power2mW: 1.0');
    c._parseLine(`Power mW: ${hamlibMw}`);
    c._parseLine('RPRT 0');
  }
  c.setTxPowerWatts(watts);
  return { wire: out.filter((w) => /RFPOWER|^w PC/.test(w)).join(''), codec: c };
}
function flexWire(watts) {
  const s = new SmartSdrClient();
  const out = [];
  s._send = (cmd) => out.push(cmd);
  s.setTxPower(watts);
  return out.join('');
}

console.log('planFrame: the rule');
const GENERIC = B.powerRange({ link: 'kenwood', maxW: 100 });
t('no level entered = leave the radio alone, at any radio level', () => {
  for (const radio of [0, 0.5, 5, 20, 100]) {
    const p = plan(0, radio, GENERIC);
    assert.strictEqual(p.action, 'leave');
    assert.strictEqual(p.reason, 'none-entered');
  }
});
t('a level entered = that level, above or below the radio\'s', () => {
  assert.deepStrictEqual(plan(5, 100, GENERIC), { action: 'set', watts: 5, belowMin: false, clamped: false });
  assert.deepStrictEqual(plan(20, 5, GENERIC), { action: 'set', watts: 20, belowMin: false, clamped: false });
});
t('the radio already at the entered level = no command', () => {
  assert.strictEqual(plan(5, 5, GENERIC).action, 'leave');
  assert.strictEqual(plan(5, 5, GENERIC).reason, 'at-level');
});
t('never above the entry: every case, every link, rounds down', () => {
  const ranges = [
    B.powerRange({ link: 'kenwood', maxW: 15 }), B.powerRange({ link: 'civ', maxW: 100 }),
    B.powerRange({ link: 'civ', maxW: 10 }), B.powerRange({ link: 'rigctld', maxW: 15, fullScaleW: 110 }),
    B.powerRange({ link: 'rigctld', maxW: 20, fullScaleW: 20 }), B.powerRange({ link: 'flex', maxW: 100 }),
    B.powerRange({ link: 'flrig', maxW: 100 }), B.powerRange({ link: 'rigctld-raw', maxW: 100 }),
  ];
  for (const r of ranges) {
    for (const e of [0.1, 0.5, 1, 2.5, 3.3, 5, 7.7, 10, 20, 37, 100, 110, 500]) {
      const p = plan(e, 50, r);
      if (p.action !== 'set' || p.belowMin) continue;
      assert.ok(p.watts <= e + 1e-9, `${JSON.stringify(r)} entered ${e} set ${p.watts}`);
      assert.ok(p.watts <= r.maxW + 1e-9);
    }
  }
});
t('above what the rig can be set to: clamped to its maximum, and says so', () => {
  const p = plan(50, 5, B.powerRange({ link: 'kenwood', maxW: 15 }));
  assert.deepStrictEqual(p, { action: 'set', watts: 15, belowMin: false, clamped: true });
});
t('below what the rig can be set to: its minimum, and says so (the closest it can do)', () => {
  const p = plan(1, 50, B.powerRange({ link: 'kenwood', maxW: 100, minW: 5 }));
  assert.strictEqual(p.watts, 5);
  assert.strictEqual(p.belowMin, true);
});
t('a positive default (if ever set) only lowers a radio it can read', () => {
  assert.strictEqual(B.planFrame({ enteredW: 0, radioW: 50, range: GENERIC, defaultW: 1 }).watts, 1);
  assert.strictEqual(B.planFrame({ enteredW: 0, radioW: 0.5, range: GENERIC, defaultW: 1 }).action, 'leave');
  assert.strictEqual(B.planFrame({ enteredW: 0, radioW: 0, range: GENERIC, defaultW: 1 }).action, 'leave');
  assert.strictEqual(B.BEACON_DEFAULT_WATTS, 0);
});

console.log('Elecraft KX3, native CAT (PCnnn; whole watts; rev G5 p. 22)');
const KX3 = getModel('KX2/KX3');
t('20 W radio, 5 W entered: PC005;', () => {
  const p = plan(5, 20, rangeFor('kenwood', KX3));
  assert.strictEqual(kenwoodWire('KX2/KX3', p.watts), 'PC005;');
});
t('0.5 W entered: PC000; (the radio\'s lowest), never PC001; (the codec alone rounds 0.5 up to 1 W)', () => {
  assert.strictEqual(kenwoodWire('KX2/KX3', 0.5), 'PC001;', 'the codec rounds; this is why the plan floors first');
  const p = plan(0.5, 10, rangeFor('kenwood', KX3));
  assert.strictEqual(p.watts, 0);
  assert.strictEqual(kenwoodWire('KX2/KX3', p.watts), 'PC000;');
});
t('2.7 W entered: PC002;, not PC003;', () => {
  assert.strictEqual(kenwoodWire('KX2/KX3', plan(2.7, 10, rangeFor('kenwood', KX3)).watts), 'PC002;');
});
t('nothing entered on a 20 W KX3: no power bytes at all', () => {
  assert.strictEqual(plan(0, 20, rangeFor('kenwood', KX3)).action, 'leave');
});

console.log('Elecraft KX3 + KXPA100 through rigctld (Hamlib full scale 110 W)');
t('5 W entered on a radio set to 20 W: RFPOWER 0.045 of 110 W = 4.95 W, not 1.000 (110 W, the report)', () => {
  const r = rangeFor('rigctld', KX3, { fullScaleW: 110 });
  const p = plan(5, 20, r);
  assert.strictEqual(p.action, 'set');
  const { wire } = rigctldWire(KX3, p.watts, 110000);
  assert.strictEqual(wire, 'L RFPOWER 0.045\n');
  assert.ok(0.045 * 110 <= 5);
});
t('the restore of 20 W is RFPOWER 0.182 (20 W), not 0.110 (the 29 Oct build\'s 11 W)', () => {
  const { wire } = rigctldWire(KX3, 20, 110000);
  assert.strictEqual(wire, 'L RFPOWER 0.182\n');
});
t('before Hamlib has answered, the range is the model\'s and the write divides by 100 W: only ever under', () => {
  const r = rangeFor('rigctld', KX3);
  const p = plan(5, 20, r);
  assert.strictEqual(p.watts, 5);
  assert.strictEqual(rigctldWire(KX3, p.watts).wire, 'L RFPOWER 0.050\n');
});

console.log('Xiegu G90 through rigctld (20 W full scale, #989/#993)');
const G90 = getModel('G90');
t('5 W entered: RFPOWER 0.250 (5 W), even though Hamlib says 100 W', () => {
  const r = rangeFor('rigctld', G90, { fullScaleW: 20 });
  const p = plan(5, 20, r);
  const { wire } = rigctldWire(G90, p.watts, 100000);
  assert.strictEqual(wire, 'L RFPOWER 0.250\n');
});
t('a G90 set to 5 W with nothing entered keeps 5 W (the report: it went to 20 W)', () => {
  assert.strictEqual(plan(0, 5, rangeFor('rigctld', G90, { fullScaleW: 20 })).action, 'leave');
});
t('more than 20 W entered: 20 W, RFPOWER 1.000 and no more', () => {
  const p = plan(50, 5, rangeFor('rigctld', G90, { fullScaleW: 20 }));
  assert.strictEqual(p.watts, 20);
  assert.strictEqual(p.clamped, true);
  assert.strictEqual(rigctldWire(G90, p.watts, 100000).wire, 'L RFPOWER 1.000\n');
});

console.log('Icom CI-V (0..255 of the model maximum)');
const IC7300 = getModel('IC-7300');
t('5 W on an IC-7300: level 12 (4.7 W), not 13 (5.1 W, the codec\'s own rounding)', () => {
  assert.strictEqual(civWire('IC-7300', 5), 'fefe94e0140a0013fd', 'unplanned: 13 = 5.1 W');
  const p = plan(5, 100, rangeFor('civ', IC7300));
  assert.ok(p.watts <= 5 && p.watts > 4.6, String(p.watts));
  assert.strictEqual(civWire('IC-7300', p.watts), 'fefe94e0140a0012fd');
});
t('1 W on an IC-705 (10 W): level 25, not above 1 W', () => {
  const IC705 = getModel('IC-705');
  const p = plan(1, 10, rangeFor('civ', IC705));
  assert.ok(p.watts <= 1);
  const lvl = parseInt(civWire('IC-705', p.watts).slice(12, 16), 10);
  assert.ok(lvl / 255 * 10 <= 1 + 1e-9, `level ${lvl}`);
});

console.log('Yaesu (PCnnn; whole watts, 5 W minimum on the FT-710)');
const FT710 = getModel('FT-710');
t('20 W entered on a radio at 100 W: PC020;', () => {
  assert.strictEqual(kenwoodWire('FT-710', plan(20, 100, rangeFor('kenwood', FT710)).watts), 'PC020;');
});
t('1 W entered: PC005;, the radio\'s minimum, flagged belowMin for the log', () => {
  const p = plan(1, 100, rangeFor('kenwood', FT710));
  assert.strictEqual(p.belowMin, true);
  assert.strictEqual(kenwoodWire('FT-710', p.watts), 'PC005;');
});

console.log('FlexRadio (SmartSDR rfpower, integer percent of 100 W)');
t('5 W entered on a Flex at 100: rfpower=5', () => {
  const p = plan(5, 100, B.powerRange({ link: 'flex', maxW: 100 }));
  assert.strictEqual(flexWire(p.watts), 'transmit set rfpower=5');
});
t('2.5 W entered: rfpower=2, not 3', () => {
  const p = plan(2.5, 100, B.powerRange({ link: 'flex', maxW: 100 }));
  assert.strictEqual(flexWire(p.watts), 'transmit set rfpower=2');
});

console.log(`\nWSPR beacon power scale: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
