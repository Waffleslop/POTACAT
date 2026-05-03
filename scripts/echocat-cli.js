#!/usr/bin/env node
'use strict';
//
// scripts/echocat-cli.js — headless smoke client for the ECHOCAT v1
// protocol. Connects to a running POTACAT desktop, completes the
// handshake, and dumps a few server messages to stdout.
//
// Usage:
//   node scripts/echocat-cli.js wss://192.168.1.42:7300                 # no auth
//   node scripts/echocat-cli.js wss://192.168.1.42:7300 --token=XXX     # token mode
//   node scripts/echocat-cli.js wss://host:7300 --watch                 # stay connected, dump events
//   node scripts/echocat-cli.js wss://host:7300 --insecure              # skip TLS verification (LAN cert)
//
// Doubles as a Phase-0 acceptance check for lib/echocat-protocol.js:
// if this script connects, sees a server `hello`, sends a client
// `hello`, and gets `auth-mode` back, the protocol module is wired
// up correctly.
//

const protocol = require('../lib/echocat-protocol');

let WebSocket;
try {
  WebSocket = require('ws');
} catch (err) {
  console.error('[echocat-cli] `ws` module not installed. Run `npm install` in the POTACAT repo first.');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { url: null, token: null, watch: false, insecure: false, timeoutMs: 8000 };
  for (const a of argv) {
    if (a.startsWith('wss://') || a.startsWith('ws://')) args.url = a;
    else if (a.startsWith('--token=')) args.token = a.slice('--token='.length);
    else if (a === '--watch') args.watch = true;
    else if (a === '--insecure') args.insecure = true;
    else if (a.startsWith('--timeout=')) args.timeoutMs = parseInt(a.slice('--timeout='.length), 10) || args.timeoutMs;
    else if (a === '--help' || a === '-h') { args.help = true; }
  }
  return args;
}

function usage() {
  console.error(`echocat-cli — headless smoke client for ECHOCAT v${protocol.PROTOCOL_VERSION}

Usage:
  node scripts/echocat-cli.js <ws-url> [options]

Options:
  --token=XXX     auth token (when server requires one)
  --watch         stay connected and print incoming messages until Ctrl-C
  --insecure      skip TLS cert verification (for self-signed LAN certs)
  --timeout=MS    give up after this many ms when not in --watch (default 8000)
  --help, -h      this help

Examples:
  node scripts/echocat-cli.js wss://localhost:7300 --insecure
  node scripts/echocat-cli.js wss://192.168.1.42:7300 --token=secret --watch --insecure
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) { usage(); process.exit(args.url ? 0 : 1); }

  console.error(`[echocat-cli] connecting to ${args.url}${args.insecure ? ' (insecure)' : ''}`);

  const ws = new WebSocket(args.url, {
    rejectUnauthorized: !args.insecure,
  });

  let serverHelloSeen = false;
  let authModeSeen = false;
  let authOk = false;

  const timeout = setTimeout(() => {
    if (args.watch) return;
    console.error('[echocat-cli] timed out waiting for server messages');
    process.exit(2);
  }, args.timeoutMs);

  ws.on('open', () => {
    console.error('[echocat-cli] WS open — sending client hello');
    const hello = protocol.buildClientHello({
      clientVersion: 'echocat-cli/0.1',
      clientPlatform: 'node',
    });
    ws.send(JSON.stringify(hello));
  });

  ws.on('message', (raw) => {
    const text = raw.toString('utf8');
    const r = protocol.parse(text, protocol.Dir.S2C);
    if (!r.ok) {
      console.error(`[echocat-cli] received unrecognized frame: ${r.error} — raw: ${text.slice(0, 120)}`);
      return;
    }
    const msg = r.msg;
    switch (msg.type) {
      case 'hello':
        serverHelloSeen = true;
        console.error(`[echocat-cli] server hello: protocol=${msg.protocolVersion} version=${msg.serverVersion || '(unknown)'} caps=${(msg.capabilities || []).join(',')}`);
        break;
      case 'auth-mode':
        authModeSeen = true;
        console.error(`[echocat-cli] auth-mode: ${msg.mode}`);
        if (msg.mode === 'none') {
          // Server auto-authenticates; nothing to send.
        } else if (msg.mode === 'token') {
          if (!args.token) {
            console.error('[echocat-cli] server requires a token; pass --token=XXX');
            ws.close();
            process.exit(3);
            return;
          }
          ws.send(JSON.stringify({ type: 'auth', token: args.token }));
        } else if (msg.mode === 'club') {
          console.error('[echocat-cli] club-mode auth requires callsign + password — not supported by this script');
          ws.close();
          process.exit(3);
        }
        break;
      case 'auth-ok':
        authOk = true;
        console.error('[echocat-cli] authenticated');
        if (!args.watch) {
          // We've proven the handshake works. Stop here unless watching.
          clearTimeout(timeout);
          setTimeout(() => { ws.close(); }, 250);
        }
        break;
      case 'auth-fail':
        console.error(`[echocat-cli] auth failed: ${msg.reason}`);
        ws.close();
        process.exit(4);
        break;
      case 'spots':
        console.error(`[echocat-cli] spots: ${msg.data.length} entries`);
        if (args.watch) {
          for (const s of msg.data.slice(0, 5)) {
            console.log(JSON.stringify(s));
          }
        }
        break;
      default:
        if (args.watch) {
          // Dump everything else as a single line so it's easy to grep.
          console.log(JSON.stringify(msg));
        }
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(timeout);
    const reasonText = reason && reason.toString ? reason.toString() : '';
    console.error(`[echocat-cli] WS closed (${code})${reasonText ? ': ' + reasonText : ''}`);
    if (!serverHelloSeen) {
      console.error('[echocat-cli] FAIL — server never sent a hello (is the desktop on protocol v1+?)');
      process.exit(5);
    }
    if (!authModeSeen) {
      console.error('[echocat-cli] FAIL — server never sent auth-mode (is the server actually ECHOCAT?)');
      process.exit(6);
    }
    if (!authOk) {
      console.error('[echocat-cli] FAIL — never got auth-ok');
      process.exit(7);
    }
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error(`[echocat-cli] WS error: ${err.message}`);
  });
}

main();
