'use strict';
// A fake VARA TNC for tests (#287): speaks enough of VARA's TCP protocol for
// POTACAT's probe and for Pat's varahf / varafm transport (n8jja/Pat-Vara
// v1.2.0, vara/vara.go and transport.go):
//   - a command port and a data port at command + 1;
//   - commands end in a carriage return;
//   - every command is answered OK, VERSION with "VERSION <name>";
//   - CONNECT <mycall> <target> is answered with a refusal (DISCONNECTED) by
//     default, so a test can see the call was placed without a CMS behind it.
// It records every command it receives, in order.
const net = require('net');

function startFakeVaraTnc({ host = '127.0.0.1', port = 0, name = 'VARA HF v4.8.7 (fake)', onConnect = 'refuse' } = {}) {
  const commands = [];
  const sockets = new Set();
  let cmdSock = null;
  const send = (line) => { if (cmdSock && !cmdSock.destroyed) cmdSock.write(line + '\r'); };
  const cmdServer = net.createServer((sock) => {
    sockets.add(sock);
    cmdSock = sock;
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const parts = buf.split('\r');
      buf = parts.pop();
      for (const raw of parts) {
        const c = raw.trim();
        if (!c) continue;
        commands.push(c);
        if (/^VERSION$/i.test(c)) { send('VERSION ' + name); continue; }
        if (/^CONNECT\s+\S+\s+\S+/i.test(c)) {
          send('OK');
          if (onConnect === 'refuse') setTimeout(() => send('DISCONNECTED'), 50);
          continue;
        }
        if (/^(DISCONNECT|ABORT)$/i.test(c)) { send('OK'); setTimeout(() => send('DISCONNECTED'), 20); continue; }
        send('OK');
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { sockets.delete(sock); if (cmdSock === sock) cmdSock = null; });
  });
  const dataServer = net.createServer((sock) => { sockets.add(sock); sock.on('error', () => {}); sock.on('close', () => sockets.delete(sock)); });
  const listen = (srv, p) => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(p, host, () => resolve(srv.address().port)); });
  return (async () => {
    // The data port must be the command port + 1: find a free pair.
    for (let i = 0; i < 20; i++) {
      const cp = await listen(cmdServer, port || 0);
      try {
        await listen(dataServer, cp + 1);
        return {
          host, port: cp, commands,
          send,
          dataConnected: () => [...sockets].some((s) => s.localPort === cp + 1),
          close: () => new Promise((resolve) => {
            for (const s of sockets) { try { s.destroy(); } catch {} }
            cmdServer.close(() => dataServer.close(() => resolve()));
          }),
        };
      } catch (e) {
        await new Promise((r) => cmdServer.close(r));
        if (port) throw e;
      }
    }
    throw new Error('no free port pair for the fake VARA');
  })();
}

module.exports = { startFakeVaraTnc };
