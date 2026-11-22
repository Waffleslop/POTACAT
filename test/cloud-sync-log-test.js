'use strict';
// Cloud sync writes what it did to the session log, quietly, and never
// names the account (B10, 2026-11-15).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { syncSummaryLine, syncErrorLine, backgroundSyncLine, createSyncLogger, shouldRepullHistory, repullLine } = require('../lib/cloud-sync-log');
const CloudSyncClient = require('../lib/cloud-sync');

let passed = 0;
const pending = [];
function t(name, fn) {
  const r = fn();
  const done = () => { passed++; console.log('  ok ' + name); };
  if (r && typeof r.then === 'function') pending.push(r.then(done)); else done();
}

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

t('Sync Now re-pulls the history when this log is missing it (2 here, 360 in the Cloud)', () => {
  assert.strictEqual(shouldRepullHistory({ cloudCount: 360, localCount: 2, hasCursor: true }), true);
  assert.strictEqual(shouldRepullHistory({ cloudCount: 360, localCount: 360, hasCursor: true }), false);
  assert.strictEqual(shouldRepullHistory({ cloudCount: 300, localCount: 360, hasCursor: true }), false);
  assert.strictEqual(shouldRepullHistory({ cloudCount: 360, localCount: 2, hasCursor: false }), false, 'no cursor: the pull is already the whole history');
  assert.strictEqual(shouldRepullHistory({ cloudCount: null, localCount: 2, hasCursor: true }), false, 'an unknown count changes nothing');
  assert.strictEqual(shouldRepullHistory({ cloudCount: 360, localCount: null, hasCursor: true }), false);
  assert.strictEqual(repullLine({ cloudCount: 360, localCount: 2 }),
    "[Cloud] Sync Now: this log holds 2 QSOs and the Cloud 360: pulling the account's whole history again");
});

t('resetPullCursor makes the next pull start from the beginning', async () => {
  const c = new CloudSyncClient({ apiBase: 'https://example.invalid', lastSyncTimestamp: '2026-11-15T00:00:00Z' });
  const paths = [];
  c._authedRequest = async (m, p) => { paths.push(p); return { qsos: [], hasMore: false }; };
  return (async () => {
    await c.pull();
    c.resetPullCursor();
    await c.pull();
    assert.match(paths[0], /&since=/);
    assert.doesNotMatch(paths[1], /&since=/);
  })();
});

t('cloud-ipc runs the check before Sync Now and clears the saved cursor too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud-ipc.js'), 'utf8');
  assert.match(src, /async function syncNow\(\) \{[\s\S]{0,200}await repullIfHistoryMissing\(sync\);[\s\S]{0,80}sync\.sync\(view, getSyncCallbacks\(\)\)/);
  assert.match(src, /sync\.resetPullCursor\(\);\s*settings\.cloudLastSyncTimestamp = null;/);
});

Promise.all(pending).then(() => console.log(`cloud-sync-log-test: ${passed} passed`), (err) => { console.error(err); process.exit(1); });
