// Gateways that need their own modem (Casey 2026-11-22, "fix community
// gateways"). Winlink lists a gateway running a community-built modem under a
// standard mode; only its service code says so. Those rows go after the
// standard ones under "Needs its own modem (service code X)", still callable.
// Any other code (a club's private code for ordinary gateways) is a normal
// row, an empty code (an unpatched Pat) is treated as before, and MERCURY keeps
// its own rule (gatewaysForChoice, test/winlink-pat-test.js).
// Run: node test/winlink-own-modem-test.js
'use strict';
const path = require('path');
const assert = require('assert');
const { readSrc } = require('./_src');
const W = require('../lib/winlink-pat');
const V = require('../lib/winlink-mail-view');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const row = (call, serviceCode) => ({ call, serviceCode, serviceTag: serviceCode && serviceCode !== 'PUBLIC' ? serviceCode : '' });

test('the known codes, and nothing else', () => {
  assert.deepStrictEqual(W.OWN_MODEM_CODES, ['DATA2G', 'MODEM73', 'VARDEFM', 'IONHF']);
  assert.ok(!W.OWN_MODEM_CODES.includes('MERCURY'), 'MERCURY has its own rule');
  assert.ok(!W.OWN_MODEM_CODES.includes('PUBLIC'));
});

test('known codes go after the standard rows, grouped by code, Pat order kept, marked ownModem', () => {
  const list = [
    row('AA1DG-10', 'DATA2G'), row('W1AW-10', 'PUBLIC'), row('K1MD-10', 'MODEM73'),
    row('N1ABC-10', 'PUBLIC'), row('AB1DG-10', 'DATA2G'), row('W2ION-10', 'IONHF'), row('W3VF-10', 'VARDEFM'),
  ];
  const out = W.groupOwnModemGateways(list);
  assert.deepStrictEqual(out.map((g) => g.call), ['W1AW-10', 'N1ABC-10', 'AA1DG-10', 'AB1DG-10', 'K1MD-10', 'W2ION-10', 'W3VF-10']);
  assert.deepStrictEqual(out.map((g) => g.ownModem || ''), ['', '', 'DATA2G', 'DATA2G', 'MODEM73', 'IONHF', 'VARDEFM']);
  assert.ok(out.every((g) => g.ownModem ? g.serviceTag === g.ownModem : true), 'each keeps its tag');
  assert.ok(!('ownModem' in list[0]), 'the input rows are not changed');
});

test('a code the operator typed that is not a known one stays a normal row, tagged', () => {
  const list = [row('K9CLB-10', 'MYCLUB'), row('W1AW-10', 'PUBLIC'), row('K8EM-10', 'EMCOMM')];
  const out = W.groupOwnModemGateways(list);
  assert.deepStrictEqual(out.map((g) => g.call), ['K9CLB-10', 'W1AW-10', 'K8EM-10'], 'order unchanged');
  assert.ok(out.every((g) => !g.ownModem));
  assert.strictEqual(out[0].serviceTag, 'MYCLUB');
});

test('an empty code (an unpatched Pat) is treated as today: never hidden, never moved', () => {
  const list = [row('K1ABC-10', ''), { call: 'K2ABC-10' }, row('W1AW-10', 'PUBLIC')];
  const out = W.groupOwnModemGateways(list);
  assert.deepStrictEqual(out.map((g) => g.call), ['K1ABC-10', 'K2ABC-10', 'W1AW-10']);
  assert.ok(out.every((g) => !g.ownModem));
  assert.deepStrictEqual(W.groupOwnModemGateways(null), []);
});

test('MERCURY unchanged: gatewaysForChoice first, and grouping never touches a MERCURY row', () => {
  const list = [row('KU0HN-10', 'MERCURY'), row('W1AW-10', 'PUBLIC'), row('AA1DG-10', 'DATA2G')];
  const chosen = W.groupOwnModemGateways(W.gatewaysForChoice(list, { mode: 'vara', mercury: true }));
  assert.deepStrictEqual(chosen.map((g) => g.call), ['KU0HN-10'], 'chosen: the VARA HF list is MERCURY only, as #929');
  assert.ok(!chosen[0].ownModem);
  const notChosen = W.groupOwnModemGateways(W.gatewaysForChoice(list, { mode: 'vara', mercury: false }));
  assert.deepStrictEqual(notChosen.map((g) => g.call), ['W1AW-10', 'AA1DG-10'], 'not chosen: no MERCURY row');
  assert.strictEqual(notChosen[1].ownModem, 'DATA2G');
});

test('the sections both mail views draw: plain rows, then one heading per code, indices into the list', () => {
  const list = W.groupOwnModemGateways([row('AA1DG-10', 'DATA2G'), row('W1AW-10', 'PUBLIC'), row('K1MD-10', 'MODEM73')]);
  const s = V.gatewaySections(list);
  assert.strictEqual(s.length, 3);
  assert.strictEqual(s[0].heading, null);
  assert.deepStrictEqual(s[0].rows.map((r) => [r.g.call, r.i]), [['W1AW-10', 0]]);
  assert.strictEqual(s[1].heading, 'Needs its own modem (service code DATA2G)');
  assert.deepStrictEqual(s[1].rows.map((r) => [r.g.call, r.i]), [['AA1DG-10', 1]]);
  assert.strictEqual(s[2].heading, 'Needs its own modem (service code MODEM73)');
  assert.strictEqual(V.ownModemHeading('IONHF'), 'Needs its own modem (service code IONHF)');
});

test('sections: a list from an older shack (no ownModem) is one plain section, as before; the cap is per section', () => {
  const list = [row('K1ABC-10', ''), row('W1AW-10', 'PUBLIC'), row('N0XYZ-10', 'DATA2G')];
  const s = V.gatewaySections(list);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].rows.length, 3);
  const many = Array.from({ length: 5 }, (_, i) => row('W' + i + 'AW-10', 'PUBLIC')).concat([{ ...row('AA1DG-10', 'DATA2G'), ownModem: 'DATA2G' }]);
  const capped = V.gatewaySections(many, 2);
  assert.strictEqual(capped[0].rows.length, 2);
  assert.deepStrictEqual(capped[1].rows.map((r) => r.i), [5], 'own-modem rows are not cut off by a long standard list');
  assert.deepStrictEqual(V.gatewaySections(null)[0].rows, []);
});

test('wiring: the shack groups after the Mercury rule and before the list goes anywhere; both views draw the sections', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const gw = main.slice(main.indexOf('async function winlinkGateways('), main.indexOf('let _winlinkGatewaysLogged'));
  const choice = gw.indexOf('WinlinkPat.gatewaysForChoice(');
  const group = gw.indexOf('WinlinkPat.groupOwnModemGateways(list)');
  assert.ok(group > choice && choice > 0, 'grouped after the Mercury rule');
  assert.ok(group < gw.indexOf('winlinkState.setGateways('), 'before ECHOCAT and the mail window see it');
  const pop = readSrc(path.join(__dirname, '..', 'renderer', 'winlink-popout.js'));
  const b = pop.slice(pop.indexOf('function buildGatewayOptions('), pop.indexOf('var loadSeq = 0;'));
  assert.ok(b.includes('WinlinkMailView.gatewaySections(gateways, 120)'), 'the mail window draws the sections');
  assert.ok(b.includes('<optgroup label="\' + esc(sec.heading) + \'">'), 'one optgroup per code, under its heading');
  assert.ok(b.includes('<option value="\' + row.i + \'"'), 'option values stay indices into the list');
  const web = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
  const r = web.slice(web.indexOf('function mailRenderGateways()'), web.indexOf('function mailPickGateway('));
  assert.ok(r.includes('MailView.gatewaySections(mailGateways, 80)'), 'ECHOCAT Web draws the sections');
  assert.ok(r.includes("mailMake('div', 'mail-gw-group', sec.heading)"), 'with the heading');
  assert.ok(r.includes("g.serviceTag || ''"), 'each row shows its code');
  const css = readSrc(path.join(__dirname, '..', 'renderer', 'remote.css'));
  assert.ok(css.includes('.mail-gw-group {'), 'the heading has a style');
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'winlink-popout.html'));
  assert.ok(html.includes('../lib/winlink-mail-view.js'), 'the mail window loads WinlinkMailView');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
