#!/usr/bin/env node
'use strict';
// SSTV templates follow the account across machines (GET/PUT /v1/sstv/templates,
// potacat-cloudlog CLOUD_TO_DESKTOP_HANDOFF_2026-09-29_SSTV_TEMPLATES.md):
// identity stamping, the merge rule every client shares, size checks, the
// compare-and-swap client against a fake server, and the Share-my-Rig guard.
// Run: node test/sstv-template-sync-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/sstv-template-sync');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
let idN = 0;
const newId = () => 'id-' + (++idN);
const tpl = (o) => Object.assign({ texts: [{ key: 'call', label: 'K3SBP' }], name: 'T' }, o);

console.log('SSTV template sync');

// ---- stamping ----------------------------------------------------------------
test('a new template gets an id and updatedAt; an unchanged one keeps its stamp', () => {
  const a = S.stampTemplates([], [tpl({ name: 'A' })], { now: 1000, newId });
  assert.ok(a.templates[0].id && a.templates[0].updatedAt === 1000 && a.changed);
  const b = S.stampTemplates(a.templates, a.templates.map((t) => Object.assign({}, t)), { now: 2000, newId });
  assert.strictEqual(b.templates[0].updatedAt, 1000, 'nothing changed, stamp kept');
  assert.ok(!b.changed);
});

test('an edit bumps updatedAt; a removal leaves a tombstone', () => {
  const a = S.stampTemplates([], [tpl({ name: 'A' }), tpl({ name: 'B' })], { now: 1000, newId }).templates;
  const edited = [Object.assign({}, a[0], { name: 'A2' })];
  const r = S.stampTemplates(a, edited, { now: 3000, newId });
  assert.strictEqual(r.templates[0].updatedAt, 3000);
  assert.deepStrictEqual(r.deleted, [{ id: a[1].id, at: 3000 }]);
});

test('two templates with one id: the second gets its own', () => {
  const r = S.stampTemplates([], [tpl({ id: 'x', updatedAt: 5 }), tpl({ id: 'x', updatedAt: 5 })], { now: 10, newId });
  assert.notStrictEqual(r.templates[0].id, r.templates[1].id);
});

test('a stale copy of a deleted template stays deleted (the web client saves its whole list)', () => {
  const r = S.stampTemplates([], [tpl({ id: 'gone', updatedAt: 100 }), tpl({ id: 'kept', updatedAt: 100 })], { now: 500, newId, deleted: [{ id: 'gone', at: 200 }] });
  assert.deepStrictEqual(r.templates.map((t) => t.id), ['kept']);
  // …but one edited AFTER the delete (restored by an import) comes back.
  const r2 = S.stampTemplates([], [tpl({ id: 'gone', updatedAt: 300 })], { now: 500, newId, deleted: [{ id: 'gone', at: 200 }] });
  assert.deepStrictEqual(r2.templates.map((t) => t.id), ['gone']);
  assert.ok(!r2.deleted.some((d) => d.id === 'gone'));
});

test('tombstones older than 90 days are pruned, and at most 500 kept', () => {
  const now = 200 * 86400000;
  const kept = S.pruneTombstones([{ id: 'old', at: now - 91 * 86400000 }, { id: 'new', at: now - 1 }], now);
  assert.deepStrictEqual(kept.map((d) => d.id), ['new']);
  const many = Array.from({ length: 600 }, (_, i) => ({ id: 'd' + i, at: now - i }));
  assert.strictEqual(S.pruneTombstones(many, now).length, 500);
});

// ---- merging -----------------------------------------------------------------
test('merge: union by id, newer wins, ours on a tie, our order first', () => {
  const ours = { templates: [tpl({ id: 'a', updatedAt: 5, name: 'a-ours' }), tpl({ id: 'b', updatedAt: 9, name: 'b-ours' })], deleted: [] };
  const theirs = { templates: [tpl({ id: 'c', updatedAt: 1 }), tpl({ id: 'b', updatedAt: 9, name: 'b-theirs' }), tpl({ id: 'a', updatedAt: 7, name: 'a-theirs' })], deleted: [] };
  const m = S.mergeSets(ours, theirs, 100);
  assert.deepStrictEqual(m.templates.map((t) => t.id), ['a', 'b', 'c']);
  assert.strictEqual(m.templates[0].name, 'a-theirs', 'newer updatedAt wins');
  assert.strictEqual(m.templates[1].name, 'b-ours', 'a tie keeps ours');
});

test('merge: a tombstone at or after updatedAt drops the template on both sides', () => {
  const m = S.mergeSets({ templates: [tpl({ id: 'a', updatedAt: 5 })], deleted: [] }, { templates: [], deleted: [{ id: 'a', at: 5 }] }, 100);
  assert.deepStrictEqual(m.templates, []);
  assert.deepStrictEqual(m.deleted, [{ id: 'a', at: 5 }]);
  const kept = S.mergeSets({ templates: [tpl({ id: 'a', updatedAt: 6 })], deleted: [] }, { templates: [], deleted: [{ id: 'a', at: 5 }] }, 100);
  assert.strictEqual(kept.templates.length, 1, 'edited after the delete: kept');
});

test('merge: scalars ours, claimed packs the union, defaultReply cleared only if its template went', () => {
  const m = S.mergeSets(
    { templates: [tpl({ id: 'r', updatedAt: 1 })], deleted: [], lookShuffle: 3, claimedPacks: ['halloween'], activePack: null, defaultReply: 'r' },
    { templates: [], deleted: [{ id: 'r', at: 2 }], lookShuffle: 9, claimedPacks: ['winter'], activePack: 'winter', defaultReply: 'reply', someFutureKey: 1 }, 100);
  assert.strictEqual(m.lookShuffle, 3);
  assert.strictEqual(m.activePack, null);
  assert.deepStrictEqual(m.claimedPacks, ['halloween', 'winter']);
  assert.strictEqual(m.defaultReply, null);
  assert.strictEqual(m.someFutureKey, 1, 'unknown keys survive');
  const s = S.mergeSets({ templates: [], deleted: [], defaultReply: 'reply-big' }, { templates: [], deleted: [] }, 100);
  assert.strictEqual(s.defaultReply, 'reply-big', 'a starter id is not a template');
});

// ---- limits ------------------------------------------------------------------
test('checkSet refuses what the server would, in words', () => {
  const ok = { templates: [tpl({ id: 'a', updatedAt: 1, bgDataUrl: 'data:image/jpeg;base64,AAAA' })], deleted: [] };
  assert.ok(S.checkSet(ok).ok);
  const big = { templates: [tpl({ id: 'a', updatedAt: 1, name: 'Beach', bgDataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(160 * 1024) })] };
  assert.ok(/Beach has a photo too large/.test(S.checkSet(big).error));
  const svg = { templates: [tpl({ id: 'a', updatedAt: 1, bgDataUrl: 'data:image/svg+xml;base64,AAAA' })] };
  assert.ok(!S.checkSet(svg).ok);
  const many = { templates: Array.from({ length: 25 }, (_, i) => tpl({ id: 'i' + i, updatedAt: 1 })) };
  assert.ok(/24 can sync/.test(S.checkSet(many).error));
  const noId = { templates: [tpl({ updatedAt: 1 })] };
  assert.ok(!S.checkSet(noId).ok);
});

// ---- the client, against a fake compare-and-swap server -------------------
function fakeServer(o = {}) {
  const srv = { version: 0, data: null, puts: 0, gets: 0 };
  srv.request = async (method, p, body) => {
    if (o.notDeployed) { throw new Error('HTTP 404: <!DOCTYPE html>Cannot GET /v1/sstv/templates'); }
    if (p !== '/v1/sstv/templates') throw new Error('bad path ' + p);
    if (method === 'GET') { srv.gets++; return { version: srv.version, updatedAt: srv.data ? 1 : null, data: srv.data ? JSON.parse(JSON.stringify(srv.data)) : null }; }
    srv.puts++;
    if (o.beforePut) o.beforePut(srv);
    if (body.baseVersion !== srv.version) {
      const e = new Error('conflict'); e.status = 409; e.body = { error: 'conflict', version: srv.version, updatedAt: 1, data: JSON.parse(JSON.stringify(srv.data)) }; throw e;
    }
    srv.version += 1; srv.data = JSON.parse(JSON.stringify(body.data));
    return { version: srv.version, updatedAt: 1 };
  };
  return srv;
}
function machine(srv, owner, initial) {
  const settings = Object.assign({}, initial || {});
  const saves = [];
  const sync = new S.SstvTemplateSync({
    request: () => (settings._signedOut ? null : srv.request),
    owner: () => (settings._signedOut ? null : owner),
    getSettings: () => settings,
    saveSettings: (patch, opts) => { Object.assign(settings, patch); saves.push([patch, opts]); },
    now: () => 1000,
    debounceMs: 0,
  });
  // What main's save-settings does for a local edit.
  const edit = (list) => { const r = S.stampTemplates(settings.sstvTemplates || [], list, { now: Date.now(), newId, deleted: settings.sstvTemplatesDeleted }); settings.sstvTemplates = r.templates; settings.sstvTemplatesDeleted = r.deleted; };
  return { settings, sync, saves, edit };
}

test('a 404 (route not deployed) keeps templates local and says so', async () => {
  const m = machine(fakeServer({ notDeployed: true }), 'u1', { sstvTemplates: [tpl({ id: 'a', updatedAt: 1 })] });
  const st = await m.sync.sync('test');
  assert.strictEqual(st.status, 'not-ready');
  assert.strictEqual(m.settings.sstvTemplates.length, 1);
});

test('signed out: nothing is sent', async () => {
  const srv = fakeServer();
  const m = machine(srv, 'u1', { _signedOut: true, sstvTemplates: [tpl({ id: 'a', updatedAt: 1 })] });
  assert.strictEqual((await m.sync.sync('test')).status, 'signed-out');
  assert.strictEqual(srv.gets + srv.puts, 0);
});

test('two machines: templates travel both ways, and a delete travels too', async () => {
  const srv = fakeServer();
  const A = machine(srv, 'u1'), B = machine(srv, 'u1');
  A.edit([tpl({ name: 'CQ at home' })]);
  await A.sync.sync('edit');
  assert.strictEqual(srv.version, 1);
  assert.deepStrictEqual(A.settings.sstvTemplatesSync.version, 1);
  await B.sync.sync('sstv-window');
  assert.deepStrictEqual(B.settings.sstvTemplates.map((t) => t.name), ['CQ at home']);
  assert.ok(B.saves.every(([, o]) => o && o.fromCloud), 'adopted from the cloud, never re-stamped');
  B.edit([]); // B deletes it
  await B.sync.sync('edit');
  await A.sync.sync('sstv-window');
  assert.deepStrictEqual(A.settings.sstvTemplates, []);
  assert.strictEqual(A.settings.sstvTemplatesDeleted[0].id, B.settings.sstvTemplatesDeleted[0].id);
});

test('nothing new on either side: no PUT', async () => {
  const srv = fakeServer();
  const A = machine(srv, 'u1');
  A.edit([tpl({ name: 'x' })]);
  await A.sync.sync('edit');
  const puts = srv.puts;
  await A.sync.sync('sstv-window');
  assert.strictEqual(srv.puts, puts);
});

test('409: merge the server copy and retry with its version', async () => {
  let raced = false;
  const srv = fakeServer({ beforePut: (s) => {
    if (raced) return; raced = true;
    // Another machine wrote between our GET and PUT.
    s.version += 1; s.data = { potacatSstvTemplates: 1, templates: [tpl({ id: 'other', updatedAt: 5, name: 'from the laptop' })], deleted: [] };
  } });
  const A = machine(srv, 'u1');
  A.edit([tpl({ name: 'from the shack' })]);
  const st = await A.sync.sync('edit');
  assert.strictEqual(st.status, 'ok');
  assert.deepStrictEqual(srv.data.templates.map((t) => t.name).sort(), ['from the laptop', 'from the shack']);
  assert.strictEqual(A.settings.sstvTemplatesSync.version, srv.version);
});

test('another account starts from version 0, not the last account\'s', async () => {
  const srv = fakeServer();
  const A = machine(srv, 'u2', { sstvTemplatesSync: { owner: 'u1', version: 7 } });
  A.edit([tpl({ name: 'x' })]);
  const st = await A.sync.sync('signin');
  assert.strictEqual(st.status, 'ok', st.error);
  assert.strictEqual(srv.version, 1);
});

test('an over-size set is not sent, and the reason is kept for the operator', async () => {
  const srv = fakeServer();
  const A = machine(srv, 'u1', { sstvTemplates: [tpl({ id: 'a', updatedAt: 1, name: 'Beach', bgDataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(200 * 1024) })] });
  const st = await A.sync.sync('edit');
  assert.strictEqual(st.status, 'too-large');
  assert.ok(/Beach/.test(st.error));
  assert.strictEqual(srv.puts, 0);
});

// ---- wiring --------------------------------------------------------------------
test('main stamps identities on every template write path and syncs', () => {
  const main = R('main.js');
  const ipcSave = main.slice(main.indexOf("ipcMain.handle('save-settings'"), main.indexOf("ipcMain.handle('save-settings'") + 600);
  assert.ok(/stampSstvTemplatesPatch\(newSettings\)/.test(ipcSave), 'the SSTV window');
  const remoteSave = main.slice(main.indexOf("remoteServer.on('save-settings'"), main.indexOf("remoteServer.on('save-settings'") + 1200);
  assert.ok(/stampSstvTemplatesPatch\(partial\)/.test(remoteSave), 'the ECHOCAT web client');
  assert.ok(/stampSstvTemplatesPatch\(patch\);\n\s+Object\.assign\(settings, patch\);\n\s+saveSettings\(settings\);\n\s+afterSstvSettingsSaved\(patch\)/.test(main), 'import');
  assert.ok(/new SstvTemplateSyncLib\.SstvTemplateSync\(/.test(main));
  assert.ok(/sstvTemplateSync\.sync\('sstv-window'\)/.test(main) && /sstvTemplateSync\.sync\('signin'\)/.test(main) && /sstvTemplateSync\.sync\('boot'\)/.test(main));
});

test('Share my Rig: a guest never writes the owner\'s settings and never receives their templates', () => {
  const src = R('lib/remote-server.js');
  const c = src.slice(src.indexOf("case 'save-settings':"), src.indexOf("case 'save-settings':") + 700);
  assert.ok(/if \(ws\._passSession\) \{[\s\S]*?break;\s*\}\s*if \(msg\.settings\) this\.emit\('save-settings'/.test(c));
  const { RemoteServer } = require('../lib/remote-server');
  const rs = Object.create(RemoteServer.prototype);
  rs._remoteSettings = { myCallsign: 'K3SBP', sstvTemplates: [{ id: 'a' }], sstvTextElements: [{}] };
  const g = rs._settingsFor({ _passSession: { code: 'x' } });
  assert.ok(!('sstvTemplates' in g) && !('sstvTextElements' in g) && g.myCallsign === 'K3SBP');
  assert.strictEqual(rs._settingsFor({}).sstvTemplates.length, 1, 'the owner still gets them');
});

test('the SSTV window saves small photos and adopts the stamped list', () => {
  const js = R('renderer/sstv-popout.js');
  assert.ok(/bgDataUrl = templatePhotoDataUrl\(bgImage\)/.test(js));
  assert.ok(/TEMPLATE_PHOTO_MAX_W = 640, TEMPLATE_PHOTO_MAX_H = 496/.test(js));
  assert.ok(/onSstvTemplatesUpdate\(/.test(js));
  assert.ok(/Array\.isArray\(echoSettings\.sstvTemplates\)/.test(R('renderer/remote.js')), 'the web client adopts an emptied list');
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
  }
  console.log(`\nSSTV template sync: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
