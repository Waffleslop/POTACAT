#!/usr/bin/env node
'use strict';
// #279: Transmit power for SSTV. Empty (the default) changes nothing. A level
// is set just before the picture keys and the radio's own level goes back
// when the picture ends, however it ends (finished, HALT, an error, the SWR
// guard, the stuck-TX limit, a Guest Pass ending), and after a crash on the
// next power report. The Guest Pass cap still clamps; a radio POTACAT cannot
// set the power of is left alone and the SSTV window says so. Nothing here
// keys a radio: setPower is a recorder.
// Run: node test/sstv-tx-power-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/sstv-tx-power');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function harness(opts = {}) {
  let marker = opts.marker || null;
  const sent = [];
  const logs = [];
  let t = 1000;
  const s = P.createSession({
    load: () => marker,
    save: (m) => { marker = m ? JSON.parse(JSON.stringify(m)) : null; },
    setPower: (w) => { sent.push(w); return opts.refuse ? false : true; },
    now: () => t,
    log: (l) => logs.push(l),
  });
  return { s, sent, logs, marker: () => marker, tick: (ms) => { t += ms; } };
}

console.log('parseWatts: empty means no change');
test('empty, null, 0, negative and junk are "use the radio\'s power"', () => {
  for (const v of [undefined, null, '', '  ', 0, '0', -5, 'abc', NaN]) assert.strictEqual(P.parseWatts(v), null, String(v));
});
test('numbers and "25 W" parse; rounded to 0.1 W; capped at MAX_W', () => {
  assert.strictEqual(P.parseWatts('25'), 25);
  assert.strictEqual(P.parseWatts('25 W'), 25);
  assert.strictEqual(P.parseWatts(12.34), 12.3);
  assert.strictEqual(P.parseWatts(99999), P.MAX_W);
});

console.log('plan');
test('empty: no change, whatever the radio', () => {
  assert.deepStrictEqual(P.plan({ wantW: '', currentW: 100, canSet: true }), { action: 'none', why: 'empty' });
  assert.deepStrictEqual(P.plan({ wantW: null, currentW: 100, canSet: true }), { action: 'none', why: 'empty' });
});
test('a radio without CAT power control: untouched', () => {
  assert.deepStrictEqual(P.plan({ wantW: 25, currentW: 100, canSet: false }), { action: 'none', why: 'no-power-control' });
});
test('power never reported: untouched (nothing to put back)', () => {
  assert.deepStrictEqual(P.plan({ wantW: 25, currentW: 0, canSet: true }), { action: 'none', why: 'power-unknown' });
});
test('already at the level: no command', () => {
  assert.deepStrictEqual(P.plan({ wantW: 25, currentW: 25, canSet: true }), { action: 'none', why: 'same' });
});
test('a level to set, with the level to put back', () => {
  assert.deepStrictEqual(P.plan({ wantW: 25, currentW: 100, canSet: true }), { action: 'set', watts: 25, restoreW: 100, capped: false });
});
test('the Guest Pass cap clamps the SSTV level', () => {
  assert.deepStrictEqual(P.plan({ wantW: 100, currentW: 5, canSet: true, capW: 10 }), { action: 'set', watts: 10, restoreW: 5, capped: true });
});
test('the radio\'s own maximum clamps too', () => {
  const p = P.plan({ wantW: 50, currentW: 2, canSet: true, limitW: 10 });
  assert.strictEqual(p.watts, 10);
});

console.log('session: set before, restore after');
test('begin saves the marker BEFORE sending the level; end puts the old level back once', () => {
  // Records the marker on disk at the moment of each command.
  const sent = [];
  let markerAtSend = null;
  let mk = null;
  const s2 = P.createSession({
    load: () => mk, save: (m) => { mk = m; },
    setPower: (w) => { if (!markerAtSend) markerAtSend = mk && { ...mk }; sent.push(w); return true; },
  });
  const h = { sent };
  const p = s2.begin({ wantW: 25, currentW: 100, canSet: true, rigId: 'r1' });
  assert.strictEqual(p.action, 'set');
  assert.ok(markerAtSend && markerAtSend.watts === 100 && markerAtSend.sstvWatts === 25, 'marker written first');
  assert.ok(s2.active());
  assert.strictEqual(s2.end('picture ended'), 'restored');
  assert.deepStrictEqual(h.sent, [25, 100]);
  assert.strictEqual(s2.end('again'), 'none', 'a second end does nothing');
  assert.deepStrictEqual(h.sent, [25, 100]);
});
test('HALT / error / SWR trip all end the same way (end is the one path)', () => {
  for (const why of ['HALT', 'dax_tx send failed', 'SWR guard', 'stuck-TX limit', 'Guest Pass ended']) {
    const h = harness();
    h.s.begin({ wantW: 10, currentW: 50, canSet: true });
    assert.strictEqual(h.s.end(why), 'restored', why);
    assert.deepStrictEqual(h.sent, [10, 50], why);
  }
});
test('empty: begin sends nothing and end sends nothing', () => {
  const h = harness();
  assert.strictEqual(h.s.begin({ wantW: '', currentW: 50, canSet: true }).action, 'none');
  assert.strictEqual(h.s.end('picture ended'), 'none');
  assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.marker(), null);
});
test('no CAT power: begin sends nothing, no marker', () => {
  const h = harness();
  assert.strictEqual(h.s.begin({ wantW: 25, currentW: 50, canSet: false }).why, 'no-power-control');
  assert.strictEqual(h.s.end('picture ended'), 'none');
  assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.marker(), null);
});
test('a level the radio refused: marker undone, nothing to restore', () => {
  const h = harness({ refuse: true });
  assert.strictEqual(h.s.begin({ wantW: 25, currentW: 50, canSet: true }).why, 'not-set');
  assert.strictEqual(h.marker(), null);
  assert.strictEqual(h.s.end('x'), 'none');
});
test('back-to-back pictures: the SSTV level is never saved as home', () => {
  const h = harness();
  h.s.begin({ wantW: 25, currentW: 100, canSet: true });
  h.s.end('picture 1');
  // The radio has not reported 100 W yet; POTACAT still shows 25.
  h.s.begin({ wantW: 25, currentW: 25, canSet: true });
  h.s.end('picture 2');
  assert.strictEqual(h.sent[h.sent.length - 1], 100);
});
test('the operator setting a power mid-picture is theirs: no restore', () => {
  const h = harness();
  h.s.begin({ wantW: 25, currentW: 100, canSet: true });
  h.s.operatorSet();
  assert.strictEqual(h.s.end('picture ended'), 'none');
  assert.deepStrictEqual(h.sent, [25]);
  assert.strictEqual(h.marker(), null);
});

console.log('session: readbacks (crash, lost restore)');
test('readbacks during the picture are ignored', () => {
  const h = harness();
  h.s.begin({ wantW: 25, currentW: 100, canSet: true });
  assert.strictEqual(h.s.onReadback(25), 'none');
  assert.deepStrictEqual(h.sent, [25]);
});
test('the radio confirming the old level clears the marker', () => {
  const h = harness();
  h.s.begin({ wantW: 25, currentW: 100, canSet: true });
  h.s.end('done');
  assert.strictEqual(h.s.onReadback(100), 'confirmed');
  assert.strictEqual(h.marker(), null);
});
test('a stale readback right after the restore waits, then retries, then gives up', () => {
  const h = harness();
  h.s.begin({ wantW: 25, currentW: 100, canSet: true });
  h.s.end('done');
  assert.strictEqual(h.s.onReadback(25), 'waiting');
  h.tick(P.RETRY_GAP_MS + 1);
  assert.strictEqual(h.s.onReadback(25), 'restored');
  h.tick(P.RETRY_GAP_MS + 1);
  assert.strictEqual(h.s.onReadback(25), 'restored');
  h.tick(P.RETRY_GAP_MS + 1);
  assert.strictEqual(h.s.onReadback(25), 'gave-up');
  assert.strictEqual(h.marker(), null);
});
test('a crash during a picture: the next session restores on the first readback', () => {
  const h = harness({ marker: { watts: 100, sstvWatts: 25, rigId: 'r1', at: 1, state: 'tx' } });
  assert.strictEqual(h.s.onReadback(25, { rigId: 'r1' }), 'restored');
  assert.deepStrictEqual(h.sent, [100]);
});
test('a different level since is left alone; another rig is not touched', () => {
  const h = harness({ marker: { watts: 100, sstvWatts: 25, rigId: 'r1', at: 1, state: 'returning' } });
  assert.strictEqual(h.s.onReadback(60, { rigId: 'r2' }), 'other-rig');
  assert.strictEqual(h.s.onReadback(60, { rigId: 'r1' }), 'left-alone');
  assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.marker(), null);
});

console.log('wiring (main.js, the SSTV window, ECHOCAT)');
const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer/sstv-popout.html'), 'utf8');
const POP = fs.readFileSync(path.join(ROOT, 'renderer/sstv-popout.js'), 'utf8');
const RS = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/echocat-protocol.md'), 'utf8');
const RUN = fs.readFileSync(path.join(ROOT, 'scripts/run-tests.js'), 'utf8');
function body(src, sig) {
  const i = src.indexOf(sig);
  assert.ok(i >= 0, 'missing: ' + sig);
  const open = src.indexOf('{', i + sig.length - 1);
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced: ' + sig);
}

test('the PTT dispatcher sets the level for an SSTV key-down after every refusal, before keying', () => {
  const b = body(MAIN, 'function handleRemotePtt(state, opts = {}) {');
  const begin = b.indexOf("if (state && opts.txKind === 'sstv') sstvTxPowerBegin();");
  assert.ok(begin > 0, 'begin call');
  assert.ok(begin > b.indexOf('_swrTripped'), 'after the SWR guard');
  assert.ok(begin > b.indexOf('ownTxPrivilegeRefused'), 'after the licence check');
  assert.ok(begin > b.indexOf("target.type === 'none'"), 'a no-CAT radio returns before it');
  assert.ok(begin > b.indexOf('if (tciRigTarget()) return'), 'TCI returns before it');
  assert.ok(begin < b.indexOf('if (isFlexRig) {'), 'before the key-down');
});
test('every key-up through the dispatcher puts the level back, after the unkey', () => {
  const b = body(MAIN, 'function handleRemotePtt(state, opts = {}) {');
  const end = b.indexOf("if (!state) sstvTxPowerEnd('picture ended');");
  assert.ok(end > 0, 'end call');
  assert.ok(end > b.indexOf('gatedSetTransmit(state, pttEmission);'), 'after the unkey');
});
test('paths that end a picture without the dispatcher also end the power session', () => {
  assert.ok(/function sstvHaltTxNow\(\) \{[\s\S]*?sstvTxPowerEnd\('HALT'\)/.test(MAIN), 'HALT');
  assert.ok(/ipcMain\.on\('sstv-tx-complete'[\s\S]{0,400}sstvTxPowerEnd\(/.test(MAIN), 'tx-complete');
  assert.ok(/PTT was released before the radio keyed[\s\S]{0,200}sstvTxPowerEnd\(/.test(MAIN) || /sstvTxPowerEnd\('picture not sent'\);\s*sendCatLog\('\[SSTV\] PTT was released before the radio keyed/.test(MAIN), 'not keyed');
});
test('readbacks, operator sets and the quit path are wired', () => {
  assert.ok(/function sendCatPower\(watts\) \{[\s\S]*?sstvTxPowerReconcile\(/.test(MAIN), 'readback');
  const setPwr = MAIN.slice(MAIN.indexOf("case 'set-tx-power': {", 52000));
  assert.ok(/sstvTxPower\.operatorSet\(\)/.test(setPwr.slice(0, 2500)), 'operator set');
  assert.ok(/sstvTxPowerEnd\('POTACAT closing'\)/.test(MAIN), 'quit');
});
test('the cap comes from the pass, the command goes through the gated setters', () => {
  const b = body(MAIN, 'function sstvTxPowerBegin() {');
  assert.ok(b.includes("interceptCatCommand({ type: 'tx_power'"), 'pass cap asked');
  const c = body(MAIN, 'function sstvCommandTxPower(watts) {');
  assert.ok(c.includes('gatedSetTxPower(') && c.includes('gatedSmartSdrTxPower('), 'gated setters only');
  assert.ok(!c.includes('setRadioTxPowerRaw'), 'never the ungated setter');
});
test('the marker and the level are machine keys', () => {
  assert.ok(/'sstvTxPowerW',/.test(MAIN) && /'sstvTxPowerRestore',/.test(MAIN));
});
test('the SSTV window: one plain field, empty by default, and the state line', () => {
  assert.ok(HTML.includes('id="sstv-tx-power"'), 'field');
  assert.ok(!/id="sstv-tx-power"[^>]*value="/.test(HTML), 'no default value');
  assert.ok(HTML.includes('Transmit power for SSTV'), 'label');
  assert.ok(HTML.includes('id="sstv-tx-power-state"'), 'state line');
  assert.ok(HTML.includes('../lib/sstv-tx-power.js'), 'module loaded');
  assert.ok(POP.includes('SstvTxPower.parseWatts') && POP.includes('sstvTxPowerW'), 'saved through parseWatts');
  assert.ok(MAIN.includes('power: sstvPowerState()'), 'sstv-rig-state carries the power state');
});
test('ECHOCAT: optional field in the settings blob, capability, doc', () => {
  assert.ok(/sstvTxPowerW: SstvTxPower\.parseWatts\(settings\.sstvTxPowerW\)/.test(MAIN), 'blob');
  assert.ok(RS.includes("'sstv-tx-power'"), 'capability');
  assert.ok(DOC.includes('sstvTxPowerW'), 'doc');
});
test('a device may save sstvTxPowerW, never the restore level (device-settings allowlist)', () => {
  const DS = require('../lib/device-settings');
  assert.strictEqual(DS.isDeviceWritable('sstvTxPowerW'), true);
  assert.strictEqual(DS.isDeviceWritable('sstvTxPowerRestore'), false);
});
test('this test is in the runner', () => {
  assert.ok(RUN.includes("'test/sstv-tx-power-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
