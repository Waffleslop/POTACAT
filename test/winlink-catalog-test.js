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
test('lines built to be slow are not: thousands of spaces, repeated header words', () => {
  const rows = ROWS.map((r) => line(r));
  const slow = [];
  for (let i = 0; i < 1500; i++) slow.push('CAT' + i + ' ID' + i + ' "s"' + ' '.repeat(900) + '7');
  for (let i = 0; i < 300; i++) slow.push('CATEGORY INQUIRY_ID '.repeat(48));
  const t0 = Date.now();
  const pre = [];
  for (let i = 0; i < 300; i++) pre.push('CATEGORY INQUIRY_ID '.repeat(48));
  const p = C.parseCatalogList(pre.concat([HEADER], rows, slow).join('\n'));
  assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0) + ' ms');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.items.length, 40 + 1500);
  assert.strictEqual(p.items[45].size, 7);
  const quotes = [];
  for (let i = 0; i < 1500; i++) quotes.push('CAT ID' + i + ' ' + '" '.repeat(480));
  const t1 = Date.now();
  C.parseCatalogList([HEADER].concat(rows, quotes).join('\n'));
  assert.ok(Date.now() - t1 < 1500, 'quotes: ' + (Date.now() - t1) + ' ms');
});
test('the subject closes at the quote before the size, the date or the end, not at the last quote on the line', () => {
  const rows = ROWS.map((r) => line(r));
  rows.push('CATX  Q1  "Forecast for "Big Bend" area"   5855   2026/03/01 03:44   [G]');
  rows.push('CATX  Q2  "Plain subject"   100   2026/03/01 03:44   [G]   "a later column"');
  rows.push('CATX  Q3  "Ends in a quote""');
  rows.push('CATX  Q4  "No size here"   2026/03/01 03:44   "note"');
  rows.push('CATX  Q5  "Flag only"   [L]');
  rows.push('CATX  Q6  "Never closed properly" and more words');
  const p = C.parseCatalogList([HEADER].concat(rows).join('\n'));
  const get = (id) => p.items.find((i) => i.id === id);
  assert.deepStrictEqual(get('Q1'), { category: 'CATX', id: 'Q1', subject: 'Forecast for "Big Bend" area', size: 5855 });
  assert.deepStrictEqual(get('Q2'), { category: 'CATX', id: 'Q2', subject: 'Plain subject', size: 100 }, 'a quote in a later column does not stretch the subject');
  assert.strictEqual(get('Q3').subject, 'Ends in a quote"');
  assert.deepStrictEqual([get('Q4').subject, get('Q4').size], ['No size here', null]);
  assert.strictEqual(get('Q5').subject, 'Flag only');
  assert.strictEqual(get('Q6'), undefined, 'no closing quote before a size, a date or the end: not a row');
  assert.strictEqual(p.skipped, 1);
});
test('a size with thousands separators', () => {
  const rows = ROWS.map((r) => line(r));
  rows.push('CATX  T1  "Comma size"   219,867   2026/03/01 03:44');
  rows.push('CATX  T2  "Small"   1,234');
  rows.push('CATX  T3  "Not a size"   12,34');
  const p = C.parseCatalogList([HEADER].concat(rows).join('\n'));
  assert.strictEqual(p.items.find((i) => i.id === 'T1').size, 219867);
  assert.strictEqual(p.items.find((i) => i.id === 'T2').size, 1234);
  assert.strictEqual(p.items.find((i) => i.id === 'T3'), undefined);
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
  assert.strictEqual(C.categoryName('WX_US_TX'), 'Weather: Texas');
  assert.strictEqual(C.categoryName('wx_us_nj'), 'Weather: New Jersey');
  assert.strictEqual(C.categoryName('WX_US_ZZ'), 'Weather: US ZZ', 'not a state: the code, with spaces');
  assert.strictEqual(C.categoryName('WX_US_RAD'), 'Weather: US RAD');
  assert.strictEqual(Object.keys(C.US_STATES).length, 52);
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
  assert.strictEqual(g[5].name, 'Weather: Texas');
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
  assert.strictEqual(ids('texas forecast').length, 14, 'the placeholder example finds the Texas items');
  assert.strictEqual(C.searchItems(C.mergeCatalog([{ category: 'WX_US_TX', id: 'TX_TAB', subject: 'Tabular state forecast', size: 1 }]).items, 'texas').length, 1, 'by the state name alone');
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
  assert.strictEqual(C.isLarge({ size: 59499 }), false);
  assert.strictEqual(C.isLarge({ size: 59500 }), true, 'it reads 60 KB, so it is tagged');
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
  for (const mode of ['ardop', 'vara', 'varafm', 'packet', 'mercury']) assert.strictEqual(C.sizeAdvice([it(14499)], mode).advice, '', mode);
});
test('radio, 15 KB to under 60 KB: several minutes', () => {
  assert.strictEqual(C.sizeAdvice([it(15000)], 'ardop').advice, 'About 15 KB. That is several minutes over the radio.');
  assert.strictEqual(C.sizeAdvice([it(30000), it(29499)], 'packet').advice, 'About 59 KB. That is several minutes over the radio.');
  assert.strictEqual(C.sizeAdvice([it(14500)], 'ardop').advice, 'About 15 KB. That is several minutes over the radio.', 'the figure shown decides: 15 KB is never without the line');
  assert.strictEqual(C.sizeAdvice([it(59500)], 'ardop').advice, 'About 60 KB. That is slow over the radio; consider Telnet for this one.');
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

console.log('the stored catalog');
const T0 = 1770000000000;
const BIG = reply(ROWS.concat(ROWS.map((r, i) => [r[0], 'EXTRA' + i, r[2] + ' again and again and again and again and again', r[3]])).concat(ROWS.map((r, i) => [r[0], 'MORE' + i, r[2] + ' once more with a longer line of words', r[3]])));
const catMsg = { body: BIG, from: 'SERVICE' };
test('what is kept on disk, cleaned on the way in and out', () => {
  const s = C.storedFrom(C.parseCatalogList(LIST), { mid: 'ABC123', date: '2026-03-10T14:15:00Z', from: 'SERVICE' }, T0);
  assert.deepStrictEqual([s.modified, s.sourceMid, s.sourceDate, s.sourceFrom, s.readAt, s.items.length], ['2026/03/09 17:08', 'ABC123', '2026-03-10T14:15:00Z', 'SERVICE', T0, 40]);
  assert.deepStrictEqual(C.cleanStored(JSON.parse(JSON.stringify(s))), s);
  assert.strictEqual(C.cleanStored(null), null);
  assert.strictEqual(C.cleanStored({ items: [] }), null);
  assert.strictEqual(C.cleanStored({ items: 'x' }), null);
  const dirty = C.cleanStored({ items: [{ category: 'A', id: 'OK', subject: 5, size: 'big' }, { id: 'no category' }, { category: 'A', id: 'B AD', subject: '' }], modified: 7 });
  assert.deepStrictEqual(dirty.items, [{ category: 'A', id: 'OK', subject: '5', size: null }]);
  assert.strictEqual(dirty.modified, '');
});
test('a sender is one plain word, whatever the mail says', () => {
  assert.strictEqual(C.cleanSender('SERVICE@winlink.org'), 'SERVICE@winlink.org');
  assert.strictEqual(C.cleanSender('<b>x</b>\r\n  evil'), '<b>x</b> evil');
  assert.strictEqual(C.cleanSender('  Winlink   Inquiry\tServer  '), 'Winlink Inquiry Server', 'single spaces are kept');
  assert.strictEqual(C.cleanSender('a'.repeat(200)).length, 60);
  assert.strictEqual(C.cleanSender(null), 'an unknown sender');
});

console.log('the pending request, tied to the message');
const LISTMSG = { mid: 'L1', to: ['INQUIRY'], subject: 'REQUEST' };
const KNOWN = { out: true, sentFresh: true };
const settle = (o) => C.settleRequest({ request: { at: T0, mid: 'L1' }, outbox: [], sent: [], lists: KNOWN, now: T0 + 1000, ...o });
test('which request is ours: the LIST message that a fresh Outbox listing shows after the send and not before', () => {
  assert.deepStrictEqual(C.newRequest(T0, ['OLDLIST'], ['L1', 'OLDLIST']), { at: T0, mid: 'L1' });
  assert.deepStrictEqual(C.newRequest(T0, ['A'], ['A']), { at: T0, mid: '' }, 'cannot be told: kept as unknown');
  assert.deepStrictEqual(C.newRequest(T0, null, null), { at: T0, mid: '' });
  assert.deepStrictEqual(C.requestEntries([{ mid: 'A', to: ['INQUIRY'], subject: 'REQUEST' }, { mid: 'B', to: ['W1AW'], subject: 'REQUEST' }, { mid: 'C', to: ['inquiry@winlink.org'], subject: ' request ' }]), ['A', 'C']);
  assert.deepStrictEqual([C.isListBody(' list\r\n'), C.isListBody('PROP_3DAY'), C.isListBody('LIST\nPROP_3DAY')], [true, false, false]);
});
test('never a second LIST while one is in the Outbox, whatever the state says, and it is said in words; Request again only when none is', () => {
  const said = 'A request for the full catalog is already in the Outbox. It goes out with your next Send / Receive.';
  for (const kind of ['none', 'queued', 'sent', 'unknown']) for (const again of [false, true]) assert.deepStrictEqual(C.listRule({ inOutbox: [{ mid: 'L1' }], kind, again }), { queue: false, text: said }, kind + ' ' + again);
  assert.deepStrictEqual(C.listRule({ inOutbox: [], kind: 'none', again: false }), { queue: true, text: '' });
  assert.deepStrictEqual(C.listRule({ inOutbox: [], kind: 'sent', again: false }), { queue: false, text: '' });
  assert.strictEqual(C.listRule({ inOutbox: [], kind: 'sent', again: true }).queue, true);
  assert.strictEqual(C.listRule({ inOutbox: [], kind: 'unknown', again: false }).queue, false);
  assert.strictEqual(C.TEXT.alreadyQueued, said);
});
test('a LIST found in the Outbox that nobody recorded is adopted as the request; a recorded one that is there is kept', () => {
  assert.deepStrictEqual(C.adoptRequest(null, [{ mid: 'L0', date: 'x' }], T0), { at: T0, mid: 'L0' });
  assert.deepStrictEqual(C.adoptRequest({ at: 5, mid: 'GONE' }, ['L0'], T0), { at: T0, mid: 'L0' });
  assert.deepStrictEqual(C.adoptRequest({ at: 5, mid: 'L0' }, [{ mid: 'L9' }, { mid: 'L0' }], T0), { at: 5, mid: 'L0' });
  assert.deepStrictEqual(C.adoptRequest({ at: 5, mid: 'L1' }, [], T0), { at: 5, mid: 'L1' });
  assert.strictEqual(C.adoptRequest(null, [], T0), null);
});
test('more than one new LIST after the send: the one dated nearest our send is ours', () => {
  const at = Date.parse('2026-03-10T12:00:00Z');
  const after = [{ mid: 'OTHER', date: '2026-03-10T11:20:00Z' }, { mid: 'OURS', date: '2026-03-10T12:00:01Z' }, { mid: 'OLD', date: '2026-03-01T00:00:00Z' }];
  assert.deepStrictEqual(C.newRequest(at, [{ mid: 'OLD' }], after), { at, mid: 'OURS' });
  assert.deepStrictEqual(C.newRequest(at, [], [{ mid: 'A' }, { mid: 'B' }]), { at, mid: 'A' }, 'no dates: the first listed');
  assert.deepStrictEqual(C.noteAfterRequest({ mid: 'U', at: 5 }, true), null, 'a new request clears the could-not-read note');
  assert.deepStrictEqual(C.noteAfterRequest({ mid: 'U', at: 5 }, false), { mid: 'U', at: 5 });
});
test('in the Outbox: queued, however long it sits there, and never forgotten', () => {
  const o = { outbox: [LISTMSG] };
  assert.deepStrictEqual([settle(o).kind, settle(o).pendingKind, settle(o).inOutbox, settle(o).drop, settle(o).requestedAt], ['queued', 'queued', true, false, T0]);
  assert.strictEqual(settle({ ...o, now: T0 + 30 * 86400000 }).kind, 'queued');
  assert.strictEqual(settle({ ...o, stored: { readAt: T0 + 5, items: [] } }).kind, 'queued', 'a catalog read meanwhile does not clear a request that is still in the Outbox');
});
test('deleted from the Outbox before it went (gone, and a fresh Sent list does not hold it): forgotten at once', () => {
  assert.deepStrictEqual([settle({}).kind, settle({}).drop, settle({}).request, settle({}).pending], ['none', true, null, false]);
});
test('a stale or failed Sent list never wipes a request: it is unknown, kept, and shown as queued', () => {
  for (const lists of [{ out: true, sentFresh: false }, { out: false, sentFresh: false }, null]) {
    const s = settle({ lists });
    assert.deepStrictEqual([s.kind, s.drop, s.pendingKind, s.request], ['unknown', false, 'queued', { at: T0, mid: 'L1' }], JSON.stringify(lists));
  }
  assert.strictEqual(settle({ lists: { out: true, sentFresh: false }, sent: [LISTMSG] }).kind, 'sent', 'found in Sent is enough');
});
test('sent: pending with Request again, until a catalog is read or 7 days pass', () => {
  const o = { sent: [LISTMSG] };
  assert.deepStrictEqual([settle(o).kind, settle(o).pendingKind], ['sent', 'sent']);
  assert.strictEqual(settle({ ...o, now: T0 + 7 * 86400000 - 1 }).kind, 'sent');
  assert.deepStrictEqual([settle({ ...o, now: T0 + 7 * 86400000 }).kind, settle({ ...o, now: T0 + 7 * 86400000 }).drop], ['none', true]);
  assert.strictEqual(settle({ ...o, stored: { readAt: T0 + 500, items: [] } }).kind, 'none', 'a catalog read after the request');
  assert.strictEqual(settle({ ...o, stored: { readAt: T0 - 500, items: [] } }).kind, 'sent', 'an older catalog does not answer it');
});
test('a request whose message could not be identified: queued while any catalog request is in the Outbox, else sent', () => {
  const r = { at: T0, mid: '' };
  assert.strictEqual(settle({ request: r, outbox: [{ mid: 'X', to: ['INQUIRY'], subject: 'REQUEST' }] }).kind, 'sent', 'another catalog request in the Outbox proves nothing: queued is only for a message known to be there');
  assert.strictEqual(settle({ request: r, outbox: [{ mid: 'X', to: ['INQUIRY'], subject: 'REQUEST' }], now: T0 + 7 * 86400000 }).kind, 'none', 'and the 7 days apply');
  assert.strictEqual(settle({ request: r }).kind, 'sent');
  assert.strictEqual(settle({ request: r, lists: null }).kind, 'unknown');
  assert.strictEqual(settle({ request: null }).kind, 'none');
  assert.strictEqual(settle({ request: null }).drop, false);
});
test('a clock stepped back does not end the wait: up to an hour ahead counts as just made', () => {
  assert.strictEqual(settle({ sent: [LISTMSG], now: T0 - 5000 }).kind, 'sent');
  assert.strictEqual(settle({ sent: [LISTMSG], now: T0 - 3600000 }).kind, 'sent');
  assert.strictEqual(settle({ sent: [LISTMSG], now: T0 - 3600001 }).kind, 'none', 'more than an hour ahead is not a real stamp');
  assert.strictEqual(C.pendingActive(T0, T0 + 7 * 86400000 - 1), true);
  assert.strictEqual(C.pendingActive(0, T0), false);
});
test('which folders are known: Sent is fresh only when listed with or after the Outbox; a failed listing never counts', () => {
  let l = C.noteListed(null, ['in', 'out', 'sent'], 'BOX');
  assert.deepStrictEqual(l, { box: 'BOX', out: true, sentFresh: true });
  l = C.noteListed(l, ['out'], 'BOX');
  assert.deepStrictEqual(l, { box: 'BOX', out: true, sentFresh: false }, 'the Outbox changed: the Sent list is older now');
  assert.strictEqual(C.noteListed(l, ['in', 'out'], 'BOX').sentFresh, false, 'Sent failed to list');
  assert.strictEqual(C.noteListed(l, ['sent'], 'BOX').sentFresh, true);
  assert.deepStrictEqual(C.noteListed(l, [], 'OTHER'), { box: 'OTHER', out: false, sentFresh: false }, 'another operator: nothing known');
  assert.deepStrictEqual(C.noteListed(l, [], 'BOX'), l);
});

console.log('one Inbox message: skip, unreadable, accept or offer');
const stored400 = { items: Array.from({ length: 400 }, (_, i) => ({ category: 'A', id: 'S' + i, subject: '', size: null })), readAt: 1 };
const FORGED = { body: reply(ROWS.slice(0, 21)) + '\n' + ' '.repeat(5000), from: 'STRANGER@example.com' };
test('not a catalog: skipped, with no log line', () => {
  for (const m of [{ body: 'hello' }, { body: 'x'.repeat(9000) }, null]) assert.deepStrictEqual(C.decideMessage(m, { mid: 'M', pending: true }), { action: 'skip' });
});
test('a mail that only mentions the column names is not a catalog, pending or not, and nothing of it is logged', () => {
  const words = { body: 'To ask, send the INQUIRY_ID.\nCATEGORY then INQUIRY_ID then SUBJECT are the columns.\n' + 'More words here.\n'.repeat(600) };
  assert.deepStrictEqual(C.decideMessage(words, { mid: 'M', pending: false }), { action: 'skip' });
  assert.deepStrictEqual(C.decideMessage(words, { mid: 'M', pending: true }), { action: 'skip' }, 'pending or not');
  const mention = { body: 'Read about INQUIRY_ID.\n' + 'More words here.\n'.repeat(600) };
  assert.deepStrictEqual(C.decideMessage(mention, { mid: 'M', pending: true }), { action: 'skip' }, 'no header line: never flagged');
});
test('unreadable: the header and at least 5 rows, or the header while a request is pending; the log has counts only', () => {
  const junk = [];
  for (let i = 0; i < 60; i++) junk.push('SECRET LINE OF MAIL number ' + i + ' ' + 'pad '.repeat(20));
  const broken = { body: reply(ROWS.slice(0, 6), { tail: junk }), from: 'SERVICE' };
  const d = C.decideMessage(broken, { mid: 'M', pending: false, from: 'SERVICE' });
  assert.strictEqual(d.action, 'unreadable');
  assert.strictEqual(d.log, 'catalog: a message from SERVICE looks like the Winlink catalog but its table could not be read (6 rows read, 60 lines skipped)');
  assert.ok(!/SECRET/.test(d.log));
  const few = { body: reply(ROWS.slice(0, 4), { tail: junk }) };
  assert.strictEqual(C.decideMessage(few, { mid: 'M', pending: false }).action, 'skip', '4 rows and nobody waiting: not flagged');
  assert.strictEqual(C.decideMessage(few, { mid: 'M', pending: true }).action, 'skip', 'a help text with the header never ends a wait');
  assert.strictEqual(C.UNREADABLE_MIN_ROWS, 5);
});
test('a catalog nobody asked for is offered, never taken', () => {
  const d = C.decideMessage(catMsg, { mid: 'M1', from: 'SERVICE', date: '2026-03-10T14:15:00Z', pending: false, stored: null, now: T0 });
  assert.strictEqual(d.action, 'offer');
  assert.deepStrictEqual(d.offer, { mid: 'M1', from: 'SERVICE', date: '2026-03-10T14:15:00Z', count: 120, have: 0 });
  assert.strictEqual(d.log, 'catalog: a catalog message from SERVICE is in the Inbox (120 items); it is used only if the operator says so');
  assert.strictEqual(d.stored, undefined);
});
test('a catalog the operator asked for is accepted', () => {
  const d = C.decideMessage(catMsg, { mid: 'M1', from: 'SERVICE', date: '2026-03-10T14:15:00Z', pending: true, stored: null, now: T0 });
  assert.strictEqual(d.action, 'accept');
  assert.deepStrictEqual([d.stored.items.length, d.stored.sourceMid, d.stored.sourceFrom, d.stored.readAt], [120, 'M1', 'SERVICE', T0]);
  assert.strictEqual(d.log, 'catalog: read the Winlink catalog you asked for, from SERVICE (120 items)');
});
test('asked for, but fewer than half the items of the catalog in use: offered, with both counts', () => {
  const d = C.decideMessage(catMsg, { mid: 'M1', from: 'SERVICE', pending: true, stored: stored400, now: T0 });
  assert.strictEqual(d.action, 'offer');
  assert.deepStrictEqual([d.offer.count, d.offer.have], [120, 400]);
  const half = { items: stored400.items.slice(0, 240) };
  assert.strictEqual(C.decideMessage(catMsg, { mid: 'M1', pending: true, stored: half, now: T0 }).action, 'accept', 'exactly half is not a shrink');
});
test('the forged 21-row mail in each state', () => {
  assert.strictEqual(C.decideMessage(FORGED, { mid: 'F', from: FORGED.from, pending: false, stored: null, now: T0 }).action, 'offer', 'nothing asked for: the operator decides');
  assert.strictEqual(C.decideMessage(FORGED, { mid: 'F', from: FORGED.from, pending: false, stored: stored400, now: T0 }).action, 'offer');
  assert.strictEqual(C.decideMessage(FORGED, { mid: 'F', from: FORGED.from, pending: true, stored: stored400, now: T0 }).action, 'offer', 'pending, but it would shrink 400 items to 21');
  assert.strictEqual(C.decideMessage(FORGED, { mid: 'F', from: FORGED.from, pending: true, stored: null, now: T0 }).action, 'accept', 'pending and no catalog yet: the reply the operator asked for');
  assert.strictEqual(C.decideMessage(FORGED, { mid: 'F', from: FORGED.from, pending: false, declined: ['F'], now: T0 }).action, 'skip', 'declined once: not offered again');
  assert.strictEqual(C.sourceRow({ items: [], offer: C.decideMessage(FORGED, { mid: 'F', from: '<i>x</i> STRANGER', pending: false, now: T0 }).offer }).text, 'A catalog message from <i>x</i> STRANGER is in your Inbox: 21 items.', 'the sender is plain text for the surface to show as text');
});
test('declined offers are remembered by message, the last 50', () => {
  let d = [];
  for (let i = 0; i < 60; i++) d = C.addDeclined(d, 'M' + i);
  assert.strictEqual(d.length, 50);
  assert.strictEqual(d[49], 'M59');
  assert.deepStrictEqual(C.addDeclined(['A'], 'A'), ['A']);
  assert.deepStrictEqual(C.cleanDeclined(['A', 5, '', null]), ['A']);
  assert.strictEqual(C.cleanOffer({ mid: 'M', count: 0 }), null);
});
test('Use it: the offered message read again; gone or changed is no catalog', () => {
  const offer = { mid: 'M1', from: 'SERVICE', date: '2026-03-10T14:15:00Z', count: 120, have: 0 };
  assert.strictEqual(C.useOffer(catMsg, offer, T0).items.length, 120);
  assert.strictEqual(C.useOffer({ body: 'gone' }, offer, T0), null);
  assert.strictEqual(C.useOffer(catMsg, null, T0), null);
});

test('while pending, only a catalog dated after the request (less 10 minutes) is the reply; an older one is offered and ends nothing', () => {
  const at = Date.parse('2026-03-10T12:00:00Z');
  const ctx = (date) => ({ mid: 'M1', from: 'SERVICE', date, pending: true, requestAt: at, stored: null, now: T0 });
  const old = C.decideMessage(catMsg, ctx('2025-07-01T00:00:00Z'));
  assert.deepStrictEqual([old.action, old.answers], ['offer', false], 'a catalog from last year is not what was asked for');
  assert.strictEqual(C.decideMessage(catMsg, ctx('2026-03-10T11:49:59Z')).action, 'offer');
  assert.strictEqual(C.decideMessage(catMsg, ctx('2026-03-10T11:50:00Z')).action, 'accept', '10 minutes of clock difference are allowed');
  assert.strictEqual(C.decideMessage(catMsg, ctx('2026-03-10T12:05:00Z')).action, 'accept');
  assert.deepStrictEqual([C.decideMessage(catMsg, ctx('not a date')).action, C.decideMessage(catMsg, ctx('not a date')).answers], ['offer', false]);
  const shrink = C.decideMessage(catMsg, { ...ctx('2026-03-10T12:05:00Z'), stored: stored400 });
  assert.deepStrictEqual([shrink.action, shrink.answers], ['offer', true], 'the reply arrived, but it is the operator who decides');
  assert.strictEqual(C.REPLY_EARLY_MS, 600000);
});

console.log('what a finished pass changes');
const passOf = (o) => ({ accepted: null, offer: null, unreadableMid: '', clearPending: false, failed: false, examined: 1, left: 0, logs: [], ...o });
test('accepted: the wait is over, the could-not-read note is cleared, an outstanding offer is superseded', () => {
  const r = C.applyScan({ request: { at: T0, mid: 'L1' }, offer: { mid: 'OLDOFFER', from: 'X', count: 30 }, declined: ['D1'], unreadable: { mid: 'U1' } }, passOf({ accepted: { items: [1] }, clearPending: true }), ['A', 'B'], 5);
  assert.deepStrictEqual(r.state, { request: null, offer: null, declined: ['D1', 'OLDOFFER'], unreadable: null, examined: ['A', 'B'] });
  assert.deepStrictEqual([r.changed, r.save, r.lookDone, r.again], [true, true, true, false]);
});
test('a request whose message is still in the Outbox is never cleared by a pass', () => {
  const r = C.applyScan({ request: { at: T0, mid: 'L1' }, requestInOutbox: true }, passOf({ offer: { mid: 'M', from: 'X', count: 30 }, clearPending: true }), [], 5);
  assert.deepStrictEqual(r.state.request, { at: T0, mid: 'L1' });
});
test('offered: kept for the operator; an older offer is superseded; the same offer again changes nothing', () => {
  const offer = { mid: 'M2', from: 'W1AW', date: '', count: 21, have: 400 };
  const r = C.applyScan({ request: { at: T0, mid: 'L1' }, offer: { mid: 'M1', from: 'X', count: 30 }, declined: [] }, passOf({ offer, clearPending: true }), [], 5);
  assert.deepStrictEqual([r.state.offer, r.state.declined, r.state.request, r.changed], [offer, ['M1'], null, true]);
  const same = C.applyScan({ offer }, passOf({ offer, examined: 0 }), [], 5);
  assert.deepStrictEqual([same.state.declined, same.changed, same.save], [[], false, false]);
});
test('unreadable: noted with its message, once; it survives a restart and a later pass that finds nothing', () => {
  const r = C.applyScan({ request: { at: T0, mid: 'L1' } }, passOf({ unreadableMid: 'U1', clearPending: true }), [], 5);
  assert.deepStrictEqual([r.state.unreadable, r.state.request, r.changed], [{ mid: 'U1' }, null, true]);
  assert.strictEqual(C.applyScan({ unreadable: { mid: 'U1' } }, passOf({ unreadableMid: 'U1' }), [], 5).changed, false);
  assert.deepStrictEqual(C.applyScan({ unreadable: { mid: 'U1' } }, passOf({}), [], 5).state.unreadable, { mid: 'U1' });
  assert.strictEqual(C.cleanUnreadable({ mid: '' }), null);
});
test('the one-time look is finished only when nothing failed, there was mail, and none is left; more mail asks for another pass', () => {
  assert.deepStrictEqual([C.applyScan({}, passOf({}), [], 5).lookDone, C.applyScan({}, passOf({}), [], 5).again], [true, false]);
  assert.strictEqual(C.applyScan({}, passOf({}), [], 0).lookDone, false, 'the Inbox was not listed yet');
  assert.deepStrictEqual([C.applyScan({}, passOf({ failed: true, left: 1 }), [], 5).lookDone, C.applyScan({}, passOf({ failed: true, left: 1 }), [], 5).again], [false, false]);
  assert.deepStrictEqual([C.applyScan({}, passOf({ left: 300 }), [], 500).lookDone, C.applyScan({}, passOf({ left: 300 }), [], 500).again], [false, true]);
});
test('the examined set never shrinks under a pass: pruned to the Inbox as it is, capped no lower than the Inbox', () => {
  const inbox = Array.from({ length: 1300 }, (_, i) => ({ mid: 'M' + i }));
  const all = inbox.map((m) => m.mid);
  const r = C.applyScan({ examined: all.slice(0, 1100) }, passOf({ examined: 200, left: 0 }), ['GONE1', 'GONE2'].concat(all), 1300, inbox);
  assert.strictEqual(r.state.examined.length, 1300, 'every Inbox message stays examined: none is read again');
  assert.ok(!r.state.examined.includes('GONE1'), 'IDs no longer in the Inbox are dropped');
  assert.deepStrictEqual([r.save, r.lookDone, r.again], [true, true, false]);
  const same = C.applyScan({ examined: all }, passOf({ examined: 0 }), all, 1300, inbox);
  assert.strictEqual(same.save, false, 'nothing new examined: the settings are not written');
  assert.strictEqual(C.toSettings({ examined: all }).winlinkCatalogExamined.length, 1300);
  assert.strictEqual(C.cleanExamined(Array.from({ length: 6000 }, (_, i) => 'X' + i), C.EXAMINED_LIMIT).length, 5000);
});
test('another pass is asked for only when this one made progress, so a scan always ends', () => {
  assert.strictEqual(C.applyScan({}, passOf({ left: 300, examined: 200 }), [], 500).again, true);
  assert.strictEqual(C.applyScan({}, passOf({ left: 300, examined: 0 }), [], 500).again, false);
});
test('a pending request that is newer than the could-not-read note outranks it; an older one does not', () => {
  const note = { mid: 'U', at: 100 };
  assert.strictEqual(C.payload(null, { pendingKind: 'queued', requestedAt: 200, unreadable: note }).unreadable, false);
  assert.strictEqual(C.sourceRow(C.payload(null, { pendingKind: 'queued', requestedAt: 200, unreadable: note })).kind, 'pending');
  assert.strictEqual(C.payload(null, { pendingKind: 'queued', requestedAt: 50, unreadable: note }).unreadable, true);
  assert.strictEqual(C.payload(null, { unreadable: note }).unreadable, true);
  assert.strictEqual(C.stamp(null, { pendingKind: 'sent', requestedAt: 200, unreadable: note }).unreadable, false);
  assert.deepStrictEqual(C.applyScan({ now: 77 }, passOf({ unreadableMid: 'U1' }), [], 5).state.unreadable, { mid: 'U1', at: 77 });
});
test('what is kept in settings; an empty value removes its key; the old date mark is removed', () => {
  const s = C.toSettings({ request: { at: T0, mid: 'L1' }, offer: null, declined: [], examined: ['A'], unreadable: { mid: 'U' } });
  assert.deepStrictEqual(s, { winlinkCatalogRequest: { at: T0, mid: 'L1' }, winlinkCatalogOffer: undefined, winlinkCatalogDeclined: undefined, winlinkCatalogExamined: ['A'], winlinkCatalogUnreadable: { mid: 'U' }, winlinkCatalogScannedTo: undefined });
  assert.ok('winlinkCatalogScannedTo' in s);
  const many = [];
  for (let i = 0; i < 1200; i++) many.push('M' + i);
  assert.deepStrictEqual([C.cleanExamined(many).length, C.cleanExamined(many)[999], C.EXAMINED_MAX], [1000, 'M1199', 1000]);
});
test('after Use it or No thanks: the answered offer goes; one that arrived meanwhile stays', () => {
  const a = { mid: 'M1', from: 'X', count: 30 };
  const b = { mid: 'M2', from: 'Y', date: '', count: 50, have: 0 };
  assert.deepStrictEqual(C.afterOffer({ offer: a, declined: [], unreadable: { mid: 'U' } }, a, true), { offer: null, declined: ['M1'], unreadable: null });
  assert.deepStrictEqual(C.afterOffer({ offer: b, declined: [], unreadable: { mid: 'U' } }, a, false), { offer: b, declined: ['M1'], unreadable: { mid: 'U' } });
});

console.log('which messages a pass reads');
const INBOX = [
  { mid: 'OLD', date: '2026-03-01T00:00:00Z', from: 'A' }, { mid: 'MID', date: '2026-03-10T00:00:00Z', from: 'B' },
  { mid: 'NEW1', date: '2026-03-11T00:00:00Z', from: 'C' }, { mid: 'NEW2', date: '2026-03-12T00:00:00Z', from: 'D' }, { mid: 'SEEN', date: '2026-03-13T00:00:00Z', from: 'E' },
];
test('every message not examined before, whatever its date; newest-dated first; capped, with the rest counted', () => {
  assert.deepStrictEqual(C.toExamine(INBOX, { seen: new Set(['SEEN']) }), { mids: ['NEW2', 'NEW1', 'MID', 'OLD'], left: 0 });
  assert.deepStrictEqual(C.toExamine(INBOX, { seen: new Set(), cap: 2 }), { mids: ['SEEN', 'NEW2'], left: 3 });
  assert.deepStrictEqual(C.toExamine(INBOX, { seen: new Set(INBOX.map((m) => m.mid)) }), { mids: [], left: 0 }, 'nothing is fetched twice across launches');
  assert.deepStrictEqual(C.toExamine(null, {}), { mids: [], left: 0 });
  assert.deepStrictEqual([C.shouldScan({ pending: true }), C.shouldScan({ want: true }), C.shouldScan({})], [true, true, false]);
});

console.log('what a surface is given');
test('the full items or none, the picks, where the request stands, an offer, the stamp', () => {
  const s = C.storedFrom(C.parseCatalogList(LIST), { mid: 'M', date: '2026-03-10T14:15:00Z' }, 5);
  const p = C.payload(s, { picks: { starred: ['PROP_WWV'], recent: [] } });
  assert.deepStrictEqual([p.items.length, p.count, p.pending, p.pendingKind, p.modified, p.offer], [40, 40, false, '', '2026/03/09 17:08', null]);
  assert.deepStrictEqual(p.picks, { starred: ['PROP_WWV'], recent: [] });
  const none = C.payload(null, { pendingKind: 'sent', requestedAt: 9, unreadable: true, offer: { mid: 'M', from: 'X', count: 30 } });
  assert.deepStrictEqual([none.items, none.pending, none.pendingKind, none.requestedAt, none.unreadable], [[], true, 'sent', 9, true]);
  assert.deepStrictEqual(none.offer, { mid: 'M', from: 'X', date: '', count: 30, have: 0 });
  assert.strictEqual(C.payload(null, { pendingKind: 'bogus', requestedAt: 9 }).pending, false);
  assert.deepStrictEqual(C.stamp(s, { pendingKind: 'queued', requestedAt: 9, picksAt: 77, offer: { mid: 'M', count: 3 } }), { count: 40, readAt: 5, requestedAt: 9, pendingKind: 'queued', unreadable: false, offerMid: 'M', picksAt: 77 });
  assert.deepStrictEqual(C.stamp(null, {}), { count: 0, readAt: 0, requestedAt: 0, pendingKind: '', unreadable: false, offerMid: '', picksAt: 0 });
});

console.log('what may be requested');
test('only items of the catalog in force: the starter list, or the full catalog', () => {
  assert.deepStrictEqual(C.checkRequest(['PROP_3DAY', 'DIDUNO', 'PROP_3DAY'], null), { ok: true, ids: ['PROP_3DAY', 'DIDUNO'], over: 0, error: '' });
  assert.strictEqual(C.checkRequest(['PUB_VARA'], null).ok, false, 'not in the starter list');
  assert.strictEqual(C.checkRequest(['PUB_VARA'], FULL).ok, true, 'in the full catalog');
  assert.strictEqual(C.checkRequest(['DIDUNO', 'MADE_UP'], FULL).ok, false, 'one unknown ID refuses the whole request');
  assert.deepStrictEqual(C.checkRequest(['DIDUNO', 'MADE_UP'], FULL).ids, []);
  assert.strictEqual(C.checkRequest(['DIDUNO', 'MADE_UP'], FULL).error, C.TEXT.notInCatalog);
  assert.strictEqual(C.checkRequest([], FULL).error, 'Tick at least one item.');
  assert.strictEqual(C.checkRequest('PROP_3DAY', FULL).ok, false);
  for (const bad of [null, 5, {}, ['x'], '__proto__', 'constructor', 'hasOwnProperty']) assert.strictEqual(C.checkRequest([bad], FULL).ok, false, String(bad));
});
test('the command words are never items, even when a catalog lists them', () => {
  const withWords = FULL.concat([{ category: 'WL2K_HELP', id: 'LIST', subject: 'x', size: 1 }, { category: 'WL2K_HELP', id: 'UPDATE_CAT', subject: 'y', size: 1 }, { category: 'WL2K_HELP', id: 'list', subject: 'z', size: 1 }]);
  assert.strictEqual(C.mergeCatalog(withWords).items.length, 40, 'not listed');
  for (const w of ['LIST', 'UPDATE_CAT', 'list']) assert.strictEqual(C.checkRequest([w], withWords).ok, false, w);
  assert.strictEqual(C.checkRequest(['LIST'], null).ok, false);
});
test('more than 200 ticked: the first 200 go, the rest are counted', () => {
  const many = Array.from({ length: 230 }, (_, i) => ({ category: 'A', id: 'N' + i, subject: '', size: null }));
  const r = C.checkRequest(many.map((m) => m.id), many);
  assert.deepStrictEqual([r.ok, r.ids.length, r.over, r.ids[199]], [true, 200, 30, 'N199']);
  assert.strictEqual(C.buildRequests(r.ids).length, 20);
  assert.strictEqual(C.overText(200, 30), '200 of the 230 items are in the Outbox. The other 30 are still ticked.');
  assert.strictEqual(C.overText(200, 1), '200 of the 201 items are in the Outbox. The other 1 is still ticked.');
  const huge = Array.from({ length: 5300 }, (_, i) => ({ category: 'A', id: 'H' + i, subject: '', size: null }));
  const big = C.checkRequest(huge.map((m) => m.id), huge.slice(0, 5000));
  assert.deepStrictEqual([big.ok, big.ids.length, big.over], [true, 200, 5100], 'IDs past 5,000 are counted, not lost');
});
test('a star goes only on an item of the catalog in force; it can always be taken off', () => {
  assert.deepStrictEqual([C.mayStar('PROP_WWV', true, null), C.mayStar('MADE_UP', true, null), C.mayStar('MADE_UP', false, null), C.mayStar('<b>', false, null), C.mayStar('LIST', true, FULL), C.mayStar('PUB_VARA', true, FULL)], [true, false, true, false, false, true]);
});

console.log('the source row');
test('the short list', () => {
  assert.deepStrictEqual(C.sourceRow({ items: [], pending: false }), { kind: 'starter', text: 'Showing the short list. Winlink has several hundred more items.', button: 'Get the full catalog', button2: '' });
});
test('requested and still in the Outbox: no button, so it cannot be queued twice', () => {
  assert.deepStrictEqual(C.sourceRow({ items: [], pending: true, pendingKind: 'queued' }), { kind: 'pending', text: 'The full catalog is requested. It arrives as a message of about 70 KB after your next Send / Receive, and this list fills in by itself.', button: '', button2: '' });
});
test('requested and sent: the same words and a quiet Request again', () => {
  assert.deepStrictEqual(C.sourceRow({ items: FULL, count: 40, pending: true, pendingKind: 'sent' }), { kind: 'pending', text: C.TEXT.sourcePending, button: '', button2: 'Request again' });
});
test('the full catalog: how many items and as of when (Winlink\'s date, else the message date)', () => {
  assert.deepStrictEqual(C.sourceRow({ items: FULL, count: 40, modified: '2026/03/09 17:08', sourceDate: '2026-03-10T14:15:00Z' }), { kind: 'full', text: 'Full catalog: 40 items, as of 9 March 2026.', button: 'Update the catalog', button2: '' });
  assert.strictEqual(C.sourceRow({ items: FULL, count: 40, modified: '', sourceDate: '2026-03-10T14:15:00Z' }).text, 'Full catalog: 40 items, as of 10 March 2026.');
  assert.strictEqual(C.sourceRow({ items: FULL, count: 40, modified: '', sourceDate: '' }).text, 'Full catalog: 40 items.');
  assert.strictEqual(C.sourceRow({ items: FULL, count: 1400 }).text, 'Full catalog: 1,400 items.');
});
test('pending and unreadable, every combination: unreadable always wins and always has a button', () => {
  const kinds = [];
  for (const full of [false, true]) for (const pending of [false, true]) for (const unreadable of [false, true]) {
    const r = C.sourceRow({ items: full ? FULL : [], count: full ? 40 : 0, pending, pendingKind: pending ? 'queued' : '', unreadable });
    kinds.push([full, pending, unreadable, r.kind, r.button].join(' '));
    if (unreadable) assert.ok(r.kind === 'unreadable' && r.button, 'never left waiting with no button');
  }
  assert.deepStrictEqual(kinds, [
    'false false false starter Get the full catalog', 'false false true unreadable Get the full catalog',
    'false true false pending ', 'false true true unreadable Get the full catalog',
    'true false false full Update the catalog', 'true false true unreadable Update the catalog',
    'true true false pending ', 'true true true unreadable Update the catalog',
  ]);
  assert.strictEqual(C.sourceRow({ items: [], unreadable: true }).text, 'A catalog message arrived but POTACAT could not read it. The short list still works.');
  assert.strictEqual(C.sourceRow({ items: FULL, count: 40, unreadable: true }).text, 'A newer catalog message arrived but POTACAT could not read it. Your catalog is unchanged.');
});
test('a catalog waiting for the operator: Use it / No thanks, and both counts when it is much smaller', () => {
  assert.deepStrictEqual(C.sourceRow({ items: [], offer: { mid: 'M', from: 'SERVICE', count: 1400, have: 0 } }), { kind: 'offer', text: 'A catalog message from SERVICE is in your Inbox: 1,400 items.', button: 'Use it', button2: 'No thanks' });
  assert.strictEqual(C.sourceRow({ items: FULL, count: 400, offer: { mid: 'M', from: 'W1AW', count: 21, have: 400 } }).text, 'A catalog message from W1AW is in your Inbox: 21 items. Yours has 400.');
  assert.strictEqual(C.sourceRow({ items: FULL, count: 400, offer: { mid: 'M', from: 'W1AW', count: 390, have: 400 } }).text, 'A catalog message from W1AW is in your Inbox: 390 items.');
  assert.strictEqual(C.sourceRow({ items: [], pending: true, unreadable: true, offer: { mid: 'M', from: 'X', count: 30 } }).kind, 'offer', 'the one with something to decide goes first');
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

// ── a real Pat, offline (skipped when there is none) ──────────────────────
// Pat takes a request To INQUIRY into its Outbox with the body byte for byte,
// and reading an Inbox message does not mark it read: the two things the
// glue in main.js relies on. Pat never connects here (no --listen, a closed
// proxy, its own folders).
async function realPat() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const net = require('net');
  const { spawn } = require('child_process');
  const WinlinkPat = require('../lib/winlink-pat');
  const { WinlinkClient } = require('../lib/winlink-client');
  const bin = process.env.POTACAT_TEST_PAT || path.join(__dirname, '..', 'assets', 'pat', WinlinkPat.patBinaryName());
  if (!fs.existsSync(bin)) return 'skip';
  const { patTestEnv } = require('./modem-loopback/pat-env');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-catalog-'));
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(WinlinkPat.buildPatConfig({ mycall: 'N0CALL', httpPort: port }), null, 2));
  const mbox = path.join(dir, 'mailbox');
  fs.mkdirSync(mbox, { recursive: true });
  const args = WinlinkPat.buildPatArgs({ configPath: cfgPath, mboxDir: mbox, logPath: path.join(dir, 'pat.log'), eventLogPath: path.join(dir, 'pat-events.json'), formsDir: path.join(dir, 'forms') });
  const proc = spawn(bin, args, { stdio: 'ignore', env: patTestEnv(dir, ['N0CALL']), windowsHide: true });
  const c = new WinlinkClient({ port });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { await c.status(); up = true; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    assert.ok(up, 'Pat answered');
    // 12 items: two messages, 10 and 2, exactly as built.
    const ids = FULL.slice(0, 12).map((i) => i.id);
    const msgs = C.buildRequests(ids);
    for (const m of msgs) {
      const f = composeFields({ to: m.to, subject: m.subject, body: m.body });
      assert.strictEqual(f.ok, true, f.error);
      await c.send(f.fields, []);
    }
    const out = await c.mailbox('out');
    assert.strictEqual(out.length, 2, 'two request messages in the Outbox');
    const bodies = [];
    for (const q of out) {
      assert.deepStrictEqual([q.to.join(','), q.subject], ['INQUIRY', 'REQUEST']);
      bodies.push((await c.message('out', q.mid)).body.replace(/\r\n/g, '\n').trim());
    }
    assert.deepStrictEqual(bodies.sort(), msgs.map((m) => m.body).sort(), 'Pat holds the IDs as sent, one per line');
    // A catalog reply in the Inbox: a message file put there, as a session would.
    const big = reply(ROWS.concat(ROWS.map((r, i) => [r[0], 'EXTRA' + i, r[2] + ' again and again and again and again and again', r[3]])).concat(ROWS.map((r, i) => [r[0], 'MORE' + i, r[2] + ' once more with a longer line of words', r[3]])));
    assert.ok(big.length > C.LIST_MIN_BYTES);
    const f = composeFields({ to: 'N0CALL', subject: 'INQUIRY: LIST', body: big });
    await c.send(f.fields, []);
    const queued = (await c.mailbox('out')).find((m) => m.subject === 'INQUIRY: LIST');
    const outDir = path.join(mbox, 'N0CALL', 'out');
    const file = fs.readdirSync(outDir).find((n) => n.indexOf(queued.mid) === 0);
    assert.ok(file, 'the message file: ' + fs.readdirSync(outDir).join(' '));
    fs.mkdirSync(path.join(mbox, 'N0CALL', 'in'), { recursive: true });
    fs.renameSync(path.join(outDir, file), path.join(mbox, 'N0CALL', 'in', file));
    await c.markRead('in', queued.mid, false);
    const before = (await c.mailbox('in')).find((m) => m.mid === queued.mid);
    assert.strictEqual(before.read, false, 'unread to begin with');
    const msg = await c.message('in', queued.mid);
    assert.strictEqual(C.looksLikeCatalog(msg), true);
    const p = C.parseCatalogList(msg.body);
    assert.strictEqual(p.ok, true, p.reason);
    assert.strictEqual(p.items.length, 120);
    assert.strictEqual(p.modified, '2026/03/09 17:08');
    const after = (await c.mailbox('in')).find((m) => m.mid === queued.mid);
    assert.strictEqual(after.read, false, 'reading the message for its catalog does not mark it read');
    assert.deepStrictEqual(C.toExamine(await c.mailbox('in'), { seen: new Set() }).mids, [queued.mid]);
  } finally {
    c.close();
    try { proc.kill(); } catch { /* gone */ }
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Pat still has a file open: the temp folder is cleaned by the OS */ }
  }
  return 'ok';
}

console.log('');
async function scanTests() {
  const check = async (name, fn) => {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  };
  const box = { NEW2: catMsg, NEW1: { body: BIG.replace('Global_Modified: 2026/03/09', 'Global_Modified: 2026/01/01'), from: 'OLDER' }, SEEN: { body: 'hello' }, MID: { body: 'hi' }, OLD: { body: 'yo' } };
  const run = (o) => {
    const reads = [];
    const writes = [];
    const seen = o.seen || new Set();
    return C.scanInbox({
      list: INBOX, seen, mark: o.mark || '', stored: o.stored || null, pending: !!o.pending, declined: o.declined || [], now: T0, cap: o.cap,
      read: (mid) => { reads.push(mid); if (o.fail && o.fail.includes(mid)) return Promise.reject(new Error('Pat did not answer')); return Promise.resolve((o.box || box)[mid]); },
      store: (s) => { writes.push(s); if (o.storeThrows) throw new Error('disk'); return o.storeRefused ? undefined : true; },
    }).then((res) => ({ res, reads, writes, seen }));
  };
  console.log('a pass over the Inbox');
  await check('newest wins: the first catalog found ends the pass, and it is accepted when one was asked for', async () => {
    const { res, reads, writes, seen } = await run({ pending: true });
    assert.deepStrictEqual(reads, ['SEEN', 'NEW2'], 'one at a time, newest first, and no further');
    assert.strictEqual(res.accepted.sourceMid, 'NEW2');
    assert.strictEqual(res.accepted.modified, '2026/03/09 17:08');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(res.clearPending, true, 'pending is cleared on read');
    assert.strictEqual(res.left, 3, 'the three older ones were not needed');
    assert.ok(seen.has('SEEN') && seen.has('NEW2') && !seen.has('NEW1'));
    assert.deepStrictEqual(res.logs, ['catalog: read the Winlink catalog you asked for, from D (120 items)']);
  });
  await check('nothing asked for: offered, not written', async () => {
    const { res, writes } = await run({ pending: false });
    assert.strictEqual(res.accepted, null);
    assert.strictEqual(writes.length, 0);
    assert.deepStrictEqual(res.offer, { mid: 'NEW2', from: 'D', date: '2026-03-12T00:00:00Z', count: 120, have: 0 });
    assert.strictEqual(res.clearPending, false);
  });
  await check('asked for, but it would shrink the catalog in use: offered, and the wait is over', async () => {
    const { res, writes } = await run({ pending: true, stored: stored400 });
    assert.strictEqual(writes.length, 0);
    assert.deepStrictEqual([res.offer.count, res.offer.have, res.clearPending], [120, 400, true]);
  });
  await check('a declined message is passed over; the next catalog is the one offered', async () => {
    const { res, reads } = await run({ pending: false, declined: ['NEW2'] });
    assert.deepStrictEqual(reads, ['SEEN', 'NEW2', 'NEW1']);
    assert.strictEqual(res.offer.mid, 'NEW1');
  });
  await check('a read that fails: the message is not marked seen, the mark does not move, the rest is still read', async () => {
    const { res, reads, seen } = await run({ pending: true, fail: ['SEEN'] });
    assert.deepStrictEqual(reads, ['SEEN', 'NEW2']);
    assert.strictEqual(res.failed, true);
    assert.ok(!seen.has('SEEN') && seen.has('NEW2'));
    assert.strictEqual(res.left, 4, 'the failed one is asked for again on the next pass');
    assert.strictEqual(res.accepted.sourceMid, 'NEW2');
  });
  await check('a write that is refused or throws: nothing accepted, not seen, no success logged, pending kept', async () => {
    for (const o of [{ storeRefused: true }, { storeThrows: true }]) {
      const { res, seen } = await run({ pending: true, ...o });
      assert.deepStrictEqual([res.accepted, res.failed, res.clearPending, res.logs.length, res.left], [null, true, false, 0, 4]);
      assert.ok(!seen.has('NEW2'));
    }
  });
  await check('pending plus an unreadable reply: flagged, the wait is over, older mail is still looked at', async () => {
    const junk = [];
    for (let i = 0; i < 60; i++) junk.push('line ' + i + ' ' + 'pad '.repeat(20));
    const b = { ...box, SEEN: { body: reply(ROWS.slice(0, 8), { tail: junk }), from: 'E' }, NEW2: { body: 'x' }, NEW1: { body: 'y' } };
    const { res, reads } = await run({ pending: true, box: b });
    assert.deepStrictEqual([res.unreadableMid, res.clearPending, res.accepted, res.offer], ['SEEN', true, null, null]);
    assert.strictEqual(reads.length, 5);
  });
  await check('everything examined before: nothing is read', async () => {
    const { res, reads } = await run({ pending: true, seen: new Set(INBOX.map((m) => m.mid)) });
    assert.deepStrictEqual([reads.length, res.examined, res.left], [0, 0, 0]);
  });
  await check('dates out of order or in the future never hide the reply: a small future-dated mail first, the older-dated 70 kB reply still read', async () => {
    const list = [{ mid: 'FUTURE', date: '2031-01-01T00:00:00Z', from: 'X' }, { mid: 'NOTE', date: '2026-03-14T00:00:00Z', from: 'Y' }, { mid: 'REPLY', date: '2026-03-09T23:55:00Z', from: 'SERVICE' }];
    const b = { FUTURE: { body: 'hi' }, NOTE: { body: 'hello' }, REPLY: catMsg };
    const seen = new Set();
    const go = (l) => C.scanInbox({ list: l, seen, pending: true, requestAt: Date.parse('2026-03-10T00:00:00Z'), stored: null, now: T0, read: (mid) => Promise.resolve(b[mid]), store: () => true });
    const first = await go(list.slice(0, 2));
    assert.deepStrictEqual([first.accepted, first.examined], [null, 2]);
    const second = await go(list);
    assert.strictEqual(second.accepted.sourceMid, 'REPLY', 'the reply listed later, with an older date, is still examined');
    assert.strictEqual(second.examined, 1, 'and only it');
  });
  await check('pending, and the Inbox holds a catalog dated long before the request: offered, the wait goes on', async () => {
    const list = [{ mid: 'ANCIENT', date: '2025-07-01T00:00:00Z', from: 'SERVICE' }];
    const res = await C.scanInbox({ list, seen: new Set(), pending: true, requestAt: T0, stored: null, now: T0, read: () => Promise.resolve(catMsg), store: () => { throw new Error('must not be written'); } });
    assert.deepStrictEqual([res.accepted, res.offer.mid, res.clearPending], [null, 'ANCIENT', false]);
  });
  await check('capped: two reads in a pass of two', async () => {
    const { reads } = await run({ pending: false, cap: 2, box: { ...box, NEW2: { body: 'n' } } });
    assert.deepStrictEqual(reads, ['SEEN', 'NEW2']);
  });
  await check('a rule that throws rejects the pass (the caller catches it); it never hangs', async () => {
    let said = '';
    await C.scanInbox({ list: INBOX, seen: { has: () => false, add: () => { throw new Error('boom'); } }, read: () => Promise.resolve({ body: 'x' }), store: () => true }).catch((e) => { said = e.message; });
    assert.strictEqual(said, 'boom');
  });
}

(async () => {
  await scanTests();
  console.log('a real Pat, offline');
  const name = 'Pat queues the request To INQUIRY as built; reading the catalog message leaves it unread';
  let skipped = 0;
  try {
    const r = await realPat();
    if (r === 'skip') { skipped++; console.log('  skip ' + name + ' (no Pat binary: assets/pat or POTACAT_TEST_PAT)'); }
    else { pass++; console.log('  ok  ' + name); }
  } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  // exitCode, not exit(): exiting under a just-closed fetch socket trips a libuv assert on Windows.
  process.exitCode = fail ? 1 : 0;
})();
