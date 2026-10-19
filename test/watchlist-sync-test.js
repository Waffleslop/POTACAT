'use strict';
// Watchlist sync between the desktop and ECHOCAT devices (2026-10-19): the
// blob carries settings.watchlist raw; a device edits it by add/remove
// operations so two edits at once never overwrite each other; owner only.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { applyWatchlistEdit, validEntry } = require('../lib/watchlist-edit');
const P = require('../lib/echocat-protocol');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

test('add appends new entries, skips ones already there (any case)', () => {
  const r = applyWatchlistEdit('K1ABC, W1AW:20m:CW', { add: ['k1abc', 'N0CALL', 'w1aw:20M:cw', 'US-NJ'] });
  assert.strictEqual(r.next, 'K1ABC, W1AW:20m:CW, N0CALL, US-NJ');
  assert.deepStrictEqual(r.added, ['N0CALL', 'US-NJ']);
});
test('remove matches the WHOLE entry, case-insensitively', () => {
  const r = applyWatchlistEdit('K1ABC, K1ABC:20m, W1AW', { remove: ['k1abc'] });
  assert.strictEqual(r.next, 'K1ABC:20m, W1AW', 'K1ABC:20m is a different entry');
  assert.deepStrictEqual(r.removed, ['K1ABC']);
});
test('two devices editing at once both land (operations, not a replace)', () => {
  const phone = { add: ['N0PHONE'] };
  const desk = { add: ['K0DESK'], remove: ['W1AW'] };
  const a = applyWatchlistEdit('W1AW', desk);
  const b = applyWatchlistEdit(a.next, phone);
  assert.strictEqual(b.next, 'K0DESK, N0PHONE');
});
test('a no-op edit changes nothing; garbage is rejected and named', () => {
  const r = applyWatchlistEdit('K1ABC', { add: ['K1ABC'], remove: ['NOT,THERE', '<b>'] });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.next, 'K1ABC');
  assert.deepStrictEqual(r.rejected, ['NOT,THERE', '<b>']);
  assert.ok(validEntry('W1AW/*') && validEntry('VE3:40m') && validEntry('ON'));
});
test('wired: blob, demux (guest refused), handler, window, desktop Settings echo, capability, protocol', () => {
  const main = R('main.js');
  const rs = R('lib/remote-server.js');
  assert.ok(/    watchlist: settings\.watchlist \|\| '',/.test(main), 'the blob carries the raw list');
  assert.ok(/const \{ sstvTemplates, sstvTextElements, watchlist, \.\.\.rest \} = s;/.test(rs), 'a Guest Pass gets no watchlist');
  const demux = rs.slice(rs.indexOf("case 'watchlist-edit':"), rs.indexOf("case 'set-cluster-node':"));
  assert.ok(/if \(ws\._passSession\)/.test(demux) && /'Guest Pass cannot change the watchlist\.'/.test(demux));
  const h = main.slice(main.indexOf("remoteServer.on('watchlist-edit'"), main.indexOf("remoteServer.on('set-cluster-node'"));
  assert.ok(/WatchlistEdit\.applyWatchlistEdit\(settings\.watchlist, \{ add, remove \}\)/.test(h));
  assert.ok(/win\.webContents\.send\('watchlist-updated', settings\.watchlist\)/.test(h), 'the desktop window follows');
  assert.ok(/type: 'watchlist-result', ok: r\.rejected\.length === 0, reqId,/.test(h));
  assert.ok(/updateRemoteSettings\(\);/.test(h), 'every client gets the list as it is now');
  assert.ok(/has\('watchlist'\) \|\|/.test(main), 'a desktop Settings edit reaches open devices');
  assert.ok(/'watchlist-sync',/.test(rs));
  assert.ok(P.MESSAGES['watchlist-edit'] && P.MESSAGES['watchlist-result']);
  assert.ok(/window\.api\.onWatchlistUpdated\(/.test(R('renderer/app.js')));
});
test('log-qso replies carry reqId and the records written, with their uuids', () => {
  const main = R('main.js');
  const h = main.slice(main.indexOf("remoteServer.on('log-qso'"), main.indexOf('// --- JTCAT remote control'));
  assert.strictEqual((h.match(/sendLogResult\(\{[^}]*reqId/g) || []).length >= 2, true, 'refusals carry reqId');
  assert.ok(/records: result\.records\.map\(\(r\) => \(\{\n\s*uuid: r\.uuid \|\| ''/.test(h), 'success lists each record\'s uuid');
});

console.log(`\nWatchlist sync: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
