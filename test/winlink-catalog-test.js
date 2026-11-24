// Winlink catalog requests (docs/winlink-catalog.md): the rules in
// lib/winlink-catalog.js. The starter list, reading Winlink's LIST reply,
// search and grouping, building the request messages, the size advice, the
// picks and every sentence the panel shows.
//
// The catalog reply below is written by hand in the documented shape
// (CATEGORY, INQUIRY_ID, "SUBJECT", SIZE, ORIGINATED, flag). No row is copied
// from Winlink, Winlink Express or any other program's list; the subjects are
// made up for the test.
// Run: node test/winlink-catalog-test.js
'use strict';
const assert = require('assert');
const C = require('../lib/winlink-catalog');
const { composeFields } = require('../lib/winlink-pat');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ── the fixture: 40 rows, 6 categories ─────────────────────────────────────
const ROWS = [
  ['PROPAGATION', 'PROP_3DAY', 'Test three day outlook', 2799],
  ['PROPAGATION', 'PROP_WWV', 'Test solar numbers for today', 621],
  ['PROPAGATION', 'PROP.27DO', 'Test outlook for 27 days', 1606],
  ['PROPAGATION', 'PROP_LONG', 'Test long range table', 19628],
  ['WL2K_RMS', 'PUB_ARDOP', 'Test list of ARDOP stations', 26706],
  ['WL2K_RMS', 'PUB_PACKET', 'Test list of packet stations', 219867],
  ['WL2K_RMS', 'PUB_PACTOR', 'Test list of Pactor stations', 32933],
  ['WL2K_RMS', 'PUB_VARA', 'Test list of VARA stations', 75234],
  ['WL2K_USERS', 'WL2K_NEARBY', 'Test stations near you', 3000],
  ['WL2K_USERS', 'WL2K_MOBILES', 'Test stations on the move', 41000],
  ['WL2K_HELP', 'DIDUNO', 'Test tips', 2450],
  ['WL2K_HELP', 'USER.OPTIONS', 'Test account settings', 2940],
  ['WL2K_HELP', 'INQUIRIES', 'Test how to ask', 1886],
  ['WL2K_HELP', 'HELP_FOUR', 'Test help number four', 900],
];
for (let i = 1; i <= 14; i++) ROWS.push(['WX_US_TX', 'TX_ZON_' + i, 'Test zone forecast ' + i + ' for Texas', 4000 + i]);
for (let i = 1; i <= 12; i++) ROWS.push(['SAT_PIX', 'PIX' + i + '.JPG', 'Test picture ' + i, 50000 + i * 1000]);

function line(r, sep) {
  const s = sep || '   ';
  return [r[0], r[1], '"' + r[2] + '"', r[3], '2026/03/0' + (1 + (r[3] % 9)) + ' 03:44', '[G]'].join(s);
}
const HEADER = 'CATEGORY     INQUIRY_ID      SUBJECT     SIZE    ORIGINATED       G/L';
function reply(rows, o) {
  o = o || {};
  const pre = o.preamble || ['Automated reply.', 'Processed: 2026/03/10 14:15', 'Global_Modified: 2026/03/09 17:08', ''];
  return pre.concat([HEADER], rows.map((r) => line(r, o.sep)), o.tail || ['']).join(o.eol || '\n');
}
const LIST = reply(ROWS);

console.log('the fixture');
test('40 rows in 6 categories, over 5 kB only when padded like the real one', () => {
  assert.strictEqual(ROWS.length, 40);
  assert.strictEqual(new Set(ROWS.map((r) => r[0])).size, 6);
});

console.log('parseCatalogList');
test('reads every row: category, ID, subject, size, and the Global_Modified date', () => {
  const p = C.parseCatalogList(LIST);
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.items.length, 40);
  assert.strictEqual(p.modified, '2026/03/09 17:08');
  assert.deepStrictEqual(p.items[0], { category: 'PROPAGATION', id: 'PROP_3DAY', subject: 'Test three day outlook', size: 2799 });
  assert.deepStrictEqual(p.items[2].id, 'PROP.27DO', 'an ID with a dot is kept as written');
  assert.strictEqual(p.items[39].id, 'PIX12.JPG');
});
test('IDs are kept exactly as written (case and all)', () => {
  const rows = ROWS.slice();
  rows[0] = ['Propagation', 'Prop_3Day', 'Mixed case', 10];
  const p = C.parseCatalogList(reply(rows));
  assert.strictEqual(p.items[0].id, 'Prop_3Day');
  assert.strictEqual(p.items[0].category, 'Propagation');
});
test('tabs between columns', () => {
  const p = C.parseCatalogList(reply(ROWS, { sep: '\t' }));
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.items.length, 40);
  assert.strictEqual(p.items[5].size, 219867);
});
test('CRLF line ends and trailing spaces', () => {
  const p = C.parseCatalogList(reply(ROWS, { eol: '   \r\n' }));
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.items.length, 40);
  assert.strictEqual(p.items[39].subject, 'Test picture 12');
  assert.strictEqual(p.modified, '2026/03/09 17:08');
});
test('no sizes, no dates, no flags: rows still read, size unknown', () => {
  const text = ['x', HEADER].concat(ROWS.map((r) => r[0] + '  ' + r[1] + '  "' + r[2] + '"')).join('\n');
  const p = C.parseCatalogList(text);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.items.length, 40);
  assert.strictEqual(p.items[0].size, null);
  assert.strictEqual(p.modified, '');
});
test('a date with no size is not read as a size', () => {
  const rows = ROWS.map((r) => r[0] + '  ' + r[1] + '  "' + r[2] + '"  2026/03/01 03:44  [G]');
  const p = C.parseCatalogList([HEADER].concat(rows).join('\n'));
  assert.strictEqual(p.ok, true);
  assert.ok(p.items.every((i) => i.size === null));
});
test('an apostrophe and two spaces inside a subject are kept', () => {
  const rows = ROWS.slice();
  rows[1] = ['PROPAGATION', 'PROP_WWV', "Today's  solar numbers", 621];
  const p = C.parseCatalogList(reply(rows));
  assert.strictEqual(p.items[1].subject, "Today's  solar numbers");
});
test('a truncated last line is skipped and counted, the rest is read', () => {
  const p = C.parseCatalogList(reply(ROWS, { tail: ['WX_US_TX   TX_ZON_99   "Test zone forec'] }));
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.items.length, 40);
  assert.strictEqual(p.skipped, 1);
});
test('30 lines of preamble before the header', () => {
  const pre = [];
  for (let i = 0; i < 29; i++) pre.push('Some line of introduction number ' + i + ' with "quotes" in it');
  pre.push('Global_Modified: 2026/01/02 03:04');
  const p = C.parseCatalogList(reply(ROWS, { preamble: pre }));
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.items.length, 40);
  assert.strictEqual(p.modified, '2026/01/02 03:04');
});
test('the header is found in any case', () => {
  const p = C.parseCatalogList(LIST.replace(HEADER, HEADER.toLowerCase()));
  assert.strictEqual(p.ok, true);
});
test('duplicates: the first one wins', () => {
  const rows = ROWS.concat([['WL2K_HELP', 'DIDUNO', 'A second copy', 1]]);
  const p = C.parseCatalogList(reply(rows));
  assert.strictEqual(p.items.length, 40);
  assert.strictEqual(p.items.find((i) => i.id === 'DIDUNO').subject, 'Test tips');
});
test('a message that only mentions INQUIRY_ID is not a catalog', () => {
  const text = 'To ask for an item, send its INQUIRY_ID in the body.\nThe columns are CATEGORY, then the ID, then the SUBJECT.\n' + 'More words. '.repeat(600);
  assert.strictEqual(C.parseCatalogList(text).ok, false);
  assert.strictEqual(C.parseCatalogList(text).reason, 'no-header');
});
test('a help text with the column names on one line but no table: not-a-table, with the first line seen', () => {
  const lines = ['The table has CATEGORY INQUIRY_ID SUBJECT columns.'];
  for (let i = 0; i < 40; i++) lines.push('Plain sentence number ' + i + '.');
  const p = C.parseCatalogList(lines.join('\n'));
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'not-a-table');
  assert.strictEqual(p.firstLine, 'Plain sentence number 0.');
});
test('fewer than 20 rows is not accepted', () => {
  const p = C.parseCatalogList(reply(ROWS.slice(0, 19)));
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'not-a-table');
});
test('less than 80% rows after the header is not accepted', () => {
  const junk = [];
  for (let i = 0; i < 20; i++) junk.push('not a row ' + i);
  assert.strictEqual(C.parseCatalogList(reply(ROWS, { tail: junk })).ok, false);
  assert.strictEqual(C.parseCatalogList(reply(ROWS, { tail: junk.slice(0, 5) })).ok, true);
});
test('caps: 5,000 items, subject 200 characters, a very long line skipped', () => {
  const many = [];
  for (let i = 0; i < 5200; i++) many.push(['CAT' + (i % 30), 'ID' + i, 'S' + i, i]);
  many[3] = ['CAT3', 'LONGSUBJ', 'x'.repeat(260), 5];
  const p = C.parseCatalogList(reply(many, { tail: ['CAT1  HUGE  "' + 'y'.repeat(5000) + '"  1'] }));
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.items.length, C.MAX_ITEMS);
  assert.strictEqual(C.MAX_ITEMS, 5000);
  assert.strictEqual(p.items[3].subject.length, 200);
  assert.ok(!p.items.some((i) => i.id === 'HUGE'));
});
test('hostile input never throws: not a string, empty, binary, only quotes', () => {
  for (const t of [null, undefined, 42, {}, '', '\u0000\u0001\u0002', '"""""""', HEADER, HEADER + '\n"\n"\n']) {
    const p = C.parseCatalogList(t);
    assert.strictEqual(p.ok, false);
    assert.ok(Array.isArray(p.items) && p.items.length === 0);
  }
});
test('an ID or category with markup or spaces in it is never a row', () => {
  const rows = ROWS.map((r) => line(r));
  rows.push('<img src=x> <script> "bad row" 5');
  rows.push('CAT ID EXTRA "three tokens" 5');
  const p = C.parseCatalogList([HEADER].concat(rows).join('\n'));
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.items.length, 40);
  assert.ok(p.items.every((i) => /^[A-Za-z0-9._-]+$/.test(i.id) && /^[A-Za-z0-9._-]+$/.test(i.category)));
});
test('a subject is plain text: markup in it comes back as the same characters, never changed into anything', () => {
  const rows = ROWS.slice();
  rows[0] = ['PROPAGATION', 'PROP_3DAY', '<b onmouseover=alert(1)>x</b> & more', 5];
  assert.strictEqual(C.parseCatalogList(reply(rows)).items[0].subject, '<b onmouseover=alert(1)>x</b> & more');
});

console.log('looksLikeCatalog');
test('over 5 kB and holding INQUIRY_ID', () => {
  const big = LIST + '\n' + ' '.repeat(6000);
  assert.strictEqual(C.looksLikeCatalog({ body: big }), true);
  assert.strictEqual(C.looksLikeCatalog({ body: LIST.slice(0, 3000) }), false, 'too small');
  assert.strictEqual(C.looksLikeCatalog({ body: 'x'.repeat(9000) }), false, 'no INQUIRY_ID');
  assert.strictEqual(C.looksLikeCatalog({ body: big.toLowerCase() }), true, 'any case');
  assert.strictEqual(C.looksLikeCatalog({}), false);
  assert.strictEqual(C.looksLikeCatalog(null), false);
});

console.log('the starter list');
test('every starter item has a category, an ID and our own name; IDs are unique', () => {
  assert.ok(C.STARTER.length >= 8 && C.STARTER.length <= 14);
  const ids = C.STARTER.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const s of C.STARTER) {
    assert.ok(/^[A-Z0-9._]+$/.test(s.id), s.id);
    assert.ok(/^[A-Z0-9_]+$/.test(s.category), s.category);
    assert.ok(s.name && s.name.length <= 70, s.id);
    assert.strictEqual(s.size, undefined, 'no sizes are shipped');
  }
});
test('the list is exactly the plan\'s, less the two IDs with a single unofficial source', () => {
  assert.deepStrictEqual(C.STARTER.map((s) => s.id), ['PROP_3DAY', 'PROP_WWV', 'PUB_ARDOP', 'PUB_PACKET', 'PUB_PACTOR', 'WL2K_NEARBY', 'WL2K_MOBILES', 'DIDUNO', 'USER.OPTIONS']);
  assert.ok(!C.STARTER.some((s) => s.id === 'PUB_VARA' || s.id === 'INQUIRIES'));
});
test('WL2K_NEARBY says it needs a position report first', () => {
  assert.strictEqual(C.STARTER.find((s) => s.id === 'WL2K_NEARBY').note, 'Needs a position report first (Templates > Position report).');
});

console.log('category names');
test('friendly names for the four we name, Weather for WX_, the code for the rest', () => {
  assert.strictEqual(C.categoryName('PROPAGATION'), 'Propagation');
  assert.strictEqual(C.categoryName('WL2K_RMS'), 'Gateway lists');
  assert.strictEqual(C.categoryName('WL2K_USERS'), 'Stations');
  assert.strictEqual(C.categoryName('WL2K_HELP'), 'Help');
  assert.strictEqual(C.categoryName('WX_US_TX'), 'Weather: US TX');
  assert.strictEqual(C.categoryName('WX_FAX'), 'Weather: FAX');
  assert.strictEqual(C.categoryName('SAT_PIX'), 'SAT_PIX');
});

console.log('one view from two sources');
const FULL = C.parseCatalogList(LIST).items;
test('no full catalog: the view is the starter list, no sizes', () => {
  const v = C.mergeCatalog(null);
  assert.strictEqual(v.full, false);
  assert.strictEqual(v.items.length, C.STARTER.length);
  assert.ok(v.items.every((i) => i.size === null && i.name));
  assert.strictEqual(C.mergeCatalog([]).full, false);
});
test('a full catalog replaces the starter list; starter wording stays as the name', () => {
  const v = C.mergeCatalog(FULL);
  assert.strictEqual(v.full, true);
  assert.strictEqual(v.items.length, 40);
  const p = v.items.find((i) => i.id === 'PROP_3DAY');
  assert.strictEqual(p.name, 'Three-day propagation forecast');
  assert.strictEqual(p.subject, 'Test three day outlook');
  assert.strictEqual(p.size, 2799);
  const other = v.items.find((i) => i.id === 'PUB_VARA');
  assert.strictEqual(other.name, '', 'no starter wording: Winlink\'s subject is shown');
  assert.strictEqual(C.itemLabel(other), 'Test list of VARA stations');
  assert.strictEqual(C.itemLabel(p), 'Three-day propagation forecast');
  assert.strictEqual(C.itemLabel({ id: 'X1', name: '', subject: '' }), 'X1');
});
test('groups: our four first in a fixed order, then the rest by name, each with a count', () => {
  const g = C.groupItems(C.mergeCatalog(FULL).items);
  assert.deepStrictEqual(g.map((x) => x.code), ['PROPAGATION', 'WL2K_RMS', 'WL2K_USERS', 'WL2K_HELP', 'SAT_PIX', 'WX_US_TX']);
  assert.deepStrictEqual(g.map((x) => x.items.length), [4, 4, 2, 4, 12, 14]);
  assert.strictEqual(g[5].name, 'Weather: US TX');
  const s = C.groupItems(C.mergeCatalog(null).items);
  assert.deepStrictEqual(s.map((x) => x.name), ['Propagation', 'Gateway lists', 'Stations', 'Help']);
});
test('which groups start open: all of the short list; in the full one only those with a pick, or everything found', () => {
  const g = C.groupItems(C.mergeCatalog(FULL).items);
  assert.strictEqual(C.groupStartsOpen(g[0], { full: false }), true);
  assert.strictEqual(C.groupStartsOpen(g[0], { full: true, pickIds: [] }), false);
  assert.strictEqual(C.groupStartsOpen(g[0], { full: true, pickIds: ['PROP_WWV'] }), true);
  assert.strictEqual(C.groupStartsOpen(g[1], { full: true, pickIds: ['PROP_WWV'] }), false);
  assert.strictEqual(C.groupStartsOpen(g[1], { full: true, finding: true }), true);
});

console.log('search');
test('finds by our name, Winlink\'s subject, the ID and the category, every word, any case', () => {
  const items = C.mergeCatalog(FULL).items;
  const ids = (q) => C.searchItems(items, q).map((i) => i.id);
  assert.deepStrictEqual(ids('three-day'), ['PROP_3DAY']);
  assert.deepStrictEqual(ids('solar numbers'), ['PROP_WWV']);
  assert.deepStrictEqual(ids('prop.27'), ['PROP.27DO']);
  assert.strictEqual(ids('wx_us_tx').length, 14);
  assert.strictEqual(ids('texas forecast 3').length, 2, 'TX_ZON_3 and TX_ZON_13');
  assert.strictEqual(ids('weather').length, 14, 'the friendly category name');
  assert.deepStrictEqual(ids('packet gateways'), ['PUB_PACKET']);
  assert.deepStrictEqual(ids('zzzz'), []);
  assert.deepStrictEqual(ids('   '), []);
});
test('a name that starts with the words comes first; the limit holds', () => {
  const items = C.mergeCatalog(FULL).items;
  assert.strictEqual(C.searchItems(items, 'test picture 1')[0].id, 'PIX1.JPG');
  assert.strictEqual(C.searchItems(items, 'test', 5).length, 5);
});

console.log('the request messages');
test('one item: To INQUIRY, Subject REQUEST, the ID alone in the body', () => {
  assert.deepStrictEqual(C.buildRequests(['PROP_3DAY']), [{ to: 'INQUIRY', subject: 'REQUEST', body: 'PROP_3DAY', ids: ['PROP_3DAY'] }]);
});
test('10 in one message, 11 in two, 25 in three; one ID per line, in the order ticked', () => {
  const ids = [];
  for (let i = 1; i <= 25; i++) ids.push('ID.' + i);
  assert.strictEqual(C.buildRequests(ids.slice(0, 10)).length, 1);
  const eleven = C.buildRequests(ids.slice(0, 11));
  assert.deepStrictEqual(eleven.map((m) => m.ids.length), [10, 1]);
  assert.strictEqual(eleven[0].body, 'ID.1\nID.2\nID.3\nID.4\nID.5\nID.6\nID.7\nID.8\nID.9\nID.10');
  assert.strictEqual(eleven[1].body, 'ID.11');
  assert.deepStrictEqual(C.buildRequests(ids).map((m) => m.ids.length), [10, 10, 5]);
  assert.strictEqual(C.MAX_IDS_PER_MESSAGE, 10);
});
test('the exact bytes Pat is given: CRLF between IDs, none after the last', () => {
  const m = C.buildRequests(['PROP_3DAY', 'PROP_WWV'])[0];
  const c = composeFields({ to: m.to, subject: m.subject, body: m.body, date: '2026-11-24T12:00:00Z' });
  assert.strictEqual(c.ok, true, c.error);
  assert.strictEqual(c.fields.to, 'INQUIRY');
  assert.strictEqual(c.fields.subject, 'REQUEST');
  assert.strictEqual(Buffer.from(c.fields.body).toString('hex'), Buffer.from('PROP_3DAY\r\nPROP_WWV').toString('hex'));
});
test('IDs go out exactly as the catalog spells them; duplicates and junk are dropped', () => {
  const m = C.buildRequests(['Prop_3Day', 'Prop_3Day', '', null, 'TWO WORDS', 'A\nB', 'X"Y', '<b>', 'US.RAD.CONUS', ' PADDED ']);
  assert.deepStrictEqual(m[0].ids, ['Prop_3Day', 'US.RAD.CONUS']);
  assert.deepStrictEqual(C.buildRequests([]), []);
  assert.deepStrictEqual(C.buildRequests(null), []);
  assert.deepStrictEqual(C.buildRequests('PROP_3DAY'), []);
});
test('a request is never larger than the cap: 200 IDs at most', () => {
  const ids = [];
  for (let i = 0; i < 500; i++) ids.push('N' + i);
  assert.strictEqual(C.buildRequests(ids).reduce((n, m) => n + m.ids.length, 0), C.MAX_IDS_PER_REQUEST);
});
test('the full catalog is asked for with LIST', () => {
  assert.deepStrictEqual(C.listRequest(), { to: 'INQUIRY', subject: 'REQUEST', body: 'LIST' });
  assert.strictEqual(composeFields(C.listRequest()).ok, true);
});
test('the compose hint: INQUIRY in To, with or without @winlink.org', () => {
  assert.strictEqual(C.isCatalogAddress('INQUIRY'), true);
  assert.strictEqual(C.isCatalogAddress('k1abc, inquiry@winlink.org'), true);
  assert.strictEqual(C.isCatalogAddress('INQUIRY@example.com'), false);
  assert.strictEqual(C.isCatalogAddress('INQUIRYX'), false);
  assert.strictEqual(C.isCatalogAddress(''), false);
  assert.strictEqual(C.TEXT.composeHint, 'This is a Winlink catalog request. The Catalog button builds it for you.');
});

console.log('sizes');
test('formatSize: bytes, then whole KB of 1000 bytes', () => {
  assert.strictEqual(C.formatSize(600), '600 bytes');
  assert.strictEqual(C.formatSize(1), '1 byte');
  assert.strictEqual(C.formatSize(26706), '27 KB');
  assert.strictEqual(C.formatSize(219867), '220 KB');
  assert.strictEqual(C.formatSize(999), '999 bytes');
  assert.strictEqual(C.formatSize(1000), '1 KB');
  assert.strictEqual(C.formatSize(2500000), '2.5 MB');
  assert.strictEqual(C.formatSize(null), '');
  assert.strictEqual(C.formatSize(-5), '');
  assert.strictEqual(C.isLarge({ size: 60000 }), true);
  assert.strictEqual(C.isLarge({ size: 59999 }), false);
  assert.strictEqual(C.isLarge({ size: null }), false);
  assert.strictEqual(C.showLargeTag({ id: 'X', name: '', subject: 'Big thing', size: 70000 }), true);
  assert.strictEqual(C.showLargeTag({ id: 'PUB_PACKET', name: 'Packet gateways and frequencies (large)', subject: '', size: 219867 }), false, 'the name says it already');
});
const it = (size) => ({ id: 'X' + size, size });
test('the running total', () => {
  assert.strictEqual(C.sizeAdvice([], 'telnet').total, 'Nothing ticked yet');
  assert.strictEqual(C.sizeAdvice([it(600)], 'telnet').total, '1 item, about 600 bytes');
  assert.strictEqual(C.sizeAdvice([it(4000), it(4000), it(4000)], 'telnet').total, '3 items, about 12 KB');
  assert.strictEqual(C.sizeAdvice([it(4000), it(null), it(4000)], 'ardop').total, '3 items');
});
test('Telnet: no advice at any size', () => {
  assert.strictEqual(C.sizeAdvice([it(100000)], 'telnet').advice, '');
});
test('radio, under 15 KB: no advice', () => {
  for (const mode of ['ardop', 'vara', 'varafm', 'packet', 'mercury']) assert.strictEqual(C.sizeAdvice([it(14999)], mode).advice, '', mode);
});
test('radio, 15 KB to under 60 KB: several minutes', () => {
  assert.strictEqual(C.sizeAdvice([it(15000)], 'ardop').advice, 'About 15 KB. That is several minutes over the radio.');
  assert.strictEqual(C.sizeAdvice([it(30000), it(29999)], 'packet').advice, 'About 60 KB. That is several minutes over the radio.');
});
test('radio, 60 KB or more: slow, consider Telnet', () => {
  assert.strictEqual(C.sizeAdvice([it(60000)], 'vara').advice, 'About 60 KB. That is slow over the radio; consider Telnet for this one.');
});
test('one item over 120 KB adds the size-limit line, in any mode', () => {
  const limit = 'Winlink compresses messages; one this large may still be refused by your size limit.';
  assert.strictEqual(C.sizeAdvice([it(219867)], 'ardop').advice, 'About 220 KB. That is slow over the radio; consider Telnet for this one. ' + limit);
  assert.strictEqual(C.sizeAdvice([it(219867)], 'telnet').advice, limit);
  assert.strictEqual(C.sizeAdvice([it(120000)], 'telnet').advice, '', 'over, not at');
  assert.strictEqual(C.sizeAdvice([it(70000), it(70000)], 'telnet').advice, '', 'two items of 70 KB are two messages');
});
test('an unknown size: no figure and no radio advice', () => {
  const a = C.sizeAdvice([it(50000), it(null)], 'ardop');
  assert.strictEqual(a.total, '2 items');
  assert.strictEqual(a.advice, '');
});
test('the thresholds are named', () => {
  assert.strictEqual(C.ADVICE_NOTE_BYTES, 15000);
  assert.strictEqual(C.ADVICE_SLOW_BYTES, 60000);
  assert.strictEqual(C.LARGE_ITEM_BYTES, 60000);
  assert.strictEqual(C.SIZE_LIMIT_BYTES, 120000);
  assert.strictEqual(C.isRadioMode('telnet'), false);
  assert.strictEqual(C.isRadioMode('ardop'), true);
});

console.log('picks');
test('requested items go first, newest first, at most 8', () => {
  let p = C.normalizePicks(null);
  assert.deepStrictEqual(p, { starred: [], recent: [] });
  p = C.addRecent(p, ['A', 'B']);
  p = C.addRecent(p, ['C', 'A']);
  assert.deepStrictEqual(p.recent, ['C', 'A', 'B']);
  p = C.addRecent(p, ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepStrictEqual(p.recent, ['1', '2', '3', '4', '5', '6', '7', 'C']);
  assert.strictEqual(C.RECENT_MAX, 8);
});
test('a star keeps an item in Your picks after it leaves the last 8', () => {
  let p = C.addRecent(null, ['OLD']);
  p = C.setStar(p, 'OLD', true);
  p = C.addRecent(p, ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.ok(p.recent.indexOf('OLD') < 0);
  assert.deepStrictEqual(C.pickIds(p), ['1', '2', '3', '4', '5', '6', '7', '8', 'OLD']);
  assert.strictEqual(C.isStarred(p, 'OLD'), true);
  p = C.setStar(p, 'OLD', false);
  assert.deepStrictEqual(C.pickIds(p).indexOf('OLD'), -1);
});
test('an item never requested can be starred; stars are capped; junk is dropped', () => {
  let p = C.setStar(null, 'PROP_WWV', true);
  assert.deepStrictEqual(C.pickIds(p), ['PROP_WWV']);
  for (let i = 0; i < 80; i++) p = C.setStar(p, 'S' + i, true);
  assert.strictEqual(p.starred.length, C.STARRED_MAX);
  assert.deepStrictEqual(C.normalizePicks({ starred: ['A', 'A', 5, 'B C', '<i>'], recent: 'x' }), { starred: ['A'], recent: [] });
});
test('Your picks shows only items the current list holds', () => {
  const view = C.mergeCatalog(null);
  const p = C.addRecent(null, ['GONE_ID', 'PROP_WWV']);
  assert.deepStrictEqual(C.pickItems(view.items, p).map((i) => i.id), ['PROP_WWV']);
});

console.log('the stored catalog and the pending request');
test('what is kept on disk, cleaned on the way in and out', () => {
  const s = C.storedFrom(C.parseCatalogList(LIST), { mid: 'ABC123', date: '2026-03-10T14:15:00Z' }, 1770000000000);
  assert.strictEqual(s.modified, '2026/03/09 17:08');
  assert.strictEqual(s.sourceMid, 'ABC123');
  assert.strictEqual(s.sourceDate, '2026-03-10T14:15:00Z');
  assert.strictEqual(s.readAt, 1770000000000);
  assert.strictEqual(s.items.length, 40);
  assert.deepStrictEqual(C.cleanStored(JSON.parse(JSON.stringify(s))), s);
  assert.strictEqual(C.cleanStored(null), null);
  assert.strictEqual(C.cleanStored({ items: [] }), null);
  assert.strictEqual(C.cleanStored({ items: 'x' }), null);
  const dirty = C.cleanStored({ items: [{ category: 'A', id: 'OK', subject: 5, size: 'big' }, { id: 'no category' }, { category: 'A', id: 'B AD', subject: '' }], modified: 7 });
  assert.deepStrictEqual(dirty.items, [{ category: 'A', id: 'OK', subject: '5', size: null }]);
  assert.strictEqual(dirty.modified, '');
});
test('which Inbox messages are worth reading: not seen, not the stored one, not older than it; newest first, capped', () => {
  const list = [
    { mid: 'OLD', date: '2026-03-01T00:00:00Z' }, { mid: 'SRC', date: '2026-03-10T00:00:00Z' },
    { mid: 'NEW1', date: '2026-03-11T00:00:00Z' }, { mid: 'NEW2', date: '2026-03-12T00:00:00Z' }, { mid: 'SEEN', date: '2026-03-13T00:00:00Z' },
  ];
  const stored = { sourceMid: 'SRC', sourceDate: '2026-03-10T00:00:00Z' };
  assert.deepStrictEqual(C.toExamine(list, { seen: new Set(['SEEN']), stored }), ['NEW2', 'NEW1']);
  assert.deepStrictEqual(C.toExamine(list, { seen: new Set(), stored: null }), ['SEEN', 'NEW2', 'NEW1', 'SRC', 'OLD']);
  assert.deepStrictEqual(C.toExamine(list, { seen: new Set(), stored: null, cap: 2 }), ['SEEN', 'NEW2']);
  assert.deepStrictEqual(C.toExamine(null, {}), []);
});
test('the pending flag lasts 7 days', () => {
  const t = 1770000000000;
  assert.strictEqual(C.pendingActive(t, t + 1000), true);
  assert.strictEqual(C.pendingActive(t, t + 7 * 86400000 - 1), true);
  assert.strictEqual(C.pendingActive(t, t + 7 * 86400000), false);
  assert.strictEqual(C.pendingActive(0, t), false);
  assert.strictEqual(C.pendingActive(undefined, t), false);
  assert.strictEqual(C.pendingActive(t + 3600000, t), false, 'a stamp from the future (the clock was wrong) does not lock the button');
});
test('what a surface is given: the full items or none, the picks, pending, the stamp', () => {
  const s = C.storedFrom(C.parseCatalogList(LIST), { mid: 'M', date: '2026-03-10T14:15:00Z' }, 5);
  const p = C.payload(s, { picks: { starred: ['PROP_WWV'], recent: [] }, requestedAt: 0, now: 10 });
  assert.strictEqual(p.items.length, 40);
  assert.strictEqual(p.count, 40);
  assert.strictEqual(p.pending, false);
  assert.strictEqual(p.modified, '2026/03/09 17:08');
  assert.deepStrictEqual(p.picks, { starred: ['PROP_WWV'], recent: [] });
  const none = C.payload(null, { requestedAt: 9, now: 10, unreadable: true });
  assert.deepStrictEqual(none.items, []);
  assert.strictEqual(none.pending, true);
  assert.strictEqual(none.unreadable, true);
  assert.deepStrictEqual(C.stamp(s, { requestedAt: 9, now: 10 }), { count: 40, readAt: 5, requestedAt: 9, unreadable: false });
  assert.deepStrictEqual(C.stamp(null, { requestedAt: 9, now: 9 + 8 * 86400000 }), { count: 0, readAt: 0, requestedAt: 0, unreadable: false });
});

console.log('the source row');
test('the short list', () => {
  assert.deepStrictEqual(C.sourceRow({ items: [], pending: false }), { kind: 'starter', text: 'Showing the short list. Winlink has several hundred more items.', button: 'Get the full catalog' });
});
test('requested: no button, so it cannot be queued twice', () => {
  const r = C.sourceRow({ items: [], pending: true });
  assert.strictEqual(r.kind, 'pending');
  assert.strictEqual(r.text, 'The full catalog is requested. It arrives as a message of about 70 KB after your next Send / Receive, and this list fills in by itself.');
  assert.strictEqual(r.button, '');
  assert.strictEqual(C.sourceRow({ items: FULL, count: 40, pending: true }).kind, 'pending');
});
test('the full catalog: how many items and as of when (Winlink\'s date, else the message date)', () => {
  assert.deepStrictEqual(C.sourceRow({ items: FULL, count: 40, modified: '2026/03/09 17:08', sourceDate: '2026-03-10T14:15:00Z' }), { kind: 'full', text: 'Full catalog: 40 items, as of 9 March 2026.', button: 'Update the catalog' });
  assert.strictEqual(C.sourceRow({ items: FULL, count: 40, modified: '', sourceDate: '2026-03-10T14:15:00Z' }).text, 'Full catalog: 40 items, as of 10 March 2026.');
  assert.strictEqual(C.sourceRow({ items: FULL, count: 40, modified: '', sourceDate: '' }).text, 'Full catalog: 40 items.');
  assert.strictEqual(C.sourceRow({ items: FULL, count: 1400 }).text, 'Full catalog: 1,400 items.');
});
test('a catalog message that could not be read: the short list still works', () => {
  const r = C.sourceRow({ items: [], pending: false, unreadable: true });
  assert.strictEqual(r.kind, 'unreadable');
  assert.strictEqual(r.text, 'A catalog message arrived but POTACAT could not read it. The short list still works.');
  assert.strictEqual(r.button, 'Get the full catalog');
  assert.strictEqual(C.sourceRow({ items: FULL, count: 40, unreadable: true }).kind, 'full', 'an older full catalog is still shown');
});

console.log('every sentence');
test('the panel\'s words', () => {
  const T = C.TEXT;
  assert.strictEqual(T.button, 'Catalog');
  assert.strictEqual(T.buttonTitle, 'Ask Winlink to mail you weather, propagation, gateway lists and help files');
  assert.strictEqual(T.title, 'Winlink catalog');
  assert.strictEqual(T.lead, 'Winlink can mail you weather, propagation forecasts, gateway lists and help files. Tick what you want and put the request in the Outbox. Each answer arrives as its own message: send the request with Send / Receive, wait a few minutes, then connect again to collect it.');
  assert.strictEqual(T.findPlaceholder, 'Find: propagation, Texas forecast, packet gateways');
  assert.strictEqual(T.picksHead, 'Your picks');
  assert.strictEqual(T.radioConfirm, 'The catalog is about 70 KB. Over the radio that can take a long time; it is quick over Telnet.');
  assert.strictEqual(T.radioConfirmYes, 'Request it anyway');
  assert.strictEqual(T.radioConfirmNo, 'Cancel');
  assert.strictEqual(T.findNone, 'Nothing in the catalog has those words.');
  assert.strictEqual(T.findNoneStarter, 'The full catalog has several hundred more items.');
  assert.strictEqual(T.noCallsign, 'Set your callsign in Settings > Station first');
  assert.strictEqual(T.close, 'Close');
  assert.strictEqual(T.send, 'Put in Outbox');
  assert.strictEqual(T.large, 'large');
});
test('after Put in Outbox', () => {
  assert.strictEqual(C.queuedText(3), 'The request for 3 items is in the Outbox. It goes out with your next Send / Receive. The answers arrive a few minutes later, so connect once more to collect them.');
  assert.strictEqual(C.queuedText(1), 'The request for 1 item is in the Outbox. It goes out with your next Send / Receive. The answer arrives a few minutes later, so connect once more to collect it.');
});
test('part of a long request failed: what is in the Outbox and what is not', () => {
  assert.strictEqual(C.partialText(10, 15, 'Pat is not running'), '10 of the 25 items are in the Outbox. The other 15 are still ticked: Pat is not running');
});
test('no sentence has an emoji or a dash used as punctuation', () => {
  const all = Object.keys(C.TEXT).map((k) => C.TEXT[k]).concat(C.STARTER.map((s) => s.name + ' ' + (s.note || '')), [C.queuedText(2), C.partialText(1, 2, 'x')]);
  for (const s of all) assert.ok(/^[\x20-\x7E]+$/.test(s) && !/ - | -- /.test(s), s);
});

console.log('one module, two homes');
test('the same file loads in the mail window as window.WinlinkCatalog', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'winlink-catalog.js'), 'utf8');
  const self = {};
  new Function('self', 'module', src)(self, undefined);
  assert.strictEqual(typeof self.WinlinkCatalog.parseCatalogList, 'function');
  assert.deepStrictEqual(Object.keys(self.WinlinkCatalog).sort(), Object.keys(C).sort());
  assert.ok(!/\brequire\(/.test(src.replace(/\/\/.*$/gm, '')), 'no require: the window has no Node');
  assert.ok(!/=>|`|\bconst\b|\blet\b/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'plain ES5, like the other dual-mode modules');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
