// Settings export/import secret handling (lib/settings-secrets.js).
// Guards against the blocklist-rot that shipped exports carrying
// sota/K4/RS-BA1/cluster passwords and ECHOCAT device tokens.
// Run: node test/settings-secrets-test.js
'use strict';

const assert = require('assert');
const { SECRET_KEYS, stripSecrets, restoreSecrets } = require('../lib/settings-secrets');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

function sampleSettings() {
  return {
    myCallsign: 'K3SBP',
    grid: 'FN20jb',
    qrzPassword: 'qrz-pw',
    qrzApiKey: 'qrz-key',
    sotaPassword: 'sota-pw',
    wavelogApiKey: 'wl-key',
    remoteToken: 'rt-123',
    echocatToken: 'et-456',
    cloudAccessToken: 'jwt.a.b',
    cloudRefreshToken: 'refresh-1',
    smartSdrClientId: 'machine-guid',
    catTarget: { type: 'k4-network', host: 'k4', port: 9205, password: 'k4-pw' },
    rigs: [
      { id: 'rig_1', name: 'K4', catTarget: { type: 'k4-network', host: 'k4', password: 'k4-pw' } },
      { id: 'rig_2', name: 'IC-705', catTarget: { type: 'icom-network', host: '705', username: 'user', password: 'rsba1-pw' } },
      { id: 'rig_3', name: 'Flex', catTarget: { type: 'tcp', host: '127.0.0.1', port: 5002 }, flexApiHost: '10.0.0.5' },
    ],
    clusterNodes: [
      { id: 'n1', name: 'W3LPL', host: 'w3lpl.net', port: 7373, enabled: true },
      { id: 'n2', name: 'HamAlert', host: 'hamalert.org', port: 7300, enabled: true, loginCall: 'gavinh', password: 'ha-pw' },
    ],
    pairedDevices: [{ id: 'd1', name: 'iPhone', token: 'raw-bearer-token' }],
    connectionTargets: [{ id: 't1', name: 'Shack', deviceToken: 'dt-789' }],
  };
}

console.log('stripSecrets:');
{
  const src = sampleSettings();
  const out = stripSecrets(src);
  for (const k of SECRET_KEYS) check(!(k in out), `top-level ${k} stripped`);
  check(!('pairedDevices' in out), 'pairedDevices (bearer tokens) stripped entirely');
  check(!('connectionTargets' in out), 'connectionTargets (deviceTokens) stripped entirely');
  check(out.catTarget && !('password' in out.catTarget) && out.catTarget.host === 'k4', 'catTarget password stripped, rest kept');
  check(!('password' in out.rigs[0].catTarget) && !('password' in out.rigs[1].catTarget), 'rig catTarget passwords stripped');
  check(out.rigs[1].catTarget.username === 'user', 'non-secret catTarget fields kept');
  check(!('password' in out.clusterNodes[1]) && out.clusterNodes[1].loginCall === 'gavinh', 'cluster node password stripped, loginCall kept');
  check(out.myCallsign === 'K3SBP' && out.grid === 'FN20jb', 'non-secrets intact');
  check(src.qrzPassword === 'qrz-pw' && src.rigs[0].catTarget.password === 'k4-pw' &&
        src.clusterNodes[1].password === 'ha-pw', 'input object not mutated');
  check(JSON.stringify(out).indexOf('pw') === -1 && JSON.stringify(out).indexOf('token') === -1 &&
        JSON.stringify(out).indexOf('jwt') === -1, 'serialized export contains no secret material');
}

console.log('restoreSecrets (round-trip: export then import on the same machine):');
{
  const current = sampleSettings();
  const imported = JSON.parse(JSON.stringify(stripSecrets(current)));
  restoreSecrets(imported, current);
  for (const k of SECRET_KEYS) check(imported[k] === current[k], `top-level ${k} restored`);
  check(imported.pairedDevices && imported.pairedDevices[0].token === 'raw-bearer-token', 'pairedDevices restored from current machine');
  check(imported.catTarget.password === 'k4-pw', 'active catTarget password restored (type match)');
  check(imported.rigs[0].catTarget.password === 'k4-pw', 'rig_1 password re-grafted by id');
  check(imported.rigs[1].catTarget.password === 'rsba1-pw', 'rig_2 RS-BA1 password re-grafted by id');
  check(imported.clusterNodes[1].password === 'ha-pw', 'HamAlert node password re-grafted by id');
}

console.log('restoreSecrets edge cases:');
{
  const current = sampleSettings();
  // Import that CARRIES its own values must win.
  const withOwn = { qrzPassword: 'their-pw', clusterNodes: [{ id: 'n2', password: 'their-ha' }] };
  restoreSecrets(withOwn, current);
  check(withOwn.qrzPassword === 'their-pw', 'explicit imported secret wins over current');
  check(withOwn.clusterNodes[0].password === 'their-ha', 'explicit imported node password wins');

  // Unknown rig/node ids get nothing grafted.
  const foreign = { rigs: [{ id: 'rig_X', catTarget: { type: 'k4-network' } }], clusterNodes: [{ id: 'nX' }] };
  restoreSecrets(foreign, current);
  check(!foreign.rigs[0].catTarget.password, 'no graft onto unknown rig id');
  check(!foreign.clusterNodes[0].password, 'no graft onto unknown node id');

  // catTarget transport mismatch → no graft (different radio, stale password).
  const mismatch = { catTarget: { type: 'icom-network', host: 'x' } };
  restoreSecrets(mismatch, current);
  check(!mismatch.catTarget.password, 'no catTarget graft across transport types');

  // Degenerate inputs never throw.
  restoreSecrets(null, current);
  restoreSecrets({}, null);
  check(stripSecrets(null) && typeof stripSecrets(null) === 'object', 'null-safe');
  passed++; console.log('  ✓ degenerate inputs handled');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'settings-secrets tests failed');
