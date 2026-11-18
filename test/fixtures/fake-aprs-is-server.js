// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// A local stand-in for an APRS-IS server, for tests and for a scratch POTACAT
// pointed at it with POTACAT_APRS_IS_SERVER=127.0.0.1:<port> (dev builds only).
// Nothing here talks to the real APRS-IS.
//
// It answers a login the way aprsc does ("# logresp CALL verified, server X"
// or "unverified"), checks the passcode with lib/aprs-passcode.js, records
// every line a client sends, and passes each packet a verified client sends
// on to the read-only (pass -1) clients with ,qAC,<server> added, so a
// client's own beacon comes back over its feed. It sends "# keepalive" lines
// every keepaliveMs.
//
//   const srv = await startFakeAprsIs({ port: 0 });
//   srv.port; srv.logins; srv.received; srv.feed('W1AW>APRS:>hi'); await srv.close();
//
// Run alone: node test/fixtures/fake-aprs-is-server.js [port]

'use strict';

const net = require('net');
const { aprsPasscode } = require('../../lib/aprs-passcode');

function startFakeAprsIs({ port = 0, name = 'T2FAKE', keepaliveMs = 20000, log, refuseVerify = false } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const clients = new Set();
  const srv = {
    port: 0,
    logins: [],   // { call, verified, readOnly, vers, filter } (the passcode is never kept)
    received: [], // every non-login line from every client: { call, line }
    clients,
    feed(line) { for (const c of clients) if (c.readOnly) c.sock.write(line + '\r\n'); },
    close() {
      return new Promise((resolve) => {
        clearInterval(ka);
        for (const c of clients) { try { c.sock.destroy(); } catch {} }
        server.close(() => resolve());
      });
    },
    dropAll() { for (const c of clients) { try { c.sock.destroy(); } catch {} } },
  };
  const server = net.createServer((sock) => {
    const c = { sock, call: null, verified: false, readOnly: false, buf: '' };
    clients.add(c);
    sock.setEncoding('utf8');
    sock.write(`# aprsc 2.1.19-fake ${name}\r\n`);
    sock.on('data', (chunk) => {
      c.buf += chunk;
      let i;
      while ((i = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, i).replace(/\r$/, '');
        c.buf = c.buf.slice(i + 1);
        if (!line) continue;
        if (!c.call) {
          const m = /^user\s+(\S+)\s+pass\s+(-?\d+)(?:\s+vers\s+(\S+)\s+(\S+))?(?:\s+filter\s+(.*))?/i.exec(line);
          if (!m) { sock.write('# invalid login\r\n'); continue; }
          c.call = m[1].toUpperCase();
          const pass = Number(m[2]);
          c.readOnly = pass === -1;
          c.verified = !c.readOnly && !refuseVerify && pass === aprsPasscode(c.call);
          srv.logins.push({ call: c.call, verified: c.verified, readOnly: c.readOnly, vers: m[3] ? m[3] + ' ' + m[4] : '', filter: m[5] || '' });
          say(`login ${c.call} ${c.readOnly ? 'read-only' : c.verified ? 'verified' : 'unverified'} ${m[3] || ''} ${m[4] || ''}`);
          sock.write(`# logresp ${c.call} ${c.verified ? 'verified' : 'unverified'}, server ${name}\r\n`);
          continue;
        }
        srv.received.push({ call: c.call, line });
        say(`from ${c.call}: ${line}`);
        if (line[0] === '#' || !c.verified) continue;
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const head = line.slice(0, colon);
        const out = (/,qA.,/.test(head) ? head : head + ',qAC,' + name) + line.slice(colon);
        srv.feed(out);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => clients.delete(c));
  });
  const ka = setInterval(() => { for (const c of clients) { try { c.sock.write(`# keepalive ${name}\r\n`); } catch {} } }, keepaliveMs);
  if (ka.unref) ka.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { srv.port = server.address().port; resolve(srv); });
  });
}

module.exports = { startFakeAprsIs };

if (require.main === module) {
  startFakeAprsIs({ port: Number(process.argv[2]) || 14580, keepaliveMs: 20000, log: (s) => console.log(new Date().toISOString(), s) })
    .then((s) => console.log('fake APRS-IS on 127.0.0.1:' + s.port));
}
