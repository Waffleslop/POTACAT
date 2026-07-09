// Slash-callsign profile directory encoding + nested-dir migration
// (LZ3AW/P report, 2026-07-09: adding a portable operator nested its profile
// dir inside the base call's dir, and the Summary dropdown couldn't switch
// in either direction).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { profileDirName, profileCallFromDirName, migrateNestedSlashProfiles } = require('../lib/profile-dirs');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

// --- Codec ---

check('encode: slash becomes underscore', () => {
  assert.strictEqual(profileDirName('LZ3AW/P'), 'LZ3AW_P');
  assert.strictEqual(profileDirName('lz3aw/p'), 'LZ3AW_P');
  assert.strictEqual(profileDirName('F/LZ3AW/P'), 'F_LZ3AW_P');
  assert.strictEqual(profileDirName('K3SBP'), 'K3SBP');
});

check('decode: underscore becomes slash, round-trips', () => {
  for (const call of ['LZ3AW/P', 'F/LZ3AW/P', 'K3SBP', 'W1AW/4']) {
    assert.strictEqual(profileCallFromDirName(profileDirName(call)), call);
  }
});

// --- Migration ---

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

check('nested LZ3AW/P moves to encoded top level with paths rewritten', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-profiles-'));
  const nested = path.join(tmp, 'LZ3AW', 'P');
  writeJson(path.join(tmp, 'LZ3AW', 'settings.json'), { myCallsign: 'LZ3AW' });
  writeJson(path.join(nested, 'settings.json'), {
    myCallsign: 'LZ3AW/P',
    adifLogPath: path.join(nested, 'potacat_qso_log.adi'),
    grid: 'KN22',
  });
  fs.writeFileSync(path.join(nested, 'potacat_qso_log.adi'), 'POTACAT log\n<eoh>\n');

  const { moved, skipped } = migrateNestedSlashProfiles(tmp);
  assert.strictEqual(skipped.length, 0, JSON.stringify(skipped));
  assert.strictEqual(moved.length, 1);
  assert.strictEqual(moved[0].call, 'LZ3AW/P');

  const dest = path.join(tmp, 'LZ3AW_P');
  assert(fs.existsSync(path.join(dest, 'settings.json')), 'moved settings.json');
  assert(fs.existsSync(path.join(dest, 'potacat_qso_log.adi')), 'log moved with the dir');
  assert(!fs.existsSync(nested), 'nested dir gone');

  const s = JSON.parse(fs.readFileSync(path.join(dest, 'settings.json'), 'utf-8'));
  assert.strictEqual(s.myCallsign, 'LZ3AW/P', 'callsign untouched');
  assert.strictEqual(s.adifLogPath, path.join(dest, 'potacat_qso_log.adi'), 'adifLogPath rewritten');
  assert.strictEqual(s.grid, 'KN22', 'other fields untouched');

  // Parent profile untouched
  const parent = JSON.parse(fs.readFileSync(path.join(tmp, 'LZ3AW', 'settings.json'), 'utf-8'));
  assert.strictEqual(parent.myCallsign, 'LZ3AW');
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('doubly-nested F/LZ3AW/P migrates child-first', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-profiles-'));
  writeJson(path.join(tmp, 'F', 'settings.json'), { myCallsign: 'F' });
  writeJson(path.join(tmp, 'F', 'LZ3AW', 'settings.json'), { myCallsign: 'F/LZ3AW' });
  writeJson(path.join(tmp, 'F', 'LZ3AW', 'P', 'settings.json'), { myCallsign: 'F/LZ3AW/P' });

  const { moved, skipped } = migrateNestedSlashProfiles(tmp);
  assert.strictEqual(skipped.length, 0, JSON.stringify(skipped));
  assert.deepStrictEqual(moved.map(m => m.call).sort(), ['F/LZ3AW', 'F/LZ3AW/P']);
  assert(fs.existsSync(path.join(tmp, 'F_LZ3AW', 'settings.json')));
  assert(fs.existsSync(path.join(tmp, 'F_LZ3AW_P', 'settings.json')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('idempotent: second run moves nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-profiles-'));
  writeJson(path.join(tmp, 'LZ3AW', 'settings.json'), { myCallsign: 'LZ3AW' });
  writeJson(path.join(tmp, 'LZ3AW', 'P', 'settings.json'), { myCallsign: 'LZ3AW/P' });
  migrateNestedSlashProfiles(tmp);
  const second = migrateNestedSlashProfiles(tmp);
  assert.strictEqual(second.moved.length, 0);
  assert.strictEqual(second.skipped.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('conflict: existing encoded dir is not clobbered', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-profiles-'));
  writeJson(path.join(tmp, 'LZ3AW', 'settings.json'), { myCallsign: 'LZ3AW' });
  writeJson(path.join(tmp, 'LZ3AW', 'P', 'settings.json'), { myCallsign: 'LZ3AW/P', marker: 'nested' });
  writeJson(path.join(tmp, 'LZ3AW_P', 'settings.json'), { myCallsign: 'LZ3AW/P', marker: 'existing' });

  const { moved, skipped } = migrateNestedSlashProfiles(tmp);
  assert.strictEqual(moved.length, 0);
  assert.strictEqual(skipped.length, 1);
  const kept = JSON.parse(fs.readFileSync(path.join(tmp, 'LZ3AW_P', 'settings.json'), 'utf-8'));
  assert.strictEqual(kept.marker, 'existing', 'pre-existing dir survives');
  assert(fs.existsSync(path.join(tmp, 'LZ3AW', 'P', 'settings.json')), 'nested left in place for manual resolution');
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('normal profile subdirs without settings.json are ignored', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-profiles-'));
  writeJson(path.join(tmp, 'K3SBP', 'settings.json'), { myCallsign: 'K3SBP' });
  fs.mkdirSync(path.join(tmp, 'K3SBP', 'backups'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '_archived', 'OLD-2026'), { recursive: true });

  const { moved, skipped } = migrateNestedSlashProfiles(tmp);
  assert.strictEqual(moved.length, 0);
  assert.strictEqual(skipped.length, 0);
  assert(fs.existsSync(path.join(tmp, 'K3SBP', 'backups')), 'plain subdir untouched');
  fs.rmSync(tmp, { recursive: true, force: true });
});

if (failures) {
  console.error(`\nprofile-dirs-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nprofile-dirs-test: OK');
