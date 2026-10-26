#!/usr/bin/env node
'use strict';
/**
 * FLRig (a shared radio): lib/xmlrpc.js, lib/flrig-transport.js and
 * lib/codecs/flrig-codec.js, driven through the REAL RigController against a
 * fake flrig that frames its replies the way flrig's xmlrpcpp does (read from
 * flrig 2.0.12: HTTP/1.1, `Content-length`, strings as bare <value>, ints as
 * <i4>, arrays for rig.get_modes, a <fault> struct for an unknown method,
 * keep-alive by default).
 *
 * KM4CFT 2026-10-25: an FTDX10 held by Ham2K Polo, whose rigctld emulation
 * serves frequency and mode but no PTT. With flrig holding the radio, Polo
 * and POTACAT are both its clients and transmit works.
 *
 * Run: node test/flrig-codec-test.js
 */
const assert = require('assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const X = require('../lib/xmlrpc');
const { FlrigTransport, probeFlrig } = require('../lib/flrig-transport');
const { FlrigCodec, flrigModel, normalizeRadioMode, smeterFromDbm, swrFromRatio } = require('../lib/codecs/flrig-codec');
const { RigController } = require('../lib/rig-controller');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 2500, step = 15) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await wait(step); } return pred(); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// flrig's own mode vocabularies (src/rigs/*/*.cxx in 2.0.12).
const VOCAB = {
  FTDX10: ['LSB', 'USB', 'CW-U', 'FM', 'AM', 'RTTY-L', 'CW-L', 'DATA-L', 'RTTY-U', 'DATA-FM', 'FM-N', 'DATA-U', 'AM-N', 'PSK', 'DATA-FMN'],
  IC7300: ['LSB', 'USB', 'AM', 'FM', 'CW', 'CW-R', 'RTTY', 'RTTY-R', 'LSB-D', 'USB-D', 'AM-D', 'FM-D'],
  TS890S: ['LSB', 'USB', 'CW', 'FM', 'AM', 'FSK', 'CW-R', 'FSK-R', 'LSB-D', 'USB-D', 'FM-D', 'AM-D'],
  KX3: ['LSB', 'USB', 'CW', 'FM', 'AM', 'DATA', 'CW-R', 'DATA-R'],
  G90: ['LSB', 'USB', 'AM', 'CW', 'CW-R'],
};

// --- a fake flrig ---------------------------------------------------------
// Frames exactly like xmlrpcpp (XmlRpcServer::generateHeader/generateResponse).
function xmlrpcpp(bodyInner) {
  const body = `<?xml version="1.0"?>\r\n<methodResponse><params><param>\r\n\t${bodyInner}\r\n</param></params></methodResponse>\r\n`;
  return { head: `HTTP/1.1 200 OK\r\nServer: XMLRPC++ 0.7\r\nContent-Type: text/xml\r\nContent-length: ${Buffer.byteLength(body)}\r\n\r\n`, body };
}
function xmlrpcppFault(msg, code = -1) {
  const body = `<?xml version="1.0"?>\r\n<methodResponse><fault>\r\n\t<value><struct><member><name>faultCode</name><value><i4>${code}</i4></value></member><member><name>faultString</name><value>${msg}</value></member></struct></value>\r\n</fault></methodResponse>\r\n`;
  return { head: `HTTP/1.1 200 OK\r\nServer: XMLRPC++ 0.7\r\nContent-Type: text/xml\r\nContent-length: ${Buffer.byteLength(body)}\r\n\r\n`, body };
}
const S = (s) => `<value>${s}</value>`;           // flrig string
const I = (n) => `<value><i4>${n}</i4></value>`;   // flrig int
const ARR = (list) => `<value><array><data>${list.map(S).join('')}</data></array></value>`;

function parseCall(xml) {
  const m = /<methodName>([^<]+)<\/methodName>/.exec(xml);
  const params = [];
  const re = /<param><value>(?:<(i4|int|double|string|boolean)>([\s\S]*?)<\/\1>|([^<]*))<\/value><\/param>/g;
  let r;
  while ((r = re.exec(xml))) params.push(r[1] ? { type: r[1], value: r[2] } : { type: 'string', value: r[3] });
  return { method: m ? m[1] : '', params };
}

function fakeFlrig({ vocab = VOCAB.FTDX10, xcvr = 'FTDX10', online = true, version = '2.0.12', pwrScale = 1, closeAfterEach = false, missing = [] } = {}) {
  const st = { freq: 14020700, mode: 'CW-U', ptt: 0, ab: 'A', split: 0, power: 100, dbm: -73, swr: '1.5', pwr: '50', rfgain: 100, volume: 20, calls: [], online, xcvr };
  const socks = new Set();
  const server = net.createServer((sock) => {
    socks.add(sock); sock.on('close', () => socks.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const he = buf.indexOf('\r\n\r\n');
        if (he === -1) return;
        const head = buf.slice(0, he).toString('latin1');
        const len = parseInt((/content-length:\s*(\d+)/i.exec(head) || [])[1] || '-1', 10);
        if (len < 0 || buf.length < he + 4 + len) return;
        const body = buf.slice(he + 4, he + 4 + len).toString('utf8');
        buf = buf.slice(he + 4 + len);
        const call = parseCall(body);
        st.calls.push(call);
        const out = answer(call);
        sock.write(out.head + out.body);
        if (closeAfterEach) sock.end();
      }
    });
    sock.on('error', () => {});
  });
  function answer({ method, params }) {
    const p0 = params[0] ? params[0].value : undefined;
    const t0 = params[0] ? params[0].type : undefined;
    if (missing.includes(method)) return xmlrpcppFault(`${method}: unknown method name`);
    switch (method) {
      case 'main.get_version': return xmlrpcpp(S(version));
      case 'rig.get_xcvr': return xmlrpcpp(S(st.online ? st.xcvr : ''));
      case 'rig.get_modes': return st.online ? xmlrpcpp(ARR(vocab)) : xmlrpcpp('');
      case 'rig.get_maxpwr': return xmlrpcpp(I(100));
      case 'rig.get_pwrmeter_scale': return xmlrpcpp(I(st.online ? pwrScale : 0));
      case 'rig.get_vfo': return xmlrpcpp(S(st.online ? String(st.freq) : '14070000'));
      case 'rig.set_vfo': if (t0 !== 'double') return xmlrpcppFault('type error'); st.freq = Math.round(parseFloat(p0)); return xmlrpcpp('');
      case 'rig.get_mode': return xmlrpcpp(S(st.online ? st.mode : 'USB'));
      case 'rig.set_mode': if (vocab.includes(p0)) { st.mode = p0; return xmlrpcpp(I(1)); } return xmlrpcpp(''); // unknown name: silently ignored, as flrig does
      case 'rig.get_ptt': return xmlrpcpp(I(st.ptt));
      case 'rig.set_ptt': if (t0 !== 'i4' && t0 !== 'int') return xmlrpcppFault('type error'); st.ptt = parseInt(p0, 10) ? 1 : 0; return xmlrpcpp('');
      case 'rig.get_AB': return xmlrpcpp(S(st.ab));
      case 'rig.set_AB': if (p0 === 'A' || p0 === 'B') st.ab = p0; return xmlrpcpp('');
      case 'rig.get_split': return xmlrpcpp(I(st.split));
      case 'rig.set_split': st.split = parseInt(p0, 10) ? 1 : 0; return xmlrpcpp('');
      case 'rig.get_DBM': return xmlrpcpp(S(st.online && !st.ptt ? String(st.dbm) : '0'));
      case 'rig.get_SWR': return xmlrpcpp(S(st.swr));
      case 'rig.get_pwrmeter': return xmlrpcpp(S(st.pwr));
      case 'rig.get_power': return xmlrpcpp(I(st.power));
      case 'rig.set_power': if (t0 !== 'i4' && t0 !== 'int') return xmlrpcppFault('type error'); st.power = parseInt(p0, 10); return xmlrpcpp('');
      case 'rig.get_rfgain': return xmlrpcpp(I(st.rfgain));
      case 'rig.set_rfgain': if (t0 !== 'double') return xmlrpcppFault('type error'); st.rfgain = Math.round(parseFloat(p0)); return xmlrpcpp('');
      case 'rig.get_volume': return xmlrpcpp(I(st.volume));
      case 'rig.set_volume': st.volume = parseInt(p0, 10); return xmlrpcpp('');
      case 'rig.tune': st.tuned = (st.tuned || 0) + 1; return xmlrpcpp('');
      default: return xmlrpcppFault(`${method}: unknown method name`);
    }
  }
  return {
    st, server,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    // server.close() waits for keep-alive sockets; drop them so a test ends.
    close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }),
    calls: (m) => st.calls.filter((c) => c.method === m),
  };
}

function rig(port, { model } = {}) {
  const m = flrigModel(model || null);
  const transport = new FlrigTransport({ timeoutMs: 800, reconnectMs: 150 });
  const codec = new FlrigCodec(m, (d) => transport.write(d));
  const cat = new RigController(m, transport, codec);
  cat._debug = true; // as main.js sets it: the log lines are part of the contract
  const ev = { logs: [], frequency: [], mode: [], ptt: [], vfo: [], split: [], smeter: [], swr: [], powerMeter: [], power: [], rfgain: [], afgain: [], status: [] };
  for (const k of Object.keys(ev)) if (k !== 'logs') cat.on(k, (v) => ev[k].push(v));
  cat.on('log', (l) => ev.logs.push(l));
  cat.connect({ host: '127.0.0.1', port });
  return { cat, transport, codec, ev, stop: () => cat.disconnect() };
}

(async () => {
  console.log('\n=== xmlrpc encode / decode (flrig shapes) ===');
  await test('encodeCall types every parameter the way flrig casts it', () => {
    assert.ok(/<methodName>rig\.set_vfo<\/methodName><params><param><value><double>14020700<\/double>/.test(X.encodeCall('rig.set_vfo', [X.dbl(14020700)])));
    assert.ok(/<i4>1<\/i4>/.test(X.encodeCall('rig.set_ptt', [X.i4(1)])));
    assert.ok(/<string>DATA-U<\/string>/.test(X.encodeCall('rig.set_mode', [X.str('DATA-U')])));
    assert.ok(/<string>a&amp;b&lt;c<\/string>/.test(X.encodeCall('rig.set_mode', [X.str('a&b<c')])));
    assert.ok(/<params><\/params>/.test(X.encodeCall('rig.get_vfo')));
    assert.throws(() => X.encodeCall('rig.get_vfo; rm'), /bad method/);
  });
  await test('decodeResponse: bare string, i4, double, array, empty result, fault', () => {
    assert.deepStrictEqual(X.decodeResponse(xmlrpcpp(S('14020700')).body), { ok: true, value: '14020700' });
    assert.deepStrictEqual(X.decodeResponse(xmlrpcpp(I(1)).body), { ok: true, value: 1 });
    assert.deepStrictEqual(X.decodeResponse(xmlrpcpp('<value><double>1.5</double></value>').body), { ok: true, value: 1.5 });
    assert.deepStrictEqual(X.decodeResponse(xmlrpcpp(ARR(['LSB', 'USB', 'DATA-U'])).body), { ok: true, value: ['LSB', 'USB', 'DATA-U'] });
    assert.deepStrictEqual(X.decodeResponse(xmlrpcpp('').body), { ok: true, value: null });
    const f = X.decodeResponse(xmlrpcppFault('rig.get_foo: unknown method name').body);
    assert.strictEqual(f.ok, false);
    assert.strictEqual(f.fault.string, 'rig.get_foo: unknown method name');
    assert.strictEqual(f.fault.code, -1);
    assert.deepStrictEqual(X.decodeResponse(xmlrpcpp(S('S9 &amp; up')).body).value, 'S9 & up');
    assert.strictEqual(X.decodeResponse('<html>nope</html>').ok, false);
  });

  console.log('\n=== mode vocabulary ===');
  await test('the radio\'s names normalise to the tokens the rest of POTACAT reads', () => {
    const want = { 'DATA-U': 'PKTUSB', 'USB-D': 'PKTUSB', 'USB-D2': 'PKTUSB', 'PKT-U': 'PKTUSB', DATA: 'PKTUSB', DIGU: 'PKTUSB', 'DATA-L': 'PKTLSB', 'LSB-D': 'PKTLSB', 'DATA-R': 'PKTLSB',
      'CW-U': 'CW', CW: 'CW', 'CW-L': 'CWR', 'CW-R': 'CWR', 'RTTY-L': 'RTTY', FSK: 'RTTY', 'RTTY-U': 'RTTYR', 'RTTY-R': 'RTTYR', 'FM-N': 'FM', 'AM-N': 'AM', 'DATA-FM': 'PKTFM', 'FM-D': 'PKTFM', DV: 'DV', USB: 'USB', LSB: 'LSB' };
    for (const [k, v] of Object.entries(want)) assert.strictEqual(normalizeRadioMode(k), v, k);
  });
  await test('a digital tune picks each radio\'s own DATA name (Yaesu DATA-U, Icom/Kenwood USB-D, Elecraft DATA), never USB when a data mode exists', () => {
    const pick = (vocab, req) => { const c = new FlrigCodec(flrigModel(null), () => {}); c._radioModes = vocab; return c.radioModeFor(c.resolveMode(req, 14074000)); };
    assert.strictEqual(pick(VOCAB.FTDX10, 'FT8'), 'DATA-U');
    assert.strictEqual(pick(VOCAB.FTDX10, 'DIGL'), 'DATA-L');
    assert.strictEqual(pick(VOCAB.FTDX10, 'CW'), 'CW-U');
    assert.strictEqual(pick(VOCAB.FTDX10, 'RTTY'), 'RTTY-L');
    assert.strictEqual(pick(VOCAB.IC7300, 'FT8'), 'USB-D');
    assert.strictEqual(pick(VOCAB.IC7300, 'DIGU'), 'USB-D');
    assert.strictEqual(pick(VOCAB.IC7300, 'CWR'), 'CW-R');
    assert.strictEqual(pick(VOCAB.TS890S, 'PKTUSB'), 'USB-D');
    assert.strictEqual(pick(VOCAB.TS890S, 'RTTY'), 'FSK');
    assert.strictEqual(pick(VOCAB.KX3, 'FT8'), 'DATA');
    assert.strictEqual(pick(VOCAB.KX3, 'DIGL'), 'DATA-R');
    assert.strictEqual(pick(VOCAB.KX3, 'SSB'), 'USB');
    // The G90 has no DATA mode in flrig: a digital tune falls back to USB rather than sending nothing.
    assert.strictEqual(pick(VOCAB.G90, 'FT8'), 'USB');
    assert.strictEqual(pick(VOCAB.G90, 'SSB'), 'USB');
    const c = new FlrigCodec(flrigModel(null), () => {}); c._radioModes = VOCAB.G90;
    assert.strictEqual(c.radioModeFor(c.resolveMode('SSB', 7200000)), 'LSB', 'SSB below 10 MHz is LSB');
    assert.strictEqual(c.resolveMode('PSK31'), 'PKTUSB');
    assert.strictEqual(c.resolveMode('JTTY'), 'PKTUSB');
    assert.strictEqual(c.resolveMode('nonsense'), null);
  });
  await test('meters: S9 = -73 dBm = 121 on the wire (the rigctld codec\'s rounding of 54*255/114), SWR 1.5 = 30, "0" means no reading', () => {
    assert.strictEqual(smeterFromDbm('-73'), 121);
    assert.strictEqual(smeterFromDbm('-127'), 0);
    assert.strictEqual(smeterFromDbm('-13'), 255);
    assert.strictEqual(smeterFromDbm('0'), null);
    assert.strictEqual(swrFromRatio('1.5'), 30);
    assert.strictEqual(swrFromRatio('1.0'), 0);
    assert.strictEqual(swrFromRatio('0'), null);
  });
  await test('flrigModel: picked model keeps bands/power, protocol and caps are the codec\'s', () => {
    const m = flrigModel({ brand: 'Yaesu', protocol: 'kenwood', maxPower: 100, minPower: 5, bands: ['20m'], caps: { atu: true, filter: true, nb: true }, cw: { text: 'ky1' } });
    assert.strictEqual(m.protocol, 'flrig');
    assert.strictEqual(m.brand, 'Yaesu');
    assert.strictEqual(m.caps.filter, false, 'no bandwidth over this link');
    assert.strictEqual(m.caps.nb, false);
    assert.strictEqual(m.caps.vfo, true);
    assert.strictEqual(m.caps.split, true);
    assert.strictEqual(m.caps.txpower, true);
    assert.strictEqual(m.cw.text, false, 'no CW text over this link');
    assert.strictEqual(m.minPower, 5);
    assert.deepStrictEqual(m.bands, ['20m']);
    assert.strictEqual(flrigModel(null).protocol, 'flrig');
  });

  console.log('\n=== the real RigController over a fake flrig ===');
  await test('connect: probe, safety PTT off, then frequency / mode / PTT / A-B / split / S-meter arrive in POTACAT units', async () => {
    const f = fakeFlrig(); const port = await f.listen();
    const r = rig(port);
    try {
      assert.ok(await until(() => r.ev.frequency.length && r.ev.mode.length && r.ev.smeter.length && r.ev.vfo.length && r.ev.split.length, 4000), 'poll replies arrived: ' + JSON.stringify({ f: r.ev.frequency, m: r.ev.mode, s: r.ev.smeter, v: r.ev.vfo, sp: r.ev.split }) + '\n' + r.ev.logs.join('\n'));
      assert.strictEqual(r.ev.frequency[0], 14020700);
      assert.strictEqual(r.ev.mode[0], 'CW', 'CW-U reads as CW');
      assert.strictEqual(r.ev.vfo[0], 'A');
      assert.strictEqual(r.ev.split[0], false);
      assert.deepStrictEqual(r.ev.ptt, [], 'PTT is reported on CHANGE only; RX at connect is no change');
      assert.strictEqual(r.ev.smeter[0], 121, 'S9');
      const order = f.st.calls.map((c) => c.method);
      assert.deepStrictEqual(order.slice(0, 6), ['main.get_version', 'rig.get_xcvr', 'rig.get_modes', 'rig.get_maxpwr', 'rig.get_pwrmeter_scale', 'rig.set_ptt'], order.join(','));
      assert.strictEqual(f.calls('rig.set_ptt')[0].params[0].value, '0', 'the connect safety is PTT OFF');
      assert.ok(r.ev.logs.some((l) => /flrig 2\.0\.12 holds the radio: FTDX10/.test(l)), r.ev.logs.join('\n'));
      assert.ok(r.ev.logs.some((l) => /flrig modes: LSB USB CW-U/.test(l)));
      assert.strictEqual(r.ev.status[0] && r.ev.status[0].connected, true);
    } finally { r.stop(); await f.close(); }
  });
  await test('tune: rig.set_vfo as a DOUBLE and rig.set_mode with the radio\'s own name; the readback follows', async () => {
    const f = fakeFlrig(); const port = await f.listen();
    const r = rig(port);
    try {
      await until(() => r.ev.frequency.length && r.codec._radioModes);
      r.cat.tune(14074000, 'FT8');
      assert.ok(await until(() => f.st.freq === 14074000 && f.st.mode === 'DATA-U', 3000), `freq ${f.st.freq} mode ${f.st.mode}\n` + r.ev.logs.join('\n'));
      assert.strictEqual(f.calls('rig.set_vfo')[0].params[0].type, 'double');
      assert.ok(await until(() => r.ev.mode.includes('PKTUSB') && r.ev.frequency.includes(14074000), 3000), 'readback');
      r.cat.tune(7200000, 'SSB');
      assert.ok(await until(() => f.st.freq === 7200000 && f.st.mode === 'LSB', 3000), `40 m SSB -> LSB (got ${f.st.mode})`);
      r.cat.tune(14250000, 'SSB');
      assert.ok(await until(() => f.st.mode === 'USB', 3000), '20 m SSB -> USB');
    } finally { r.stop(); await f.close(); }
  });
  await test('PTT, split, A/B, RF power, RF gain and AF gain go out typed the way flrig casts them', async () => {
    const f = fakeFlrig(); const port = await f.listen();
    const r = rig(port);
    try {
      await until(() => r.ev.frequency.length);
      r.cat.setTransmit(true);
      assert.ok(await until(() => f.st.ptt === 1), 'keyed');
      r.cat.setTransmit(false);
      assert.ok(await until(() => f.st.ptt === 0), 'unkeyed');
      r.cat.setSplit(true); r.cat.setVfo('B'); r.cat.setTxPower(37); r.cat.setRfGain(60); r.cat.setAfGain(15);
      assert.ok(await until(() => f.st.split === 1 && f.st.ab === 'B' && f.st.power === 37 && f.st.rfgain === 60 && f.st.volume === 15, 3000), JSON.stringify(f.st));
      assert.strictEqual(f.calls('rig.set_rfgain')[0].params[0].type, 'double');
      assert.strictEqual(f.calls('rig.set_power')[0].params[0].type, 'i4');
      assert.strictEqual(f.calls('rig.set_ptt')[1].params[0].type, 'i4');
      await wait(200); // the controller throttles power sets to one per 150 ms
      r.cat.setTxPower(500);
      assert.ok(await until(() => f.calls('rig.set_power').length >= 2));
      assert.strictEqual(f.st.power, 100, 'clamped to the model maximum');
      r.cat.startTune();
      assert.ok(await until(() => f.st.tuned === 1), 'rig.tune starts the tuner');
      assert.ok(r.ev.logs.some((l) => /PTT write: rig\.set_ptt 1/.test(l)));
    } finally { r.stop(); await f.close(); }
  });
  await test('meters while keyed: SWR ratio and the power meter (watts / scale) reach the controller', async () => {
    const f = fakeFlrig({ pwrScale: 1 }); const port = await f.listen();
    const r = rig(port);
    try {
      await until(() => r.ev.frequency.length);
      f.st.ptt = 1; // keyed from the front panel: the poll sees it
      assert.ok(await until(() => r.ev.swr.length && r.ev.powerMeter.length, 5000), 'SWR + power arrived\n' + r.ev.logs.join('\n'));
      assert.strictEqual(r.ev.swr[0], 30, '1.5:1');
      assert.strictEqual(r.ev.powerMeter[0], 50);
      assert.ok(r.ev.logs.some((l) => /flrig power meter: raw 50, scale 1 -> 50\.0 W/.test(l)));
    } finally { r.stop(); await f.close(); }
  });
  await test('transceiver OFFLINE in flrig: placeholders are not reported as the dial, and it is said once', async () => {
    const f = fakeFlrig({ online: false }); const port = await f.listen();
    const r = rig(port);
    try {
      await until(() => f.calls('rig.get_vfo').length >= 3, 4000);
      assert.deepStrictEqual(r.ev.frequency, [], 'no 14.070 placeholder');
      assert.deepStrictEqual(r.ev.mode, [], 'no USB placeholder');
      assert.strictEqual(r.ev.logs.filter((l) => /transceiver is OFFLINE/.test(l)).length, 1, r.ev.logs.join('\n'));
      f.st.online = true;
      assert.ok(await until(() => r.ev.frequency.length, 12000), 'the slow xcvr re-check notices it came online');
      assert.ok(r.ev.logs.some((l) => /holds the radio: FTDX10/.test(l)));
    } finally { r.stop(); await f.close(); }
  });
  await test('an older flrig without a method: that readback is latched off and said once; everything else keeps polling', async () => {
    const f = fakeFlrig({ missing: ['rig.get_DBM', 'rig.get_maxpwr'] }); const port = await f.listen();
    const r = rig(port);
    try {
      await until(() => f.calls('rig.get_vfo').length >= 4, 4000);
      assert.ok(r.ev.frequency.length >= 2);
      assert.strictEqual(f.calls('rig.get_DBM').length, 1, 'asked once, then never again');
      assert.strictEqual(r.ev.logs.filter((l) => /does not have rig\.get_DBM/.test(l)).length, 1);
      assert.deepStrictEqual(r.ev.smeter, []);
    } finally { r.stop(); await f.close(); }
  });
  await test('a server that closes the socket after every reply is not a lost link', async () => {
    const f = fakeFlrig({ closeAfterEach: true }); const port = await f.listen();
    const r = rig(port);
    try {
      assert.ok(await until(() => r.ev.frequency.length >= 2 && r.ev.mode.length >= 1, 5000), r.ev.logs.join('\n'));
      assert.ok(!r.ev.status.some((s) => s.connected === false), 'never reported disconnected');
      assert.ok(!r.ev.logs.some((l) => /Transport error/.test(l)), r.ev.logs.join('\n'));
    } finally { r.stop(); await f.close(); }
  });
  await test('nothing listening: one error line, no connect; it links up when flrig appears, and reports a lost link when it goes', async () => {
    const port = await freePort();
    const r = rig(port);
    try {
      await wait(500);
      assert.strictEqual(r.ev.status.length, 0, 'never connected');
      assert.strictEqual(r.ev.logs.filter((l) => /Transport error: .*ECONNREFUSED/.test(l)).length, 1, 'said once, not every 150 ms\n' + r.ev.logs.join('\n'));
      const f = fakeFlrig(); f.server.listen(port, '127.0.0.1');
      assert.ok(await until(() => r.ev.frequency.length, 4000), 'connected once flrig appeared');
      assert.strictEqual(r.ev.status[0].connected, true);
      await f.close();
      for (const s of []) s.destroy();
      assert.ok(await until(() => r.ev.status.some((s) => s.connected === false), 4000), 'lost link reported\n' + r.ev.logs.join('\n'));
    } finally { r.stop(); }
  });
  await test('probeFlrig (Test Connection): version, transceiver, dial and modes; a refused port is explained', async () => {
    const f = fakeFlrig(); const port = await f.listen();
    const p = await probeFlrig({ host: '127.0.0.1', port });
    await f.close();
    assert.deepStrictEqual({ ok: p.ok, version: p.version, xcvr: p.xcvr, freqHz: p.freqHz, mode: p.mode, n: p.modes.length }, { ok: true, version: '2.0.12', xcvr: 'FTDX10', freqHz: 14020700, mode: 'CW-U', n: 15 });
    const dead = await probeFlrig({ host: '127.0.0.1', port: await freePort(), timeoutMs: 800 });
    assert.strictEqual(dead.ok, false);
    assert.ok(/is flrig running/.test(dead.error), dead.error);
    const notFlrig = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': 5 }); res.end('hello'); });
    await new Promise((r) => notFlrig.listen(0, '127.0.0.1', r));
    const nf = await probeFlrig({ host: '127.0.0.1', port: notFlrig.address().port, timeoutMs: 800 });
    notFlrig.close();
    assert.strictEqual(nf.ok, false);
    assert.ok(/not an XML-RPC response|not flrig/.test(nf.error), nf.error);
  });

  console.log('\n=== wiring (main.js, renderer, libs) ===');
  await test('main.js: the flrig connect branch, detectRigType, the model merge, the test IPC and the link allowlist', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.ok(/\} else if \(target\.type === 'flrig'\) \{[\s\S]{0,1600}transport = new FlrigTransport\(\);[\s\S]{0,400}codec = new FlrigCodec\(model, \(data\) => transport\.write\(data\)\);[\s\S]{0,400}cat = new RigController\(model, transport, codec\);/.test(main), 'connectCat branch');
    assert.ok(/cat\.on\('powerMeter', sendCatFwdPower\);[\s\S]{0,300}resolveCatHostPort\(target, 12345, 'flrig'\)/.test(main), 'wattmeter wired, host:port paste handled, default 12345');
    assert.ok(/if \(target\.type === 'flrig'\) return 'flrig';/.test(main), 'detectRigType');
    assert.ok(/if \(rigType === 'flrig'\) return flrigModel\(explicit \|\| getModel\(null, 'flrig'\)\);/.test(main), 'getActiveRigModel merges the picked model');
    assert.ok(/case 'flrig':\s+return flrigModel\(null\)\.caps;/.test(main), 'caps fallback');
    assert.ok(/ipcMain\.handle\('test-flrig'/.test(main) && /probeFlrig\(\{ host, port \}\)/.test(main), 'Test Connection IPC');
    assert.ok(/'https:\/\/sourceforge\.net\/projects\/fldigi\/'/.test(main), 'download link allowed');
    assert.ok(/rigType === 'flrig';\n\}/.test(main) || /\|\| rigType === 'flrig'/.test(main), 'AF gain offered');
    const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert.ok(/testFlrig: \(config\) => ipcRenderer\.invoke\('test-flrig', config\)/.test(pre));
  });
  await test('renderer: radio type in the editor and the wizard, host/port, Test Connection, target builders, voice-as-data row', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    assert.ok(/name="radio-type" value="flrig"> FLRig \(a shared radio\)/.test(html));
    assert.ok(/id="set-flrig-host"/.test(html) && /id="set-flrig-port"[^>]*value="12345"/.test(html) && /id="flrig-test-btn"/.test(html));
    assert.ok(/name="welcome-radio-type" value="flrig"/.test(html) && /id="welcome-flrig-host"/.test(html));
    assert.ok(/href="https:\/\/sourceforge\.net\/projects\/fldigi\/files\/flrig\/" data-external="1"/.test(html));
    const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    assert.ok(/type: 'flrig',\s+host: \(setFlrigHost && setFlrigHost\.value\.trim\(\)\) \|\| '127\.0\.0\.1',\s+port: parseInt\(setFlrigPort && setFlrigPort\.value, 10\) \|\| 12345/.test(app), 'editor builds the target');
    assert.ok(/type: 'flrig',\s+host: document\.getElementById\('welcome-flrig-host'\)/.test(app), 'wizard builds the target');
    assert.ok(/currentTarget\.type === 'flrig'\) \{\s+setRadioType\('flrig'\)/.test(app), 'editor reopens it');
    assert.ok(/\['serialcat', 'icom', 'civ-tcp', 'icom-network', 'hamlib', 'rigctldnet', 'flrig'\]\.includes\(type\)/.test(app), 'Voice in DATA mode row');
    assert.ok(/window\.api\.testFlrig\(\{ host, port \}\)/.test(app));
    assert.ok(/const shared = \['flrig', 'rigctldnet'\]\.includes\(getSelectedRadioType\(\)\);/.test(app), 'picking a model keeps the flrig connection');
  });
  await test('libs: rig family, setup-note radio type, setup-share wording, port presence, generic caps, test runner', () => {
    const RF = require('../lib/rig-family');
    assert.strictEqual(RF.familyFromCatTarget({ type: 'flrig', host: '127.0.0.1', port: 12345 }), 'flrig');
    assert.strictEqual(RF.familyFromRadioType('flrig'), 'flrig');
    assert.deepStrictEqual(RF.audioSourcesFor('flrig').map((o) => o.value), ['dax'], 'a local sound card, no DAX wording');
    const notes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rig-setup-notes.js'), 'utf8');
    assert.ok(/rigctldnet: 'rigctldnet', flrig: 'flrig',/.test(notes));
    const share = require('../lib/setup-share');
    const srcShare = fs.readFileSync(path.join(__dirname, '..', 'lib', 'setup-share.js'), 'utf8');
    assert.ok(/flrig: 'flrig \(a shared radio\)'/.test(srcShare));
    void share;
    const P = require('../lib/serial-port-presence');
    assert.strictEqual(P.portOfTarget({ type: 'flrig', host: '127.0.0.1', port: 12345 }), '', 'no serial port to wait for');
    const { getModel } = require('../lib/rig-models');
    assert.strictEqual(getModel(null, 'flrig').protocol, 'flrig');
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8');
    assert.ok(runner.includes("'test/flrig-codec-test.js'"), 'in the npm test chain');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
