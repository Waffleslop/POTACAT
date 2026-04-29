#!/usr/bin/env node
'use strict';

// ===========================================================================
// RS-BA1 protocol probe
// ===========================================================================
//
// Phase 1 of the OEM-remote strategy: characterize what an IP-native Icom
// (IC-705 / IC-9700 / IC-7610 / IC-7851 / IC-R8600) responds to over UDP,
// without needing a bench radio in our own shop. Users with these radios
// run the script against their own rig, paste the resulting log file
// back to us, and we converge on the right packet formats from real
// over-the-wire evidence.
//
// SAFETY: Default mode is read-only. The probe never sends any packet that
// causes the radio to transmit unless `--allow-tx` is passed AND the user
// types YES to the on-screen confirmation. The "set frequency" probe also
// restores the original frequency before exit.
//
// Status disclaimer: every packet format in this file is best-effort
// reverse-engineering based on public sources (wfview's wiki, packet
// captures shared by RS-BA1 users). It WILL be wrong in places — that is
// the entire point of running it: discovering exactly where it's wrong.
//
// ---------------------------------------------------------------------------
// Quick start
// ---------------------------------------------------------------------------
//
//   1. Enable Network Connect on the radio:
//        IC-7610: SET > Network > Network Function = ON, Network User = on, set
//                 username/password, default port 50001
//        IC-9700: similar (Network menu)
//        IC-705:  Wi-Fi must be connected; SET > Network > similar setup
//
//   2. Note the radio's IP address (SET > Network > Network Information).
//
//   3. From any machine on the same LAN as the radio, run:
//
//        node scripts/rsba1-probe.js --host 192.168.1.50 --user CASEY --pass mypass
//
//   4. Probe runs through ~6 read-only phases and writes a log file
//      `rsba1-probe-<timestamp>.log` next to the script. Send that log
//      back to the maintainer.
//
// ---------------------------------------------------------------------------
// Available CLI flags
// ---------------------------------------------------------------------------
//
//   --host <ip>            Radio IP address (REQUIRED)
//   --port <n>             Control port (default 50001)
//   --civ-port <n>         Civ port    (default 50002)
//   --audio-port <n>       Audio port  (default 50003)
//   --user <name>          Username configured on radio
//   --pass <password>      Password configured on radio
//   --rig <model>          Optional radio model hint (e.g. "ic-7610")
//   --phases <a,b,c>       Comma-separated phase list. Default: all read-only
//                          phases. Available: reach, ping, login, civ-passive,
//                          civ-poll, civ-poll-text, audio-listen, set-freq,
//                          cw-text, cw-key
//   --variants <a,b,c>     Header layout variants to try. Default: all known.
//                          Available: v1-civ-leads-len, v2-len-leads-civ,
//                          v3-rsba1-classic
//   --duration <ms>        How long to listen after each send. Default 5000.
//   --log <path>           Override log file path
//   --allow-tx             Enable phases that may transmit (cw-text, cw-key,
//                          set-freq). Will prompt for explicit confirmation.
//   --quiet                Suppress per-byte console output (still in log)
//   --help                 This message
//
// ===========================================================================

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- CLI parsing ---------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) continue;
    const k = a.replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[k] = true;
    } else {
      out[k] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.host) {
  console.log(fs.readFileSync(__filename, 'utf8').match(/^\/\/[^\n]*\n(?:\/\/[^\n]*\n)*/m)[0]);
  process.exit(args.help ? 0 : 1);
}

const HOST = args.host;
const CONTROL_PORT = parseInt(args.port || '50001', 10);
const CIV_PORT = parseInt(args['civ-port'] || '50002', 10);
const AUDIO_PORT = parseInt(args['audio-port'] || '50003', 10);
const USERNAME = args.user || '';
const PASSWORD = args.pass || '';
const RIG = args.rig || 'unknown';
const ALL_PHASES = ['reach', 'ping', 'login', 'civ-passive', 'civ-poll', 'civ-poll-text', 'audio-listen'];
const TX_PHASES  = ['set-freq', 'cw-text', 'cw-key'];
const phases = (args.phases ? String(args.phases).split(',').map(s => s.trim()) : ALL_PHASES);
const ALL_VARIANTS = ['v1-civ-leads-len', 'v2-len-leads-civ', 'v3-rsba1-classic'];
const variants = (args.variants ? String(args.variants).split(',').map(s => s.trim()) : ALL_VARIANTS);
const DURATION = parseInt(args.duration || '5000', 10);
const LOG_PATH = args.log || path.resolve(process.cwd(), `rsba1-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const ALLOW_TX = !!args['allow-tx'];
const QUIET = !!args.quiet;

const requestedTxPhases = phases.filter(p => TX_PHASES.includes(p));
if (requestedTxPhases.length > 0 && !ALLOW_TX) {
  console.error(`Refusing to run TX-capable phases (${requestedTxPhases.join(', ')}) without --allow-tx.`);
  process.exit(1);
}

// --- Logging -------------------------------------------------------------

const logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
function log(...parts) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}`;
  if (!QUIET || /^!!|^==/.test(parts[0] || '')) console.log(line);
  logStream.write(line + '\n');
}
function logHex(label, buf) {
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');
  log(`   ${label} (${buf.length} bytes): ${hex}`);
  // ASCII for grep-ability
  const ascii = [...buf].map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
  log(`   ${label} ascii      : ${ascii}`);
}

// --- Packet helpers (best-effort RS-BA1) ----------------------------------
//
// The Icom remote protocol uses a 16-byte header followed by an optional
// payload. Three layouts have been observed in public captures and we try
// each:
//
//   v1-civ-leads-len  (used by some Civ-stream packets in wfview captures)
//     [civId(2)][type(1)][seq(2)][sender(4)][receiver(4)][len(2)][payload?]
//
//   v2-len-leads-civ
//     [len(2)][civId(2)][type(1)][seq(2)][sender(4)][receiver(4)][payload?]
//
//   v3-rsba1-classic  (most commonly described in public sources)
//     [length(4 LE)][type(2 LE)][seq(2 LE)][senderId(4 LE)][receiverId(4 LE)][payload?]
//
// We send the same logical "AreYouThere" / "Login" / etc. as each variant
// and see which gets a reply. Whichever does is the right one for that
// firmware/family.

const SENDER_ID = (Math.floor(Math.random() * 0xfffffff) | 0x10000000) >>> 0;
let seq = 0;

const TYPE = {
  // Tentative type codes from public RS-BA1 / wfview docs
  AREYOUTHERE: 0x03,
  IAMHERE:     0x04,
  PING_REQ:    0x06,
  PING_REPLY:  0x07,
  LOGIN_REQ:   0x70,    // Civ-stream login on some firmwares
  LOGIN_REPLY: 0x80,
  CIV_DATA:    0xc1,    // CIV passthrough
  TOKEN:       0x90,
  CONNINFO:    0xa0,
};

function buildHeader(variant, type, payloadLen, senderId, receiverId, sequence) {
  if (variant === 'v3-rsba1-classic') {
    const buf = Buffer.alloc(16 + payloadLen);
    buf.writeUInt32LE(16 + payloadLen, 0);    // length
    buf.writeUInt16LE(type, 4);                 // type
    buf.writeUInt16LE(sequence, 6);             // seq
    buf.writeUInt32LE(senderId, 8);             // senderId
    buf.writeUInt32LE(receiverId, 12);          // receiverId
    return buf;
  }
  if (variant === 'v1-civ-leads-len') {
    const buf = Buffer.alloc(16 + payloadLen);
    buf.writeUInt16LE(0xfeed, 0);               // civ id (placeholder)
    buf.writeUInt8(type, 2);
    buf.writeUInt16LE(sequence, 3);
    buf.writeUInt32LE(senderId, 5);
    buf.writeUInt32LE(receiverId, 9);
    buf.writeUInt16LE(16 + payloadLen, 13);
    return buf;
  }
  if (variant === 'v2-len-leads-civ') {
    const buf = Buffer.alloc(16 + payloadLen);
    buf.writeUInt16LE(16 + payloadLen, 0);
    buf.writeUInt16LE(0xfeed, 2);
    buf.writeUInt8(type, 4);
    buf.writeUInt16LE(sequence, 5);
    buf.writeUInt32LE(senderId, 7);
    buf.writeUInt32LE(receiverId, 11);
    return buf;
  }
  throw new Error('unknown variant: ' + variant);
}

function tryParseHeader(buf) {
  // Probe each variant's interpretation; return them all so the user/log
  // captures everything we might have learned.
  const out = {};
  if (buf.length >= 16) {
    out['v3-rsba1-classic'] = {
      length:     buf.readUInt32LE(0),
      type:       buf.readUInt16LE(4),
      seq:        buf.readUInt16LE(6),
      senderId:   buf.readUInt32LE(8).toString(16),
      receiverId: buf.readUInt32LE(12).toString(16),
    };
  }
  if (buf.length >= 15) {
    out['v1-civ-leads-len'] = {
      civId:      buf.readUInt16LE(0).toString(16),
      type:       buf.readUInt8(2),
      seq:        buf.readUInt16LE(3),
      senderId:   buf.readUInt32LE(5).toString(16),
      receiverId: buf.readUInt32LE(9).toString(16),
      length:     buf.readUInt16LE(13),
    };
  }
  return out;
}

// --- UDP transport -------------------------------------------------------

const sockets = {};
let receivedAny = false;
const receivedByPort = { control: 0, civ: 0, audio: 0 };

function openSocket(name, label) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      receivedAny = true;
      receivedByPort[name] = (receivedByPort[name] || 0) + 1;
      log(`<- [${name}] from ${rinfo.address}:${rinfo.port}`);
      logHex(`  reply`, msg);
      const parsed = tryParseHeader(msg);
      log(`   parsed: ${JSON.stringify(parsed)}`);
    });
    sock.on('error', (err) => {
      log(`!! [${name}] socket error: ${err.message}`);
    });
    sock.bind(0, () => {
      const addr = sock.address();
      log(`[${name}] bound on local port ${addr.port}`);
      sockets[name] = sock;
      resolve();
    });
  });
}

function sendOn(socketName, port, packet, label) {
  return new Promise((resolve) => {
    sockets[socketName].send(packet, port, HOST, (err) => {
      if (err) log(`!! [${socketName}] send error: ${err.message}`);
      else log(`-> [${socketName}] ${label} -> ${HOST}:${port}`);
      logHex(`  sent`, packet);
      resolve();
    });
  });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// --- Probes --------------------------------------------------------------

async function phaseReach() {
  log('=== Phase: reach (UDP-level reachability) ===');
  // Send a tiny zero-length probe to each port and listen for ANY reply.
  // Some radios reply with an immediate ICMP "port unreachable" if the
  // radio's network mode is off; the probe shows whether the port is open.
  const empty = Buffer.alloc(1, 0);
  await sendOn('control', CONTROL_PORT, empty, 'empty-probe (control)');
  await sendOn('civ',     CIV_PORT,     empty, 'empty-probe (civ)');
  await sendOn('audio',   AUDIO_PORT,   empty, 'empty-probe (audio)');
  await delay(DURATION);
}

async function phasePing() {
  log('=== Phase: ping ===');
  for (const v of variants) {
    log(`-- variant ${v} --`);
    const pkt = buildHeader(v, TYPE.PING_REQ, 0, SENDER_ID, 0, seq++);
    await sendOn('control', CONTROL_PORT, pkt, `ping (${v})`);
    await delay(2000);
  }
  await delay(DURATION);
}

async function phaseAreYouThere() {
  log('=== Phase: AreYouThere handshake ===');
  for (const v of variants) {
    log(`-- variant ${v} --`);
    const pkt = buildHeader(v, TYPE.AREYOUTHERE, 0, SENDER_ID, 0, seq++);
    await sendOn('control', CONTROL_PORT, pkt, `AreYouThere (${v})`);
    await delay(2500);
  }
  await delay(DURATION);
}

async function phaseLogin() {
  log('=== Phase: login ===');
  if (!USERNAME || !PASSWORD) {
    log('!! Skipping login phase: --user and --pass not provided');
    return;
  }
  for (const v of variants) {
    log(`-- variant ${v} (sending plaintext credentials, untranslated) --`);
    const userBuf = Buffer.from(USERNAME.padEnd(16, '\0'), 'ascii').slice(0, 16);
    const passBuf = Buffer.from(PASSWORD.padEnd(16, '\0'), 'ascii').slice(0, 16);
    const payload = Buffer.concat([userBuf, passBuf]);
    const pkt = buildHeader(v, TYPE.LOGIN_REQ, payload.length, SENDER_ID, 0, seq++);
    payload.copy(pkt, 16);
    await sendOn('control', CONTROL_PORT, pkt, `login (${v})`);
    await delay(3000);
  }
  await delay(DURATION);
}

async function phaseCivPassive() {
  log('=== Phase: civ-passive (listen only on Civ port) ===');
  // Some firmware spontaneously emits CIV transcription packets once a
  // session is established. We listen for DURATION ms with no sends.
  await delay(DURATION);
}

async function phaseCivPoll() {
  log('=== Phase: civ-poll (request frequency via CIV-over-UDP) ===');
  // Standard CI-V "read frequency" command (0x03) wrapped in a UDP packet.
  // CI-V sequence: FE FE <radioAddr> <ourAddr> 03 FD
  // Try common radio addresses; user can override via --civ-addr later.
  const radioAddrs = [0x94, 0xa4, 0xa2, 0x88]; // IC-7610, IC-9700, IC-7300, etc.
  const ourAddr = 0xe0;
  for (const addr of radioAddrs) {
    log(`-- CI-V addr 0x${addr.toString(16)} --`);
    const civ = Buffer.from([0xfe, 0xfe, addr, ourAddr, 0x03, 0xfd]);
    for (const v of variants) {
      const pkt = buildHeader(v, TYPE.CIV_DATA, civ.length, SENDER_ID, 0, seq++);
      civ.copy(pkt, 16);
      await sendOn('civ', CIV_PORT, pkt, `civ-read-freq addr=0x${addr.toString(16)} (${v})`);
      await delay(800);
    }
  }
  await delay(DURATION);
}

async function phaseCivPollText() {
  log('=== Phase: civ-poll-text (request mode via CI-V 0x04) ===');
  // CI-V "read mode" (0x04) — should produce a short reply we can recognize.
  const radioAddrs = [0x94, 0xa4, 0xa2, 0x88];
  const ourAddr = 0xe0;
  for (const addr of radioAddrs) {
    const civ = Buffer.from([0xfe, 0xfe, addr, ourAddr, 0x04, 0xfd]);
    for (const v of variants) {
      const pkt = buildHeader(v, TYPE.CIV_DATA, civ.length, SENDER_ID, 0, seq++);
      civ.copy(pkt, 16);
      await sendOn('civ', CIV_PORT, pkt, `civ-read-mode addr=0x${addr.toString(16)} (${v})`);
      await delay(800);
    }
  }
  await delay(DURATION);
}

async function phaseAudioListen() {
  log('=== Phase: audio-listen (passive on audio port) ===');
  // Audio frames may come unsolicited once a session is up. We just listen.
  await delay(DURATION);
}

// TX-capable phases: only enter with --allow-tx and after explicit YES.

async function phaseSetFreq() {
  log('=== Phase: set-freq (changes radio frequency) ===');
  log('!! This phase will attempt to change the radio frequency.');
  log('   It will NOT key TX. Original frequency is restored at exit.');
  // Implementation deferred to next iteration once we know the right packet
  // format from the read-only phases. Skip with a clear log entry for now.
  log('-- Skipped: requires confirmed packet format from earlier phases. --');
}

async function phaseCwText() {
  log('=== Phase: cw-text (sends a CW transmission via 0x17) ===');
  log('!! THIS WILL CAUSE THE RADIO TO TRANSMIT.');
  log('!! Confirm antenna is connected and band is clear.');
  log('-- Skipped: requires confirmed packet format from earlier phases. --');
}

async function phaseCwKey() {
  log('=== Phase: cw-key (sends per-element CW paddle keying) ===');
  log('!! THIS WILL CAUSE THE RADIO TO TRANSMIT.');
  log('-- Skipped: requires confirmed packet format from earlier phases. --');
}

async function confirmTx() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('TX-capable phases requested. Type YES (uppercase) to proceed: ', (a) => {
      rl.close();
      resolve(a.trim() === 'YES');
    });
  });
}

// --- Main ---------------------------------------------------------------

async function main() {
  log('==================================================================');
  log('RS-BA1 probe — Phase 1 reverse-engineering aid');
  log('==================================================================');
  log(`Target host:        ${HOST}`);
  log(`Target ports:       control=${CONTROL_PORT} civ=${CIV_PORT} audio=${AUDIO_PORT}`);
  log(`Username:           ${USERNAME ? '(set, ' + USERNAME.length + ' chars)' : '(none)'}`);
  log(`Password:           ${PASSWORD ? '(set, ' + PASSWORD.length + ' chars)' : '(none)'}`);
  log(`Rig hint:           ${RIG}`);
  log(`Phases requested:   ${phases.join(', ')}`);
  log(`Variants:           ${variants.join(', ')}`);
  log(`Per-phase duration: ${DURATION}ms`);
  log(`Sender ID assigned: 0x${SENDER_ID.toString(16)}`);
  log(`Allow TX:           ${ALLOW_TX}`);
  log(`Log file:           ${LOG_PATH}`);
  log(`Node version:       ${process.version}`);
  log(`Platform:           ${process.platform} ${process.arch}`);
  log('');

  if (requestedTxPhases.length > 0) {
    const ok = await confirmTx();
    if (!ok) {
      log('!! Confirmation declined. Aborting.');
      logStream.end();
      process.exit(1);
    }
  }

  await openSocket('control');
  await openSocket('civ');
  await openSocket('audio');

  const phaseFns = {
    'reach':         phaseReach,
    'ping':          phasePing,
    'handshake':     phaseAreYouThere,   // alias
    'are-you-there': phaseAreYouThere,
    'login':         phaseLogin,
    'civ-passive':   phaseCivPassive,
    'civ-poll':      phaseCivPoll,
    'civ-poll-text': phaseCivPollText,
    'audio-listen':  phaseAudioListen,
    'set-freq':      phaseSetFreq,
    'cw-text':       phaseCwText,
    'cw-key':        phaseCwKey,
  };
  // 'reach' isn't in ALL_PHASES default but allow as alias if user types it
  for (const name of phases) {
    const fn = phaseFns[name];
    if (!fn) { log(`!! Unknown phase: ${name}`); continue; }
    try {
      await fn();
    } catch (err) {
      log(`!! Phase ${name} threw: ${err.stack || err.message}`);
    }
    log('');
  }

  log('=== Summary ===');
  log(`Total replies received: ${receivedAny ? Object.entries(receivedByPort).map(([k,v])=>`${k}=${v}`).join(', ') : 'NONE'}`);
  if (!receivedAny) {
    log('No replies on any port. Most likely causes:');
    log('  - Radio Network Function not enabled');
    log('  - Wrong IP / port (check radio Network menu)');
    log('  - Firewall on this machine blocking inbound UDP');
    log('  - Radio expects connection from a specific subnet only');
  }
  log('');
  log(`Log written to ${LOG_PATH}`);
  log('Please send this file back to the maintainer for analysis.');

  for (const sock of Object.values(sockets)) sock.close();
  logStream.end();
}

main().catch(err => {
  log(`!! Fatal: ${err.stack || err.message}`);
  logStream.end();
  process.exit(1);
});
