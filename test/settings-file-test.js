// test/settings-file-test.js — settings wiped (lloyd_ko4l on a Windows
// upgrade, n8jms on a Mac, 2026-10). The write went straight over the live
// file; a POTACAT closed mid-write left a truncated file, the next launch read
// it as a fresh install, and the next save replaced everything.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SF = require('../lib/settings-file');

let pass = 0, fail = 0;
function t(name, fn) {
  try { SF._resetForTests(); fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-settings-'));
const f = (n) => path.join(dir, n);

console.log('settings file:');
t('a write lands whole through a temp file, and keeps a .bak of the last good file', () => {
  const p = f('a.json');
  SF.writeSettingsFile(p, { myCallsign: 'K3SBP' }, { now: 1000 });
  assert.ok(!fs.existsSync(p + '.bak'), 'nothing to back up the first time');
  SF.writeSettingsFile(p, { myCallsign: 'K3SBP', grid: 'FN20' }, { now: 2000 });
  assert.deepStrictEqual(JSON.parse(readSrc(p + '.bak')), { myCallsign: 'K3SBP' });
  assert.deepStrictEqual(JSON.parse(readSrc(p)), { myCallsign: 'K3SBP', grid: 'FN20' });
  assert.ok(!fs.existsSync(p + '.tmp'));
});
t('the .bak is refreshed at most once an hour, and never from a broken file', () => {
  const p = f('b.json');
  SF.writeSettingsFile(p, { v: 1 }, { now: 0 });
  SF.writeSettingsFile(p, { v: 2 }, { now: SF.BACKUP_EVERY_MS });     // backs up v1
  SF.writeSettingsFile(p, { v: 3 }, { now: SF.BACKUP_EVERY_MS + 5 }); // too soon: still v1
  assert.strictEqual(JSON.parse(readSrc(p + '.bak')).v, 1);
  fs.writeFileSync(p, '{"v": 3, "trunc');
  SF.writeSettingsFile(p, { v: 4 }, { now: SF.BACKUP_EVERY_MS * 3 });
  assert.strictEqual(JSON.parse(readSrc(p + '.bak')).v, 1, 'a truncated file is never the backup');
});
t('a truncated file is restored from the .bak, kept as .corrupt, and said', () => {
  const p = f('c.json');
  fs.writeFileSync(p + '.bak', JSON.stringify({ myCallsign: 'KO4L', rigs: [{ id: 'r1' }] }));
  fs.writeFileSync(p, '{"myCallsign": "KO4L", "rig');
  const r = SF.readSettingsFile(p, { now: Date.UTC(2026, 10, 4) });
  assert.strictEqual(r.status, 'restored');
  assert.strictEqual(r.data.myCallsign, 'KO4L');
  assert.ok(r.keptAs && fs.existsSync(r.keptAs));
  const line = SF.describeRead('settings.json', r);
  assert.ok(/settings\.json could not be used: it does not parse/.test(line) && /Restored it from settings\.json\.bak/.test(line), line);
});
t('an empty file with no backup is reported, not read silently as a fresh install', () => {
  const p = f('d.json');
  fs.writeFileSync(p, '');
  const r = SF.readSettingsFile(p, { keepCorrupt: false });
  assert.strictEqual(r.status, 'unreadable'); assert.strictEqual(r.data, null);
  assert.ok(/no backup to restore from/.test(SF.describeRead('settings.json', r)));
});
t('a missing file with a .bak beside it is the lost file, restored', () => {
  const p = f('e.json');
  fs.writeFileSync(p + '.bak', JSON.stringify({ myCallsign: 'N8JMS' }));
  const r = SF.readSettingsFile(p);
  assert.strictEqual(r.status, 'restored'); assert.strictEqual(r.data.myCallsign, 'N8JMS');
  assert.strictEqual(SF.readSettingsFile(f('none.json')).status, 'missing', 'a real fresh install');
});
t('main.js reads and writes every settings file through it', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
  assert.ok(main.includes('const r = SettingsFile.readSettingsFile(p, { keepCorrupt: first });'));
  assert.ok(main.includes('SettingsFile.writeSettingsFile(p, obj);'));
  assert.ok(!/function _writeJsonAtomic[\s\S]{0,400}fs\.writeFileSync\(p, JSON\.stringify/.test(main), 'no direct write over the live file');
});
fs.rmSync(dir, { recursive: true, force: true });
console.log('\nsettings file: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
