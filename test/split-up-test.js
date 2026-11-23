// Split "up N" from the VFO window (#689, DA2PK): one click turns split on
// and puts the TX VFO at the receive frequency plus N kHz; pressing again
// returns to simplex. It respects the VFO lock and the radio's range, sets
// VFOs only (never transmits), and shows only where the radio can do it.
// Run: node test/split-up-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const S = require('../lib/split-up');
const { RIG_CONTROLS } = require('../lib/rig-controls');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const vfo = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
const remoteJs = readSrc(path.join(root, 'renderer', 'remote.js'));
const remoteHtml = readSrc(path.join(root, 'renderer', 'remote.html'));
const remoteServer = readSrc(path.join(root, 'lib', 'remote-server.js'));
const ctl = readSrc(path.join(root, 'lib', 'rig-controller.js'));

const BASE = { rxHz: 14074000, split: false, locked: false, available: true };

console.log('Split up N (#689)');

// --- TX frequency math ---
test('the offsets are +1, +2, +5 and -1 kHz; +1 is the default', () => {
  assert.deepStrictEqual(S.OFFSETS_KHZ, [1, 2, 5, -1]);
  assert.strictEqual(S.DEFAULT_KHZ, 1);
  assert.strictEqual(S.normalizeOffset(undefined), 1);
  assert.strictEqual(S.normalizeOffset('5'), 5);
  assert.strictEqual(S.normalizeOffset(3), 1, 'an offset not offered falls back to +1');
  assert.strictEqual(S.normalizeOffset(1000), 1, 'never a wild jump');
});

test('TX = RX + N kHz, to the hertz, for each N', () => {
  assert.strictEqual(S.txHz(14074000, 1), 14075000);
  assert.strictEqual(S.txHz(14074000, 2), 14076000);
  assert.strictEqual(S.txHz(14074000, 5), 14079000);
  assert.strictEqual(S.txHz(14074000, -1), 14073000);
  assert.strictEqual(S.txHz(7025340, 1), 7026340, 'CW: up 1 from an odd dial keeps the odd hertz');
  assert.strictEqual(S.txHz(14195000.4, 5), 14200000, 'rounded to whole hertz');
  for (const n of S.OFFSETS_KHZ) {
    const p = S.plan({ ...BASE, offsetKhz: n });
    assert.strictEqual(p.ok, true, 'N=' + n);
    assert.strictEqual(p.txHz, 14074000 + n * 1000, 'N=' + n);
    assert.deepStrictEqual(p.steps[p.steps.length - 1], { action: 'set-freq-other', hz: 14074000 + n * 1000 });
  }
});

test('"up" is the dial plus N in every mode: the plan has no mode or sideband in it', () => {
  const p = S.plan({ ...BASE, offsetKhz: 1 });
  for (const st of p.steps) assert.ok(!('mode' in st), JSON.stringify(st));
});

test('the words are the ones heard on the air', () => {
  assert.strictEqual(S.label(1), 'Up 1');
  assert.strictEqual(S.label(5), 'Up 5');
  assert.strictEqual(S.label(-1), 'Down 1');
  assert.strictEqual(S.optionText(2), '+2 kHz');
  assert.strictEqual(S.optionText(-1), '-1 kHz');
  assert.strictEqual(S.buttonFace(false, 1).text, 'Split up 1');
  assert.strictEqual(S.buttonFace(false, -1).text, 'Split down 1');
  assert.strictEqual(S.buttonFace(true, 5).text, 'Split off');
  assert.ok(/does not transmit/.test(S.buttonFace(false, 1).title));
});

// --- On, then back to simplex ---
test('from simplex: split on FIRST, then the TX VFO (Commander sets TX only once split is on)', () => {
  const p = S.plan({ ...BASE, offsetKhz: 1 });
  assert.deepStrictEqual(p.steps, [
    { action: 'set-split', value: true },
    { action: 'set-freq-other', hz: 14075000 },
  ]);
});

test('already in split: a new N only moves the TX VFO', () => {
  const p = S.plan({ ...BASE, split: true, offsetKhz: 5 });
  assert.deepStrictEqual(p.steps, [{ action: 'set-freq-other', hz: 14079000 }]);
});

test('split off restores simplex: pressing again sends split off and nothing else', () => {
  const off = S.press({ ...BASE, split: true, offsetKhz: 1 });
  assert.strictEqual(off.ok, true);
  assert.deepStrictEqual(off.steps, [{ action: 'set-split', value: false }]);
  assert.deepStrictEqual(S.planOff({ ...BASE, split: true }).steps, [{ action: 'set-split', value: false }]);
  const on = S.press({ ...BASE, split: false, offsetKhz: 1 });
  assert.strictEqual(on.steps[0].action, 'set-split');
  assert.strictEqual(on.steps[0].value, true);
});

test('it never transmits: the only actions are split and the other VFO', () => {
  for (const split of [false, true]) {
    for (const n of S.OFFSETS_KHZ) {
      for (const st of S.press({ ...BASE, split, offsetKhz: n }).steps) {
        assert.ok(['set-split', 'set-freq-other'].includes(st.action), st.action);
      }
    }
  }
  const body = readSrc(path.join(root, 'lib', 'split-up.js'));
  assert.ok(!/ptt|transmit\(|keyDown|setPtt/i.test(body.replace(/\/\/.*$/gm, '').replace(/it does not transmit/g, '')), 'no PTT in the module');
});

// --- VFO lock ---
test('the VFO lock refuses split up, a new N and split off, with the lock words', () => {
  for (const fn of [S.plan, S.planOff, S.press]) {
    for (const split of [false, true]) {
      const r = fn({ ...BASE, split, locked: true, offsetKhz: 1 });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'locked');
      assert.deepStrictEqual(r.steps, []);
      assert.strictEqual(r.message, 'VFO locked. Unlock the VFO to change frequency.');
    }
  }
});

test('main refuses split-up while locked (the dispatcher passes _vfoLocked)', () => {
  const at = main.indexOf("case 'split-up'");
  assert.ok(at > 0, "no case 'split-up' in applyRigControl");
  const body = main.slice(at, at + 3000);
  assert.ok(/SplitUp\.plan\(/.test(body), 'uses lib/split-up.js');
  assert.ok(/locked:\s*_vfoLocked/.test(body), 'passes the VFO lock');
  assert.ok(/reach:\s*rigReachNow\(\)/.test(body), "passes the radio's range");
});

test('the VFO window checks the lock before sending, and says why', () => {
  assert.ok(/SplitUp\.press\(\{[^}]*locked:\s*vfoLocked/.test(vfo), 'VFO window passes vfoLocked');
  assert.ok(/SplitUp\.(plan|press)\([\s\S]{0,400}showSplitUpRefusal|showSplitUpRefusal/.test(vfo), 'a refusal is shown');
});

// --- Range ---
test("outside the radio's range: refused, nothing sent; unknown range never refuses", () => {
  const reach = [[30e3, 56e6]];
  const r = S.plan({ ...BASE, rxHz: 55999500, offsetKhz: 1, reach });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'out-of-range');
  assert.deepStrictEqual(r.steps, []);
  assert.ok(/56\.001 MHz/.test(r.message), r.message);
  assert.strictEqual(S.plan({ ...BASE, offsetKhz: 1, reach }).ok, true);
  assert.strictEqual(S.plan({ ...BASE, offsetKhz: 1, reach: null }).ok, true);
  assert.strictEqual(S.plan({ ...BASE, offsetKhz: 1, reach: [] }).ok, true);
  assert.strictEqual(S.plan({ ...BASE, rxHz: 0, offsetKhz: 1 }).reason, 'no-freq');
});

test('a TX outside the ham band but inside the radio is NOT refused (operator\'s call)', () => {
  const r = S.plan({ ...BASE, rxHz: 14349500, offsetKhz: 1, reach: [[30e3, 56e6]] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.txHz, 14350500);
});

// --- Hidden without split caps ---
test('offered only where caps.splitUp (split AND a working TX-frequency command)', () => {
  assert.strictEqual(S.available(null), false);
  assert.strictEqual(S.available({}), false);
  assert.strictEqual(S.available({ split: true }), false);
  assert.strictEqual(S.available({ split: true, splitFreq: true, splitUp: false }), false);
  assert.strictEqual(S.available({ split: true, splitFreq: true, splitUp: true }), true);
  const r = S.plan({ ...BASE, available: false, offsetKhz: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unavailable');
  assert.strictEqual(S.planOff({ ...BASE, available: false }).ok, false);
});

test('main: caps.splitUp needs splitFreq and is never set on a Flex (a second TX frequency is a second slice)', () => {
  assert.ok(/caps\.splitUp\s*=\s*!!\(caps\.splitFreq\s*&&\s*rigType !== 'flex'\)/.test(main), 'caps.splitUp');
  assert.ok(/'splitUp'/.test(main.slice(main.indexOf('function vfoCatCaps'), main.indexOf('function vfoCatCaps') + 600)), 'vfoCatCaps sends splitUp to the VFO window');
});

test('splitFreq is true only where the link can really send the TX frequency (no dead button on a Yaesu)', () => {
  const cap = (C, model) => new C(model, () => {});
  const kw = cap(KenwoodCodec, RIG_MODELS['TS-590S/SG']);
  assert.strictEqual(kw.canSetFrequencyOther(), true, 'Kenwood FB/FA');
  assert.strictEqual(cap(KenwoodCodec, RIG_MODELS['FT-991/991A']).canSetFrequencyOther(), true, 'FT-991A: FB');
  assert.strictEqual(cap(KenwoodCodec, RIG_MODELS['FT-891']).canSetFrequencyOther(), false, 'FT-891 declines');
  assert.strictEqual(cap(KenwoodCodec, RIG_MODELS['FT-710']).canSetFrequencyOther(), false, 'FT-710 declines (no trusted RX-VFO readback yet)');
  const civ = cap(CivCodec, RIG_MODELS['IC-7300']);
  assert.strictEqual(civ.canSetFrequencyOther(), true);
  civ._otherUnsupported = true;
  assert.strictEqual(civ.canSetFrequencyOther(), false, 'firmware that NAKs 25');
  const rc = cap(RigctldCodec, { brand: 'Hamlib', protocol: 'rigctld', caps: {}, maxPower: 100 });
  assert.strictEqual(rc.canSetFrequencyOther(), true);
  rc._splitUnsupported = true;
  assert.strictEqual(rc.canSetFrequencyOther(), false);
  assert.ok(/canSetFrequencyOther/.test(ctl.slice(ctl.indexOf('get hasFrequencyOther()'), ctl.indexOf('get hasFrequencyOther()') + 400)), 'the controller asks the codec');
});

test('the VFO window hides the row unless catCaps.splitUp', () => {
  assert.ok(/id="split-up-row"/.test(vfo), 'the row');
  assert.ok(/SplitUp\.available\(vfoCatCaps\)/.test(vfo), 'gated on vfoCatCaps.splitUp');
});

test('ECHOCAT Web hides its Up button unless capabilities.splitUp', () => {
  assert.ok(/id="rc-split-up"/.test(remoteHtml), 'the button');
  assert.ok(/SplitUp\.available\(s\.capabilities\)/.test(remoteJs), 'gated on capabilities.splitUp');
});

// --- Wiring ---
test('one rig-control action, split-up, in the registry and the dispatcher', () => {
  const m = RIG_CONTROLS['split-up'];
  assert.ok(m, 'registry entry');
  assert.strictEqual(m.caps, 'splitUp');
  assert.strictEqual(m.txOnly, true);
  assert.ok(main.includes("case 'split-up'"));
});

test('a Guest Pass may not use it (it moves the TX frequency), and is told why in the split words', () => {
  const A = require('../lib/guest-pass-authority');
  assert.ok(A.GUEST_DENIED_RIG_ACTIONS.has('split-up'));
  assert.ok(!A.GUEST_RIG_ACTIONS.has('split-up'));
  const W = require('../lib/pass-wording');
  assert.strictEqual(W.refusalKind('rig-control:split-up'), 'split');
});

test('the VFO window: script, row in the header card, one action, split off through set-split', () => {
  assert.ok(vfo.includes('<script src="../lib/split-up.js"></script>'));
  assert.ok(/action:\s*'split-up'/.test(vfo), 'sends split-up');
  assert.ok(/id="split-up-btn"/.test(vfo) && /id="split-up-n"/.test(vfo));
  const head = vfo.slice(vfo.indexOf('class="card head-card"'), vfo.indexOf('id="widget-smeter"'));
  assert.ok(head.includes('id="split-up-row"'), 'beside the TX frequency row, in the header card');
  assert.ok(/splitup:\s*\['split-up-row'\]/.test(vfo), 'a Small VFO item');
});

test('the Small VFO can show it (off by default)', () => {
  const L = require('../lib/vfo-layout');
  const it = L.SMALL_ITEMS.find(i => i.key === 'splitup');
  assert.ok(it, 'Small VFO item');
  assert.strictEqual(it.on, false);
  assert.strictEqual(L.normalizeSmall(null).on.splitup, false);
});

test('ECHOCAT Web: the module is inlined and the button sends split-up / set-split', () => {
  assert.ok(remoteHtml.includes('<!-- split-up-js -->'));
  assert.ok(/\['split-up-js',\s*'split-up\.js'\]/.test(remoteServer));
  assert.ok(/action:\s*'split-up'/.test(remoteJs));
  assert.ok(/SplitUp\.press\(/.test(remoteJs));
});

test('the test is in the runner list', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/split-up-test.js'"));
});

console.log(`\nsplit-up-test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
