#!/usr/bin/env node
'use strict';
// The Winlink address book, and the Position report and POTA spot forms
// (Casey 2026-11-11). Run: node test/winlink-contacts-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const C = require('../lib/winlink-contacts');
const P = require('../lib/pota-email-spot');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const html = readSrc(path.join(root, 'renderer', 'winlink-popout.html'));
const js = readSrc(path.join(root, 'renderer', 'winlink-popout.js'));

console.log('Winlink address book and the two forms');

test('an address is a Winlink address (a callsign or tactical name) or an email; anything else is not', () => {
  assert.strictEqual(C.normalizeAddress('w1aw'), 'W1AW');
  assert.strictEqual(C.normalizeAddress('k3sbp-10'), 'K3SBP-10');
  assert.strictEqual(C.normalizeAddress('ARES-NC'), 'ARES-NC');
  assert.strictEqual(C.normalizeAddress('Joe@Example.COM'), 'joe@example.com');
  assert.strictEqual(C.normalizeAddress('<w1aw>'), 'W1AW');
  assert.strictEqual(C.normalizeAddress('not an address'), '');
  assert.strictEqual(C.normalizeAddress('a@b'), '');
  assert.strictEqual(C.kindOf('W1AW'), 'winlink');
  assert.strictEqual(C.kindOf('joe@example.com'), 'email');
});

test('To and Cc keep the comma-separated form the send path expects', () => {
  assert.deepStrictEqual(C.splitAddresses('w1aw, joe@x.org; K3SBP w1aw'), ['W1AW', 'joe@x.org', 'K3SBP']);
  assert.strictEqual(C.joinAddresses(['w1aw', 'joe@x.org', 'W1AW']), 'W1AW, joe@x.org');
});

test('contacts: one per address, edited in place by id, a clash refused in words', () => {
  let r = C.saveContact([], { name: 'Mom', address: 'MOM@example.com' });
  assert.ok(r.ok && r.id);
  assert.strictEqual(r.list[0].address, 'mom@example.com');
  assert.strictEqual(r.list[0].kind, 'email');
  const clash = C.saveContact(r.list, { name: 'Mother', address: 'mom@example.com' });
  assert.ok(!clash.ok && /already in your address book as Mom/.test(clash.error));
  r = C.saveContact(r.list, { id: r.id, name: 'Mom (home)', address: 'mom@example.com' });
  assert.strictEqual(r.list.length, 1);
  assert.strictEqual(r.list[0].name, 'Mom (home)');
  assert.ok(!C.saveContact([], { address: 'nope nope' }).ok);
  assert.deepStrictEqual(C.removeContact(r.list, r.id), []);
});

test('groups: a name and addresses, names unique', () => {
  let r = C.saveGroup([], { name: 'Family', members: ['mom@example.com', 'W1AW', 'a@b'] });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.list[0].members, ['mom@example.com', 'W1AW']);
  assert.ok(!C.saveGroup(r.list, { name: 'family', members: ['W1AW'] }).ok);
  assert.ok(!C.saveGroup([], { name: 'Empty', members: [] }).ok, 'a group needs an address');
});

test('suggestions: saved contacts first, then groups, then everyone seen in mail; never yourself', () => {
  const contacts = C.saveContact([], { name: 'ARES net control', address: 'W1AW' }).list;
  const groups = C.saveGroup([], { name: 'Family', members: ['mom@example.com'] }).list;
  const now = Date.parse('2026-11-12T00:00:00Z');
  const lists = {
    in: [{ from: 'KY4RY', date: '2026-11-11T22:20:00Z' }, { from: 'K3SBP', date: '2026-11-11T22:00:00Z' }, { from: 'N3HYM', date: '2026-10-01T00:00:00Z' }],
    sent: [{ to: ['KY4RY'], date: '2026-11-11T22:25:00Z' }],
  };
  const all = C.suggest('', { contacts, groups, lists, mycall: 'K3SBP', now, limit: 10 });
  assert.strictEqual(all[0].type, 'contact');
  assert.strictEqual(all[1].type, 'group');
  assert.deepStrictEqual(all.filter((r) => r.type === 'seen').map((r) => r.address), ['KY4RY', 'N3HYM'], 'recent and frequent first');
  assert.ok(!all.some((r) => r.address === 'K3SBP'));
  assert.deepStrictEqual(C.suggest('net', { contacts, groups, lists, now }).map((r) => r.address), ['W1AW'], 'a name matches');
  assert.ok(!C.suggest('', { contacts, lists, now, exclude: ['W1AW'] }).some((r) => r.address === 'W1AW'), 'already chosen is not offered');
});

test('writing to a contact moves it up', () => {
  const list = C.saveContact([], { name: 'Mom', address: 'mom@example.com' }).list;
  const t = C.touch(list, ['MOM@EXAMPLE.COM'], 5000);
  assert.ok(t.changed);
  assert.strictEqual(t.list[0].lastUsedAt, 5000);
  assert.ok(/WinlinkContacts\.touch\(settings\.winlinkContacts, WinlinkContacts\.splitAddresses/.test(main), 'the send path records it');
});

test('the shack keeps the book per profile and every surface gets it the same way', () => {
  assert.ok(/contacts: WinlinkContacts\.normalizeContacts\(settings\.winlinkContacts\)/.test(main));
  assert.ok(/contactGroups: WinlinkContacts\.normalizeGroups\(settings\.winlinkContactGroups\)/.test(main));
  assert.ok(/case 'winlink-contact':/.test(main) && /case 'winlink-contact-group':/.test(main));
  const proto = readSrc(path.join(root, 'lib', 'echocat-protocol.js'));
  assert.ok(/'winlink-contact': \{ dir: Dir\.C2S/.test(proto) && /'winlink-contact-group': \{ dir: Dir\.C2S/.test(proto));
  assert.ok(/contacts: f\.optArray, contactGroups: f\.optArray/.test(proto));
  const rs = readSrc(path.join(root, 'lib', 'remote-server.js')).replace(/\r\n/g, '\n');
  assert.ok(/case 'winlink-contact':\n\s*case 'winlink-contact-group':/.test(rs));
  assert.ok(/'winlink-contact', 'winlink-contact-group'/.test(readSrc(path.join(root, 'lib', 'guest-pass-authority.js'))), 'refused for a Guest Pass');
});

test('compose: To and Cc are chip fields over the same hidden comma-separated values', () => {
  assert.ok(/<div class="wl-chips" data-field="to">/.test(html) && /<input type="hidden" id="wl-c-to">/.test(html));
  assert.ok(/<div class="wl-chips" data-field="cc">/.test(html) && /<input type="hidden" id="wl-c-cc">/.test(html));
  assert.ok(/id="wl-c-book"[^>]*aria-label="Open the address book"/.test(html));
  assert.ok(/window\.api\.send\(\{ to: chipValue\('to'\), cc: chipValue\('cc'\),/.test(js), 'typed text is committed before it goes');
  assert.ok(/'<button class="wl-btn" id="wl-addbook">Add to address book<\/button>'/.test(js), 'a received message offers to save its sender');
});

test('POTA park references are checked before a spot goes', () => {
  assert.strictEqual(P.parkRef('us-1234'), 'US-1234');
  assert.strictEqual(P.parkRef('K-0001'), 'K-0001');
  assert.strictEqual(P.parkRef('JA-10234'), 'JA-10234');
  assert.strictEqual(P.parkRef('US1234'), '');
  assert.strictEqual(P.parkRef('PARK'), '');
  assert.deepStrictEqual(P.FORM_MODES, ['CW', 'SSB', 'FM', 'FT8', 'FT4', 'DATA']);
  const m = P.buildSpotMessage({ call: 'k3sbp', refs: ['US-1234'], freqKhz: 14074, mode: 'USB' });
  assert.deepStrictEqual([m.call, m.refs, m.freqKhz, m.mode], ['K3SBP', ['US-1234'], 14074, 'SSB'], 'the parts for the form');
});

test('the POTA spot is a form: parks, frequency, mode, comment, and the exact lines POTA receives', () => {
  assert.ok(/<form class="wl-form" id="wl-form-spot" hidden/.test(html));
  assert.ok(/<pre id="wl-spot-preview"><\/pre>/.test(html));
  assert.ok(/PES\.spotLine\(\{ call: call, ref: ref, freqKhz: mhz > 0 \? mhz \* 1000 : 0, mode: mode, comment: comment \}\)/.test(js), 'built by the shared line builder, never hand-edited');
  assert.ok(/chipFields\.parks\.items\.filter\(function \(r\) \{ return !!PES\.parkRef\(r\); \}\)/.test(js), 'only valid parks reach the preview');
  assert.ok(/function composeSpot\(t\) \{\s*if \(!t \|\| !t\.to\) return;\s*openSpotForm\(t\);/.test(js), 'Activation\'s Winlink spot opens the same form');
});

test('the Position report is a form: where it goes said plainly, the position editable, optional email', () => {
  assert.ok(/<form class="wl-form" id="wl-form-pos" hidden/.test(html));
  assert.ok(/Goes to Winlink's position map \(QTH\), not a person's inbox\./.test(html));
  assert.ok(/'Starting point: the center of grid square ' \+ p\.grid \+ ', accurate to about ' \+ p\.km \+ ' km\./.test(js));
  assert.ok(/window\.api\.posreport\(\{ lat: lat, lon: lon, comment: comment \}\)/.test(js));
  assert.ok(/position: \(\(\) => \{/.test(main) && /const km = g\.length >= 8 \? 1 : g\.length >= 6 \? 5 : 100;/.test(main));
  assert.ok(/if \(k === 'pos'\) openPositionForm\(\);/.test(js), 'the Templates menu opens it');
});

test('theme colours only in the new styles', () => {
  const rules = html.match(/\.(wl-chips?[a-z-]*|wl-kind|wl-book[a-z-]*|wl-sug[a-z-]*|wl-suggest|wl-form[a-z-]*|wl-ico)[^{]*\{[^}]*\}/g) || [];
  assert.ok(rules.length >= 20, 'rules found: ' + rules.length);
  for (const r of rules) {
    const bare = r.replace(/var\([^)]*\)/g, '').replace(/rgba\(0,0,0,0\.35\)/g, '');
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(bare), 'a colour outside a theme token: ' + r.slice(0, 80));
  }
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/winlink-contacts-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
