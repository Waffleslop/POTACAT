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

// ---- a fake SCU-LAN10, from the spec's phases -------------------------------

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

async function fakeUnit({ user = 'defaultuser', pass = 'defaultuser', sid = 0x22, catDoubleReply = true } = {}) {
  const { base, socks } = await bindConsecutive();
  const [ctrl, cat, audio, scope] = socks;
  const u = { base, ctrl, cat, audio, scope, sid, silent: false, events: [], catSeen: [], keepalives: { ctrl: 0, cat: 0, audio: 0, scope: 0 }, logins: 0, audioPeer: null, respSeq: 0, lastCmdSeq: null };
  const seq = { ctrl: 0, cat: 0, audio: 0, scope: 0 };
  const reply = (name, sock, rinfo, channel, msgType, body) => {
    seq[name] = (seq[name] + 1) & 0xFF;
    sock.send(P.buildPacket({ seq: seq[name], channel, msgType, body }), rinfo.port, rinfo.address);
  };
  const on = (name, sock, handler) => sock.on('message', (msg, rinfo) => {
    const p = P.parsePacket(msg);
    if (!p) { u.events.push(`${name}:bad`); return; }
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
      u.events.push(`setup:${P.CHANNEL_NAME[p.channel]}:${p.body[4].toString(16)}`);
      reply('ctrl', ctrl, rinfo, P.CHANNEL.CTRL, P.MSG.SETUP_ACK, Buffer.alloc(4));
    }
  });
  const portInit = (name, sock, channel) => (p, rinfo) => {
    if (p.msgType !== P.MSG.PORT_INIT) return false;
    assert.strictEqual(p.body[0], u.sid, `${name} init echoes the session id`);
    u.events.push(`init:${name}`);
    reply(name, sock, rinfo, channel, P.MSG.PORT_INIT_ACK, Buffer.alloc(4));
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
    if (text === 'FA;') answer = 'FA014074000;';
    else if (text === 'ID;') answer = 'ID0670;';
    if (!answer) return;
    u.respSeq = (u.respSeq + 1) & 0xFF;
    const body = Buffer.concat([Buffer.from([u.respSeq, 0, 0, 0]), Buffer.from(answer)]);
    reply('cat', cat, rinfo, P.CHANNEL.CAT, P.MSG.DATA_IN, body);
    if (catDoubleReply) reply('cat', cat, rinfo, P.CHANNEL.CAT, P.MSG.DATA_IN, body);
  });
  const audioInit = portInit('audio', audio, P.CHANNEL.AUDIO);
  on('audio', audio, (p, rinfo) => { if (audioInit(p, rinfo)) u.audioPeer = rinfo; });
  on('scope', scope, portInit('scope', scope, P.CHANNEL.SCOPE));
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
    assert.strictEqual(c.t.txReady, false, 'no TX audio');
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

test('no address: a clear error, nothing sent', () => {
  const t = new Sculan10Transport();
  const errs = [];
  t.on('error', (e) => errs.push(e.message));
  t.connect({ host: '' });
  assert.ok(/no address set .* 192\.168\.49\.1/.test(errs[0]), errs[0]);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nSCU-LAN10: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
