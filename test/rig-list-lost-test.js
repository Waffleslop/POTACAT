// test/rig-list-lost-test.js — GitHub #314: a working rig was replaced by a
// bare "Serial CAT on COM4 @ 38400" entry. That name is the one the rig
// migration makes when a catTarget survives and the rig list does not. The
// rig list (rigs, activeRigId) is a machine key in the global settings.json;
// catTarget is an operator key in the profile file. Moving the operator
// pointer (an operator switch, or the start-up repair of a lost pointer)
// rewrote settings.json from a fresh read, and a read that gave nothing wrote
// a file holding the pointer alone.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SF = require('../lib/settings-file');
const { globalWithPointer } = require('../lib/profile-switch-guard');
const { planRigMigration, applyRigMigration } = require('../lib/rig-migration');

let pass = 0, fail = 0;
function t(name, fn) {
  try { SF._resetForTests(); fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const FT710 = { id: 'rig_ft710', name: 'FT-710', model: 'FT-710', catTarget: { type: 'serial', path: 'COM4', baudRate: 38400 }, audioSource: 'usb' };
const GLOBAL_KEYS = new Set(['activeProfile', 'rigs', 'activeRigId', 'cloudDeviceId']);
function split(s) {
  const g = {};
  for (const [k, v] of Object.entries(s)) if (GLOBAL_KEYS.has(k)) g[k] = v;
  return g;
}

console.log('rig list survives the operator pointer moving (#314)');

t('a settings.json that cannot be read: the pointer write keeps the rig list held in memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-314-'));
  const SETTINGS_PATH = path.join(root, 'settings.json');
  const memory = { activeProfile: 'K1ABC', rigs: [FT710], activeRigId: FT710.id, cloudDeviceId: 'dev-1', myCallsign: 'K1ABC', catTarget: FT710.catTarget };
  // The file on disk does not parse and there is no .bak: the read gives nothing.
  fs.writeFileSync(SETTINGS_PATH, '{"activeProfile": "K1AB');
  const r = SF.readSettingsFile(SETTINGS_PATH, { keepCorrupt: false });
  assert.strictEqual(r.data, null, 'precondition: the read gives nothing');
  // The old code: (r.data || {}) + pointer. That file held the pointer alone.
  const old = Object.assign({}, r.data || {}, { activeProfile: 'W2XYZ' });
  assert.deepStrictEqual(Object.keys(old), ['activeProfile'], 'the old write lost the rig list');
  const next = globalWithPointer(r.data, split(memory), 'w2xyz');
  SF.writeSettingsFile(SETTINGS_PATH, next);
  const back = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  assert.strictEqual(back.activeProfile, 'W2XYZ');
  assert.deepStrictEqual(back.rigs, [FT710]);
  assert.strictEqual(back.activeRigId, FT710.id);
  assert.strictEqual(back.cloudDeviceId, 'dev-1');
  assert.ok(!('catTarget' in back) && !('myCallsign' in back), 'only machine keys reach settings.json');
  fs.rmSync(root, { recursive: true, force: true });
});

t('a readable settings.json wins over memory key by key, and keeps keys memory lacks', () => {
  const disk = { activeProfile: 'K1ABC', rigs: [FT710], activeRigId: FT710.id, legacyKey: 1 };
  const out = globalWithPointer(disk, { rigs: [], activeRigId: null }, 'W2XYZ');
  assert.deepStrictEqual(out.rigs, [FT710]);
  assert.strictEqual(out.activeRigId, FT710.id);
  assert.strictEqual(out.legacyKey, 1);
  assert.strictEqual(out.activeProfile, 'W2XYZ');
});

console.log('the rig migration makes a rig only from a file with no rig list (#314)');

t('a rig list with rigs in it is never touched', () => {
  const s = { activeProfile: 'K1ABC', rigs: [FT710], activeRigId: FT710.id, catTarget: { type: 'serial', path: 'COM9' } };
  const plan = planRigMigration(s, { now: 1 });
  assert.strictEqual(plan.action, 'none');
  assert.strictEqual(applyRigMigration(s, plan), false);
  assert.deepStrictEqual(s.rigs, [FT710]);
});

t('an emptied rig list is the operator\'s own: no "Serial CAT on COM4" from a leftover catTarget', () => {
  const s = { activeProfile: 'K1ABC', rigs: [], catTarget: FT710.catTarget };
  const plan = planRigMigration(s, { now: 1 });
  assert.strictEqual(plan.action, 'none');
  assert.strictEqual(applyRigMigration(s, plan), false);
  assert.deepStrictEqual(s.rigs, []);
});

t('settings from before My Rigs (single file, no rig list): the catTarget becomes the first rig, and the log says so', () => {
  const s = { myCallsign: 'K1ABC', catTarget: FT710.catTarget };
  const plan = planRigMigration(s, { now: 42, describe: (tg) => `Serial CAT on ${tg.path}` });
  assert.strictEqual(plan.action, 'legacy');
  assert.ok(/before My Rigs/.test(plan.log));
  assert.strictEqual(applyRigMigration(s, plan), true);
  assert.strictEqual(s.rigs.length, 1);
  assert.strictEqual(s.rigs[0].name, 'Serial CAT on COM4');
  assert.strictEqual(s.activeRigId, 'rig_42');
  assert.ok(!('catTarget' in s));
});

t('the profile layout with no rig list: the rig list was lost, said as a warning', () => {
  const s = { activeProfile: 'K1ABC', catTarget: FT710.catTarget };
  const plan = planRigMigration(s, { now: 7, describe: (tg) => `Serial CAT on ${tg.path}` });
  assert.strictEqual(plan.action, 'lost');
  assert.ok(/WARNING/.test(plan.log) && /rig list was lost/.test(plan.log) && /K1ABC/.test(plan.log), plan.log);
  assert.strictEqual(applyRigMigration(s, plan), true);
  assert.strictEqual(s.rigs[0].catTarget.path, 'COM4', 'the radio still connects');
});

t('no catTarget: nothing is made', () => {
  const s = { activeProfile: 'K1ABC' };
  assert.strictEqual(planRigMigration(s).action, 'none');
});

console.log('main.js uses them');
const main = readSrc(path.join(__dirname, '..', 'main.js'));

t('setActiveProfilePointer never writes a file built from an empty read', () => {
  const i = main.indexOf('function setActiveProfilePointer(');
  assert.ok(i > 0);
  const fn = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/_readJsonSafe\(SETTINGS_PATH, null\)/.test(fn), 'reads with a null fallback');
  assert.ok(/globalWithPointer\(/.test(fn), 'builds the file with globalWithPointer');
  assert.ok(/_splitSettings\(settings\)\.global/.test(fn), 'the machine keys in memory are the floor');
});

t('migrateRigSettings decides with lib/rig-migration.js, before any empty list is put in', () => {
  const i = main.indexOf('function migrateRigSettings(');
  assert.ok(i > 0);
  const fn = main.slice(i, main.indexOf('// Dedup rigs', i));
  const plan = fn.indexOf('planRigMigration(');
  const empty = fn.indexOf('s.rigs = []');
  assert.ok(plan > 0, 'uses planRigMigration');
  assert.ok(empty < 0 || empty > plan, 'the plan sees whether the rig list was there at all');
  assert.ok(/applyRigMigration\(/.test(fn) && /sendCatLog\(rigPlan\.log\)/.test(fn), 'applies the plan and logs it');
  assert.ok(!/s\.rigs\.length === 0/.test(fn), 'the old "empty list: make a rig" rule is gone');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
