'use strict';
// The desktop sends its version to POTACAT Cloud (Cloud ask 2026-11-26):
// appVersion rides in the POST /v1/devices register payload and in the
// device heartbeat body, so Cloud can tell who still runs an old release.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/cloud-device-version');
const CloudSyncClient = require('../lib/cloud-sync');

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok ' + name); }

(async () => {
  await t('a version string is sent as it is, trimmed', () => {
    assert.strictEqual(V.cleanAppVersion('1.14.8'), '1.14.8');
    assert.strictEqual(V.cleanAppVersion(' 1.15.0-beta.2 '), '1.15.0-beta.2');
  });

  await t('no version, an empty one or a non-string is left out, never sent as ""', () => {
    for (const bad of [undefined, null, '', '   ', 1148, {}, 'x'.repeat(65)]) {
      assert.strictEqual(V.cleanAppVersion(bad), '');
      assert.deepStrictEqual(V.deviceHeartbeatBody(bad), {});
      assert.ok(!('appVersion' in V.withAppVersion({ deviceId: 'd' }, bad)));
    }
  });

  await t('the register payload keeps every field and gains appVersion; the input is not changed', () => {
    const payload = { deviceId: 'd1', type: 'shack', lanHost: 'wss://10.0.0.2:7300' };
    const out = V.withAppVersion(payload, '1.14.8');
    assert.deepStrictEqual(out, { deviceId: 'd1', type: 'shack', lanHost: 'wss://10.0.0.2:7300', appVersion: '1.14.8' });
    assert.ok(!('appVersion' in payload));
  });

  await t('the heartbeat body is { appVersion }', () => {
    assert.deepStrictEqual(V.deviceHeartbeatBody('1.14.8'), { appVersion: '1.14.8' });
  });

  await t('CloudSyncClient.heartbeatDevice posts the body it is given (and {} without one)', async () => {
    const c = new CloudSyncClient({ accessToken: 'tok' });
    const calls = [];
    c._ensureAuth = async () => {};
    c._request = async (method, p, body) => { calls.push({ method, p, body }); return {}; };
    await c.heartbeatDevice('dev 1', { appVersion: '1.14.8' });
    await c.heartbeatDevice('dev1');
    assert.deepStrictEqual(calls[0], { method: 'POST', p: '/v1/devices/dev%201/heartbeat', body: { appVersion: '1.14.8' } });
    assert.deepStrictEqual(calls[1].body, {});
  });

  await t('CloudSyncClient.registerDevice posts the payload with appVersion', async () => {
    const c = new CloudSyncClient({ accessToken: 'tok' });
    let sent;
    c._ensureAuth = async () => {};
    c._request = async (method, p, body) => { sent = { method, p, body }; return {}; };
    await c.registerDevice(V.withAppVersion({ deviceId: 'd1' }, '1.14.8'));
    assert.deepStrictEqual(sent, { method: 'POST', p: '/v1/devices', body: { deviceId: 'd1', appVersion: '1.14.8' } });
  });

  await t('main.js sends app.getVersion() in the register payload and the heartbeat', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const build = src.slice(src.indexOf('function _buildCloudDevicePayload()'));
    const buildBody = build.slice(0, build.indexOf('\nfunction ', 10));
    assert.ok(/withAppVersion\(\{/.test(buildBody), 'the register payload goes through withAppVersion');
    assert.ok(/app\.getVersion\(\)/.test(buildBody), 'with app.getVersion()');
    assert.ok(/heartbeatDevice\(settings\.cloudDeviceId,\s*require\('\.\/lib\/cloud-device-version'\)\.deviceHeartbeatBody\(/.test(src),
      'the heartbeat sends deviceHeartbeatBody(app version)');
  });

  console.log(`cloud-device-version: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
