'use strict';
// CI's jtcat-tests job runs without `npm install`, so `ws` is absent there and
// any test that loads lib/remote-server.js died on require('ws') before a single
// assertion ran (the 1.10.27 and 1.11.0 Test runs). Those tests use the
// server's methods, never a socket, so when `ws` is missing this stands in a
// minimal shape; with node_modules present the real package loads untouched.
const Module = require('module');
let present = true;
try { require.resolve('ws'); } catch { present = false; }
if (!present) {
  const stub = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, Server: class {}, WebSocketServer: class {} };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'ws') return stub;
    return origLoad.call(this, request, ...rest);
  };
}
