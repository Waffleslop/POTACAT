#!/usr/bin/env node
'use strict';

const assert = require('assert');
const dgram = require('dgram');
const { RsBa1Transport, passcodeBytes, streamIdFromLocalAddress, selectLocalAddressForTarget, resampleMonoFloat32 } = require('../lib/rsba1-transport');

const CONTROL_SIZE = 0x10;
const PING_SIZE = 0x15;
const TOKEN_SIZE = 0x40;
const STATUS_SIZE = 0x50;
const LOGIN_RESPONSE_SIZE = 0x60;
const LOGIN_SIZE = 0x80;
const CONNINFO_SIZE = 0x90;
const CAPABILITIES_SIZE = 0x42;
const RADIO_CAP_SIZE = 0x66;
const CIV_HEADER_SIZE = 0x15;
const AUDIO_HEADER_SIZE = 0x18;
const OPENCLOSE_SIZE = 0x16;
const AUDIO_CODEC_LPCM16_MONO = 0x04;
const AUDIO_CODEC_LPCM16_STEREO = 0x10;

const TYPE_RETRANSMIT = 0x00;
const TYPE_AYT = 0x03;
const TYPE_IAMHERE = 0x04;
const TYPE_DISCONNECT = 0x05;
const TYPE_AYR_IAR = 0x06;
const TYPE_PING = 0x07;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
  }
}

function buildControl(type, seq, sentid, rcvdid) {
  const buf = Buffer.alloc(CONTROL_SIZE, 0);
  buf.writeUInt32LE(CONTROL_SIZE, 0);
  buf.writeUInt16LE(type, 4);
  buf.writeUInt16LE(seq, 6);
  buf.writeUInt32LE(sentid >>> 0, 8);
  buf.writeUInt32LE(rcvdid >>> 0, 12);
  return buf;
}

function buildPing(seq, sentid, rcvdid, time, reply) {
  const buf = Buffer.alloc(PING_SIZE, 0);
  buf.writeUInt32LE(PING_SIZE, 0);
  buf.writeUInt16LE(TYPE_PING, 4);
  buf.writeUInt16LE(seq, 6);
  buf.writeUInt32LE(sentid >>> 0, 8);
  buf.writeUInt32LE(rcvdid >>> 0, 12);
  buf.writeUInt8(reply ? 1 : 0, 0x10);
  buf.writeUInt32LE(time >>> 0, 0x11);
  return buf;
}

function buildLoginResponse(tokRequest, token, rejected = false) {
  const buf = Buffer.alloc(LOGIN_RESPONSE_SIZE, 0);
  buf.writeUInt32LE(LOGIN_RESPONSE_SIZE, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(tokRequest, 0x1a);
  buf.writeUInt32LE(token >>> 0, 0x1c);
  if (rejected) buf.writeUInt32LE(0xfeffffff, 0x30);
  return buf;
}

function buildTokenResponse(requestType) {
  const buf = Buffer.alloc(TOKEN_SIZE, 0);
  buf.writeUInt32LE(TOKEN_SIZE, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt8(0x02, 0x14); // response
  buf.writeUInt8(requestType, 0x15);
  buf.writeUInt32LE(0, 0x30); // accepted
  return buf;
}

function buildStatus(civPort, audioPort) {
  const buf = Buffer.alloc(STATUS_SIZE, 0);
  buf.writeUInt32LE(STATUS_SIZE, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt32LE(0, 0x30); // accepted
  buf.writeUInt16BE(civPort, 0x42);
  buf.writeUInt16BE(audioPort || 0, 0x46);
  return buf;
}

function writeAscii(buf, offset, len, value) {
  Buffer.from(String(value || '').slice(0, len), 'ascii').copy(buf, offset);
}

function buildCapabilities(seq, sentid, rcvdid, tokRequest, token, radio = {}) {
  const buf = Buffer.alloc(CAPABILITIES_SIZE + RADIO_CAP_SIZE, 0);
  buf.writeUInt32LE(buf.length, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(seq, 6);
  buf.writeUInt32LE(sentid >>> 0, 8);
  buf.writeUInt32LE(rcvdid >>> 0, 12);
  buf.writeUInt32BE(buf.length - 0x10, 0x10);
  buf.writeUInt8(0x02, 0x14);
  buf.writeUInt8(0x02, 0x15);
  buf.writeUInt16BE(0, 0x16);
  buf.writeUInt16LE(tokRequest, 0x1a);
  buf.writeUInt32LE(token >>> 0, 0x1c);
  buf.writeUInt16LE(1, 0x40);

  const base = CAPABILITIES_SIZE;
  const commoncap = radio.commoncap == null ? 0x8010 : radio.commoncap;
  const mac = radio.macAddress || Buffer.from([0x00, 0x90, 0xc7, 0x12, 0x34, 0x56]);
  buf.writeUInt16LE(commoncap, base + 0x07);
  Buffer.from(mac).copy(buf, base + 0x0a, 0, 6);
  writeAscii(buf, base + 0x10, 32, radio.name || 'IC-7610');
  writeAscii(buf, base + 0x30, 32, radio.audio || 'ICOM_VAUDIO');
  buf.writeUInt16LE(radio.conntype || 0, base + 0x50);
  buf.writeUInt8(radio.civAddress == null ? 0x98 : radio.civAddress, base + 0x52);
  buf.writeUInt16LE(radio.rxSampleMask == null ? 0x0004 : radio.rxSampleMask, base + 0x53);
  buf.writeUInt16LE(radio.txSampleMask == null ? 0x0004 : radio.txSampleMask, base + 0x55);
  buf.writeUInt32BE(radio.baudrate || 115200, base + 0x5a);
  buf.writeUInt16LE(radio.capf || 0x5001, base + 0x5e);
  return buf;
}

function encodeFreqBCD(hz) {
  const digits = String(hz).padStart(10, '0');
  const bcd = [];
  for (let i = 8; i >= 0; i -= 2) {
    const hi = parseInt(digits[i], 10);
    const lo = parseInt(digits[i + 1], 10);
    bcd.push((hi << 4) | lo);
  }
  return bcd;
}

function buildCivData(seq, sentid, rcvdid, sendSeqB, civPayload) {
  const total = CIV_HEADER_SIZE + civPayload.length;
  const buf = Buffer.alloc(total, 0);
  buf.writeUInt32LE(total, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(seq, 6);
  buf.writeUInt32LE(sentid >>> 0, 8);
  buf.writeUInt32LE(rcvdid >>> 0, 12);
  buf.writeUInt8(0xc1, 0x10);
  buf.writeUInt16LE(civPayload.length, 0x11);
  buf.writeUInt16BE(sendSeqB, 0x13);
  civPayload.copy(buf, CIV_HEADER_SIZE);
  return buf;
}

function buildAudioData(seq, sentid, rcvdid, sendSeqB, samples) {
  const payload = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    payload.writeInt16LE(samples[i], i * 2);
  }
  const total = AUDIO_HEADER_SIZE + payload.length;
  const buf = Buffer.alloc(total, 0);
  buf.writeUInt32LE(total, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(seq, 6);
  buf.writeUInt32LE(sentid >>> 0, 8);
  buf.writeUInt32LE(rcvdid >>> 0, 12);
  buf.writeUInt16BE(0x0244, 0x10);
  buf.writeUInt16BE(sendSeqB, 0x12);
  buf.writeUInt16BE(payload.length, 0x16);
  payload.copy(buf, AUDIO_HEADER_SIZE);
  return buf;
}

function waitFor(emitter, event, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      emitter.removeListener(event, onEvent);
    };
    emitter.once(event, onEvent);
  });
}

function waitUntil(predicate, timeoutMs = 1500, label = 'condition') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start >= timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function decodeLpcm16Payload(payload) {
  const out = [];
  for (let i = 0; i + 1 < payload.length; i += 2) {
    out.push(payload.readInt16LE(i));
  }
  return out;
}

async function reserveUdpPortPair() {
  for (let i = 0; i < 50; i++) {
    const first = await new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.once('error', reject);
      sock.bind(0, '127.0.0.1', () => {
        const port = sock.address().port;
        sock.close(() => resolve(port));
      });
    });
    const second = first + 1;
    const sockets = [];
    try {
      for (const port of [first, second]) {
        sockets.push(await new Promise((resolve, reject) => {
          const sock = dgram.createSocket('udp4');
          sock.once('error', reject);
          sock.bind(port, '127.0.0.1', () => resolve(sock));
        }));
      }
      await Promise.all(sockets.map((sock) => new Promise((resolve) => sock.close(resolve))));
      return { controlPort: first, civPort: second };
    } catch {
      await Promise.all(sockets.map((sock) => new Promise((resolve) => {
        try { sock.close(resolve); } catch { resolve(); }
      })));
    }
  }
  throw new Error('Could not find a free consecutive UDP port pair');
}

class MockRsBa1Server {
  constructor({ username = 'user', password = 'pass', radioAddr = 0x94, frequencyHz = 14074000, controlPort = 0, civPort = 0, audioPort = 0, advertisedCivPort = null, advertisedAudioPort = null, requiredCivOpenCount = 1, tokenFlow = 'capabilities', dropLoginPackets = 0, txSampleMask = 0x0004 } = {}) {
    this.username = username;
    this.password = password;
    this.radioAddr = radioAddr;
    this.frequencyHz = frequencyHz;
    this.bindControlPort = controlPort;
    this.bindCivPort = civPort;
    this.bindAudioPort = audioPort;
    this.advertisedCivPort = advertisedCivPort;
    this.advertisedAudioPort = advertisedAudioPort;
    this.requiredCivOpenCount = Math.max(1, Number(requiredCivOpenCount) || 1);
    this.tokenFlow = tokenFlow;
    this.dropLoginPackets = Math.max(0, Number(dropLoginPackets) || 0);
    this.txSampleMask = txSampleMask;
    this.loginPacketCount = 0;
    this.radioMacAddress = Buffer.from([0x00, 0x90, 0xc7, 0x12, 0x34, 0x56]);
    this.controlId = 0x12345678;
    this.civId = 0x23456789;
    this.audioId = 0x3456789a;
    this.token = 0x0badcafe;
    this.controlSeq = 0;
    this.civSeq = 0;
    this.civSendSeq = 0;
    this.audioSeq = 0;
    this.audioSendSeq = 0;
    this.audioPingReplies = 0;
    this.controlClientId = 0;
    this.civClientId = 0;
    this.audioClientId = 0;
    this.controlClient = null;
    this.civClient = null;
    this.audioClient = null;
    this.lastConnInfo = null;
    this.lastToken = null;
    this.tokenRemovalCount = 0;
    this.requestedCivLocalPort = 0;
    this.requestedAudioLocalPort = 0;
    this.civOpened = false;
    this.civOpenCount = 0;
    this.audioOpened = false;
    this.txAudioPackets = [];
    this.control = null;
    this.civ = null;
    this.audio = null;
  }

  async start() {
    this.control = await this._bind((msg, rinfo) => this._onControl(msg, rinfo), this.bindControlPort);
    this.civ = await this._bind((msg, rinfo) => this._onCiv(msg, rinfo), this.bindCivPort);
    this.audio = await this._bind((msg, rinfo) => this._onAudio(msg, rinfo), this.bindAudioPort);
    this.controlPort = this.control.address().port;
    this.civPort = this.civ.address().port;
    this.audioPort = this.audio.address().port;
  }

  async stop() {
    await Promise.all([this._close(this.control), this._close(this.civ), this._close(this.audio)]);
  }

  _bind(onMessage, port = 0) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('message', onMessage);
      sock.once('error', reject);
      sock.bind(port, '127.0.0.1', () => resolve(sock));
    });
  }

  _close(sock) {
    return new Promise((resolve) => {
      if (!sock) return resolve();
      try { sock.close(resolve); } catch { resolve(); }
    });
  }

  _send(sock, buf, rinfo) {
    sock.send(buf, rinfo.port, rinfo.address);
  }

  _replyControl(type, rinfo) {
    this._send(this.control, buildControl(type, this.controlSeq++, this.controlId, this.controlClientId), rinfo);
  }

  _replyCivControl(type, rinfo) {
    this._send(this.civ, buildControl(type, this.civSeq++, this.civId, this.civClientId), rinfo);
  }

  _replyAudioControl(type, rinfo) {
    this._send(this.audio, buildControl(type, this.audioSeq++, this.audioId, this.audioClientId), rinfo);
  }

  sendAudioFrame(samples = [0, 16384, -16384, 32767]) {
    if (!this.audioClient) return;
    this._send(this.audio, buildAudioData(this.audioSeq++, this.audioId, this.audioClientId, this.audioSendSeq++, samples), this.audioClient);
  }

  sendUnsolicitedAudioPing() {
    if (!this.requestedAudioLocalPort) return;
    this._send(this.audio, buildPing(this.audioSeq++, this.audioId, this.audioClientId, Date.now() >>> 0, false), {
      address: (this.controlClient && this.controlClient.address) || '127.0.0.1',
      port: this.requestedAudioLocalPort,
    });
  }

  _onControl(msg, rinfo) {
    if (msg.length < 4) return;
    const len = msg.readUInt32LE(0);
    if (len === CONTROL_SIZE) {
      const type = msg.readUInt16LE(4);
      this.controlClientId = msg.readUInt32LE(8);
      this.controlClient = rinfo;
      if (type === TYPE_AYT) this._replyControl(TYPE_IAMHERE, rinfo);
      else if (type === TYPE_AYR_IAR) this._replyControl(TYPE_AYR_IAR, rinfo);
      else if (type === TYPE_DISCONNECT) return;
      else if (type === TYPE_RETRANSMIT) return;
      return;
    }

    if (len === PING_SIZE) {
      if (msg.readUInt8(0x10) === 0) {
        const seq = msg.readUInt16LE(6);
        const time = msg.readUInt32LE(0x11);
        this._send(this.control, buildPing(seq, this.controlId, this.controlClientId, time, true), rinfo);
      }
      return;
    }

    if (len === LOGIN_SIZE) {
      this.loginPacketCount++;
      if (this.loginPacketCount <= this.dropLoginPackets) return;
      const tokRequest = msg.readUInt16LE(0x1a);
      const userOk = msg.slice(0x40, 0x50).equals(passcodeBytes(this.username, 16));
      const passOk = msg.slice(0x50, 0x60).equals(passcodeBytes(this.password, 16));
      this._send(this.control, buildLoginResponse(tokRequest, this.token, !(userOk && passOk)), rinfo);
      return;
    }

    if (len === TOKEN_SIZE) {
      const requestType = msg.readUInt8(0x15);
      this.lastToken = msg;
      if (requestType === 0x01) this.tokenRemovalCount++;
      if (requestType === 0x02 && this.tokenFlow === 'capabilities') {
        const tokRequest = msg.readUInt16LE(0x1a);
        const token = msg.readUInt32LE(0x1c);
        this._send(this.control, buildCapabilities(this.controlSeq++, this.controlId, this.controlClientId, tokRequest, token, {
          name: 'IC-7610',
          civAddress: this.radioAddr,
          macAddress: this.radioMacAddress,
          txSampleMask: this.txSampleMask,
        }), rinfo);
      } else {
        this._send(this.control, buildTokenResponse(requestType), rinfo);
      }
      return;
    }

    if (len === CONNINFO_SIZE) {
      this.lastConnInfo = msg;
      this.requestedCivLocalPort = msg.readUInt32BE(0x7c);
      this.requestedAudioLocalPort = msg.readUInt32BE(0x80);
      const advertisedAudio = this.advertisedAudioPort == null ? this.audioPort : this.advertisedAudioPort;
      this._send(this.control, buildStatus(this.advertisedCivPort || this.civPort, advertisedAudio), rinfo);
    }
  }

  _onCiv(msg, rinfo) {
    if (msg.length < 4) return;
    if (this.requestedCivLocalPort && rinfo.port !== this.requestedCivLocalPort) return;
    const len = msg.readUInt32LE(0);
    if (len === CONTROL_SIZE) {
      const type = msg.readUInt16LE(4);
      this.civClientId = msg.readUInt32LE(8);
      this.civClient = rinfo;
      if (type === TYPE_AYT) {
        this._replyCivControl(TYPE_IAMHERE, rinfo);
      } else if (type === TYPE_AYR_IAR) {
        this._replyCivControl(TYPE_AYR_IAR, rinfo);
      }
      return;
    }

    if (len === PING_SIZE) {
      if (msg.readUInt8(0x10) === 0) {
        const seq = msg.readUInt16LE(6);
        const time = msg.readUInt32LE(0x11);
        this._send(this.civ, buildPing(seq, this.civId, this.civClientId, time, true), rinfo);
      }
      return;
    }

    if (len === OPENCLOSE_SIZE) {
      const openData = msg.readUInt16LE(0x10);
      const magic = msg.readUInt8(0x15);
      const sendSeq = msg.readUInt16BE(0x13);
      if (openData === 0x01c0 && magic === 0x04) {
        assert.strictEqual(sendSeq, this.civOpenCount);
        this.civOpenCount++;
        if (this.civOpenCount >= this.requiredCivOpenCount) this.civOpened = true;
      }
      return;
    }

    if (len > CIV_HEADER_SIZE && msg.readUInt8(0x10) === 0xc1) {
      if (!this.civOpened) return;
      const datalen = msg.readUInt16LE(0x11);
      const payload = msg.slice(CIV_HEADER_SIZE, CIV_HEADER_SIZE + datalen);
      const cmd = payload[4];
      if (cmd === 0x03) {
        const response = Buffer.from([
          0xfe, 0xfe, 0xe0, this.radioAddr, 0x03,
          ...encodeFreqBCD(this.frequencyHz),
          0xfd,
        ]);
        this._send(this.civ, buildCivData(this.civSeq++, this.civId, this.civClientId, this.civSendSeq++, response), rinfo);
      }
    }
  }

  _onAudio(msg, rinfo) {
    if (msg.length < 4) return;
    if (this.requestedAudioLocalPort && rinfo.port !== this.requestedAudioLocalPort) return;
    const len = msg.readUInt32LE(0);
    if (len === CONTROL_SIZE) {
      const type = msg.readUInt16LE(4);
      this.audioClientId = msg.readUInt32LE(8);
      this.audioClient = rinfo;
      if (type === TYPE_AYT) {
        this._replyAudioControl(TYPE_IAMHERE, rinfo);
      } else if (type === TYPE_AYR_IAR) {
        this._replyAudioControl(TYPE_AYR_IAR, rinfo);
      }
      return;
    }

    if (len === PING_SIZE) {
      if (msg.readUInt8(0x10) === 1) {
        this.audioPingReplies++;
      } else if (msg.readUInt8(0x10) === 0) {
        const seq = msg.readUInt16LE(6);
        const time = msg.readUInt32LE(0x11);
        this._send(this.audio, buildPing(seq, this.audioId, this.audioClientId, time, true), rinfo);
      }
      return;
    }

    if (len === OPENCLOSE_SIZE) {
      const openData = msg.readUInt16LE(0x10);
      const magic = msg.readUInt8(0x15);
      if (openData === 0x01c0 && magic === 0x04) {
        this.audioOpened = true;
      }
      if (!this.audioOpened) return;
      this.sendAudioFrame();
      return;
    }

    if (len > AUDIO_HEADER_SIZE) {
      if (!this.audioOpened) return;
      const datalen = msg.readUInt16BE(0x16);
      this.txAudioPackets.push({
        msg,
        ident: msg.readUInt16LE(0x10),
        sendSeq: msg.readUInt16BE(0x12),
        datalen,
        payload: msg.slice(AUDIO_HEADER_SIZE, AUDIO_HEADER_SIZE + datalen),
      });
    }
  }
}

async function withServer(opts, fn) {
  const server = new MockRsBa1Server(opts);
  await server.start();
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

async function main() {
  console.log('\n=== RS-BA1 Transport ===');

  await test('prefers same-subnet LAN address over tunnel route for stream IDs', async () => {
    const fakeInterfaces = {
      en0: [{
        family: 'IPv4',
        address: '10.0.1.7',
        netmask: '255.255.254.0',
        internal: false,
      }],
      utun9: [{
        family: 'IPv4',
        address: '100.92.40.38',
        netmask: '255.255.255.255',
        internal: false,
      }],
    };
    const selected = selectLocalAddressForTarget('10.0.0.75', '100.92.40.38', fakeInterfaces);
    assert.strictEqual(selected.address, '10.0.1.7');
    assert.strictEqual(selected.source, 'same-subnet');
    assert.strictEqual(selected.interfaceName, 'en0');
  });

  await test('connects, uses assigned CIV port, and carries CI-V frequency frames', async () => {
    await withServer({ username: 'alice', password: 'secret', frequencyHz: 7074000 }, async (server) => {
      const transport = new RsBa1Transport();
      const errors = [];
      transport.on('error', (err) => errors.push(err));
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'alice',
        password: 'secret',
      });

      await waitFor(transport, 'connect');
      assert.strictEqual(transport.connected, true);

      const dataPromise = waitFor(transport, 'data');
      transport.write(Buffer.from([0xfe, 0xfe, 0x94, 0xe0, 0x03, 0xfd]));
      const [frame] = await dataPromise;
      assert.deepStrictEqual([...frame], [0xfe, 0xfe, 0xe0, 0x94, 0x03, 0x00, 0x40, 0x07, 0x07, 0x00, 0xfd]);
      assert.strictEqual(server.civClient.port > 0, true);
      assert.strictEqual(server.requestedCivLocalPort, server.civClient.port);
      assert.ok(server.controlClientId > 0);
      assert.strictEqual(server.civClientId, streamIdFromLocalAddress('127.0.0.1', server.civClient.port));
      assert.strictEqual(server.lastToken.readUInt16BE(0x24), 0x0798);
      assert.deepStrictEqual([...server.lastConnInfo.slice(0x2a, 0x30)], [...server.radioMacAddress]);
      assert.strictEqual(server.lastConnInfo.toString('ascii', 0x40, 0x47).replace(/\0/g, ''), 'IC-7610');
      assert.strictEqual(server.lastConnInfo.readUInt8(0x70), 0);
      assert.deepStrictEqual(errors, []);

      transport.disconnect();
    });
  });

  await test('sends RS-BA1 token removal when disconnecting an authenticated session', async () => {
    await withServer({ username: 'alice', password: 'secret' }, async (server) => {
      const transport = new RsBa1Transport();
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'alice',
        password: 'secret',
      });

      await waitFor(transport, 'connect');
      transport.disconnect();
      await waitUntil(() => server.tokenRemovalCount >= 2, 500, 'token removal packets');
    });
  });

  await test('rejects invalid username/password', async () => {
    await withServer({ username: 'alice', password: 'secret' }, async (server) => {
      const transport = new RsBa1Transport();
      const errorPromise = waitFor(transport, 'error');
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'alice',
        password: 'wrong',
      });

      const [err] = await errorPromise;
      assert.match(err.message, /authentication failed: invalid-credentials/);
      assert.strictEqual(transport.connected, false);
      transport.disconnect();
    });
  });

  await test('retries the exact Login packet when the first copy is lost', async () => {
    await withServer({ username: 'alice', password: 'secret', dropLoginPackets: 1 }, async (server) => {
      const transport = new RsBa1Transport();
      const logs = [];
      transport.on('log', (line) => logs.push(String(line)));
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'alice',
        password: 'secret',
      });

      await waitFor(transport, 'connect', 4000);
      assert.strictEqual(server.loginPacketCount >= 2, true);
      assert.ok(logs.some((line) => line.includes('retry Login')));
      transport.disconnect();
    });
  });

  await test('falls back to control+1 when advertised CIV port does not answer', async () => {
    const ports = await reserveUdpPortPair();
    const advertisedCivPort = ports.civPort > 64535 ? ports.civPort - 1000 : ports.civPort + 1000;
    await withServer({
      username: 'alice',
      password: 'secret',
      controlPort: ports.controlPort,
      civPort: ports.civPort,
      advertisedCivPort,
      frequencyHz: 14230000,
    }, async (server) => {
      const transport = new RsBa1Transport();
      const logs = [];
      transport.on('log', (line) => logs.push(line));
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'alice',
        password: 'secret',
      });

      await waitFor(transport, 'connect', 7000);
      assert.strictEqual(transport.connected, true);
      assert.strictEqual(server.requestedCivLocalPort, server.civClient.port);
      assert.ok(logs.some((line) => line.includes(`retrying fallback port ${ports.civPort}`)));

      const dataPromise = waitFor(transport, 'data');
      transport.write(Buffer.from([0xfe, 0xfe, 0x94, 0xe0, 0x03, 0xfd]));
      const [frame] = await dataPromise;
      assert.deepStrictEqual([...frame], [0xfe, 0xfe, 0xe0, 0x94, 0x03, 0x00, 0x00, 0x23, 0x14, 0x00, 0xfd]);

      transport.disconnect();
    });
  });

  await test('opens RS-BA1 audio stream and decodes LPCM16 mono RX frames', async () => {
    await withServer({ username: 'alice', password: 'secret' }, async (server) => {
      const transport = new RsBa1Transport();
      const connectPromise = waitFor(transport, 'connect');
      const audioReadyPromise = waitFor(transport, 'audio-ready');
      const audioPromise = waitFor(transport, 'audio-frame');
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'alice',
        password: 'secret',
        enableRxAudio: true,
        rxAudioSampleRate: 48000,
      });

      await connectPromise;
      await audioReadyPromise;
      const [frame] = await audioPromise;
      assert.strictEqual(frame.sampleRate, 48000);
      assert.strictEqual(frame.pcm.length, 4);
      assert.strictEqual(frame.pcm[0], 0);
      assert.strictEqual(frame.pcm[1], 0.5);
      assert.strictEqual(frame.pcm[2], -0.5);
      assert.ok(Math.abs(frame.pcm[3] - (32767 / 32768)) < 1e-7);
      assert.strictEqual(server.requestedCivLocalPort, server.civClient.port);
      assert.strictEqual(server.requestedAudioLocalPort, server.audioClient.port);
      assert.strictEqual(server.lastConnInfo.readUInt8(0x70), 1);
      assert.strictEqual(server.lastConnInfo.readUInt8(0x72), AUDIO_CODEC_LPCM16_MONO);
      assert.strictEqual(server.lastConnInfo.readUInt32BE(0x74), 48000);

      transport.disconnect();
    });
  });

  await test('negotiates and sends RS-BA1 LPCM16 mono TX audio packets', async () => {
    await withServer({ username: 'alice', password: 'secret' }, async (server) => {
      const transport = new RsBa1Transport();
      const connectPromise = waitFor(transport, 'connect');
      const audioReadyPromise = waitFor(transport, 'audio-ready');
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'alice',
        password: 'secret',
        enableRxAudio: true,
        enableTxAudio: true,
        rxAudioSampleRate: 48000,
        txAudioSampleRate: 48000,
      });

      await connectPromise;
      await audioReadyPromise;
      assert.strictEqual(transport.txReady, true);
      assert.strictEqual(server.lastConnInfo.readUInt8(0x70), 1);
      assert.strictEqual(server.lastConnInfo.readUInt8(0x71), 1);
      assert.strictEqual(server.lastConnInfo.readUInt8(0x72), AUDIO_CODEC_LPCM16_MONO);
      assert.strictEqual(server.lastConnInfo.readUInt8(0x73), AUDIO_CODEC_LPCM16_MONO);
      assert.strictEqual(server.lastConnInfo.readUInt32BE(0x78), 48000);
      assert.strictEqual(server.lastConnInfo.readUInt32BE(0x84), 250);

      const samples = new Float32Array(700);
      samples[0] = 0;
      samples[1] = 0.5;
      samples[2] = -0.5;
      samples[3] = 1;
      for (let i = 4; i < samples.length; i++) samples[i] = (i % 10) / 20;
      await transport.sendTxAudio(samples, { offsetMs: 500, inputSampleRate: 48000, tailSilenceMs: 0 });
      await waitUntil(() => server.txAudioPackets.length >= 2, 1000, 'TX audio packets');

      assert.strictEqual(server.txAudioPackets.length, 2);
      assert.strictEqual(server.txAudioPackets[0].datalen, 1364);
      assert.strictEqual(server.txAudioPackets[1].datalen, 36);
      assert.strictEqual(server.txAudioPackets[0].ident, 0x0080);
      assert.strictEqual(server.txAudioPackets[0].sendSeq, 0);
      assert.strictEqual(server.txAudioPackets[1].sendSeq, 1);
      const payload = Buffer.concat(server.txAudioPackets.map((p) => p.payload));
      assert.strictEqual(payload.length, 1400);
      assert.deepStrictEqual(decodeLpcm16Payload(payload.slice(0, 8)), [0, 16384, -16384, 32767]);

      transport.disconnect();
    });
  });

  await test('groups TX audio into wfview-style 20ms frames before splitting UDP chunks', async () => {
    await withServer({ includeAudio: true, enableTxAudio: true }, async (server) => {
      const transport = new RsBa1Transport({ log: () => {} });
      const audioReadyPromise = waitFor(transport, 'audio-ready', 1500);
      const connectPromise = waitFor(transport, 'connect', 1500);
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'user',
        password: 'pass',
        enableRxAudio: true,
        enableTxAudio: true,
        timeoutMs: 1500,
      });

      await connectPromise;
      await audioReadyPromise;

      const samples = new Float32Array(1920); // 40ms at 48kHz = two 20ms frames
      for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 0.25 : -0.25;
      await transport.sendTxAudio(samples, { offsetMs: 500, inputSampleRate: 48000, tailSilenceMs: 0 });
      await waitUntil(() => server.txAudioPackets.length >= 4, 1000, '20ms TX audio frame packets');

      assert.deepStrictEqual(server.txAudioPackets.map((p) => p.datalen), [1364, 556, 1364, 556]);
      assert.deepStrictEqual(server.txAudioPackets.map((p) => p.sendSeq), [0, 1, 2, 3]);

      transport.disconnect();
    });
  });

  await test('sends 16kHz RS-BA1 TX audio as unsplit 20ms mono frames', async () => {
    await withServer({ includeAudio: true, enableTxAudio: true }, async (server) => {
      const transport = new RsBa1Transport({ log: () => {} });
      const audioReadyPromise = waitFor(transport, 'audio-ready', 1500);
      const connectPromise = waitFor(transport, 'connect', 1500);
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'user',
        password: 'pass',
        enableRxAudio: true,
        enableTxAudio: true,
        txAudioSampleRate: 16000,
        txAudioBufferMs: 750,
        timeoutMs: 1500,
      });

      await connectPromise;
      await audioReadyPromise;
      assert.strictEqual(server.lastConnInfo.readUInt32BE(0x78), 16000);
      assert.strictEqual(server.lastConnInfo.readUInt32BE(0x84), 750);

      const samples = new Float32Array(640); // 40ms at 16kHz = two 20ms frames
      for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 0.2 : -0.2;
      await transport.sendTxAudio(samples, {
        offsetMs: 0,
        inputSampleRate: 16000,
        startDelayMs: 0,
        tailSilenceMs: 0,
      });
      await waitUntil(() => server.txAudioPackets.length >= 2, 1000, '16kHz TX audio packets');

      assert.deepStrictEqual(server.txAudioPackets.map((p) => p.datalen), [640, 640]);
      assert.deepStrictEqual(server.txAudioPackets.map((p) => p.sendSeq), [0, 1]);

      transport.disconnect();
    });
  });

  await test('duplicates mono TX audio into RS-BA1 PCM16 stereo packets when negotiated', async () => {
    await withServer({ includeAudio: true, enableTxAudio: true }, async (server) => {
      const transport = new RsBa1Transport({ log: () => {} });
      const audioReadyPromise = waitFor(transport, 'audio-ready', 1500);
      const connectPromise = waitFor(transport, 'connect', 1500);
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'user',
        password: 'pass',
        enableRxAudio: true,
        enableTxAudio: true,
        txAudioCodec: AUDIO_CODEC_LPCM16_STEREO,
        timeoutMs: 1500,
      });

      await connectPromise;
      await audioReadyPromise;
      assert.strictEqual(server.lastConnInfo.readUInt8(0x73), AUDIO_CODEC_LPCM16_STEREO);

      const samples = new Float32Array(960); // 20ms at 48kHz, one stereo frame after duplication
      samples[0] = 0.5;
      samples[1] = -0.5;
      for (let i = 2; i < samples.length; i++) samples[i] = i % 2 ? 0.25 : -0.25;
      await transport.sendTxAudio(samples, { offsetMs: 500, inputSampleRate: 48000, tailSilenceMs: 0 });
      await waitUntil(() => server.txAudioPackets.length >= 3, 1000, 'stereo TX audio packets');

      assert.deepStrictEqual(server.txAudioPackets.map((p) => p.datalen), [1364, 1364, 1112]);
      const payload = Buffer.concat(server.txAudioPackets.map((p) => p.payload));
      assert.strictEqual(payload.length, 3840);
      assert.deepStrictEqual(decodeLpcm16Payload(payload.slice(0, 8)), [16384, 16384, -16384, -16384]);

      transport.disconnect();
    });
  });

  await test('uses band-limited upsampling for 12kHz JTCAT TX audio', async () => {
    const inputRate = 12000;
    const outputRate = 48000;
    const toneHz = 1500;
    const src = new Float32Array(inputRate / 10);
    for (let i = 0; i < src.length; i++) {
      src[i] = Math.sin(2 * Math.PI * toneHz * i / inputRate) * 0.25;
    }

    const out = resampleMonoFloat32(src, inputRate, outputRate);
    assert.strictEqual(out.length, src.length * 4);

    let peak = 0;
    let rms = 0;
    for (let i = outputRate / 100; i < out.length - outputRate / 100; i++) {
      const v = out[i];
      peak = Math.max(peak, Math.abs(v));
      rms += v * v;
    }
    rms = Math.sqrt(rms / (out.length - outputRate / 50));

    assert.ok(peak > 0.23 && peak < 0.27, `unexpected resampled peak ${peak}`);
    assert.ok(rms > 0.16 && rms < 0.19, `unexpected resampled rms ${rms}`);
  });

  await test('learns audio remote port from inbound packets before replying', async () => {
    await withServer({ includeAudio: true, enableTxAudio: true, advertisedAudioPort: 0 }, async (server) => {
      const transport = new RsBa1Transport();
      const connectPromise = waitFor(transport, 'connect', 1500);
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'user',
        password: 'pass',
        enableRxAudio: true,
        enableTxAudio: true,
        timeoutMs: 1500,
      });

      await connectPromise;
      await waitUntil(() => server.requestedAudioLocalPort > 0, 1000, 'audio local port request');
      server.sendUnsolicitedAudioPing();
      await waitUntil(() => server.audioPingReplies >= 1, 1000, 'audio ping reply after learned port');

      assert.strictEqual(transport.audio.port, server.audioPort);

      transport.disconnect();
    });
  });

  await test('does not enable RS-BA1 TX audio when radio capabilities reject it', async () => {
    await withServer({ username: 'alice', password: 'secret', txSampleMask: 0x0001 }, async (server) => {
      const transport = new RsBa1Transport();
      const connectPromise = waitFor(transport, 'connect');
      const audioReadyPromise = waitFor(transport, 'audio-ready');
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'alice',
        password: 'secret',
        enableRxAudio: true,
        enableTxAudio: true,
      });

      await connectPromise;
      await audioReadyPromise;
      assert.strictEqual(server.lastConnInfo.readUInt8(0x71), 0);
      assert.strictEqual(transport.txReady, false);
      await assert.rejects(
        () => transport.sendTxAudio(new Float32Array([0.1]), 500, 48000),
        /not negotiated/
      );
      transport.disconnect();
    });
  });

  await test('retries CI-V OpenClose until the stream accepts data', async () => {
    await withServer({ username: 'alice', password: 'secret', requiredCivOpenCount: 3, frequencyHz: 18100000 }, async (server) => {
      const transport = new RsBa1Transport();
      transport.connect({
        host: '127.0.0.1',
        controlPort: server.controlPort,
        username: 'alice',
        password: 'secret',
      });

      await waitFor(transport, 'connect');
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.ok(server.civOpenCount >= 3, `Expected repeated OpenClose packets, got ${server.civOpenCount}`);

      const dataPromise = waitFor(transport, 'data');
      transport.write(Buffer.from([0xfe, 0xfe, 0x94, 0xe0, 0x03, 0xfd]));
      const [frame] = await dataPromise;
      assert.deepStrictEqual([...frame], [0xfe, 0xfe, 0xe0, 0x94, 0x03, 0x00, 0x00, 0x10, 0x18, 0x00, 0xfd]);

      transport.disconnect();
    });
  });

  await test('reports no-IAmHere timeout before credential validation', async () => {
    const blackhole = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      blackhole.once('error', reject);
      blackhole.bind(0, '127.0.0.1', resolve);
    });
    try {
      const transport = new RsBa1Transport();
      const errorPromise = waitFor(transport, 'error', 1000);
      transport.connect({
        host: 'localhost',
        controlPort: blackhole.address().port,
        username: 'alice',
        password: 'secret',
        timeoutMs: 200,
      });

      const [err] = await errorPromise;
      assert.strictEqual(err.code, 'RSBA1_NO_IAMHERE');
      assert.match(err.message, /before IAmHere/);
      assert.match(err.message, /before username\/password validation/);
      assert.strictEqual(err.details.host, 'localhost');
      assert.strictEqual(err.details.resolvedHost, '127.0.0.1');
      assert.ok(err.details.controlAytCount >= 1);
      assert.strictEqual(transport.connected, false);
      transport.disconnect();
    } finally {
      await new Promise((resolve) => {
        try { blackhole.close(resolve); } catch { resolve(); }
      });
    }
  });

  console.log('\n==================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('SOME TESTS FAILED');
    process.exitCode = 1;
  } else {
    console.log('ALL TESTS PASSED');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
