#!/usr/bin/env node
'use strict';
// Yaesu SCU-LAN10 (experimental): the wire protocol against the spec's own
// reference values, and the transport against a fake unit built from the
// spec's phases on real UDP sockets (localhost). Nobody here owns a unit, so
// this file is the whole of what is verified before owners test it.
// Run: node test/sculan10-test.js
const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const P = require('../lib/sculan10-protocol');
const { Sculan10Transport } = require('../lib/sculan10-transport');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 3000, step = 10) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(step); }
  return pred();
}

// ---- protocol ---------------------------------------------------------------

test('gTable matches the spec: first 16 values and the last row of 256', () => {
  assert.strictEqual(P.GTABLE.subarray(0, 16).toString('hex'), '0605040b0a09080f0e0d0c1312111017');
  assert.strictEqual(P.GTABLE.subarray(16, 32).toString('hex'), '161514' + '1b1a19181f1e1d1c23222120' + '27');
  assert.strictEqual(P.GTABLE.subarray(240, 256).toString('hex'), 'f6f5f4fbfaf9f8fffefdfc0302010007');
  assert.strictEqual(P.GTABLE[256], P.GTABLE[0], 'repeats every 256');
});

test('the five init packets parse as CTRL keepalives seq 01-05, and the builder reproduces them byte for byte', () => {
  P.INIT_PACKETS.forEach((buf, i) => {
    const p = P.parsePacket(buf);
    assert.ok(p, 'parses');
    assert.strictEqual(p.seq, i + 1);
    assert.strictEqual(p.channel, P.CHANNEL.CTRL);
    assert.strictEqual(p.msgType, P.MSG.KEEPALIVE);
    const again = P.buildPacket({ seq: p.seq, channel: p.channel, msgType: p.msgType, body: p.body, key: p.key });
    assert.ok(again.equals(buf), `packet ${i + 1}`);
  });
});

test('encrypt/decrypt round trip, and the header fields follow the spec formulas', () => {
  const body = Buffer.from('FA014074000;', 'ascii');
  const pkt = P.buildPacket({ seq: 0x42, channel: P.CHANNEL.CAT, msgType: P.MSG.DATA, body, key: 0x9C });
  assert.strictEqual(pkt.readUInt16LE(2), body.length + 10, 'length = body + 10');
  const h = pkt.subarray(6, 14);
  assert.strictEqual(h[0], 0x42);
  assert.strictEqual(h[1], 0x9C ^ 0x42 ^ 0xFC);
  assert.strictEqual(h[2], 0x9C ^ 0xFD);
  assert.strictEqual(h[3], 0x9C ^ 0x03);
  assert.strictEqual(h[4], 0x9C ^ 0x07);
  assert.strictEqual(h[5], 0x9C);
  assert.strictEqual(h[6], 0x9C ^ body.length);
  assert.strictEqual(h[7], 0x9C ^ 0x07);
  assert.ok(!pkt.subarray(14).equals(body), 'the body is not plain on the wire');
  const p = P.parsePacket(pkt);
  assert.strictEqual(p.body.toString('ascii'), 'FA014074000;');
  assert.strictEqual(p.channelName, 'cat');
  assert.ok(P.xorBody(P.xorBody(body, 0x11), 0x11).equals(body));
  // A 4096-byte body (scope size) keeps its length through the high byte.
  const big = P.parsePacket(P.buildPacket({ seq: 1, channel: P.CHANNEL.SCOPE, msgType: P.MSG.DATA_IN, body: Buffer.alloc(4096, 7) }));
  assert.strictEqual(big.body.length, 4096);
  assert.ok(big.body.every((b) => b === 7));
});

test('a packet whose header does not check out is dropped, as the unit drops it', () => {
  const good = P.buildPacket({ seq: 3, channel: P.CHANNEL.CTRL, msgType: P.MSG.KEEPALIVE, body: P.KEEPALIVE_BODY, key: 0x55 });
  for (const [i, why] of [[7, 'verify byte b1'], [9, 'constant b3'], [12, 'length b6']]) {
    const bad = Buffer.from(good); bad[i] ^= 0x01;
    assert.strictEqual(P.parsePacket(bad), null, why);
  }
  assert.strictEqual(P.parsePacket(Buffer.from('5a5a', 'hex')), null);
  assert.strictEqual(P.parsePacket(good.subarray(0, good.length - 1)), null, 'truncated');
});

test('login body: 01 00, then user and password, each 33 bytes NUL-padded, ASCII, at most 32 characters', () => {
  const b = P.buildAuthBody('defaultuser', 'x'.repeat(40));
  assert.strictEqual(b.length, 68);
  assert.strictEqual(b[0], 0x01); assert.strictEqual(b[1], 0x00);
  assert.strictEqual(b.subarray(2, 13).toString('ascii'), 'defaultuser');
  assert.ok(b.subarray(13, 35).every((x) => x === 0));
  assert.strictEqual(b.subarray(35, 67).toString('ascii'), 'x'.repeat(32));
  assert.strictEqual(b[67], 0, 'the 33rd byte stays NUL');
  const pkt = P.parsePacket(P.buildAuthPacket('u', 'p'));
  assert.strictEqual(pkt.key, 0x3A); assert.strictEqual(pkt.seq, 0x06); assert.strictEqual(pkt.msgType, P.MSG.AUTH);
});

test('setup steps: continuation on CTRL with channel CAT, then init/setup pairs, each setup naming the NEXT channel', () => {
  const st = P.setupSteps(0x22);
  assert.deepStrictEqual(st.map((x) => `${x.name}:${x.port}:${P.CHANNEL_NAME[x.channel]}`), [
    'continuation:ctrl:cat', 'cat-init:cat:cat', 'cat-setup:ctrl:audio', 'audio-init:audio:audio', 'audio-setup:ctrl:scope', 'scope-init:scope:scope',
  ]);
  assert.strictEqual(st[0].body.toString('hex'), '22000000' + '51c3009600' + '00');
  assert.strictEqual(st[2].body.toString('hex'), '2200000052c3');
  assert.strictEqual(st[4].body.toString('hex'), '2200000053c3');
  assert.strictEqual(st[1].body.toString('hex'), '22000000');
});

test('CAT framing: sid + cmd_seq out, resp_seq + text back; a codec write splits into single commands', () => {
  assert.strictEqual(P.catCommandBody(0x24, 7, 'FA;').toString('hex'), '24000000' + '07000000' + Buffer.from('FA;').toString('hex'));
  const r = P.parseCatResponse(Buffer.concat([Buffer.from([9, 0, 0, 0]), Buffer.from('FA007007000;')]));
  assert.deepStrictEqual(r, { respSeq: 9, text: 'FA007007000;' });
  assert.deepStrictEqual(P.splitCatCommands('FA;MD0;TX1;'), ['FA;', 'MD0;', 'TX1;']);
  assert.deepStrictEqual(P.splitCatCommands('FA014074000;'), ['FA014074000;']);
});

function audioBody(seq, left, right = 0) {
  const b = Buffer.alloc(24 + 640);
  b[0] = seq; b[1] = 0x00; b[2] = 0x01; b[3] = 0x02;
  b.writeUInt32LE(16000, 4);
  b.writeUInt16LE(2000, 16); b.writeUInt16LE(1000, 18); b.writeUInt16LE(0x6464, 20); b.writeUInt16LE(640, 22);
  for (let i = 0; i < 160; i++) { b.writeInt16LE(left, 24 + i * 4); b.writeInt16LE(right, 26 + i * 4); }
  return b;
}

test('RX audio: 24-byte inner header, 160 stereo frames at 16 kHz, channel 0 is the speaker', () => {
  const a = P.parseRxAudio(audioBody(5, 16384, -32768));
  assert.strictEqual(a.sampleRate, 16000);
  assert.strictEqual(a.pcm.length, 160);
  assert.strictEqual(a.frameSeq, 5);
  assert.ok(a.pcm.every((x) => x === 0.5), 'channel 0 only, scaled to [-1, 1]');
});

// ---- the spec's wire format, written again here from SPEC.md -------------
// Independent of lib/sculan10-protocol.js on purpose (the review: a fake unit
// built from the module's own code would pass a misreading on both sides).
// Transcribed from the spec's "Reference Code" (build_gtable, build_header,
// frame_packet, decrypt_body) and checked against its literal init packets.
const SPEC = {
  CTRL: 0xFC, CAT: 0xFD, AUDIO: 0xFE, SCOPE: 0xFA,
  SETUP: 0x01, AUTH: 0x03, KEEPALIVE: 0x05, PORT_INIT: 0x06, DATA: 0x07,
  SETUP_ACK: 0x81, AUTH_RESP: 0x83, KEEPALIVE_ACK: 0x85, PORT_INIT_ACK: 0x86, DATA_IN: 0x87,
};
const SPEC_NAME = { 0xFC: 'ctrl', 0xFD: 'cat', 0xFE: 'audio', 0xFA: 'scope' };
const SPEC_GTABLE = (() => { const o = [0, 0xFF, 0xFE, 5]; const t = []; for (let i = 0; i < 8192; i++) t.push((4 * Math.floor(i / 4) + 6 + o[i % 4]) & 0xFF); return t; })();
function specBuild(seq, channel, msgType, plaintext, key = Math.floor(Math.random() * 256)) {
  const n = plaintext.length;
  const header = [seq, key ^ seq ^ 0xFC, key ^ channel, key ^ 0x03, key ^ msgType, key, key ^ (n & 0xFF), key ^ (0x07 ^ ((n >> 8) & 0xFF))];
  const enc = Array.from(plaintext, (b, i) => b ^ key ^ SPEC_GTABLE[i]);
  const payload = [...header, ...enc];
  const length = payload.length + 2;
  return Buffer.from([0x5A, 0x5A, length & 0xFF, length >> 8, 0x00, 0x01, ...payload]);
}
function specParse(buf) {
  if (buf.length < 14 || buf[0] !== 0x5A || buf[1] !== 0x5A) return null;
  const h = buf.subarray(6, 14);
  const key = h[5];
  const n = (h[6] ^ key) | (((h[7] ^ key) ^ 0x07) << 8);
  const body = Buffer.from(Array.from(buf.subarray(14, 14 + n), (b, i) => b ^ key ^ SPEC_GTABLE[i]));
  return { seq: h[0], key, channel: h[2] ^ key, msgType: h[4] ^ key, body };
}

test('the independent spec encoder reproduces the five literal init packets of the spec', () => {
  const literal = ['5a5a0e00000101a0a15e585d595a5b585956', '5a5a0e000001024042bdbbbebab9b8bbbab5', '5a5a0e00000103e0e31c1a1f1b18191a1b14',
    '5a5a0e0000010480847b7d787c7f7e7d7c73', '5a5a0e000001052025dadcd9dddedfdcddd2'];
  for (const hex of literal) {
    const p = specParse(Buffer.from(hex, 'hex'));
    assert.strictEqual(specBuild(p.seq, p.channel, p.msgType, p.body, p.key).toString('hex'), hex);
    assert.strictEqual(p.channel, SPEC.CTRL);
    assert.strictEqual(p.msgType, SPEC.KEEPALIVE);
  }
  // and the module agrees with it, byte for byte, on a CAT packet and a login
  const cat = Buffer.from('FA;');
  assert.ok(P.buildPacket({ seq: 9, channel: P.CHANNEL.CAT, msgType: P.MSG.DATA, body: cat, key: 0x41 }).equals(specBuild(9, SPEC.CAT, SPEC.DATA, cat, 0x41)));
  const auth = specParse(P.buildAuthPacket('defaultuser', 'defaultuser'));
  assert.strictEqual(auth.key, 0x3A); assert.strictEqual(auth.seq, 6); assert.strictEqual(auth.msgType, SPEC.AUTH);
  assert.strictEqual(auth.body.length, 68);
  assert.strictEqual(auth.body.subarray(2, 13).toString('ascii'), 'defaultuser');
});

// ---- a fake SCU-LAN10, from the spec's phases -------------------------------
// It speaks through specBuild / specParse above, never the module's codec.

async function bindConsecutive() {
  for (let tries = 0; tries < 40; tries++) {
    const base = 40000 + Math.floor(Math.random() * 20000);
    const socks = [];
    try {
      for (let i = 0; i < 4; i++) {
        const s = dgram.createSocket('udp4');
        await new Promise((res, rej) => { s.once('error', rej); s.bind(base + i, '127.0.0.1', () => { s.removeListener('error', rej); res(); }); });
        socks.push(s);
      }
      return { base, socks };
    } catch { for (const s of socks) { try { s.close(); } catch {} } }
  }
  throw new Error('no 4 consecutive free UDP ports');
}

async function fakeUnit({ user = 'defaultuser', pass = 'defaultuser', sid = 0x22, catDoubleReply = true, setupAcks = true, dropEachSession = false } = {}) {
  const { base, socks } = await bindConsecutive();
  const [ctrl, cat, audio, scope] = socks;
  const u = { base, ctrl, cat, audio, scope, sid, silent: false, events: [], catSeen: [], keepalives: { ctrl: 0, cat: 0, audio: 0, scope: 0 }, logins: 0, audioPeer: null, respSeq: 0, lastCmdSeq: null, txAudio: [],
    radio: { mode: '2', fa: '014074000', ml: { 1: { on: '001', level: '005' }, 2: { on: '001', level: '002' }, 3: { on: '000', level: '010' } } } };
  const seq = { ctrl: 0, cat: 0, audio: 0, scope: 0 };
  const reply = (name, sock, rinfo, channel, msgType, body) => {
    seq[name] = (seq[name] + 1) & 0xFF;
    sock.send(specBuild(seq[name], channel, msgType, body), rinfo.port, rinfo.address);
  };
  const on = (name, sock, handler) => sock.on('message', (msg, rinfo) => {
    const p = specParse(msg);
    if (!p) { u.events.push(`${name}:bad`); return; }
    // A new login always gets through: the unit hands itself to whoever logs in.
    if (p.msgType === SPEC.AUTH) u.silent = false;
    if (p.msgType === P.MSG.KEEPALIVE) {
      u.keepalives[name]++;
      if (u.silent) return;
      if (name === 'ctrl' && p.seq > 5) reply(name, sock, rinfo, P.CHANNEL.CTRL, P.MSG.KEEPALIVE_ACK, Buffer.from([0]));
      return;
    }
    if (u.silent) return;
    handler(p, rinfo);
  });
  on('ctrl', ctrl, (p, rinfo) => {
    if (p.msgType === P.MSG.AUTH) {
      u.logins++;
      const b = p.body;
      const field = (o) => b.subarray(o, o + 33).toString('ascii').replace(/\0+$/, '');
      u.events.push('auth');
      if (p.key !== 0x3A || p.seq !== 6 || field(2) !== user || field(35) !== pass) return; // wrong login: silence
      u.sid = sid + u.logins - 1;
      reply('ctrl', ctrl, rinfo, P.CHANNEL.CTRL, P.MSG.AUTH_RESP, Buffer.from([u.sid, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x25, 0x01, 0x3F, 0x51]));
      return;
    }
    if (p.msgType === P.MSG.SETUP) {
      assert.strictEqual(p.body[0], u.sid, 'setup echoes the session id');
      u.events.push(`setup:${SPEC_NAME[p.channel]}:${p.body[4].toString(16)}`);
      if (setupAcks) reply('ctrl', ctrl, rinfo, P.CHANNEL.CTRL, P.MSG.SETUP_ACK, Buffer.alloc(4));
    }
  });
  const portInit = (name, sock, channel) => (p, rinfo) => {
    if (p.msgType !== P.MSG.PORT_INIT) return false;
    assert.strictEqual(p.body[0], u.sid, `${name} init echoes the session id`);
    u.events.push(`init:${name}`);
    if (setupAcks) reply(name, sock, rinfo, channel, P.MSG.PORT_INIT_ACK, Buffer.alloc(4));
    // A second program logging in elsewhere: this session goes quiet once set up.
    if (dropEachSession && name === 'scope') setTimeout(() => { u.silent = true; }, 50);
    return true;
  };
  const catInit = portInit('cat', cat, P.CHANNEL.CAT);
  on('cat', cat, (p, rinfo) => {
    if (catInit(p, rinfo)) return;
    if (p.msgType !== P.MSG.DATA) return;
    const cmdSeq = p.body[4];
    const text = p.body.subarray(8).toString('ascii');
    u.catSeen.push({ sid: p.body[0], cmdSeq, text, wireSeq: p.seq });
    if (cmdSeq === u.lastCmdSeq) return; // the radio dedupes on cmd_seq
    u.lastCmdSeq = cmdSeq;
    let answer = null;
    // A radio with a per-mode monitor (FT-710: ML0 on/off, ML1 level).
    const R = u.radio;
    let m;
    if (text === 'FA;') answer = `FA${R.fa};`;
    else if (text === 'ID;') answer = 'ID0670;';
    else if (text === 'MD0;') answer = `MD0${R.mode};`;
    else if ((m = /^MD0([0-9A-F]);$/.exec(text))) R.mode = m[1];
    else if ((m = /^FA(\d{9});$/.exec(text))) R.fa = m[1];
    else if (text === 'ML0;' || text === 'ML1;') answer = `${text.slice(0, 3)}${R.ml[R.mode][text[2] === '0' ? 'on' : 'level']};`;
    else if ((m = /^ML([01])(\d{3});$/.exec(text))) R.ml[R.mode][m[1] === '0' ? 'on' : 'level'] = m[2];
    if (!answer) return;
    u.respSeq = (u.respSeq + 1) & 0xFF;
    const body = Buffer.concat([Buffer.from([u.respSeq, 0, 0, 0]), Buffer.from(answer)]);
    reply('cat', cat, rinfo, P.CHANNEL.CAT, P.MSG.DATA_IN, body);
    if (catDoubleReply) reply('cat', cat, rinfo, P.CHANNEL.CAT, P.MSG.DATA_IN, body);
  });
  const audioInit = portInit('audio', audio, P.CHANNEL.AUDIO);
  on('audio', audio, (p, rinfo) => {
    if (audioInit(p, rinfo)) { u.audioPeer = rinfo; return; }
    if (p.msgType === P.MSG.DATA) u.txAudio.push(p.body);
  });
  const scopeInit = portInit('scope', scope, P.CHANNEL.SCOPE);
  on('scope', scope, (p, rinfo) => { if (scopeInit(p, rinfo)) u.scopePeer = rinfo; });
  // One scope frame (a 4096-byte body) to the client; dropFirst skips a
  // packet sequence number first, as a frame lost on the network would.
  u.sendScope = (body, { dropFirst = false } = {}) => {
    if (!u.scopePeer) return;
    if (dropFirst) seq.scope = (seq.scope + 1) & 0xFF;
    reply('scope', scope, u.scopePeer, P.CHANNEL.SCOPE, P.MSG.DATA_IN, body);
  };
  u.sendAudio = (frameSeq, left) => { if (u.audioPeer) reply('audio', audio, u.audioPeer, P.CHANNEL.AUDIO, P.MSG.DATA_IN, audioBody(frameSeq, left)); };
  u.sendCat = (text, respSeq) => {
    // unsolicited: to the CAT peer the client last used
    const last = u._catPeer; if (!last) return;
    reply('cat', cat, last, P.CHANNEL.CAT, P.MSG.DATA_IN, Buffer.concat([Buffer.from([respSeq, 0, 0, 0]), Buffer.from(text)]));
  };
  cat.on('message', (_m, rinfo) => { u._catPeer = rinfo; });
  u.close = () => { for (const s of socks) { try { s.close(); } catch {} } };
  return u;
}

const FAST = { loginTimeoutMs: 400, ackWaitMs: 150, stepGapMs: 5, keepaliveMs: 100, sessionLossMs: 600, reconnectMinMs: 100, reconnectMaxMs: 200 };

function client() {
  const t = new Sculan10Transport();
  const logs = [], errors = [], data = [], frames = [];
  let connects = 0, closes = 0;
  t.on('log', (m) => logs.push(m));
  t.on('error', (e) => { errors.push(e); logs.push(String(e.message)); });
  t.on('data', (d) => data.push(d.toString('latin1')));
  t.on('audio-frame', (f) => frames.push(f));
  t.on('connect', () => connects++);
  t.on('close', () => closes++);
  return { t, logs, errors, data, frames, get connects() { return connects; }, get closes() { return closes; } };
}

test('handshake against a fake unit: login, every setup step in order with the session id, keepalives on all four channels', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, username: 'defaultuser', password: 'defaultuser', ...FAST });
    assert.ok(await until(() => c.connects === 1), 'connected: ' + c.logs.join(' | '));
    assert.deepStrictEqual(u.events, ['auth', 'setup:cat:51', 'init:cat', 'setup:audio:52', 'init:audio', 'setup:scope:53', 'init:scope']);
    assert.strictEqual(c.t.sessionId, 0x22);
    assert.ok(await until(() => Object.values(u.keepalives).every((n) => n >= 8)), JSON.stringify(u.keepalives));
    assert.ok(u.keepalives.ctrl >= 5 + 3, 'the five init packets count as CTRL keepalives too');
    assert.ok(c.logs.some((l) => /phase 3: logged in after \d+ ms: session 0x22, capability bytes 0125013f51$/.test(l)), c.logs.join('\n'));
    assert.ok(c.logs.some((l) => /phase 7: session 0x22 up in \d+ ms/.test(l)));
    assert.strictEqual(c.errors.length, 0, c.errors.map((e) => e.message).join());
    assert.ok(!c.logs.some((l) => /keepalive miss/.test(l)), 'every CTRL keepalive acked');
  } finally { c.t.disconnect(); u.close(); }
});

test('CAT: each command twice with one cmd_seq; the doubled reply reaches the codec once; unsolicited RM passes through', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    c.t.write('FA;ID;');
    assert.ok(await until(() => c.data.includes('FA014074000;') && c.data.includes('ID0670;')), c.data.join());
    await sleep(80);
    const fa = u.catSeen.filter((x) => x.text === 'FA;');
    assert.strictEqual(fa.length, 2, 'sent twice');
    assert.strictEqual(fa[0].cmdSeq, fa[1].cmdSeq, 'same cmd_seq');
    assert.notStrictEqual(fa[0].wireSeq, fa[1].wireSeq, 'different wire sequence numbers');
    assert.ok(fa.every((x) => x.sid === 0x22), 'session id in every CAT packet');
    const id = u.catSeen.filter((x) => x.text === 'ID;');
    assert.notStrictEqual(id[0].cmdSeq, fa[0].cmdSeq, 'a new command, a new cmd_seq');
    assert.strictEqual(c.data.filter((d) => d === 'FA014074000;').length, 1, 'the duplicate reply was dropped');
    u.sendCat('RM1100;', 50); u.sendCat('RM1100;', 51);
    assert.ok(await until(() => c.data.filter((d) => d === 'RM1100;').length === 2), 'a repeated meter with a new seq is not a duplicate');
    assert.ok(c.logs.includes('[SCU-LAN10] CAT > FA;') && c.logs.includes('[SCU-LAN10] CAT < FA014074000;'), 'the first CAT exchanges are logged');
  } finally { c.t.disconnect(); u.close(); }
});

test('RX audio arrives as 16 kHz mono frames from channel 0, and a frame gap is counted', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1 && u.audioPeer));
    u.sendAudio(1, 3277); u.sendAudio(2, 3277); u.sendAudio(5, 3277);
    assert.ok(await until(() => c.frames.length === 3));
    assert.strictEqual(c.frames[0].sampleRate, 16000);
    assert.strictEqual(c.frames[0].pcm.length, 160);
    assert.ok(Math.abs(c.frames[0].pcm[0] - 0.1) < 0.001);
    c.t._logStats('test');
    assert.ok(c.logs.some((l) => /RX audio frames 3, lost 2/.test(l)), c.logs.join('\n'));
  } finally { c.t.disconnect(); u.close(); }
});

test('a wrong password gets no reply, so login times out with a message that says what to check', async () => {
  const u = await fakeUnit({ pass: 'right' });
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, username: 'defaultuser', password: 'wrong', ...FAST, reconnectMinMs: 5000, reconnectMaxMs: 30000 });
    assert.ok(await until(() => c.errors.length >= 1, 2000));
    const e = c.errors[0];
    assert.strictEqual(e.code, 'SCULAN10_LOGIN_TIMEOUT');
    assert.ok(e.message.includes(`no answer from the SCU-LAN10 at 127.0.0.1:${u.base}`), e.message);
    assert.ok(/check the address, port and user\/password/.test(e.message));
    assert.strictEqual(c.connects, 0);
    assert.ok(c.logs.some((l) => /reconnect #1 in 5 s/.test(l)), 'it tries again, backing off');
  } finally { c.t.disconnect(); u.close(); }
});

test('the password never reaches a log line, an error, or the target RigController reads', async () => {
  const secret = 'Zq7-s3cr3t-pw';
  const u = await fakeUnit({ pass: secret });
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, username: 'op1', password: secret, ...FAST });
    // wrong user on purpose first? no: the fake checks user too, so this login fails and times out
    assert.ok(await until(() => c.errors.length >= 1, 2000));
    c.t.disconnect();
    const u2 = await fakeUnit({ user: 'op1', pass: secret });
    const c2 = client();
    c2.t.connect({ host: '127.0.0.1', basePort: u2.base, username: 'op1', password: secret, ...FAST });
    assert.ok(await until(() => c2.connects === 1));
    c2.t.write('FA;');
    await sleep(100);
    c2.t._logStats('test');
    c2.t.disconnect();
    u2.close();
    const all = [...c.logs, ...c2.logs, ...c.errors.map((e) => e.message), JSON.stringify(c2.t._target)];
    assert.ok(all.length > 5);
    for (const line of all) assert.ok(!line.includes(secret), 'leaked: ' + line);
    assert.ok(!('password' in c2.t._target));
  } finally { c.t.disconnect(); u.close(); }
});

test('silence from the unit ends the session and the full handshake runs again by itself', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    u.silent = true;
    assert.ok(await until(() => c.errors.some((e) => e.code === 'SCULAN10_SESSION_LOST'), 3000), c.logs.join('\n'));
    assert.strictEqual(c.closes, 1);
    assert.ok(c.logs.some((l) => /keepalive miss #1/.test(l)), 'misses are logged');
    assert.ok(c.logs.some((l) => /stats, session end \(SCULAN10_SESSION_LOST\)/.test(l)));
    u.silent = false;
    assert.ok(await until(() => c.connects === 2, 3000), 'reconnected: ' + c.logs.join('\n'));
    assert.strictEqual(u.logins, 2, 'a second full login');
    assert.strictEqual(c.t.sessionId, 0x23, 'the new session id is used');
  } finally { c.t.disconnect(); u.close(); }
});

test('disconnect stops everything: no reconnect, no more packets', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    c.t.disconnect();
    await sleep(60); // a keepalive already on the wire may still land
    const n = u.keepalives.ctrl;
    await sleep(400);
    assert.strictEqual(u.keepalives.ctrl, n);
    assert.strictEqual(c.t.connected, false);
    assert.strictEqual(c.t.write('FA;'), false);
    assert.strictEqual(c.t.txReady, false, 'no TX audio while disconnected');
  } finally { u.close(); }
});

test('end to end: RigController and the Yaesu codec over the transport read the dial, and connect sends PTT off', async () => {
  const { RigController } = require('../lib/rig-controller');
  const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
  const { getModel } = require('../lib/rig-models');
  const u = await fakeUnit();
  const t = new Sculan10Transport();
  const model = { ...getModel('FTDX10') };
  model.tune = model.tune || {};
  const codec = new KenwoodCodec(model, (d) => t.write(d));
  const ctl = new RigController(model, t, codec);
  const freqs = [];
  ctl.on('frequency', (hz) => freqs.push(hz));
  ctl.on('log', () => {});
  t.on('log', () => {});
  t.on('error', () => {});
  try {
    t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => freqs.includes(14074000), 6000), 'the dial reached the controller: ' + JSON.stringify(u.catSeen.slice(0, 8).map((x) => x.text)));
    assert.ok(u.catSeen.some((x) => /^TX0;?$/.test(x.text)), 'connect safety: PTT off went to the radio');
    assert.ok(ctl.connected);
  } finally { ctl.disconnect(); u.close(); }
});

test('scope end to end: a spec-shaped frame through the SCOPE channel decodes to the line it was built from; rate and drops are in the stats', async () => {
  const Scope = require('../lib/sculan10-scope');
  const u = await fakeUnit();
  const c = client();
  const scopeFrames = [];
  c.t.on('scope-frame', (f) => scopeFrames.push(f));
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1 && u.scopePeer));
    const levels = new Uint8Array(850);
    for (let i = 0; i < 850; i++) levels[i] = 30 + (i % 7);
    levels[300] = 240; levels[301] = 250; levels[302] = 240;   // a signal
    const body = Scope.buildSpecFrame(levels);
    u.sendScope(body); u.sendScope(body); u.sendScope(body, { dropFirst: true });
    assert.ok(await until(() => scopeFrames.length === 3), 'frames arrived: ' + scopeFrames.length);
    assert.strictEqual(scopeFrames[0].body.length, 4096);
    const tracker = new Scope.MarkerTracker();
    const d = Scope.decodeScopeFrame(scopeFrames[0].body, tracker);
    assert.strictEqual(d.end, 1700);
    assert.deepStrictEqual(Array.from(d.levels), Array.from(levels), 'every bin survives the wire and the XOR');
    const f = Scope.toScopeFrame(d.levels, { seq: 1 });
    assert.strictEqual(f.wf1[301], 250, 'the signal is where it was');
    c.t._logStats('test');
    assert.ok(c.logs.some((l) => /scope frames 3( \([\d.]+\/s\))?, lost 1;/.test(l)), c.logs.filter((l) => /stats/.test(l)).join('\n'));
  } finally { c.t.disconnect(); u.close(); }
});

// ---- the independent review's findings (2026-11-05) -------------------------

// Fake sockets for the storm tests: every send fails, asynchronously, the way
// a dgram send to an unreachable or invalid address does.
function failingSockets() {
  const made = [];
  const createSocket = () => {
    const ee = new (require('events'))();
    ee.closed = false;
    ee.bind = () => {};
    ee.close = () => { ee.closed = true; };
    ee.send = (_buf, _port, _host, cb) => setImmediate(() => cb(Object.assign(new Error('send EACCES'), { code: 'EACCES' })));
    made.push(ee);
    return ee;
  };
  return { made, createSocket };
}

test('review 1 (critical): a send error fails its session ONCE: one retry pending, no storm, nothing left after disconnect', async () => {
  const f = failingSockets();
  const t = new Sculan10Transport({ createSocket: f.createSocket });
  let starts = 0, errors = 0;
  t.on('log', (m) => { if (/connecting to/.test(m)) starts++; });
  t.on('error', () => { errors++; });
  t.connect({ host: '10.1.2.3', basePort: 50000, reconnectMinMs: 200, reconnectMaxMs: 400, loginTimeoutMs: 1500 });
  await sleep(2000);
  // 0, 200, 600, 1000, 1400, 1800 ms: about six sessions in two seconds. The
  // old code had thousands (each of the six sends scheduled its own retry).
  assert.ok(starts >= 3 && starts <= 8, 'sessions in 2 s: ' + starts);
  assert.ok(errors <= starts, `one error per session (${errors} errors, ${starts} sessions)`);
  t.disconnect();
  const after = starts;
  await sleep(700);
  assert.strictEqual(starts, after, 'no session starts after disconnect');
  assert.ok(f.made.every((s) => s.closed), 'every socket closed');
});

test('review 1: a name that does not resolve is one error per session, from one lookup', async () => {
  let lookups = 0, sockets = 0;
  const t = new Sculan10Transport({
    lookup: (_h, cb) => { lookups++; setImmediate(() => cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))); },
    createSocket: () => { sockets++; throw new Error('no socket should be opened'); },
  });
  const errs = [];
  t.on('error', (e) => errs.push(e));
  t.on('log', () => {});
  t.connect({ host: 'no-such-unit.invalid', basePort: 50000, reconnectMinMs: 200, reconnectMaxMs: 400 });
  await sleep(1300);
  t.disconnect();
  assert.strictEqual(sockets, 0, 'no sockets for an address that does not resolve');
  assert.strictEqual(errs.length, lookups, 'one error per lookup');
  assert.ok(lookups >= 2 && lookups <= 6, 'lookups: ' + lookups);
  assert.strictEqual(errs[0].code, 'SCULAN10_DNS');
  assert.ok(/does not resolve to an IPv4 address/.test(errs[0].message));
});

test('review 1: an address or port that can never work is refused before any packet, said once, never retried', async () => {
  for (const [opts, code] of [
    [{ host: '::1' }, 'SCULAN10_BAD_ADDRESS'],
    [{ host: '192.168.49.1:50000' }, 'SCULAN10_BAD_ADDRESS'],
    [{ host: '255.255.255.255' }, 'SCULAN10_BAD_ADDRESS'],
    [{ host: '192.168.49.1', basePort: 65533 }, 'SCULAN10_BAD_PORT'],
    [{ host: '192.168.49.1', basePort: 70000 }, 'SCULAN10_BAD_PORT'],
  ]) {
    let sockets = 0;
    const t = new Sculan10Transport({ createSocket: () => { sockets++; throw new Error('none'); } });
    const errs = [];
    t.on('error', (e) => errs.push(e));
    t.on('log', () => {});
    t.connect({ basePort: 50000, reconnectMinMs: 50, ...opts });
    await sleep(150);
    assert.strictEqual(errs.length, 1, JSON.stringify(opts));
    assert.strictEqual(errs[0].code, code, JSON.stringify(opts));
    assert.strictEqual(sockets, 0);
    t.disconnect();
  }
});

test('review 4: a unit that answers the login but nothing else is not announced as connected', async () => {
  const u = await fakeUnit({ setupAcks: false });
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST, dataWaitMs: 200, reconnectMinMs: 5000, reconnectMaxMs: 5000 });
    assert.ok(await until(() => c.errors.some((e) => e.code === 'SCULAN10_NO_SETUP'), 3000), c.logs.join('\n'));
    assert.strictEqual(c.connects, 0, 'never "connected"');
    assert.strictEqual(c.closes, 0);
  } finally { c.t.disconnect(); u.close(); }
});

test('review 4: the retry backoff grows across short sessions and starts over only after a stable one', async () => {
  const u = await fakeUnit({ dropEachSession: true });
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST, inUseLimit: 99, stableMs: 60000 });
    assert.ok(await until(() => c.connects >= 3, 8000), 'reconnected: ' + c.logs.filter((l) => /reconnect #/.test(l)).join(' | '));
    assert.ok(c.logs.some((l) => /reconnect #2 /.test(l)), 'the second loss is retry #2, not #1 again: ' + c.logs.filter((l) => /reconnect #/.test(l)).join(' | '));
  } finally { c.t.disconnect(); u.close(); }
});

test('review 5: lost within a minute of logging in, three times running: another program has the unit, so POTACAT stops', async () => {
  const u = await fakeUnit({ dropEachSession: true });
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST, inUseLimit: 3 });
    assert.ok(await until(() => c.errors.some((e) => e.code === 'SCULAN10_IN_USE'), 10000), c.logs.join('\n'));
    const e = c.errors.find((x) => x.code === 'SCULAN10_IN_USE');
    assert.ok(/Another program \(PCC-LAN10, FT-Control or a second POTACAT\) is probably using it/.test(e.message));
    assert.ok(/POTACAT stopped trying/.test(e.message));
    const logins = u.logins;
    assert.strictEqual(logins, 3);
    await sleep(800);
    assert.strictEqual(u.logins, logins, 'no more logins: no tug-of-war');
  } finally { c.t.disconnect(); u.close(); }
});

test('review 6: an RX sample rate off the wire that no PCM stream has is not believed (16 kHz instead)', () => {
  // Bytes laid out by hand from the spec's RX audio table, rate field = 1.
  const body = Buffer.alloc(24 + 640);
  body[0] = 7; body[1] = 0x00; body[2] = 0x01; body[3] = 0x02;
  body.writeUInt32LE(1, 4);
  body.writeUInt16LE(640, 22);
  const a = P.parseRxAudio(body);
  assert.strictEqual(a.sampleRate, 16000);
  assert.strictEqual(a.rateTrusted, false);
  assert.strictEqual(a.pcm.length, 160);
  body.writeUInt32LE(48000, 4);
  assert.strictEqual(P.parseRxAudio(body).sampleRate, 48000, 'a real rate is kept');
  body.writeUInt32LE(0x3E80, 4);
  assert.strictEqual(P.parseRxAudio(body).sampleRate, 16000);
});

test('review 3: transport log lines are not printed twice (RigController leaves them to main)', () => {
  const { RigController } = require('../lib/rig-controller');
  const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
  const t = new Sculan10Transport();
  assert.strictEqual(t.routesOwnLog, true);
  const model = { brand: 'Yaesu', protocol: 'kenwood', caps: {}, cw: {}, tune: {} };
  const ctl = new RigController(model, t, new KenwoodCodec(model, () => {}));
  ctl._debug = true;
  const fromController = [];
  ctl.on('log', (m) => fromController.push(m));
  t.on('log', () => {});
  t._log('phase 1: test line');
  assert.strictEqual(fromController.length, 0);
});

test('low: a packet of an unknown type is logged once per channel, not dropped silently', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    const peer = u._catPeer;
    for (let i = 0; i < 3; i++) u.cat.send(specBuild(200 + i, SPEC.CAT, 0x99, Buffer.from([1, 2, 3])), peer.port, peer.address);
    assert.ok(await until(() => c.logs.some((l) => /CAT: a packet of unknown type 0x99/.test(l))));
    await sleep(100);
    assert.strictEqual(c.logs.filter((l) => /unknown type 0x99/.test(l)).length, 1);
  } finally { c.t.disconnect(); u.close(); }
});

test('low: a user or password the unit cannot take is refused with what is wrong, never the value', () => {
  const long = 'p'.repeat(40);
  const accented = 'pässwörd';
  for (const [user, pass, want] of [['defaultuser', long, /password is 40 characters long; the SCU-LAN10 takes at most 32/], ['defaultuser', accented, /password has a character the SCU-LAN10 cannot take/], ['ü', 'x', /user has a character/]]) {
    const t = new Sculan10Transport({ createSocket: () => { throw new Error('none'); } });
    const errs = [];
    t.on('error', (e) => errs.push(e));
    t.connect({ host: '192.168.49.1', username: user, password: pass });
    assert.strictEqual(errs[0].code, 'SCULAN10_BAD_LOGIN');
    assert.ok(want.test(errs[0].message), errs[0].message);
    assert.ok(!errs[0].message.includes(pass) && !errs[0].message.includes(long), 'the value is not in the message');
  }
  assert.strictEqual(P.loginFieldProblem('x'.repeat(32), 'password'), null, '32 is fine');
});

test('no address: a clear error, nothing sent', () => {
  const t = new Sculan10Transport();
  const errs = [];
  t.on('error', (e) => errs.push(e.message));
  t.connect({ host: '' });
  assert.ok(/no address set .* 192\.168\.49\.1/.test(errs[0]), errs[0]);
});

// ---- TX audio (#227) ----------------------------------------------------------

test('TX audio body: sid, the 24-byte header Yaesu sends (S16LE, stereo, 16 kHz, resend 1, latency 2000, volume 100), then PCM', () => {
  const pcm = P.txAudioPcm(new Float32Array(P.TX_AUDIO_FRAME_SAMPLES).fill(0.5));
  assert.strictEqual(pcm.length, 640, '10 ms of stereo Int16');
  const b = P.txAudioBody(0x23, 0x1234, pcm);
  assert.strictEqual(b.length, 4 + 24 + 640);
  assert.deepStrictEqual([...b.subarray(0, 4)], [0x23, 0, 0, 0]);
  const h = b.subarray(4, 28);
  assert.strictEqual(h.toString('hex'),
    '3412' + '01' + '02' + '803e0000' + '01' + '00000000000000' + 'd007' + 'd007' + '64' + '64' + '8002');
  assert.strictEqual(b.readInt16LE(28), 16384, 'left');
  assert.strictEqual(b.readInt16LE(30), 16384, 'right: the same sample');
  // The stream opener: header only, PCM length 0.
  const open = P.txAudioBody(0x23, 0);
  assert.strictEqual(open.length, 28);
  assert.strictEqual(open.readUInt16LE(4 + 22), 0);
  // Clipping instead of wrapping.
  const loud = P.txAudioPcm(Float32Array.from([2, -2]));
  assert.deepStrictEqual([loud.readInt16LE(0), loud.readInt16LE(4)], [32767, -32768]);
});

test('voice TX against a fake unit: an empty opener, then 10 ms frames, each twice with one frame seq; the tail is padded and sent', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    assert.strictEqual(c.t.txReady, true);
    assert.strictEqual(c.t.voiceTxActive, false);
    c.t.startVoiceTx();
    assert.strictEqual(c.t.voiceTxActive, true);
    // 50 ms of a 0.25 tone in uneven chunks, as the resampler hands them over, plus 3 ms.
    const total = 5 * 160 + 48;
    const all = new Float32Array(total).fill(0.25);
    for (let off = 0; off < total; off += 85) c.t.pushVoiceChunk(all.subarray(off, Math.min(total, off + 85)));
    c.t.stopVoiceTx();
    assert.strictEqual(c.t.voiceTxActive, false);
    assert.ok(await until(() => u.txAudio.length >= 2 * 7), `packets: ${u.txAudio.length}`);
    const frames = u.txAudio.map((b) => ({ sid: b[0], seq: b.readUInt16LE(4), len: b.readUInt16LE(4 + 22), first: b.length > 28 ? b.readInt16LE(28) : null, last: b.length > 28 ? b.readInt16LE(b.length - 4) : null }));
    for (let i = 0; i < frames.length; i += 2) assert.deepStrictEqual(frames[i], frames[i + 1], 'every frame twice');
    const once = frames.filter((_, i) => i % 2 === 0);
    assert.deepStrictEqual(once.map((f) => f.seq), [0, 1, 2, 3, 4, 5, 6], 'frame seq counts up');
    assert.strictEqual(once[0].len, 0, 'the opener has no PCM');
    assert.ok(once.slice(1).every((f) => f.len === 640 && f.sid === c.t.sessionId));
    assert.strictEqual(once[1].first, Math.round(0.25 * 32767));
    assert.strictEqual(once[6].first, Math.round(0.25 * 32767), 'the 3 ms tail went out');
    assert.strictEqual(once[6].last, 0, '...padded with silence');
    assert.ok(c.logs.some((l) => /TX audio: stream closed after .* 6 frames/.test(l)), c.logs.join('\n'));
  } finally { c.t.disconnect(); u.close(); }
});

test('voice TX: audio backed up past 300 ms is dropped from the front, so the delay cannot grow', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    c.t.startVoiceTx();
    c.t.pushVoiceChunk(new Float32Array(16000)); // one second at once
    c.t.stopVoiceTx();
    assert.ok(c.logs.some((l) => /30 frames, 11200 samples dropped/.test(l)), c.logs.join('\n'));
  } finally { c.t.disconnect(); u.close(); }
});

test('a session lost while keyed sends TX0; as soon as the next session is up; one lost while receiving does not', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    c.t.startVoiceTx();
    c.t.write('TX1;');
    u.silent = true;
    assert.ok(await until(() => c.errors.some((e) => e.code === 'SCULAN10_SESSION_LOST'), 3000));
    assert.strictEqual(c.t.voiceTxActive, false, 'the stream ended with the session');
    const before = u.catSeen.length;
    u.silent = false;
    assert.ok(await until(() => c.connects === 2, 3000), c.logs.join('\n'));
    assert.ok(await until(() => u.catSeen.slice(before).some((x) => x.text === 'TX0;' && x.sid === c.t.sessionId)), 'TX0; in the new session');
    assert.ok(c.logs.some((l) => /lost while keyed: sending TX0; now/.test(l)));
    // Released now: the next loss sends nothing.
    u.silent = true;
    assert.ok(await until(() => c.errors.filter((e) => e.code === 'SCULAN10_SESSION_LOST').length === 2, 3000));
    const mark = u.catSeen.length;
    u.silent = false;
    assert.ok(await until(() => c.connects === 3, 3000));
    await sleep(100);
    assert.ok(!u.catSeen.slice(mark).some((x) => x.text === 'TX0;'), 'no TX0; when the radio was not keyed');
  } finally { c.t.disconnect(); u.close(); }
});

test('disconnect while keyed sends TX0; first', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    c.t.write('TX1;');
    const mark = u.catSeen.length;
    c.t.disconnect();
    assert.ok(await until(() => u.catSeen.slice(mark).some((x) => x.text === 'TX0;')), 'TX0; before the sockets closed');
  } finally { u.close(); }
});

test('buffer TX (FT8, Tune): 12 kHz resampled to 16 kHz, lead and tail silence, paced in real time, then resolved', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    const tone = new Float32Array(3000).fill(0.5);            // 250 ms at 12 kHz
    const t0 = Date.now();
    const p = c.t.sendTxAudio(tone, { inputSampleRate: 12000, startDelayMs: 100, offsetMs: 0, tailSilenceMs: 50 });
    assert.strictEqual(c.t.txAudioActive, true);
    assert.strictEqual(c.t.voiceTxActive, false, 'a buffer is not voice');
    await p;
    const took = Date.now() - t0;
    assert.ok(took >= 300 && took < 900, `paced in real time: 400 ms of audio took ${took} ms`);
    assert.strictEqual(c.t.txAudioActive, false);
    assert.ok(await until(() => u.txAudio.length >= 2 * 41), `packets ${u.txAudio.length}`);
    const once = u.txAudio.filter((_, i) => i % 2 === 0);
    assert.strictEqual(once[0].readUInt16LE(4 + 22), 0, 'opener');
    const pcm = once.slice(1).map((b) => b.readInt16LE(28));
    assert.strictEqual(pcm.length, 40, '100 + 250 + 50 ms = 40 frames');
    assert.deepStrictEqual(pcm.slice(0, 10), new Array(10).fill(0), '100 ms lead silence');
    assert.ok(pcm.slice(10, 35).every((v) => v === Math.round(0.5 * 32767)), 'the tone');
    assert.deepStrictEqual(pcm.slice(35), new Array(5).fill(0), '50 ms tail');
  } finally { c.t.disconnect(); u.close(); }
});

test('buffer TX: cancelTx() stops it and rejects with "TX cancelled"; voice and a second buffer are refused while one runs', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    const p = c.t.sendTxAudio(new Float32Array(12000 * 5), { inputSampleRate: 12000 });
    await assert.rejects(c.t.sendTxAudio(new Float32Array(10)), /already in flight/);
    c.t.startVoiceTx();
    assert.strictEqual(c.t.voiceTxActive, false, 'voice did not take over the buffer');
    await sleep(100);
    c.t.cancelTx();
    await assert.rejects(p, /TX cancelled/);
    assert.strictEqual(c.t.txAudioActive, false);
    const n = u.txAudio.length;
    await sleep(100);
    assert.ok(u.txAudio.length - n <= 2, 'nothing more after the cancel');
    c.t.startVoiceTx();
    await assert.rejects(c.t.sendTxAudio(new Float32Array(10)), /voice TX is active/);
  } finally { c.t.disconnect(); u.close(); }
});

test('buffer TX: a lost session rejects it', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    const p = c.t.sendTxAudio(new Float32Array(12000 * 10), { inputSampleRate: 12000 });
    u.silent = true;
    await assert.rejects(p, /session ended/);
  } finally { c.t.disconnect(); u.close(); }
});

test('speaker monitor: each mode is read once, saved and muted; disconnect puts every mode back, then the mode and dial', async () => {
  const u = await fakeUnit();
  const c = client();
  const saved = [];
  c.t.on('monitor-saved', (s) => saved.push(s));
  let restored = 0;
  c.t.on('monitor-restored', () => restored++);
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST, muteMonitor: true });
    assert.ok(await until(() => c.connects === 1));
    c.t.write('FA;'); c.t.write('MD0;');                        // RigController's poll
    assert.ok(await until(() => u.radio.ml[2].on === '000' && u.radio.ml[2].level === '000'), JSON.stringify(u.radio));
    assert.deepStrictEqual(saved.at(-1), { 2: { on: '001', level: '002' } });
    c.t.write('MD03;'); c.t.write('MD0;');                       // the operator goes to CW
    assert.ok(await until(() => u.radio.ml[3].level === '000'));
    assert.deepStrictEqual(c.t.monitorSaved, { 2: { on: '001', level: '002' }, 3: { on: '000', level: '010' } });
    assert.deepStrictEqual(u.radio.ml[1], { on: '001', level: '005' }, 'a mode never used is left alone');
    const reads = u.catSeen.filter((x) => x.text === 'ML0;').length;
    c.t.write('MD0;'); await sleep(150);
    assert.strictEqual(u.catSeen.filter((x) => x.text === 'ML0;').length, reads, 'no second read in the same mode');
    c.t.disconnect();
    assert.ok(await until(() => u.radio.ml[2].level === '002' && u.radio.ml[3].level === '010'), JSON.stringify(u.radio.ml));
    assert.strictEqual(u.radio.ml[2].on, '001');
    assert.strictEqual(u.radio.mode, '3', 'back in the mode it was in');
    assert.strictEqual(u.radio.fa, '014074000', 'and on the dial it was on');
    assert.strictEqual(restored, 1);
  } finally { c.t.disconnect(); u.close(); }
});

test('speaker monitor: values saved by an earlier run are the radio\'s own: not re-read (they would read 0 now), still put back', async () => {
  const u = await fakeUnit();
  u.radio.ml[2] = { on: '000', level: '000' };                    // muted by a run that crashed
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST, muteMonitor: true, monitorSaved: { 2: { on: '001', level: '002' } } });
    assert.ok(await until(() => c.connects === 1));
    c.t.write('MD0;'); await sleep(200);
    assert.ok(!u.catSeen.some((x) => x.text === 'ML0;'), 'not read again');
    c.t.disconnect();
    assert.ok(await until(() => u.radio.ml[2].on === '001' && u.radio.ml[2].level === '002'));
  } finally { c.t.disconnect(); u.close(); }
});

test('speaker monitor off (the default): no ML is ever sent', async () => {
  const u = await fakeUnit();
  const c = client();
  try {
    c.t.connect({ host: '127.0.0.1', basePort: u.base, ...FAST });
    assert.ok(await until(() => c.connects === 1));
    c.t.write('MD0;'); await sleep(200);
    c.t.disconnect(); await sleep(100);
    assert.ok(!u.catSeen.some((x) => /^ML/.test(x.text)));
  } finally { c.t.disconnect(); u.close(); }
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nSCU-LAN10: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
