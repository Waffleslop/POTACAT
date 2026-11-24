// The Winlink catalog glue in main.js, RUN (docs/winlink-catalog.md).
//
// main.js's catalog functions are lifted out as they are written and run here
// with stand-ins for Pat, the settings, the mailbox cache and the file write.
// The rules they call are the real lib/winlink-catalog.js. This is what a
// source-text guard cannot show: what the glue does when Pat's Outbox and the
// cache disagree, when a write fails, when mail arrives in the middle.
// Run: node test/winlink-catalog-glue-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const WinlinkCatalog = require('../lib/winlink-catalog');
const RS = require('../lib/winlink-remote-shack');

const ROOT = path.join(__dirname, '..');
const main = readSrc(path.join(ROOT, 'main.js'));
const A = '// ── Winlink catalog requests (docs/winlink-catalog.md) ──';
const B = "/**\n * The fields of a favourite request (the mail window's invoke, an ECHOCAT\n";
assert.ok(main.includes(A) && main.indexOf(B) > main.indexOf(A), 'the catalog block is where it is expected in main.js');
const BLOCK = main.slice(main.indexOf(A), main.indexOf(B));

// ── a catalog reply, written by hand ───────────────────────────────────────
function catalogBody(n) {
  const rows = ['Global_Modified: 2026/03/09 17:08', 'CATEGORY   INQUIRY_ID   SUBJECT   SIZE   ORIGINATED   G/L'];
  for (let i = 0; i < n; i++) rows.push('CAT' + (i % 5) + '   ITEM' + i + '   "Made-up item number ' + i + ' with enough words to fill the line and then some more of them so that forty rows are a real message"   ' + (1000 + i) + '   2026/03/01 03:44   [G]');
  return rows.join('\n');
}

/** A stand-in station: Pat's folders, the cached lists main keeps, the settings, and the lifted functions. */
function station(o = {}) {
  let seq = 0;
  const pat = { in: [], out: [], sent: [] };
  const cache = { in: [], out: [], sent: [] };
  const settings = { myCallsign: 'N0CALL', ...(o.settings || {}) };
  const logs = [];
  const flags = { writeThrows: false, writeRefused: false, pushes: 0, updated: 0, saves: 0 };
  const writeStatus = new Map();
  const files = {};
  const entry = (m) => ({ mid: m.mid, to: m.to, subject: m.subject, date: m.date, from: m.from });
  const env = {
    path, app: { getPath: () => 'USERDATA' },
    fs: { readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; } },
    WinlinkCatalog, settings,
    saveSettings: () => { flags.saves++; },
    winlinkState: { list: (box) => cache[box].slice() },
    winlinkLog: (l) => logs.push(l),
    winlinkPush: () => { flags.pushes++; },
    winlinkPopoutSend: () => { flags.updated++; },
    winlinkMailboxDir: () => 'MBOX/' + settings.myCallsign,
    _settingsWriteStatus: writeStatus,
    _writeJsonAtomic: (p, obj) => {
      if (flags.writeThrows) throw new Error('disk full');
      if (flags.writeRefused) return;
      files[p] = JSON.stringify(obj);
      writeStatus.set(p, { at: Date.now(), ok: true });
    },
    // The real winlinkSend posts to Pat and refreshes the Outbox list (winlinkSendOne).
    winlinkSend: async (m) => {
      if (o.sendFails) return { ok: false, error: 'Pat refused' };
      pat.out.unshift({ mid: 'Q' + (++seq), to: [m.to], subject: m.subject, body: m.body, date: new Date().toISOString(), from: 'N0CALL' });
      cache.out = pat.out.map(entry);
      fns.listed(['out']);
      return { ok: true };
    },
  };
  const client = {
    mailbox: async (box) => { if (flags.outboxFails && box === 'out') throw new Error('Pat did not answer'); return pat[box].map(entry); },
    message: async (box, mid) => {
      if (flags.onMessage) await flags.onMessage(box, mid);
      const m = pat[box].find((x) => x.mid === mid);
      if (!m) throw new Error('not found');
      return { ...entry(m), body: m.body };
    },
  };
  const make = new Function('env', `
    let { path, app, fs, WinlinkCatalog, settings, saveSettings, winlinkState, winlinkLog, winlinkPush, winlinkPopoutSend, winlinkMailboxDir, _settingsWriteStatus, _writeJsonAtomic, winlinkSend } = env;
    let patClient = env.patClient;
    ${BLOCK}
    return { get: winlinkCatalogGet, request: winlinkCatalogRequest, requestList: winlinkCatalogRequestList, star: winlinkCatalogStar, offer: winlinkCatalogOfferAnswer,
      scan: winlinkCatalogScan, listed: winlinkCatalogListed, settle: winlinkCatalogSettle, stamp: winlinkCatalogStamp, scanning: () => _winlinkCatalogScanning };
  `);
  env.patClient = client;
  const fns = make(env);
  /** A refresh, as winlinkRefreshMailboxes does it: list the folders, say which ones listed, let the catalog look. */
  const refresh = async (boxes = ['in', 'out', 'sent'], failing = []) => {
    const listed = [];
    for (const b of boxes) { if (failing.includes(b)) continue; cache[b] = pat[b].map(entry); listed.push(b); }
    fns.listed(listed);
    if (listed.includes('in')) await fns.scan('mail');
    for (let i = 0; i < 50 && fns.scanning(); i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { pat, cache, settings, logs, flags, files, fns, refresh, client };
}

const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const listMsg = (mid) => ({ mid, to: ['INQUIRY'], subject: 'REQUEST', body: 'LIST', date: new Date().toISOString(), from: 'N0CALL' });
const itemMsg = (mid) => ({ mid, to: ['INQUIRY'], subject: 'REQUEST', body: 'PROP_3DAY', date: new Date().toISOString(), from: 'N0CALL' });
const reply = (mid, date, n = 40, from = 'SERVICE') => ({ mid, to: ['N0CALL'], subject: 'whatever', body: catalogBody(n), date, from });
const soon = () => new Date(Date.now() + 60000).toISOString();

test('Get the full catalog: one LIST message, and the request is tied to THAT message, not to an older item request the cache never saw', async () => {
  const s = station();
  s.pat.out.push(itemMsg('ITEMREQ')); // in Pat's Outbox, not in the cached list
  const r = await s.fns.requestList(false);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.pat.out.filter((m) => m.body === 'LIST').length, 1);
  assert.strictEqual(s.settings.winlinkCatalogRequest.mid, s.pat.out.find((m) => m.body === 'LIST').mid);
  assert.strictEqual(s.fns.get().pendingKind, 'queued');
});
test('never a second LIST while one is in the Outbox, even when nothing says a request is pending, and even for Request again', async () => {
  const s = station();
  s.pat.out.push(listMsg('L0')); // queued by hand, or the settings were lost
  for (const again of [false, true]) {
    const r = await s.fns.requestList(again);
    assert.deepStrictEqual([r.ok, r.already], [true, true]);
  }
  assert.strictEqual(s.pat.out.length, 1);
  assert.strictEqual(s.settings.winlinkCatalogRequest, undefined);
});
test('Pat cannot list the Outbox: nothing is queued and the reason is said', async () => {
  const s = station();
  s.flags.outboxFails = true;
  const r = await s.fns.requestList(false);
  assert.deepStrictEqual([r.ok, r.error, s.pat.out.length], [false, 'Pat did not answer', 0]);
});
test('pending, and an OLD catalog is in the Inbox: it is offered, the request stays, and Update cannot queue a second LIST', async () => {
  const s = station();
  await s.fns.requestList(false);
  s.pat.in.push(reply('OLDCAT', '2025-07-01T00:00:00Z'));
  await s.refresh();
  assert.strictEqual(Object.keys(s.files).length, 0, 'not taken');
  assert.strictEqual(s.settings.winlinkCatalogOffer.mid, 'OLDCAT');
  assert.ok(s.settings.winlinkCatalogRequest, 'the request is still waited for');
  assert.strictEqual(s.fns.get().pendingKind, 'queued');
  assert.deepStrictEqual([(await s.fns.requestList(false)).already, s.pat.out.length], [true, 1]);
});
test('the reply the operator asked for is taken by itself once the request has gone out, and the wait ends', async () => {
  const s = station();
  await s.fns.requestList(false);
  s.pat.sent.push(s.pat.out.pop());
  s.pat.in.push(reply('REPLY', soon()));
  await s.refresh();
  assert.strictEqual(JSON.parse(Object.values(s.files)[0]).items.length, 40);
  assert.strictEqual(s.settings.winlinkCatalogRequest, undefined);
  const g = s.fns.get();
  assert.deepStrictEqual([g.count, g.pending, g.offer], [40, false, null]);
  assert.ok(s.logs.some((l) => l === 'catalog: read the Winlink catalog you asked for, from SERVICE (40 items)'));
  assert.ok(s.settings.winlinkCatalogExamined.includes('REPLY'));
  assert.strictEqual(s.settings.winlinkCatalogScannedTo, undefined);
});
test('a reply that arrives while its request is still in the Outbox never clears that request', async () => {
  const s = station();
  await s.fns.requestList(false);
  s.pat.in.push(reply('EARLY', soon()));
  await s.refresh();
  assert.ok(s.settings.winlinkCatalogRequest, 'LIST is still in the Outbox');
  assert.strictEqual((await s.fns.requestList(true)).already, true);
});
test('a stale or failed Sent list does not wipe the request; a fresh one settles it', async () => {
  const s = station();
  await s.fns.requestList(false);
  await s.refresh();
  s.pat.sent.push(s.pat.out.pop()); // the session sent it
  await s.refresh(['out']); // only the Outbox was listed: the cached Sent list is older
  assert.ok(s.settings.winlinkCatalogRequest, 'kept');
  assert.deepStrictEqual([s.fns.settle().kind, s.fns.get().pendingKind], ['unknown', 'queued']);
  await s.refresh(['in', 'out', 'sent'], ['sent']); // Sent failed to list
  assert.strictEqual(s.fns.settle().kind, 'unknown');
  await s.refresh();
  assert.deepStrictEqual([s.fns.settle().kind, s.fns.get().pendingKind], ['sent', 'sent']);
  const again = await s.fns.requestList(true);
  assert.deepStrictEqual([again.ok, again.already, s.pat.out.length], [true, undefined, 1], 'Request again, now that none is in the Outbox');
});
test('deleted from the Outbox before it went: after a full refresh the request is forgotten and Get works again', async () => {
  const s = station();
  await s.fns.requestList(false);
  s.pat.out.length = 0;
  await s.refresh();
  assert.strictEqual(s.fns.get().pending, false);
  assert.strictEqual(s.settings.winlinkCatalogRequest, undefined);
  assert.strictEqual((await s.fns.requestList(false)).already, undefined);
});
test('nothing pending: a catalog in the Inbox is looked at only after the panel is opened, and is offered', async () => {
  const s = station();
  s.pat.in.push(reply('C1', '2026-03-10T00:00:00Z'));
  let reads = 0;
  s.flags.onMessage = () => { reads++; };
  await s.refresh();
  assert.strictEqual(reads, 0, 'no reading of the Inbox on a plain refresh');
  s.fns.get();
  await s.refresh();
  assert.strictEqual(s.settings.winlinkCatalogOffer.mid, 'C1');
  const before = reads;
  await s.refresh();
  await s.refresh();
  assert.strictEqual(reads, before, 'nothing is read twice');
});
test('Use it, and the save fails (throws or is refused): said in words, the offer stays, nothing is in use', async () => {
  for (const flag of ['writeThrows', 'writeRefused']) {
    const s = station({ settings: { winlinkCatalogOffer: { mid: 'C1', from: 'SERVICE', date: '', count: 40, have: 0 } } });
    s.pat.in.push(reply('C1', '2026-03-10T00:00:00Z'));
    s.flags[flag] = true;
    const r = await s.fns.offer(true);
    assert.deepStrictEqual(r, { ok: false, error: 'Could not save the catalog. Try again.' }, flag);
    assert.strictEqual(s.settings.winlinkCatalogOffer.mid, 'C1');
    assert.strictEqual(s.fns.get().count, 0);
    s.flags[flag] = false;
    assert.deepStrictEqual(await s.fns.offer(true), { ok: true });
    assert.deepStrictEqual([s.fns.get().count, s.settings.winlinkCatalogOffer, s.settings.winlinkCatalogDeclined], [40, undefined, ['C1']]);
  }
});
test('a newer offer that arrives while Use it is waiting on Pat is not lost', async () => {
  const s = station({ settings: { winlinkCatalogOffer: { mid: 'C1', from: 'SERVICE', date: '', count: 40, have: 0 } } });
  s.pat.in.push(reply('C1', '2026-03-10T00:00:00Z'));
  s.flags.onMessage = () => { s.settings.winlinkCatalogOffer = { mid: 'C2', from: 'W1AW', date: '', count: 900, have: 40 }; };
  assert.deepStrictEqual(await s.fns.offer(true), { ok: true });
  assert.strictEqual(s.settings.winlinkCatalogOffer.mid, 'C2');
  assert.deepStrictEqual(s.settings.winlinkCatalogDeclined, ['C1']);
});
test('Use it on a message that is gone: said, and the offer is dropped', async () => {
  const s = station({ settings: { winlinkCatalogOffer: { mid: 'GONE', from: 'X', date: '', count: 40, have: 0 } } });
  s.pat.in.push({ mid: 'GONE', to: ['N0CALL'], subject: 'x', body: 'not a catalog any more', date: '', from: 'X' });
  assert.deepStrictEqual(await s.fns.offer(true), { ok: false, error: 'That message is no longer in your Inbox.' });
  assert.strictEqual(s.settings.winlinkCatalogOffer, undefined);
});
test('a catalog that could not be read is remembered with its message, and cleared when a good one is read', async () => {
  const s = station();
  s.fns.get();
  const junk = [];
  for (let i = 0; i < 80; i++) junk.push('some other line of text number ' + i + ' ' + 'pad '.repeat(15));
  s.pat.in.push({ mid: 'BAD', to: ['N0CALL'], subject: 'x', body: catalogBody(8) + '\n' + junk.join('\n'), date: '2026-03-10T00:00:00Z', from: 'SERVICE' });
  await s.refresh();
  assert.deepStrictEqual(s.settings.winlinkCatalogUnreadable, { mid: 'BAD' });
  assert.strictEqual(s.fns.get().unreadable, true);
  assert.ok(s.logs.some((l) => /could not be read \(8 rows read, 80 lines skipped\)$/.test(l)) && !s.logs.some((l) => /some other line/.test(l)));
  await s.fns.requestList(false);
  s.pat.sent.push(s.pat.out.pop());
  s.pat.in.push(reply('GOOD', soon()));
  await s.refresh();
  assert.strictEqual(s.settings.winlinkCatalogUnreadable, undefined);
  assert.strictEqual(s.fns.get().unreadable, false);
});
test('230 ticked on a desktop driving a shack: through the bridge mapping and the server\'s cut, the shack queues 200 and reports 30 over', async () => {
  const s = station();
  s.files[path.join('USERDATA', 'winlink-catalog.json')] = JSON.stringify({ readAt: 1, items: Array.from({ length: 300 }, (_, i) => ({ category: 'A', id: 'N' + i, subject: 's', size: 1 })) });
  const ids = Array.from({ length: 230 }, (_, i) => 'N' + i);
  const wire = RS.INVOKES['winlink-catalog-request']([ids]).send;
  const cut = Number((/req\.ids = req\.ids\.slice\(0, (\d+)\);/.exec(readSrc(path.join(ROOT, 'lib', 'remote-server.js'))) || [])[1]);
  assert.ok(cut >= 5000, 'the server passes the whole request on');
  const r = await s.fns.request(wire.ids.slice(0, cut));
  assert.deepStrictEqual([r.ok, r.queued.length, r.messages, r.over], [true, 200, 20, 30]);
  const back = RS.reply('winlink-catalog-request', { type: 'winlink-catalog-queued', reqId: 'x', ...r }, []);
  assert.deepStrictEqual([back.over, back.queued.length], [30, 200], 'and the window is told');
  assert.strictEqual((await s.fns.request(['N1', 'LIST'])).ok, false, 'a command word refuses the request');
});
test('a star: only on an item of the catalog in force; every surface is told', async () => {
  const s = station();
  assert.strictEqual(s.fns.star('MADE_UP', true).ok, false);
  assert.strictEqual(s.fns.star('PROP_WWV', true).ok, true);
  assert.deepStrictEqual([s.settings.winlinkCatalogPicks.starred, s.flags.pushes > 0, s.fns.stamp().picksAt > 0], [['PROP_WWV'], true, true]);
});
test('a profile switch in the middle of a pass: nothing of that pass is kept for the new operator', async () => {
  const s = station();
  s.fns.get();
  s.pat.in.push(reply('C1', '2026-03-10T00:00:00Z'));
  s.flags.onMessage = () => { s.settings.myCallsign = 'K1OTHER'; };
  await s.refresh();
  assert.deepStrictEqual([s.settings.winlinkCatalogOffer, s.settings.winlinkCatalogExamined], [undefined, undefined]);
});

(async () => {
  let pass = 0, fail = 0;
  console.log('the Winlink catalog glue, run');
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
