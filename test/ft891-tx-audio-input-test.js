#!/usr/bin/env node
'use strict';
// FT-891 transmit audio input per rig (GitHub #602): front microphone jack or
// rear RTTY/DATA jack. POTACAT sets the radio's MIC SELECT / DATA IN SELECT
// menus while it is connected and puts the operator's values back when it
// disconnects or closes. Commands from the FT-891 CAT Operation Reference Book
// rev 1909-C, printed p. 8 (EX table: 0605 AM MIC SELECT, 0809 DATA IN SELECT,
// 0901 FM MIC SELECT, 1105 SSB MIC SELECT, each 0: MIC 1: REAR, one digit);
// the EX format on printed p. 7 (EX P1 P1 P1 P1 P2 ;).
// Run: node test/ft891-tx-audio-input-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../lib/ft891-tx-audio-input');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  const done = (e) => { if (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); } else { pass++; console.log('  ok  ' + name); } };
  try { const r = fn(); if (r && r.then) pending.push(r.then(() => done(), done)); else done(); } catch (e) { done(e); }
}

/** A radio that answers EXmmmm; reads from its menu table, and the bytes POTACAT wrote. */
function fakeRadio(menus, { choice = 'rear', silent = [] } = {}) {
  const radio = { menus: Object.assign({}, menus), sent: [], logs: [], notices: [] };
  let pick = choice;
  const guard = F.createGuard({
    choice: () => pick,
    query: async (cmd) => {
      radio.sent.push(cmd);
      const m = /^EX(\d{4});$/.exec(cmd);
      if (!m || silent.includes(m[1]) || !(m[1] in radio.menus)) return null;
      return 'EX' + m[1] + radio.menus[m[1]] + ';';
    },
    send: (cmd) => {
      radio.sent.push(cmd);
      const m = /^EX(\d{4})(\d);$/.exec(cmd);
      if (m) radio.menus[m[1]] = m[2];
    },
    log: (l) => radio.logs.push(l),
    notice: (m) => radio.notices.push(m),
  });
  return { radio, guard, setChoice: (c) => { pick = c; } };
}

// Factory settings (FT-891 Operating Manual 1611A, printed p. 52-53):
// 06-05 AM MIC SELECT MIC, 08-09 DATA IN SELECT REAR, 09-01 FM MIC SELECT MIC,
// 11-05 SSB MIC SELECT MIC.
const FACTORY = { '0605': '0', '0809': '1', '0901': '0', '1105': '0' };

console.log('FT-891 transmit audio input per rig (#602)');

test('the exact bytes, against the CAT reference (printed p. 7-8)', () => {
  assert.deepStrictEqual(F.MENUS.map((m) => m.menu), ['0605', '0809', '0901', '1105']);
  assert.deepStrictEqual(F.VALUES, { front: '0', rear: '1' });
  assert.strictEqual(F.readCommand('1105'), 'EX1105;');
  assert.strictEqual(F.writeCommand('1105', '1'), 'EX11051;');
  assert.strictEqual(F.writeCommand('0809', '0'), 'EX08090;');
  assert.strictEqual(F.writeCommand('0605', '1'), 'EX06051;');
  assert.strictEqual(F.writeCommand('0901', '0'), 'EX09010;');
  assert.strictEqual(F.parseReply('1105', 'EX11051;'), '1');
  assert.strictEqual(F.parseReply('1105', 'EX11050'), '0');
  assert.strictEqual(F.parseReply('1105', 'EX08091;'), null, 'another menu\'s answer is not this one');
  assert.strictEqual(F.parseReply('1105', '?;'), null);
  assert.strictEqual(F.parseReply('1105', null), null);
  assert.throws(() => F.writeCommand('0401', '1'), 'only the four MIC SELECT / DATA IN SELECT menus can be written');
  assert.throws(() => F.writeCommand('1105', '2'), 'only 0 MIC or 1 REAR');
});

test('Rear on a factory radio: SSB, AM, FM set to REAR byte-exact; DATA (already REAR) is left alone; the operator is told', async () => {
  const { radio, guard } = fakeRadio(FACTORY, { choice: 'rear' });
  const r = await guard.apply();
  assert.strictEqual(r.action, 'set');
  assert.deepStrictEqual(radio.sent, ['EX0605;', 'EX06051;', 'EX0809;', 'EX0901;', 'EX09011;', 'EX1105;', 'EX11051;']);
  assert.deepStrictEqual(radio.menus, { '0605': '1', '0809': '1', '0901': '1', '1105': '1' });
  assert.strictEqual(radio.notices.length, 1);
  assert.ok(/rear RTTY\/DATA jack/.test(radio.notices[0]) && /11-05/.test(radio.notices[0]) && /goes back|go back/.test(radio.notices[0]), radio.notices[0]);
  assert.ok(!/08-09/.test(radio.notices[0]), 'an unchanged menu is not named');
});

test('Front on a factory radio: only DATA IN SELECT moves to MIC', async () => {
  const { radio, guard } = fakeRadio(FACTORY, { choice: 'front' });
  await guard.apply();
  assert.deepStrictEqual(radio.sent.filter((c) => c.length === 8), ['EX08090;']);
  assert.ok(/front microphone jack/.test(radio.notices[0]) && /08-09/.test(radio.notices[0]));
});

test('the restore writes back exactly what was there, and only what POTACAT changed', async () => {
  const { radio, guard } = fakeRadio(FACTORY, { choice: 'rear' });
  await guard.apply();
  radio.sent.length = 0;
  const r = guard.restore('disconnect');
  assert.strictEqual(r.action, 'restored');
  assert.deepStrictEqual(radio.sent, ['EX06050;', 'EX09010;', 'EX11050;']);
  assert.deepStrictEqual(radio.menus, FACTORY);
  assert.ok(radio.logs.some((l) => /put back/.test(l) && /disconnect/.test(l)));
  radio.sent.length = 0;
  assert.strictEqual(guard.restore('app quit').action, 'none', 'a second restore sends nothing');
  assert.strictEqual(radio.sent.length, 0);
  await guard.apply(); // a late reconnect after the restore sets nothing more
  assert.strictEqual(radio.sent.length, 0);
});

test('a reconnect of the same link does not set twice or lose the operator\'s values', async () => {
  const { radio, guard } = fakeRadio(FACTORY, { choice: 'rear' });
  await guard.apply();
  const firstWrites = radio.sent.filter((c) => c.length === 8).length;
  await guard.apply();
  assert.strictEqual(radio.sent.filter((c) => c.length === 8).length, firstWrites);
  assert.strictEqual(radio.notices.length, 1);
  radio.sent.length = 0;
  guard.restore('disconnect');
  assert.deepStrictEqual(radio.menus, FACTORY, 'the values put back are the operator\'s, not POTACAT\'s');
});

test('a menu that does not answer is never written (no restore guess)', async () => {
  const { radio, guard } = fakeRadio(FACTORY, { choice: 'rear', silent: ['1105'] });
  await guard.apply();
  assert.ok(!radio.sent.includes('EX11051;'));
  assert.ok(radio.logs.some((l) => /11-05/.test(l) && /could not be read/.test(l)));
});

test('already right: nothing written, nothing said', async () => {
  const { radio, guard } = fakeRadio({ '0605': '1', '0809': '1', '0901': '1', '1105': '1' }, { choice: 'rear' });
  const r = await guard.apply();
  assert.strictEqual(r.action, 'already');
  assert.strictEqual(radio.sent.filter((c) => c.length === 8).length, 0);
  assert.strictEqual(radio.notices.length, 0);
  assert.strictEqual(guard.restore('disconnect').action, 'none');
});

test('default (nothing saved on the rig): not a byte sent, today\'s behaviour', async () => {
  const { radio, guard } = fakeRadio(FACTORY, { choice: null });
  const r = await guard.apply();
  assert.strictEqual(r.action, 'none');
  assert.strictEqual(radio.sent.length, 0);
  assert.strictEqual(F.choiceFor({ model: 'FT-891' }), null);
  assert.strictEqual(F.choiceFor({ model: 'FT-891', txAudioInput: 'side' }), null);
  assert.strictEqual(F.choiceFor({ model: 'FT-891', txAudioInput: 'rear' }), 'rear');
  assert.strictEqual(F.choiceFor({ model: 'FT-891', txAudioInput: 'front' }), 'front');
});

test('FT-891 only, and only on the direct serial CAT link', () => {
  assert.strictEqual(F.hasChoice('FT-891'), true);
  for (const m of ['FT-991/991A', 'FT-710', 'FTDX10', 'FT-818', 'TS-480', 'IC-7300', '', null]) {
    assert.strictEqual(F.hasChoice(m), false, String(m));
    assert.strictEqual(F.choiceFor({ model: m, txAudioInput: 'rear' }), null, String(m));
  }
  assert.strictEqual(F.appliesToLink('serial'), true);
  for (const t of ['rigctld', 'rigctldnet', 'flrig', 'tcp', 'yaesu-lan', 'icom', 'none', undefined]) assert.strictEqual(F.appliesToLink(t), false, String(t));
  // The Kenwood rule (#596) leaves the FT-891 alone, so the shared rig field
  // cannot make it refuse a key-down or change its TX command.
  const K = require('../lib/tx-audio-input');
  assert.strictEqual(K.hasChoice('FT-891'), false);
  assert.strictEqual(K.needsAnswer({ model: 'FT-891' }, { catType: 'serial' }), false);
});

test('never a menu outside the four, never EX0401 (standing Yaesu rule)', async () => {
  for (const choice of ['front', 'rear']) {
    const { radio, guard } = fakeRadio({ '0605': '0', '0809': '0', '0901': '1', '1105': '1' }, { choice });
    await guard.apply();
    guard.restore('disconnect');
    for (const c of radio.sent) {
      assert.ok(/^EX(0605|0809|0901|1105)[01]?;$/.test(c), c);
      assert.ok(!c.startsWith('EX0401'), c);
    }
  }
});

// Wiring: main attaches the guard to the FT-891's serial link, and every
// disconnect path (reconnect, rig switch, CAT test, WSJT-X takeover, quit)
// puts the menus back through restoreIcomNetworkDataMod, which they all call.
const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
test('main.js: attached on the serial Kenwood-protocol link, restored on every disconnect path', () => {
  assert.ok(/require\('\.\/lib\/ft891-tx-audio-input'\)/.test(MAIN));
  const serial = MAIN.slice(MAIN.indexOf('// Kenwood/Yaesu serial'));
  const end = serial.indexOf('bindRigStateEvents(cat);');
  assert.ok(end > 0 && /ft891TxAudioInputAttach\(cat, transport, target\)/.test(serial.slice(0, end)), 'attached in the serial branch');
  const restoreFn = MAIN.slice(MAIN.indexOf('async function restoreIcomNetworkDataMod('));
  assert.ok(/restoreFt891TxAudioInput\(reason\)/.test(restoreFn.slice(0, 600)), 'restored with the other menu guards');
  const remote = MAIN.slice(MAIN.indexOf('Entering remote-client mode'));
  assert.ok(/restoreFt891TxAudioInput\('remote shack'\)/.test(remote.slice(0, 1200)), 'restored before the local CAT is dropped for a remote shack');
  const quit = MAIN.slice(MAIN.indexOf("restoreIcomNetworkDataMod('app quit')") - 200, MAIN.indexOf("restoreIcomNetworkDataMod('app quit')") + 100);
  assert.ok(/cat\.disconnect\(\)/.test(quit), 'quit restores before it disconnects');
});

test('rig editor: the Transmit audio input row is offered for the FT-891 and saved on the rig', () => {
  const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  assert.ok(/<script src="\.\.\/lib\/ft891-tx-audio-input\.js"><\/script>/.test(HTML));
  const sync = APP.slice(APP.indexOf('function syncTxAudioInputRow('));
  assert.ok(/Ft891TxAudioInput\.hasChoice\(model\)/.test(sync.slice(0, 1500)), 'row shown for the FT-891');
  const save = APP.slice(APP.indexOf("const txAudioInputEl = document.getElementById('set-tx-audio-input');"));
  assert.ok(/Ft891TxAudioInput\.hasChoice\(model\)/.test(save.slice(0, 600)), 'choice saved for the FT-891');
  assert.ok(/ft891-tx-audio-input-test\.js/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.js'), 'utf8')));
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
