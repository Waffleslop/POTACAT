#!/usr/bin/env node
'use strict';
/**
 * Winlink folders (#462, #475): Archive and back, POTACAT's Deleted folder
 * (kept beside Pat's own, emptied after N days), and Reply all.
 *
 *   lib/winlink-mail-actions.js   which moves exist, the reader's buttons,
 *                                 Reply all's addresses, the purge setting
 *   lib/winlink-deleted.js        the folder's files and paths (no path
 *                                 leaves the mailbox), the copies, the purge
 *   lib/winlink-client.js move()  Pat's move, against a stand-in Pat
 *   main.js / remote-server.js    the wiring (source guards)
 *   a real Pat (when its binary is here, or POTACAT_TEST_PAT names one):
 *                                 Archive, back, Delete and Restore through
 *                                 Pat's own API, in a scratch folder with its
 *                                 own XDG folders; nothing of the PC's Pat
 *
 * Run: node test/winlink-folders-test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { readSrc } = require('./_src');
const A = require('../lib/winlink-mail-actions');
const D = require('../lib/winlink-deleted');
const { WinlinkClient } = require('../lib/winlink-client');
const { WinlinkState, FOLDERS } = require('../lib/winlink-state');
const protocol = require('../lib/echocat-protocol');

const ROOT = path.join(__dirname, '..');
const read = (f) => readSrc(path.join(ROOT, f)).replace(/\r\n/g, '\n');

let pass = 0, fail = 0, skip = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const DAY = 86400000;
const NOW = Date.parse('2026-11-13T12:00:00Z');

// ── lib/winlink-mail-actions.js ────────────────────────────────────────────
test('our own address: bare call, call@winlink.org, any case, any SSID; not an internet address', () => {
  for (const a of ['K3SBP', 'k3sbp', 'K3SBP@winlink.org', 'k3sbp@WINLINK.ORG', 'K3SBP-10', 'k3sbp-1@winlink.org', ' K3SBP ']) assert.ok(A.isOwnAddress(a, 'K3SBP'), a);
  for (const a of ['K3SBPX', 'KK3SBP', 'k3sbp@gmail.com', '', 'W1AW']) assert.ok(!A.isOwnAddress(a, 'K3SBP'), a);
  assert.ok(A.isOwnAddress('K3SBP', 'k3sbp-5'), 'our own call with an SSID is still us');
  assert.ok(!A.isOwnAddress('K3SBP', ''), 'no callsign: nothing is ours');
});

test('Reply all: To = the sender; Cc = To and Cc less us and the sender, each once, in order', () => {
  const m = { from: 'KY4RY', to: ['K3SBP', 'W1AW', 'ky4ry@winlink.org'], cc: ['k3sbp@winlink.org', 'N0CALL', 'w1aw', 'K3SBP-10', 'Ann@Example.com', 'ann@example.com'] };
  assert.deepStrictEqual(A.replyAll(m, 'K3SBP'), { to: ['KY4RY'], cc: ['W1AW', 'N0CALL', 'Ann@Example.com'] });
  assert.deepStrictEqual(A.replyAll({ from: 'KY4RY', to: ['K3SBP'] }, 'K3SBP'), { to: ['KY4RY'], cc: [] });
  // Our own message (in Archive): its own recipients.
  assert.deepStrictEqual(A.replyAll({ from: 'K3SBP', to: ['W1AW', 'K3SBP'], cc: ['N0CALL', 'w1aw'] }, 'K3SBP'), { to: ['W1AW'], cc: ['N0CALL'] });
  assert.deepStrictEqual(A.replyAll({}, 'K3SBP'), { to: [], cc: [] });
  assert.strictEqual(A.replySubject('Net'), 'Re: Net');
  assert.strictEqual(A.replySubject('RE: Net'), 'RE: Net');
});

test('the moves POTACAT makes, and no others', () => {
  const yes = [['in', 'archive'], ['sent', 'archive'], ['archive', 'in'], ['archive', 'sent'],
    ['in', 'deleted'], ['out', 'deleted'], ['sent', 'deleted'], ['archive', 'deleted'],
    ['deleted', 'in'], ['deleted', 'out'], ['deleted', 'sent'], ['deleted', 'archive']];
  for (const [f, t] of yes) assert.ok(A.canMove(f, t), f + ' -> ' + t);
  const no = [['out', 'archive'], ['in', 'sent'], ['sent', 'in'], ['in', 'out'], ['archive', 'out'], ['in', 'in'], ['deleted', 'deleted'], ['in', 'spam'], ['..', 'in'], ['in', '../x']];
  for (const [f, t] of no) assert.ok(!A.canMove(f, t), f + ' -> ' + t);
});

test('the reader\'s buttons per folder: Reply all never the default, Archive way back by who sent it', () => {
  const ids = (box, m) => A.readerActions(box, m, 'K3SBP').map((a) => a.id + (a.to ? '>' + a.to : '') + ':' + a.label);
  const many = { from: 'KY4RY', to: ['K3SBP', 'W1AW'] };
  assert.deepStrictEqual(ids('in', many), ['reply:Reply', 'reply-all:Reply all', 'forward:Forward', 'archive>archive:Archive', 'delete>deleted:Delete']);
  assert.deepStrictEqual(ids('in', { from: 'KY4RY', to: ['K3SBP'] }), ['reply:Reply', 'forward:Forward', 'archive>archive:Archive', 'delete>deleted:Delete']);
  assert.deepStrictEqual(ids('sent', { from: 'K3SBP', to: ['W1AW'] }), ['forward:Forward', 'archive>archive:Archive', 'delete>deleted:Delete']);
  assert.deepStrictEqual(ids('out', { from: 'K3SBP', to: ['W1AW'] }), ['forward:Forward', 'delete>deleted:Delete (do not send)']);
  assert.deepStrictEqual(ids('archive', many), ['reply:Reply', 'reply-all:Reply all', 'forward:Forward', 'move-back>in:Move to Inbox', 'delete>deleted:Delete']);
  assert.deepStrictEqual(ids('archive', { from: 'k3sbp@winlink.org', to: ['W1AW'] }), ['forward:Forward', 'move-back>sent:Move to Sent', 'delete>deleted:Delete']);
  assert.deepStrictEqual(ids('deleted', { from: 'KY4RY', fromBox: 'out' }), ['restore>out:Restore to Outbox', 'delete-for-good:Delete for good']);
  assert.deepStrictEqual(ids('deleted', { from: 'KY4RY', fromBox: 'bogus' }), ['restore>in:Restore to Inbox', 'delete-for-good:Delete for good']);
  assert.ok(A.readerActions('in', many, 'K3SBP').filter((a) => a.danger).every((a) => a.id === 'delete'));
});

test('the purge setting: 7, 30, 90 or never; anything else is 30', () => {
  assert.deepStrictEqual(A.DELETED_DAYS_CHOICES, [7, 30, 90, 0]);
  assert.strictEqual(A.DEFAULT_DELETED_DAYS, 30);
  for (const [v, want] of [[7, 7], ['90', 90], [0, 0], ['0', 0], ['never', 0], [undefined, 30], [null, 30], [14, 30], ['x', 30], [-1, 30]]) assert.strictEqual(A.deletedDays(v), want, String(v));
  assert.deepStrictEqual(A.DELETED_DAYS_CHOICES.map(A.daysChoiceLabel), ['7 days', '30 days', '90 days', 'Never']);
  assert.strictEqual(A.deletedFolderNote(30), 'Deleted messages are removed for good after 30 days.');
  assert.strictEqual(A.deletedFolderNote(0), 'Deleted messages stay here until you delete them for good.');
  const at = new Date(NOW - 3 * DAY).toISOString();
  assert.strictEqual(A.deletedNote({ fromBox: 'in', deletedAt: at }, 30, NOW), 'Deleted from Inbox. Removed for good in 27 days.');
  assert.strictEqual(A.deletedNote({ fromBox: 'sent', deletedAt: new Date(NOW - 29.5 * DAY).toISOString() }, 30, NOW), 'Deleted from Sent. Removed for good in 1 day.');
  assert.strictEqual(A.deletedNote({ fromBox: 'out', deletedAt: new Date(NOW - 31 * DAY).toISOString() }, 30, NOW), 'Deleted from Outbox. Removed for good today.');
  assert.strictEqual(A.deletedNote({ fromBox: 'archive', deletedAt: at }, 0, NOW), 'Deleted from Archive.');
});

test('the words carry no emoji and the module is dual-mode (window.WinlinkMailActions)', () => {
  const src = read('lib/winlink-mail-actions.js');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(src));
  assert.ok(/root\.WinlinkMailActions = factory\(\)/.test(src));
  assert.ok(!/require\(['"]/.test(src), 'no require: it runs in the pages too');
});

// ── lib/winlink-deleted.js ─────────────────────────────────────────────────
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-wl-folders-')); }

test('paths: the mailbox is <mbox>/<MYCALL> (as Pat makes it); no id or callsign leaves it', () => {
  const root = path.resolve(os.tmpdir(), 'mbox');
  assert.strictEqual(D.mailboxDir(root, 'k3sbp'), path.join(root, 'K3SBP'));
  assert.strictEqual(D.mailboxDir(root, 'G8LIY/P'), path.join(root, 'G8LIY', 'P'), 'the same join Pat does');
  for (const bad of ['', '  ', '..', '../X', 'A/../..', './X']) assert.strictEqual(D.mailboxDir(root, bad), null, JSON.stringify(bad));
  assert.strictEqual(D.mailboxDir('', 'K3SBP'), null);
  const mb = path.join(root, 'K3SBP');
  const p = D.paths(mb, 'ABC123DEF456');
  assert.deepStrictEqual(p, { dir: path.join(mb, 'deleted'), b2f: path.join(mb, 'deleted', 'ABC123DEF456.b2f'), json: path.join(mb, 'deleted', 'ABC123DEF456.json') });
  for (const bad of ['', '..', '../in/X', 'a/b', 'a\\b', 'X.b2f', 'X Y', 'x'.repeat(41), null, 5]) assert.strictEqual(D.paths(mb, bad), null, String(bad));
  assert.strictEqual(D.paths(null, 'ABC'), null);
});

test('a copy: made, read back, listed without its body, read with it; a damaged one is skipped', async () => {
  const mb = tmp();
  const msg = { mid: 'MID000000001', box: 'in', from: 'KY4RY', to: ['K3SBP'], cc: [], subject: 'Net', date: '2026-11-01T10:00:00Z', read: true, attachments: [{ name: 'a.txt', size: 3 }], body: 'Hello' };
  const rec = D.makeRecord(msg, 'in', NOW - 2 * DAY);
  assert.deepStrictEqual(Object.keys(rec), ['v', 'mid', 'fromBox', 'deletedAt', 'message']);
  assert.strictEqual(D.makeRecord(msg, 'nope', NOW).fromBox, 'in');
  const p = await D.save(mb, rec);
  assert.ok(fs.existsSync(p.json));
  await D.save(mb, D.makeRecord({ ...msg, mid: 'MID000000002', subject: 'Newer' }, 'sent', NOW - DAY));
  fs.writeFileSync(path.join(p.dir, 'MID000000003.json'), '{not json');
  fs.writeFileSync(path.join(p.dir, 'OTHER.json'), JSON.stringify({ ...rec, mid: 'MID000000001' }), 'utf8'); // name and id disagree
  const all = await D.readAll(mb);
  assert.deepStrictEqual(all.map((r) => r.mid), ['MID000000002', 'MID000000001'], 'newest deleted first; damaged copies skipped');
  const row = D.listEntry(all[1]);
  assert.strictEqual(row.body, undefined, 'the list carries no body');
  assert.strictEqual(row.box, 'deleted');
  assert.strictEqual(row.fromBox, 'in');
  assert.strictEqual(row.deletedAt, new Date(NOW - 2 * DAY).toISOString());
  assert.strictEqual(D.readEntry(await D.readOne(mb, 'MID000000001')).body, 'Hello');
  assert.strictEqual(await D.readOne(mb, '../x'), null);
  assert.deepStrictEqual(await D.readAll(path.join(mb, 'nothing-here')), [], 'no folder yet: an empty one');
});

test('purge: only what was deleted more than N days ago; never with 0; the message file goes too', async () => {
  const mb = tmp();
  const mk = async (mid, ageDays) => {
    const p = await D.save(mb, D.makeRecord({ mid, subject: mid, body: '' }, 'in', NOW - ageDays * DAY));
    fs.writeFileSync(p.b2f, 'b2f');
    return p;
  };
  const old = await mk('OLD000000001', 31);
  const edge = await mk('EDGE00000001', 30);
  const young = await mk('NEW000000001', 29.9);
  const recs = await D.readAll(mb);
  assert.deepStrictEqual(D.purgeSelect(recs, 30, NOW).sort(), ['EDGE00000001', 'OLD000000001']);
  assert.deepStrictEqual(D.purgeSelect(recs, 0, NOW), []);
  assert.deepStrictEqual(D.purgeSelect(recs, 90, NOW), []);
  assert.deepStrictEqual(D.purgeSelect(recs, 7, NOW).length, 3);
  assert.deepStrictEqual(await D.purge(mb, 0, NOW), []);
  assert.deepStrictEqual((await D.purge(mb, 30, NOW)).sort(), ['EDGE00000001', 'OLD000000001']);
  for (const p of [old, edge]) { assert.ok(!fs.existsSync(p.b2f)); assert.ok(!fs.existsSync(p.json)); }
  assert.ok(fs.existsSync(young.b2f) && fs.existsSync(young.json));
});

test('for good, forget, and back to the Outbox by rename (Pat cannot move into out)', async () => {
  const mb = tmp();
  const p = await D.save(mb, D.makeRecord({ mid: 'OUT000000001', body: '' }, 'out', NOW));
  fs.writeFileSync(p.b2f, 'queued');
  await D.restoreToOutbox(mb, 'OUT000000001');
  assert.strictEqual(fs.readFileSync(path.join(mb, 'out', 'OUT000000001.b2f'), 'utf8'), 'queued');
  assert.ok(await D.forget(mb, 'OUT000000001'));
  assert.ok(!fs.existsSync(p.json));
  const q = await D.save(mb, D.makeRecord({ mid: 'GONE00000001', body: '' }, 'in', NOW));
  fs.writeFileSync(q.b2f, 'x');
  assert.ok(await D.removeForGood(mb, 'GONE00000001'));
  assert.ok(!fs.existsSync(q.b2f) && !fs.existsSync(q.json));
  assert.strictEqual(await D.removeForGood(mb, 'GONE00000001'), false, 'already gone is not an error');
  await assert.rejects(D.removeForGood(mb, '../out/X'));
  await assert.rejects(D.restoreToOutbox(mb, 'NOPE00000001'), /ENOENT/);
});

// ── lib/winlink-state.js ───────────────────────────────────────────────────
test('the state holds a fifth folder, Deleted, and counts it', () => {
  assert.deepStrictEqual(FOLDERS, ['in', 'out', 'sent', 'archive', 'deleted']);
  const s = new WinlinkState();
  assert.ok(s.applyMailbox('deleted', [{ mid: 'D1' }, { mid: 'D2' }]));
  assert.strictEqual(s.counts().deleted, 2);
  assert.ok(s.remove('deleted', 'D1'));
  assert.strictEqual(s.snapshot().counts.deleted, 1);
  assert.strictEqual(s.totalUnread, 0, 'Deleted never counts as unread');
});

// ── lib/winlink-client.js move() against a stand-in Pat ────────────────────
test('move: POST /api/mailbox/<to> with X-Pat-SourcePath /api/mailbox/<from>/<mid>; never into out', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, src: req.headers['x-pat-sourcepath'], body });
      if (req.headers['x-pat-sourcepath'] === '/api/mailbox/in/MISSING') { res.statusCode = 400; res.end('rename: no such file'); return; }
      res.setHeader('Content-Type', 'application/json'); res.end('"OK"');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = new WinlinkClient({ port: srv.address().port });
    assert.strictEqual(await c.move('in', 'ABC123DEF456', 'archive'), 'OK');
    await c.move('sent', 'ABC123DEF456', 'deleted');
    assert.deepStrictEqual(seen.map((x) => [x.method, x.url, x.src, x.body]), [
      ['POST', '/api/mailbox/archive', '/api/mailbox/in/ABC123DEF456', ''],
      ['POST', '/api/mailbox/deleted', '/api/mailbox/sent/ABC123DEF456', ''],
    ]);
    await assert.rejects(c.move('in', 'MISSING', 'archive'), /move: HTTP 400/);
    await assert.rejects(c.move('deleted', 'ABC123DEF456', 'out'), /cannot move a message into the Outbox/);
    assert.strictEqual(seen.length, 3, 'the Outbox move never reached Pat');
    c.close();
  } finally { srv.close(); }
});

// ── wiring ─────────────────────────────────────────────────────────────────
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0;
  const j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}

test('main: Delete keeps a copy first, then Pat moves the file; a failed move takes the copy back', () => {
  const main = read('main.js');
  const del = fnBody(main, 'winlinkDelete');
  const iRead = del.indexOf('patClient.message(box, mid)');
  const iSave = del.indexOf('WinlinkDeleted.save(');
  const iMove = del.indexOf('patClient.move(box, mid, WinlinkDeleted.DELETED)');
  assert.ok(iRead > 0 && iSave > iRead && iMove > iSave, 'read, save the copy, then move');
  assert.ok(/catch \(e\) \{\s*await WinlinkDeleted\.forget\(dir, mid\)/.test(del), 'the copy is taken back when the move fails');
  assert.ok(/box === WinlinkDeleted\.DELETED\) return winlinkDeleteForGood\(mid\)/.test(del), 'Delete in Deleted is for good');
  assert.ok(!/patClient\.delete\(/.test(del), 'Delete never removes through Pat any more');
  const restore = fnBody(main, 'winlinkRestore');
  assert.ok(/target === 'out'\) await WinlinkDeleted\.restoreToOutbox\(dir, mid\)/.test(restore));
  assert.ok(/patClient\.move\(WinlinkDeleted\.DELETED, mid, target\)/.test(restore));
  const mv = fnBody(main, 'winlinkMove');
  assert.ok(/WinlinkMailActions\.canMove\(box, to\)/.test(mv), 'only the allowed moves');
  const read2 = fnBody(main, 'winlinkRead');
  assert.ok(/WinlinkDeleted\.readOne\(winlinkMailboxDir\(\), mid\)/.test(read2), 'Deleted is read from the copy, without Pat');
  assert.ok(/winlinkArmDeletedPurge\(\);/.test(fnBody(main, 'connectWinlink')), 'the purge runs at Winlink start');
  assert.ok(/setInterval\(\(\) => winlinkPurgeDeleted\('daily'\), 24 \* 3600 \* 1000\)/.test(fnBody(main, 'winlinkArmDeletedPurge')), 'and once a day');
  assert.ok(/deletedDays: WinlinkMailActions\.deletedDays\(settings\.winlinkDeletedDays\)/.test(main), 'winlink-state carries the setting');
  assert.ok(/case 'winlink-move':\s*\n\s*result\('move', await winlinkMove\(/.test(fnBody(main, 'winlinkHandleRemote')));
  assert.ok(/ipcMain\.handle\('winlink-cmd-move'/.test(main));
  assert.ok(/key === 'winlinkDeletedDays'/.test(main), 'the window sets the purge days');
});

test('server: winlink-move is an owner request; mail-folders-v2 advertised; Deleted only to devices that know it', () => {
  const server = read('lib/remote-server.js');
  assert.ok(/case 'winlink-delete':\n\s*case 'winlink-move':/.test(server), 'winlink-move rides the owner-only winlink-request path');
  assert.ok(/'mail-folders-v2',/.test(server));
  assert.ok(/m\.box === 'deleted'\) \{ for \(const c of this\._openClients\(\)\) if \(this\._knowsDeletedFolder\(c\)\)/.test(server));
  assert.ok(/m\.box !== 'deleted' \|\| this\._knowsDeletedFolder\(ws\)/.test(server), 'hydration too');
  assert.ok(/c\._clientCapabilities\.includes\('mail-folders-v2'\)/.test(server));
  const spec = protocol.MESSAGES['winlink-move'];
  assert.ok(spec && spec.dir === protocol.Dir.C2S && spec.feature === 'winlink');
  assert.deepStrictEqual(Object.keys(spec.fields), ['box', 'mid', 'to', 'reqId']);
  assert.ok(protocol.MESSAGES['winlink-state'].fields.deletedDays);
  const web = read('renderer/remote.js');
  assert.ok(/capabilities: \[[^\]]*'mail-folders-v2'/.test(web), 'ECHOCAT Web says it knows the Deleted folder');
  const doc = read('docs/echocat-protocol.md');
  assert.ok(/`winlink-move`/.test(doc) && /`mail-folders-v2`/.test(doc), 'documented');
});

test('the Winlink window: a Deleted folder, the reader from readerActions, Delete for good asks on the button', () => {
  const html = read('renderer/winlink-popout.html');
  const js = read('renderer/winlink-popout.js');
  assert.ok(/data-box="deleted">Deleted <span class="wl-count" id="wl-c-deleted">/.test(html));
  assert.ok(/<script src="\.\.\/lib\/winlink-mail-actions\.js"><\/script>/.test(html));
  assert.ok(/WMA\.readerActions\(openBox, m, mycall\)/.test(js));
  assert.ok(/delBtn\.textContent = WMA\.DELETE_FOR_GOOD_CONFIRM/.test(js), 'one line on the button, not a dialog');
  assert.ok(!/\b(alert|confirm)\(/.test(js), 'no modal box');
  assert.ok(/window\.api\.setPref\('winlinkDeletedDays', n\)/.test(js));
  assert.ok(/move: \(box, mid, to\) => ipcRenderer\.invoke\('winlink-cmd-move'/.test(read('preload-winlink-popout.js')));
});

// ── a real Pat (skipped when there is none) ────────────────────────────────
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
test('a real Pat: Archive and back, Delete into deleted/ and Restore, all through Pat\'s own API', async () => {
  const WinlinkPat = require('../lib/winlink-pat');
  const bin = process.env.POTACAT_TEST_PAT || path.join(ROOT, 'assets', 'pat', WinlinkPat.patBinaryName());
  if (!fs.existsSync(bin)) { skip++; return 'skip'; }
  const { patTestEnv } = require('./modem-loopback/pat-env');
  const dir = tmp();
  const port = await freePort();
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
    const fields = WinlinkPat.composeFields({ to: 'W1AW', cc: 'KY4RY', subject: 'Folder test', body: 'Hello' });
    assert.ok(fields.ok, fields.error);
    await c.send(fields.fields);
    const [queued] = await c.mailbox('out');
    assert.ok(queued && queued.mid, 'one message queued');
    const mid = queued.mid;
    const mb = D.mailboxDir(mbox, 'N0CALL');
    assert.ok(fs.existsSync(path.join(mb, 'out', mid + '.b2f')), 'Pat keeps it at <mbox>/<MYCALL>/out/<mid>.b2f');
    // Into the Inbox with Pat's own move (a stand-in for a received message), then Archive and back.
    await c.move('out', mid, 'in');
    await c.move('in', mid, 'archive');
    assert.deepStrictEqual((await c.mailbox('archive')).map((m) => m.mid), [mid]);
    assert.deepStrictEqual(await c.mailbox('in'), []);
    await c.move('archive', mid, 'in');
    assert.deepStrictEqual((await c.mailbox('in')).map((m) => m.mid), [mid]);
    // Delete: the copy first (the folder made), then Pat's move.
    const full = await c.message('in', mid);
    assert.strictEqual(full.body.replace(/\r\n/g, '\n').trim(), 'Hello');
    await D.save(mb, D.makeRecord(full, 'in', Date.now()));
    await c.move('in', mid, 'deleted');
    assert.deepStrictEqual(await c.mailbox('in'), []);
    assert.ok(fs.existsSync(path.join(mb, 'deleted', mid + '.b2f')));
    const [row] = (await D.readAll(mb)).map(D.listEntry);
    assert.strictEqual(row.subject, 'Folder test');
    assert.deepStrictEqual(row.cc, ['KY4RY']);
    // Restore.
    await c.move('deleted', mid, 'in');
    await D.forget(mb, mid);
    assert.deepStrictEqual((await c.mailbox('in')).map((m) => m.mid), [mid]);
    assert.deepStrictEqual(await D.readAll(mb), []);
    // Pat refuses a source outside the mailbox.
    await assert.rejects(c.move('../..', 'x', 'in'), /HTTP 400/);
  } finally {
    c.close();
    try { proc.kill(); } catch {}
  }
});

(async () => {
  for (const t of queue) {
    try {
      const r = await t.fn();
      if (r === 'skip') console.log('  skip ' + t.name + ' (no Pat binary; set POTACAT_TEST_PAT)');
      else { pass++; console.log('  ok  ' + t.name); }
    } catch (e) { fail++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  // exitCode, not exit(): fetch's sockets close on their own (exit() mid-close aborts libuv on Windows).
  process.exitCode = fail ? 1 : 0;
})();
