// What Dire Wolf HEARD, frame by frame, over its AGW port's monitor mode
// (lib/direwolf-agw-monitor.js). #128: Pat connected to the gateway, so
// frames were decoded, yet not one Dire Wolf receive line reached the log on
// Windows — "decoded nothing" could not be told from "printed nothing", and
// LOGDIR would not have helped (it logs APRS UI frames only). Fake AGW server
// on a real socket; frame encoding per direwolf server.c.
// Run: node test/direwolf-agw-monitor-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const net = require('net');
const path = require('path');
const A = require('../lib/direwolf-agw-monitor');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

// Dire Wolf's monitor text for a received frame (server.c server_send_monitored).
function mon(kind, head, info) {
  const text = head + '\r' + (info != null ? info + '\r' : '') + '\0';
  return A.encodeAgwFrame({ datakind: kind, callFrom: head.match(/Fm (\S+)/)[1], callTo: head.match(/To (\S+)/)[1], pid: 0xF0, data: Buffer.from(text, 'latin1') });
}

(async () => {
  console.log('direwolf-agw-monitor');

  await test('header: 36 bytes, datakind at 4, calls at 8/18, data_len little-endian at 28', () => {
    const f = A.encodeAgwFrame({ datakind: 'm' });
    assert.strictEqual(f.length, 36);
    assert.strictEqual(f[4], 'm'.charCodeAt(0));
    assert.strictEqual(f.readUInt32LE(28), 0);
    const g = A.encodeAgwFrame({ port: 1, datakind: 'S', pid: 0xF0, callFrom: 'W5AUY-10', callTo: 'N5XHI', data: Buffer.from('abc') });
    assert.strictEqual(g[0], 1);
    assert.strictEqual(g[6], 0xF0);
    assert.strictEqual(g.subarray(8, 16).toString('latin1'), 'W5AUY-10');
    assert.strictEqual(g[16], 0, 'NUL padded');
    assert.strictEqual(g.subarray(18, 23).toString('latin1'), 'N5XHI');
    assert.deepStrictEqual([...g.subarray(28, 32)], [3, 0, 0, 0], 'little endian');
    assert.strictEqual(g.subarray(36).toString(), 'abc');
    assert.throws(() => A.encodeAgwFrame({ datakind: 'mm' }), /one character/);
  });

  await test('parser: frames split across chunks and glued together come out whole, in order', () => {
    const p = new A.AgwFrameParser();
    const f1 = mon('S', ' 1:Fm W5AUY-10 To N5XHI <UA pid=F0 Len=0 F=1 >[18:07:23]');
    const f2 = mon('I', ' 1:Fm W5AUY-10 To N5XHI <I cmd, n(s)=0, n(r)=1, p=0, pid=0xf0>[18:07:25]', '[WL2K-5.0-B2FWIHJM$]');
    const both = Buffer.concat([f1, f2]);
    const out = [];
    for (let i = 0; i < both.length; i += 7) out.push(...p.push(both.subarray(i, Math.min(both.length, i + 7))));
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].datakind, 'S');
    assert.strictEqual(out[0].callFrom, 'W5AUY-10');
    assert.strictEqual(out[0].callTo, 'N5XHI');
    assert.strictEqual(out[0].pid, 0xF0);
    assert.strictEqual(out[1].datakind, 'I');
    assert.ok(out[1].data.toString('latin1').includes('[WL2K-5.0-B2FWIHJM$]'));
    assert.deepStrictEqual(new A.AgwFrameParser().push(both.subarray(0, 10)), [], 'a partial header waits');
    // junk with an impossible length is dropped rather than waited on forever
    const junk = Buffer.alloc(36); junk.writeUInt32LE(0xFFFFFFFF, 28);
    assert.deepStrictEqual(new A.AgwFrameParser().push(junk), []);
  });

  await test('describe: Dire Wolf\'s own header text, printable info quoted, binary info as a byte count, own UI as tx; other kinds null', () => {
    const ua = mon('S', ' 1:Fm W5AUY-10 To N5XHI <UA pid=F0 Len=0 F=1 >[18:07:23]');
    assert.strictEqual(A.describeMonitorFrame(new A.AgwFrameParser().push(ua)[0]), 'rx 1:Fm W5AUY-10 To N5XHI <UA pid=F0 Len=0 F=1 >[18:07:23]');
    const i = mon('I', ' 1:Fm W5AUY-10 To N5XHI <I cmd, n(s)=0, n(r)=1, p=0, pid=0xf0>[18:07:25]', '[WL2K-5.0-B2FWIHJM$]');
    assert.strictEqual(A.describeMonitorFrame(new A.AgwFrameParser().push(i)[0]), 'rx 1:Fm W5AUY-10 To N5XHI <I cmd, n(s)=0, n(r)=1, p=0, pid=0xf0>[18:07:25] "[WL2K-5.0-B2FWIHJM$]"');
    const bin = mon('I', ' 1:Fm W5AUY-10 To N5XHI <I cmd, n(s)=2, n(r)=1, p=0, pid=0xf0>[18:07:40]', Buffer.from([0x01, 0x80, 0xff, 0x00, 0x7f]).toString('latin1'));
    assert.strictEqual(A.describeMonitorFrame(new A.AgwFrameParser().push(bin)[0]), 'rx 1:Fm W5AUY-10 To N5XHI <I cmd, n(s)=2, n(r)=1, p=0, pid=0xf0>[18:07:40] [5 bytes]');
    const long = mon('U', ' 1:Fm N5XHI To BEACON <UI pid=F0 Len=90 >[18:08:00]', 'x'.repeat(90));
    assert.ok(/"x{60}…"$/.test(A.describeMonitorFrame(new A.AgwFrameParser().push(long)[0])), 'long info is cut');
    const t = mon('T', ' 1:Fm N5XHI To BEACON <UI pid=F0 Len=4 >[18:08:01]', 'test');
    assert.strictEqual(A.describeMonitorFrame(new A.AgwFrameParser().push(t)[0]), 'tx 1:Fm N5XHI To BEACON <UI pid=F0 Len=4 >[18:08:01] "test"');
    const r = A.encodeAgwFrame({ datakind: 'R', data: Buffer.alloc(8) });
    assert.strictEqual(A.describeMonitorFrame(new A.AgwFrameParser().push(r)[0]), null);
    assert.strictEqual(A.isReceivedFrame({ datakind: 'S' }), true);
    assert.strictEqual(A.isReceivedFrame({ datakind: 'T' }), false, 'our own transmission is not something the radio heard');
    assert.strictEqual(A.isReceivedFrame(null), false);
  });

  await test('client: connects, sends the one-letter m toggle once, reports every monitor frame, says when the socket goes', async () => {
    const got = { cmds: [], frames: [], logs: [], closed: null };
    const server = net.createServer((sock) => {
      const p = new A.AgwFrameParser();
      sock.on('data', (c) => {
        for (const f of p.push(c)) {
          got.cmds.push(f.datakind);
          if (f.datakind === 'm') {
            sock.write(mon('S', ' 1:Fm W5AUY-10 To N5XHI <UA pid=F0 Len=0 F=1 >[18:07:23]'));
            // a frame in two pieces, then a reply to nothing we asked
            const i = mon('I', ' 1:Fm W5AUY-10 To N5XHI <I cmd, n(s)=0, n(r)=1, p=0, pid=0xf0>[18:07:25]', '[WL2K-5.0-B2FWIHJM$]');
            sock.write(i.subarray(0, 20));
            setTimeout(() => { sock.write(i.subarray(20)); sock.write(A.encodeAgwFrame({ datakind: 'R', data: Buffer.alloc(8) })); }, 30);
            setTimeout(() => sock.destroy(), 150);
          }
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const m = A.createAgwMonitor({
      port: server.address().port,
      onFrame: (f, text) => got.frames.push([f.datakind, text]),
      onLog: (l) => got.logs.push(l),
      onClose: (code) => { got.closed = code; },
    });
    for (let k = 0; k < 100 && got.closed === null; k++) await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(got.cmds, ['m'], 'm sent exactly once');
    assert.deepStrictEqual(got.frames.map((x) => x[0]), ['S', 'I']);
    assert.ok(/^rx 1:Fm W5AUY-10 To N5XHI <UA/.test(got.frames[0][1]));
    assert.ok(/"\[WL2K-5\.0-B2FWIHJM\$\]"$/.test(got.frames[1][1]));
    assert.ok(got.logs.some((l) => /listening to what Dire Wolf hears/.test(l)));
    assert.ok(got.closed, 'onClose ran');
    assert.strictEqual(m.connected, false);
    server.close();
  });

  await test('client: nothing listening is reported once through onClose, never thrown', async () => {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    let closes = 0, code = null;
    const m = A.createAgwMonitor({ port, onClose: (c) => { closes++; code = c; } });
    for (let k = 0; k < 100 && !closes; k++) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(closes, 1);
    assert.strictEqual(code, 'ECONNREFUSED');
    m.close();
    assert.strictEqual(closes, 1, 'close after close says nothing more');
  });

  await test('main.js: the monitor starts when Dire Wolf is ready, stops with it, and counts toward the "decoded nothing" verdict', () => {
    const main = readSrc(path.join(__dirname, '..', 'main.js'));
    assert.ok(/const DirewolfAgwMonitor = require\('\.\/lib\/direwolf-agw-monitor'\);/.test(main));
    const sd = main.slice(main.indexOf('async function spawnDirewolf('), main.indexOf('\nfunction killArdop'));
    assert.ok(/const ready = \(how\) => \{[^\n]*winlinkAgwMonitorStart\(\);/.test(sd), 'started from ready()');
    const kill = main.slice(main.indexOf('function killDirewolf()'), main.indexOf('async function spawnDirewolf('));
    assert.ok(/winlinkAgwMonitorStop\(\);/.test(kill), 'stopped with the process');
    // Loosened for #257: the verdict lives in lib/direwolf-process.js packetDecodedNothing.
    assert.ok(/mode === 'packet' && DirewolfProcess\.packetDecodedNothing\(\{ stdoutHeard: _direwolfHeard, monitorHeard: _direwolfMonitorHeard,/.test(main), 'both counts must be zero before "decoded nothing"');
    assert.strictEqual(require('../lib/direwolf-process').packetDecodedNothing({ stdoutHeard: 0, monitorHeard: 1 }), false, 'a frame on the monitor alone is enough');
    const start = main.slice(main.indexOf('function winlinkAgwMonitorStart('), main.indexOf('function winlinkAgwMonitorStop('));
    assert.ok(/DirewolfAgwMonitor\.createAgwMonitor\(\{/.test(start) && /port: _winlinkAgwPort\(\)/.test(start));
    assert.ok(/if \(DirewolfAgwMonitor\.isReceivedFrame\(f\)\) _direwolfMonitorHeard\+\+;/.test(start));
    assert.ok(/winlinkLog\(`direwolf heard: \$\{text\}`\)/.test(start), 'every frame is a [Winlink] direwolf heard: line');
    const stop = main.slice(main.indexOf('function winlinkAgwMonitorStop('), main.indexOf('function killDirewolf()'));
    assert.ok(/over its AGW monitor this session/.test(stop), 'the count is logged at the end of every session');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
