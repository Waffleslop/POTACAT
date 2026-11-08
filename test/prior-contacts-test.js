#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Prior contacts on right-click (GitHub #154, hoogskev / nj2dx): a "Prior
// contacts" item in the hunter table's and the FT8 decode list's right-click
// menus opens a small read-only card (worked N times, the last contact, the
// band/mode grid, the last five contacts with their parks). One request to
// main returns the data from the log index without a QRZ lookup; one shared
// renderer (lib/prior-contacts.js) draws the card in both windows. The worked
// check mark in the hunter table gets a hover summary from the data the table
// already holds.
// Run: node test/prior-contacts-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const PC = require('../lib/prior-contacts');
const WM = require('../lib/worked-matrix');
const JtcatParser = require('../renderer/jtcat-parser');
const read = (p) => readSrc(path.join(__dirname, '..', p));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const last = { date: '20261105', time: '1432', band: '20M', mode: 'SSB', ref: 'POTA US-1234' };

test('summary: never worked, once, several times', () => {
  assert.strictEqual(PC.summaryText(0, null), 'Not worked before');
  assert.strictEqual(PC.summaryText(1, last), 'Worked once, last on 2026-11-05 14:32 UTC, 20m SSB, POTA US-1234');
  assert.strictEqual(PC.summaryText(3, last), 'Worked 3 times, last on 2026-11-05 14:32 UTC, 20m SSB, POTA US-1234');
});
test('summary: a contact with no time and no park says only what it knows', () => {
  assert.strictEqual(PC.summaryText(2, { date: '20250101', band: '40m', mode: 'cw' }), 'Worked 2 times, last on 2025-01-01, 40m CW');
  assert.strictEqual(PC.summaryText(2, {}), 'Worked 2 times');
});
test('hover summary on the check mark: newest of the entries the table holds, in any order', () => {
  const entries = [
    { date: '20261105', band: '20M', mode: 'SSB', ref: 'US-1234' },
    { date: '20250101', band: '40M', mode: 'CW', ref: '' },
  ];
  assert.strictEqual(PC.workedHoverText(entries), 'Worked 2 times, last on 2026-11-05, 20m SSB, US-1234');
  assert.strictEqual(PC.workedHoverText(entries.slice().reverse()), 'Worked 2 times, last on 2026-11-05, 20m SSB, US-1234');
  assert.strictEqual(PC.workedHoverText([]), '');
  assert.strictEqual(PC.workedHoverText(undefined), '');
});

const recent = [];
for (let i = 0; i < 7; i++) recent.push({ date: '2026110' + (7 - i), time: '1200', band: '20m', mode: 'FT8', ref: i === 1 ? '' : 'POTA US-' + (1000 + i) });
const matrix = WM.buildWorkedMatrix([{ band: '20m', mode: 'FT8' }]);

test('card: heading, summary, the grid, and at most the last five contacts with their parks', () => {
  const h = PC.cardHtml('K1ABC', { total: 7, recent, workedMatrix: matrix });
  assert.ok(h.includes('Prior contacts with K1ABC'), 'heading');
  assert.ok(h.includes('Worked 7 times, last on 2026-11-07 12:00 UTC, 20m FT8, POTA US-1000'), 'summary from the newest contact');
  assert.ok(h.includes('class="wm-table"'), 'the band/mode grid');
  assert.ok(h.includes('Last 5 contacts'), 'section label');
  assert.strictEqual((h.match(/class="pc-row"/g) || []).length, 5, 'five rows');
  assert.ok(h.includes('POTA US-1004') && !h.includes('POTA US-1005'), 'only the newest five');
  assert.ok(/<td[^>]*>—<\/td>/.test(h), 'a contact without a park shows a dash');
  assert.ok(h.includes('class="pc-close"'), 'a close button');
  assert.ok(!/<input|<select|<textarea|contenteditable/i.test(h), 'read-only');
});
test('card: one contact reads "Last contact"; none reads "Not worked before" with no grid or list', () => {
  const one = PC.cardHtml('K1ABC', { total: 1, recent: recent.slice(0, 1), workedMatrix: matrix });
  assert.ok(one.includes('Last contact<') && !one.includes('Last 1 contacts'));
  const none = PC.cardHtml('K1ABC', { total: 0, recent: [], workedMatrix: WM.buildWorkedMatrix([]) });
  assert.ok(none.includes('Not worked before'));
  assert.ok(!none.includes('wm-table') && !none.includes('pc-row'));
});
test('card: escapes what came from the log', () => {
  const h = PC.cardHtml('K1<B>', { total: 1, recent: [{ date: '20261105', band: '20m', mode: 'SSB', ref: 'POTA <x>' }] });
  assert.ok(!h.includes('<B>') && !h.includes('<x>'));
  assert.ok(h.includes('K1&lt;B&gt;') && h.includes('POTA &lt;x&gt;'));
});

// The request: extract the handler from main.js and run it with stubs.
const main = read('main.js');
test('main answers prior-contacts from the log index and the worked grid, never QRZ', () => {
  const start = main.indexOf("  ipcMain.handle('prior-contacts',");
  assert.ok(start > 0, 'handler registered');
  const end = main.indexOf('\n  });\n', start) + '\n  });\n'.length;
  let handler = null;
  let qrzCalls = 0;
  const index = new Map([['K1ABC', recent]]);
  const ctx = {
    ipcMain: { handle: (name, fn) => { handler = fn; } },
    lookupPastQsos: (c) => (index.get(String(c).toUpperCase().split('/')[0]) || []).slice(),
    workedQsos: new Map([['K1ABC', [{ band: '20M', mode: 'FT8' }]], ['K1ABC/P', [{ band: '40M', mode: 'CW' }]]]),
    WorkedMatrix: WM, JtcatParser, PriorContacts: PC, require: (m) => (m === './lib/prior-contacts' ? PC : require(m)),
    qrz: { configured: true, lookup: () => { qrzCalls++; return null; } },
    settings: { enableQrz: true },
  };
  vm.createContext(ctx);
  vm.runInContext(main.slice(start, end), ctx);
  const r = handler(null, ' k1abc ');
  assert.strictEqual(qrzCalls, 0, 'no QRZ lookup');
  assert.strictEqual(r.call, 'K1ABC');
  assert.strictEqual(r.total, 7);
  assert.strictEqual(r.recent.length, 5);
  assert.strictEqual(r.workedMatrix.total, 2, 'grid counts every form of the call');
  const empty = handler(null, '');
  assert.deepStrictEqual([empty.total, empty.recent.length], [0, 0]);
});
test('the card shows the active operator\'s contacts: the index is built from their own logbook, and a contact logged for another operator stays out of it', () => {
  const b = main.indexOf('function buildQsoDetailsIndex() {');
  const body = main.slice(b, main.indexOf('\n}\n', b));
  assert.ok(/parseAllRawQsos\(settings\.adifLogPath\)/.test(body), 'reads the active operator\'s file');
  const guard = main.indexOf('if (!logAs && qsoData.callsign) {');
  const append = main.indexOf('appendToQsoDetailsIndex(qsoData);');
  assert.ok(guard > 0 && append > guard && append - guard < 1500, 'only the active operator\'s own contacts are added live');
});

test('both windows expose the request and load the grid before the card renderer', () => {
  for (const p of ['preload.js', 'preload-jtcat-popout.js']) {
    assert.ok(/priorContacts: \(call\) => ipcRenderer\.invoke\('prior-contacts', call\)/.test(read(p)), p);
  }
  for (const p of ['renderer/index.html', 'renderer/jtcat-popout.html']) {
    const h = read(p);
    const wm = h.indexOf('<script src="../lib/worked-matrix.js"></script>');
    const pc = h.indexOf('<script src="../lib/prior-contacts.js"></script>');
    assert.ok(wm > 0 && pc > wm, p);
  }
});
test('the hunter table menu and the decode list menu each have a "Prior contacts" item', () => {
  assert.ok(/<button class="hide-spot-btn" id="hide-spot-prior-btn">Prior contacts<\/button>/.test(read('renderer/index.html')));
  assert.ok(/<button type="button" role="menuitem" id="jp-row-menu-prior">Prior contacts<\/button>/.test(read('renderer/jtcat-popout.html')));
  const app = read('renderer/app.js');
  assert.ok(/window\.api\.priorContacts\(/.test(app) && /PriorContacts\.showCard\(/.test(app));
  // The hide handler must not treat the item as a hide button.
  assert.ok(/btn\.id === 'hide-spot-prior-btn'\) return;/.test(app));
  const pop = read('renderer/jtcat-popout.js');
  assert.ok(/window\.api\.priorContacts\(/.test(pop) && /PriorContacts\.showCard\(/.test(pop));
});
test('the worked check mark in the hunter table carries the hover summary', () => {
  const app = read('renderer/app.js');
  assert.ok(/callTd\.title = PriorContacts\.workedHoverText\(workedQsos\.get\(/.test(app));
});

console.log(`\nPrior contacts: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
