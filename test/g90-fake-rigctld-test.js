#!/usr/bin/env node
'use strict';
// GitHub #109: a G90 behind rigctld, end to end over TCP. A fake rigctld
// answers polls while receiving, answers "T 1" with RPRT 0, and then drops the
// connection on ANY command while keyed: what the reporter's bundled rigctld
// did when Hamlib's G90 backend timed out mid-over ("stack smashing detected").
// The G90 model must keep the connection through a whole FT8 over and unkey
// with "T 0"; a generic rigctld model polls, loses the link, and the reconnect
// sends "T 0" before any poll.
// Run: node test/g90-fake-rigctld-test.js
const assert = require('assert');
const net = require('net');
const { RigController } = require('../lib/rig-controller');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { TcpTransport } = require('../lib/transport');
const { RIG_MODELS, GENERIC_CAPS } = require('../lib/rig-models');

let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRigctld() {
  const conns = []; // one array of command lines per connection
  const server = net.createServer((sock) => {
    const cmds = [];
    conns.push(cmds);
    let keyed = false, buf = '';
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        cmds.push(line);
        if (/^T\s+1/.test(line)) { keyed = true; sock.write('RPRT 0\n'); continue; }
        if (/^T\s+0/.test(line)) { keyed = false; sock.write('RPRT 0\n'); continue; }
        if (keyed) { sock.destroy(); return; } // the crash: any CAT while keyed
        if (line === 'f') sock.write('14074000\n');
        else if (line === 'm') sock.write('PKTUSB\n3000\n');
        else if (line === 't') sock.write('0\n');
        else sock.write('RPRT 0\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, conns, port: server.address().port })));
}

function controller(model, port) {
  const transport = new TcpTransport();
  const codec = new RigctldCodec(model, (d) => transport.write(d));
  transport.on('data', (d) => codec.onData(d));
  const r = new RigController(model, transport, codec);
  r.connect({ host: '127.0.0.1', port });
  return r;
}

async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
}

const tests = [
  test('G90: one connection through a 15 s over, and the over ends with T 0', async () => {
    const { server, conns, port } = await fakeRigctld();
    const r = controller(RIG_MODELS.G90, port);
    try {
      await sleep(1500);
      assert.ok(conns.length === 1 && conns[0].some((c) => c === 'f'), 'polled while receiving: ' + JSON.stringify(conns));
      r.setTransmit(true);
      await sleep(15000);
      r.setTransmit(false);
      await sleep(1500);
      assert.strictEqual(conns.length, 1, 'never reconnected: ' + conns.map((c) => c.join(',')).join(' || '));
      const c = conns[0];
      const t1 = c.findIndex((x) => /^T\s+1/.test(x)), t0 = c.findIndex((x, i) => i > t1 && /^T\s+0/.test(x));
      assert.ok(t1 >= 0 && t0 === t1 + 1, 'nothing between T 1 and T 0: ' + JSON.stringify(c.slice(t1, t1 + 4)));
      assert.ok(c.slice(t0 + 1).length > 0, 'polling resumed after the over');
    } finally { r.disconnect(); server.close(); }
  }),
  test('a rigctld model that polls in TX loses the link, and the reconnect unkeys before it polls', async () => {
    const { server, conns, port } = await fakeRigctld();
    const r = controller(GENERIC_CAPS.rigctld, port);
    try {
      await sleep(1500);
      r.setTransmit(true);
      await sleep(5000); // a poll in TX drops it; TcpTransport retries after 2 s
      assert.ok(conns.length >= 2, 'the fake dropped the link and it came back: ' + conns.length);
      const again = conns[1];
      const t0 = again.findIndex((x) => /^T\s+0/.test(x));
      const firstPoll = again.findIndex((x) => x === 'f' || x === 'm' || x === 't');
      assert.ok(t0 >= 0 && (firstPoll < 0 || t0 < firstPoll), 'T 0 before any poll after the reconnect: ' + JSON.stringify(again));
    } finally { r.disconnect(); server.close(); }
  }),
];

Promise.all(tests).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
