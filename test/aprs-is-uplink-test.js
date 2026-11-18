#!/usr/bin/env node
'use strict';
// APRS phase 4: the one APRS-IS uplink (lib/aprs-is.js AprsIsClient), against a
// local fake APRS-IS server (test/fixtures/fake-aprs-is-server.js). Nothing
// here reaches the real APRS-IS. Run: node test/aprs-is-uplink-test.js

const assert = require('assert');
const { AprsIsClient } = require('../lib/aprs-is');
const { aprsPasscode } = require('../lib/aprs-passcode');
const { startFakeAprsIs } = require('./fixtures/fake-aprs-is-server');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(20); }
  return fn();
}

(async () => {
  await test('logs in as CALL-10 with the computed passcode and the software name and version; verified', async () => {
    const srv = await startFakeAprsIs();
    const c = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '9.9.9' });
    const states = [];
    c.on('status', (s) => states.push(s.state));
    c.connect();
    assert.ok(await until(() => c.verified), 'verified');
    assert.deepStrictEqual(srv.logins, [{ call: 'K3ABC-10', verified: true, readOnly: false, vers: 'POTACAT 9.9.9', filter: '' }]);
    assert.strictEqual(c.status().state, 'verified');
    assert.ok(states.includes('connecting') && states.includes('verified'));
    c.disconnect();
    await srv.close();
  });

  await test('send: refused before the login is verified, delivered after', async () => {
    const srv = await startFakeAprsIs();
    const c = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1' });
    assert.strictEqual(c.send('W1AW>APRS,qAO,K3ABC-10:>x'), false);
    c.connect();
    await until(() => c.verified);
    assert.strictEqual(c.send('W1AW>APRS,qAO,K3ABC-10:>x'), true);
    assert.ok(await until(() => srv.received.some((r) => r.line === 'W1AW>APRS,qAO,K3ABC-10:>x')));
    c.disconnect();
    await srv.close();
  });

  await test('unverified login: nothing can be sent, and the status says unverified', async () => {
    const srv = await startFakeAprsIs({ refuseVerify: true });
    const c = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1' });
    c.connect();
    assert.ok(await until(() => c.status().state === 'unverified'));
    assert.strictEqual(c.verified, false);
    assert.strictEqual(c.send('K3ABC-10>APZPCT,TCPIP*:>x'), false);
    await wait(100);
    assert.strictEqual(srv.received.length, 0);
    c.disconnect();
    await srv.close();
  });

  await test('the passcode never leaves in an event or the status', async () => {
    const srv = await startFakeAprsIs();
    const code = String(aprsPasscode('K3ABC'));
    const c = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1' });
    const seen = [];
    for (const ev of ['status', 'line', 'connected', 'verified', 'disconnected', 'error']) c.on(ev, (x) => seen.push(JSON.stringify(x === undefined ? null : x)));
    c.connect();
    await until(() => c.verified);
    seen.push(JSON.stringify(c.status()));
    assert.ok(seen.every((s) => !s.includes('pass ' + code) && !new RegExp('\\b' + code + '\\b').test(s)), seen.join('\n'));
    c.disconnect();
    await srv.close();
  });

  await test('a dropped connection is no longer verified and reconnects; disconnect() ends it', async () => {
    const srv = await startFakeAprsIs();
    const c = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1', retryBaseMs: 50 });
    c.connect();
    await until(() => c.verified);
    srv.dropAll();
    assert.ok(await until(() => !c.verified));
    assert.ok(await until(() => c.verified && srv.logins.length === 2), 'logged in again');
    c.disconnect();
    srv.dropAll();
    await wait(300);
    assert.strictEqual(srv.logins.length, 2, 'no reconnect after disconnect()');
    assert.strictEqual(c.status().state, 'stopped');
    await srv.close();
  });

  await test('keep-alive: a "#" line when nothing was sent for keepaliveMs', async () => {
    const srv = await startFakeAprsIs({ keepaliveMs: 100000 });
    const c = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1', keepaliveMs: 150, idleMs: 5000 });
    c.connect();
    await until(() => c.verified);
    assert.ok(await until(() => srv.received.some((r) => r.line[0] === '#'), 2000));
    c.disconnect();
    await srv.close();
  });

  await test('end to end: a packet heard on the radio reaches the server as ,qAO,<call>, once', async () => {
    const { createIgate } = require('../lib/aprs-igate');
    const srv = await startFakeAprsIs();
    const c = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1' });
    c.connect();
    await until(() => c.verified);
    const ig = createIgate({ call: c.call, send: (l) => c.send(l) });
    assert.ok(ig.offer('W1AW>APDR16,WIDE1-1:=4130.00N/07200.00W-hi').ok);
    assert.strictEqual(ig.offer('W1AW>APDR16,KB1XYZ-1*,WIDE1*:=4130.00N/07200.00W-hi').reason, 'duplicate');
    assert.strictEqual(ig.offer('W2XYZ>APRS,TCPIP*:>from the internet').reason, 'from-internet');
    await wait(200);
    assert.deepStrictEqual(srv.received.filter((r) => r.line[0] !== '#').map((r) => r.line), ['W1AW>APDR16,WIDE1-1,qAO,K3ABC-10:=4130.00N/07200.00W-hi']);
    c.disconnect();
    await srv.close();
  });

  console.log(`\nAPRS-IS uplink: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
