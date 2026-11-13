// How each sent Winlink message went out (#442).
//
// Pat moves a delivered message from out/ to sent/ and records nothing about
// the route. When a session ends, POTACAT gives each message that was in the
// Outbox at the start, is gone from it, and is now in Sent one record:
// gateway, dial and mode (or the internet) and the time. Kept by message id
// in sent-routes.json in the profile's Winlink folder, so Archive and Deleted
// (which keep the id) keep it. A message sent before this shows nothing.
// Run: node test/winlink-sent-routes-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const R = require('../lib/winlink-sent-routes');
const A = require('../lib/winlink-mail-actions');
const T = Date.UTC(2026, 10, 13, 14, 32, 10);

console.log('which messages a session sent');
test('in the Outbox before, gone after, in Sent now', () => {
  const ids = R.sentThisSession({
    outBefore: [{ mid: 'AAAAAAAAAAAA' }, { mid: 'BBBBBBBBBBBB' }, { mid: 'CCCCCCCCCCCC' }],
    outAfter: [{ mid: 'BBBBBBBBBBBB' }],
    sentAfter: [{ mid: 'AAAAAAAAAAAA' }, { mid: 'OLDOLDOLDOLD' }],
  });
  // B is still queued; C left the Outbox but is not in Sent (deleted during the session); OLD was sent before.
  assert.deepStrictEqual(ids, ['AAAAAAAAAAAA']);
});
test('bare ids work as well as Pat rows; duplicates once', () => {
  assert.deepStrictEqual(R.sentThisSession({ outBefore: ['X1', 'X1', 'X2'], outAfter: [], sentAfter: ['X1', 'X2'] }), ['X1', 'X2']);
});
test('without the Outbox from before, nothing is guessed', () => {
  assert.deepStrictEqual(R.sentThisSession({ outBefore: null, outAfter: [], sentAfter: [{ mid: 'A1' }] }), []);
  assert.deepStrictEqual(R.sentThisSession({ outBefore: ['A1'], outAfter: [], sentAfter: null }), []);
});
test('an id that could be a path is never taken', () => {
  assert.deepStrictEqual(R.sentThisSession({ outBefore: ['../x', 'A1'], outAfter: [], sentAfter: ['../x', 'A1'] }), ['A1']);
});

console.log('one record');
test('a radio session: gateway upper case, dial, mode, time', () => {
  assert.deepStrictEqual(R.makeRoute({ mode: 'ardop', gateway: 'w5abc-10', dialKhz: 7102.04 }, T),
    { mode: 'ardop', transport: 'radio', sentAt: '2026-11-13T14:32:10.000Z', gateway: 'W5ABC-10', dialKhz: 7102.04 });
});
test('the internet: no gateway, no dial', () => {
  assert.deepStrictEqual(R.makeRoute({ mode: 'telnet', gateway: 'CMS (internet)', dialKhz: 7102 }, T),
    { mode: 'telnet', transport: 'internet', sentAt: '2026-11-13T14:32:10.000Z' });
});
test('no mode or no time: no record', () => {
  assert.strictEqual(R.makeRoute({ mode: '' }, T), null);
  assert.strictEqual(R.makeRoute({ mode: 'ardop' }, 0), null);
  assert.strictEqual(R.makeRoute({ mode: 'pigeon' }, T), null);
});

console.log('the store');
test('record, get, and the oldest go first beyond MAX', () => {
  const route = R.makeRoute({ mode: 'packet', gateway: 'K3SBP-10', dialKhz: 145050 }, T);
  let map = R.record({}, ['M1', 'M2'], route);
  assert.strictEqual(R.get(map, 'M1').gateway, 'K3SBP-10');
  assert.strictEqual(R.get(map, 'M3'), null);
  assert.strictEqual(R.get(map, '__proto__'), null);
  const big = {};
  for (let i = 0; i < R.MAX + 5; i++) big['N' + i] = R.makeRoute({ mode: 'telnet' }, T + i * 1000);
  map = R.clean(big);
  assert.strictEqual(Object.keys(map).length, R.MAX);
  assert.ok(!map.N0 && map['N' + (R.MAX + 4)], 'the newest are kept');
});
test('the file: written whole, read back, junk dropped; a broken file is an empty store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-wl-routes-'));
  try {
    const file = R.fileIn(dir);
    assert.strictEqual(path.basename(file), 'sent-routes.json');
    assert.deepStrictEqual(R.load(file), {});
    const map = R.record({}, ['ABCDEF123456'], R.makeRoute({ mode: 'vara', gateway: 'W5ABC', dialKhz: 10145.5 }, T));
    assert.ok(R.save(file, { ...map, 'bad/id': { mode: 'ardop', sentAt: '2026-11-13T00:00:00Z' }, JUNK: { mode: 'ardop' } }));
    const back = R.load(file);
    assert.deepStrictEqual(Object.keys(back), ['ABCDEF123456']);
    assert.strictEqual(back.ABCDEF123456.dialKhz, 10145.5);
    assert.ok(!fs.existsSync(file + '.tmp'));
    fs.writeFileSync(file, '{not json');
    assert.deepStrictEqual(R.load(file), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log('the line the reader shows');
test('a radio session', () => {
  assert.strictEqual(A.sentRouteLine(R.makeRoute({ mode: 'ardop', gateway: 'W5ABC', dialKhz: 7102 }, T)),
    'Sent 13 Nov 2026 at 14:32 UTC via W5ABC on 7.102 MHz (ARDOP).');
  assert.strictEqual(A.sentRouteLine(R.makeRoute({ mode: 'packet', gateway: 'K3SBP-10', dialKhz: 145050 }, T)),
    'Sent 13 Nov 2026 at 14:32 UTC via K3SBP-10 on 145.050 MHz (Packet).');
  assert.strictEqual(A.sentRouteLine(R.makeRoute({ mode: 'vara', gateway: 'W5ABC', dialKhz: 10145.5 }, T)),
    'Sent 13 Nov 2026 at 14:32 UTC via W5ABC on 10.1455 MHz (VARA HF).');
  assert.strictEqual(A.sentRouteLine(R.makeRoute({ mode: 'mercury', gateway: 'W5ABC', dialKhz: 14000 }, T)),
    'Sent 13 Nov 2026 at 14:32 UTC via W5ABC on 14.000 MHz (Mercury).');
});
test('over the internet', () => {
  assert.strictEqual(A.sentRouteLine(R.makeRoute({ mode: 'telnet' }, T)), 'Sent 13 Nov 2026 at 14:32 UTC over the internet.');
});
test('no record: nothing at all', () => {
  assert.strictEqual(A.sentRouteLine(undefined), '');
  assert.strictEqual(A.sentRouteLine({ mode: 'ardop', sentAt: 'nope' }), '');
});
test('plain words: no emoji, no symbols beyond the sentence', () => {
  const l = A.sentRouteLine(R.makeRoute({ mode: 'varafm', gateway: 'W5ABC', dialKhz: 145090 }, T));
  assert.ok(/^[\x20-\x7e]+$/.test(l), l);
});

console.log('wiring');
const main = readSrc(path.join(root, 'main.js')).replace(/\r\n/g, '\n');
const popout = readSrc(path.join(root, 'renderer', 'winlink-popout.js'));
const remote = readSrc(path.join(root, 'renderer', 'remote.js'));
const remoteHtml = readSrc(path.join(root, 'renderer', 'remote.html'));
test('the Outbox ids are taken when a session starts, and checked when it ends', () => {
  assert.ok(/_winlinkOutMidsAtStart = winlinkState\.list\('out'\)/.test(main));
  const end = main.slice(main.indexOf('function winlinkEndSession('), main.indexOf('// ── one automatic retry after a dropped link'));
  assert.ok(/const outBefore = wasActive \? _winlinkOutMidsAtStart : null;/.test(end), 'taken at session end, before any await: the next session may start');
  assert.ok(/winlinkRecordSentRoutes\(s, outBefore, endedAt\)/.test(end));
  assert.ok(end.indexOf('winlinkRecordSentRoutes(') < end.indexOf('winlinkRefreshMailboxes()'), 'recorded before the folders are listed again');
  assert.ok(/WinlinkSentRoutes\.sentThisSession\(\{ outBefore, outAfter, sentAfter \}\)/.test(main));
});
test('the store lives in the profile Winlink folder', () => {
  assert.ok(/WinlinkSentRoutes\.fileIn\(winlinkDir\(\)\)/.test(main));
});
test('reading a message adds sentRoute, Deleted included (keyed by id)', () => {
  assert.ok(/message: winlinkWithSentRoute\(box, msg\)/.test(main));
  assert.ok(/message: winlinkWithSentRoute\(box, WinlinkDeleted\.readEntry\(rec\)\)/.test(main));
  assert.ok(/box === 'in' \|\| box === 'out'\) return msg/.test(main), 'never on Inbox or Outbox');
});
test('both readers draw the one line from lib/winlink-mail-actions.js', () => {
  assert.ok(/WMA\.sentRouteLine\(m\.sentRoute\)/.test(popout));
  assert.ok(/MailActions\.sentRouteLine\(m\.sentRoute\)/.test(remote));
  assert.ok(/id="mail-read-route"/.test(remoteHtml));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
