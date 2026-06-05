// Integration test: RemoteServer + RemoteClient end-to-end.
// Not part of the npm-test chain (uses dynamic port, spins network).
// Run manually: node test/remote-client-integration.js

'use strict';

const { RemoteServer } = require('../lib/remote-server');
const { RemoteClient } = require('../lib/remote-client');
const crypto = require('crypto');

(async () => {
  const rs = new RemoteServer();
  rs._serverVersion = 'test-1.9';
  rs.setRigModel('Test Rig 9000');
  const dev = rs.mintPairedDevice({ deviceName: 'TestLaptop', devicePlatform: 'desktop-test' });
  console.log('paired device minted:', { id: dev.id, expiresAt: !!dev.expiresAt, trusted: dev.trusted, accountLinked: dev.accountLinked });

  rs.on('log', m => process.stderr.write('[server] ' + m + '\n'));
  // start(port, token, opts) — pass 0 token (per-device auth) and a free port
  rs.start(17300, null);
  await new Promise(r => setTimeout(r, 500));
  const port = rs._port;
  const fp = (new crypto.X509Certificate(rs._tlsCertPem)).fingerprint256;
  console.log('server listening on :' + port + ', fp=' + fp.slice(0, 32) + '…');

  const target = {
    id: dev.id,
    name: 'Test shack',
    deviceToken: dev.token,
    lanHost: 'wss://127.0.0.1:' + port,
    fingerprint: fp,
  };
  const events = [];
  const c = new RemoteClient(target, { clientVersion: 'test-1.9', clientPlatform: 'desktop-test' });
  c.on('log', m => process.stderr.write('[client] ' + m + '\n'));
  c.on('connecting', e => events.push(['connecting', e.leg]));
  c.on('hello', e => events.push(['hello', e.rigModel]));
  c.on('connected', e => events.push(['connected', { expiresAt: !!e.expiresAt, trusted: e.trusted, accountLinked: e.accountLinked }]));
  c.on('disconnected', e => events.push(['disconnected', e.wasAuthed]));
  c.on('auth-fail', e => events.push(['auth-fail', e.reason]));

  c.connect();
  await new Promise(r => setTimeout(r, 1500));

  let serverTune = null;
  rs.on('tune', t => { serverTune = t; });
  c.sendTune({ frequency: 14074000, mode: 'USB' });
  await new Promise(r => setTimeout(r, 200));

  c.close();
  rs.stop && rs.stop();
  await new Promise(r => setTimeout(r, 100));

  console.log('events:', JSON.stringify(events, null, 2));
  console.log('server received tune:', JSON.stringify(serverTune));

  const ok = events.find(e => e[0] === 'hello' && e[1] === 'Test Rig 9000')
          && events.find(e => e[0] === 'connected')
          && serverTune && Math.abs(parseFloat(serverTune.freqKhz) - 14074) < 0.01
          && serverTune.mode === 'USB';
  console.log(ok ? 'PASS: end-to-end handshake + tune' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
