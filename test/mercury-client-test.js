// Tests for lib/mercury-client.js — the Mercury TCP TNC client.
// Pure control-line parser cases + a real two-socket loopback against a fake
// Mercury (net.createServer), so the whole client is exercised without electron
// or a real modem. Run: node test/mercury-client-test.js
'use strict';

const assert = require('assert');
const net = require('net');
const { MercuryClient, parseControlLine } = require('../lib/mercury-client');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ---------- pure parser ----------
test('parses OK / WRONG acks', () => {
  assert.deepStrictEqual(parseControlLine('OK'), { type: 'ack', ok: true });
  assert.deepStrictEqual(parseControlLine('WRONG'), { type: 'ack', ok: false });
});

test('parses PTT ON/OFF', () => {
  assert.deepStrictEqual(parseControlLine('PTT ON'), { type: 'ptt', on: true });
  assert.deepStrictEqual(parseControlLine('PTT OFF'), { type: 'ptt', on: false });
});

test('parses CONNECTED with callsigns + bandwidth', () => {
  assert.deepStrictEqual(parseControlLine('CONNECTED VK2XYZ AAAA 2300'),
    { type: 'connected', source: 'VK2XYZ', dest: 'AAAA', bandwidth: 2300 });
});

test('CONNECTED preserves callsign case and slash/suffix', () => {
  const ev = parseControlLine('CONNECTED PJ4/K1ABC W9XYZ-1 500');
  assert.strictEqual(ev.source, 'PJ4/K1ABC');
  assert.strictEqual(ev.dest, 'W9XYZ-1');
  assert.strictEqual(ev.bandwidth, 500);
});

test('parses CQFRAME / BUFFER / SN / BITRATE / BUSY / DISCONNECTED / IAMALIVE', () => {
  assert.deepStrictEqual(parseControlLine('CQFRAME VK2XYZ 500'), { type: 'cqframe', source: 'VK2XYZ', bandwidth: 500 });
  assert.deepStrictEqual(parseControlLine('BUFFER 1234'), { type: 'buffer', bytes: 1234 });
  assert.deepStrictEqual(parseControlLine('SN 8.2'), { type: 'sn', value: 8.2 });
  assert.deepStrictEqual(parseControlLine('BITRATE (3) 980 BPS'), { type: 'bitrate', level: 3, bps: 980 });
  assert.deepStrictEqual(parseControlLine('BUSY ON'), { type: 'busy', on: true });
  assert.deepStrictEqual(parseControlLine('DISCONNECTED'), { type: 'disconnected' });
  assert.deepStrictEqual(parseControlLine('IAMALIVE'), { type: 'iamalive' });
});

test('unknown lines (e.g. VERSION reply) surface as other/text', () => {
  assert.deepStrictEqual(parseControlLine('Mercury v2.0'), { type: 'other', text: 'Mercury v2.0' });
});

test('blank / whitespace lines parse to null', () => {
  assert.strictEqual(parseControlLine(''), null);
  assert.strictEqual(parseControlLine('   \r\n'), null);
});

// ---------- loopback integration ----------
// A fake Mercury: two TCP servers (control + data). The control server records
// commands it receives and can push async status lines; the data server echoes.
function makeFakeMercury() {
  const state = { commands: [], ctrlConn: null, dataConn: null, dataRx: Buffer.alloc(0) };
  const ctrl = net.createServer((c) => {
    state.ctrlConn = c;
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.search(/[\r\n]/)) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line) state.commands.push(line);
      }
    });
    c.on('error', () => {});
  });
  const data = net.createServer((c) => {
    state.dataConn = c;
    c.on('data', (d) => { state.dataRx = Buffer.concat([state.dataRx, d]); });
    c.on('error', () => {});
  });
  return { ctrl, data, state };
}

function runLoopback(done) {
  const fake = makeFakeMercury();
  fake.ctrl.listen(0, '127.0.0.1', () => {
    const controlPort = fake.ctrl.address().port;
    // Put the data server on a separate ephemeral port and tell the client to
    // use it explicitly (so we don't depend on control+1 being free).
    fake.data.listen(0, '127.0.0.1', () => {
      const dataPort = fake.data.address().port;
      const client = new MercuryClient();
      const events = [];
      ['ptt', 'connected', 'disconnected', 'buffer', 'busy', 'cqframe', 'sn', 'bitrate', 'iamalive', 'ack', 'status', 'data']
        .forEach((name) => client.on(name, (e) => events.push({ name, e })));

      client.connect({ host: '127.0.0.1', controlPort, dataPort });

      // Wait for both sockets up, then drive a mini session.
      const waitConnected = setInterval(() => {
        if (client.connected && client.dataConnected) {
          clearInterval(waitConnected);
          client.myCall('K3SBP');
          client.arqConnect('K3SBP', 'W4MPT');
          client.sendData(Buffer.from('hello'));
          // Fake pushes async status back on the control socket.
          fake.state.ctrlConn.write('PTT ON\r');
          fake.state.ctrlConn.write('CONNECTED K3SBP W4MPT 2300\r');
          fake.state.ctrlConn.write('BUFFER 5\rSN 9.1\rPTT OFF\r'); // batched, split test
          setTimeout(finish, 200);
        }
      }, 20);

      function finish() {
        const types = events.map((x) => x.name);
        const problems = [];
        if (!fake.state.commands.includes('MYCALL K3SBP')) problems.push('server did not receive MYCALL K3SBP; got ' + JSON.stringify(fake.state.commands));
        if (!fake.state.commands.includes('CONNECT K3SBP W4MPT')) problems.push('server did not receive CONNECT; got ' + JSON.stringify(fake.state.commands));
        if (fake.state.dataRx.toString() !== 'hello') problems.push('data socket did not receive "hello"; got ' + JSON.stringify(fake.state.dataRx.toString()));
        if (!types.includes('connected')) problems.push('client did not emit connected');
        if (!client.arqConnected) problems.push('client.arqConnected should be true after CONNECTED');
        const pttEvents = events.filter((x) => x.name === 'ptt').map((x) => x.e.on);
        if (pttEvents.length !== 2 || pttEvents[0] !== true || pttEvents[1] !== false) problems.push('expected PTT true then false; got ' + JSON.stringify(pttEvents));
        if (!events.some((x) => x.name === 'buffer' && x.e.bytes === 5)) problems.push('expected buffer=5 (CR-batched line split)');
        if (!events.some((x) => x.name === 'sn' && x.e.value === 9.1)) problems.push('expected sn=9.1');

        client.disconnect();
        fake.ctrl.close();
        fake.data.close();
        done(problems);
      }
    });
  });
}

// Run the async loopback, then print the summary.
runLoopback((problems) => {
  test('loopback: commands sent, data delivered, async status parsed', () => {
    assert.strictEqual(problems.length, 0, problems.join('\n       '));
  });
  console.log(`\nMercury client: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});

// Safety timeout so a hang fails loudly instead of stalling CI.
setTimeout(() => { console.log('  FAIL loopback timed out'); process.exit(1); }, 8000).unref();
