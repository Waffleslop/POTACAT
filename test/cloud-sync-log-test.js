'use strict';
// Cloud sync writes what it did to the session log, quietly, and never
// names the account (B10, 2026-11-15).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { syncSummaryLine, syncErrorLine, backgroundSyncLine, createSyncLogger } = require('../lib/cloud-sync-log');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok ' + name); }

t('a cycle that changed nothing writes nothing', () => {
  assert.strictEqual(syncSummaryLine({ pushed: 0, pulled: 0, conflicts: 0 }), null);
  assert.strictEqual(syncSummaryLine({ skipped: true, pushed: 0, pulled: 0, conflicts: 0 }), null);
  assert.strictEqual(syncSummaryLine(undefined), null);
});

t('a pull writes its count and the account as present', () => {
  assert.strictEqual(syncSummaryLine({ pushed: 0, pulled: 10055, conflicts: 0 }),
    '[Cloud] sync: pulled 10055 QSOs, pushed 0 (account signed in)');
  assert.strictEqual(syncSummaryLine({ pushed: 2, pulled: 1, conflicts: 1 }, { signedIn: true }),
    '[Cloud] sync: pulled 1 QSO, pushed 2, 1 conflict (the Cloud copy kept) (account signed in)');
});

t('an error names the account only as present or absent', () => {
  assert.strictEqual(syncErrorLine('HTTP 401', { signedIn: false }), '[Cloud] sync failed: HTTP 401 (no account signed in)');
  assert.strictEqual(syncErrorLine('', {}), '[Cloud] sync failed: unknown error (account signed in)');
});

t('background sync says why it did not start', () => {
  assert.match(backgroundSyncLine({ signedIn: false, syncEnabled: true }), /no account signed in/);
  assert.match(backgroundSyncLine({ signedIn: true, syncEnabled: false }), /"Enable QSO Cloud Sync" is off in Settings > Cloud/);
  assert.strictEqual(backgroundSyncLine({ signedIn: true, syncEnabled: true }), null);
});

t('the logger is quiet: one line per repeated error until a cycle succeeds', () => {
  const lines = [];
  const L = createSyncLogger((l) => lines.push(l));
  L.failed('timeout'); L.failed('timeout'); L.failed('timeout');
  assert.strictEqual(lines.length, 1);
  L.synced({ pushed: 0, pulled: 0, conflicts: 0 });
  assert.strictEqual(lines.length, 1, 'an empty cycle writes nothing');
  L.failed('timeout');
  assert.strictEqual(lines.length, 2, 'the error after a success is written again');
  L.failed('HTTP 500');
  assert.strictEqual(lines.length, 3, 'a different error is written');
  L.synced({ pushed: 0, pulled: 3, conflicts: 0 });
  assert.strictEqual(lines.length, 4);
});

t('the "not started" reason is written once until it changes', () => {
  const lines = [];
  const L = createSyncLogger((l) => lines.push(l));
  L.background({ signedIn: true, syncEnabled: false });
  L.background({ signedIn: true, syncEnabled: false });
  assert.strictEqual(lines.length, 1);
  L.background({ signedIn: true, syncEnabled: true });
  assert.strictEqual(lines.length, 1, 'running writes nothing');
  L.background({ signedIn: false, syncEnabled: true });
  assert.strictEqual(lines.length, 2);
});

t('cloud-ipc wires all three and never logs the account email', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud-ipc.js'), 'utf8');
  assert.match(src, /if \(status === 'error'\) syncLog\.failed\(/);
  assert.match(src, /onSynced: \(summary\) => \{\s*syncLog\.synced\(summary/);
  assert.match(src, /syncLog\.background\(\{ signedIn: !!settings\.cloudAccessToken/);
  const mod = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud-sync-log.js'), 'utf8');
  assert.ok(!/email/i.test(mod.replace(/never by its email/, '')), 'the log helper never touches an email');
});

console.log(`cloud-sync-log-test: ${passed} passed`);
