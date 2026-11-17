// FlexRadio SmartLink session (lib/smartlink-session.js, lib/smartlink-opus.js),
// replayed against POTACAT's D0 capture (8600M v4.2.20, 2026-11-17) through a fake
// SmartLink server and a fake radio. No network: sockets are injected.
// Fixtures: test/fixtures/smartlink/ (serial zeroed; tokens, handles, ids, the
// account and the licence id were redacted at capture).
// Run: node test/smartlink-session-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const SL = require('../lib/smartlink-session');
const Opus = require('../lib/smartlink-opus');
const { SmartSdrClient } = require('../lib/smartsdr');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FX = path.join(__dirname, 'fixtures', 'smartlink');
const lines = (f) => fs.readFileSync(path.join(FX, f), 'utf8').split(/\r?\n/).filter(Boolean);
const SERIAL = '0000-0000-0000-0000';
const SERVER = lines('d0-server.txt');
const NUMBERED = lines('d0-radio-numbered.txt');
const BARE = lines('d0-radio-bare.txt');
const FAKE_CLIENT_ID = 'test-client-id-not-real-000000';
const FAKE_REFRESH = 'test-refresh-token-not-real';
const FAKE_JWT = 'header.payload.signature-not-a-real-jwt';

// ---- fakes ---------------------------------------------------------------

function fakeSocket(onWrite, opts = {}) {
  const s = new EventEmitter();
  s.written = [];
  s.destroyed = false;
  s.write = (d) => { s.written.push(String(d)); onWrite && onWrite(String(d), s); return true; };
  s.end = () => { if (!s.destroyed) { s.destroyed = true; setImmediate(() => s.emit('close')); } };
  s.destroy = () => s.end();
  s.getPeerCertificate = () => ({ fingerprint256: opts.fingerprint || 'AA:BB' });
  s.feed = (ls) => s.emit('data', Buffer.from(ls.map((l) => l + '\n').join('')));
  if (!opts.noConnect) setImmediate(() => { if (opts.error) s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })); else s.emit('secureConnect'); });
  return s;
}

/**
 * The fake world: connectTls hands out the server for smartlink.flexradio.com
 * and the radio for anything else. `radio` picks the radio's answer script.
 */
function world(o = {}) {
  const w = { server: null, radios: [], opts: o };
  w.connectTls = (opts) => {
    if (opts.host === SL.SERVER_HOST) {
      w.serverOpts = opts;
      w.server = fakeSocket((d, s) => {
        if (d.startsWith('application register')) {
          if (o.registrationInvalid) { setImmediate(() => s.feed(['application registration_invalid'])); return; }
          const list = o.list || SERVER.filter((l) => l.startsWith('radio list')).slice(0, 1);
          setImmediate(() => s.feed([...list, ...SERVER.filter((l) => /^application /.test(l))]));
        }
        if (d.startsWith('application connect') && !o.noConnectReady) {
          setImmediate(() => s.feed(SERVER.filter((l) => l.startsWith('radio connect_ready')).slice(0, 1)));
        }
      });
      return w.server;
    }
    w.radioOpts = opts;
    const r = fakeSocket((d, s) => {
      if (s.written.length === 1) {
        // The radio's answer to its FIRST line.
        if (/^C1\|wan validate handle=WANHANDLE0001\n$/.test(d)) setImmediate(() => s.feed(o.radioScript || NUMBERED.slice(0, 9)));
        else setImmediate(() => s.feed(BARE));
      }
      if (o.onRadioWrite) o.onRadioWrite(d, s);
    }, { error: o.radioError, fingerprint: o.fingerprint });
    w.radios.push(r);
    return r;
  };
  w.post = async (url, form) => {
    w.posted = { url, form };
    if (o.refreshStatus && o.refreshStatus !== 200) return { status: o.refreshStatus, body: '{"error":"invalid_grant"}' };
    return { status: 200, body: JSON.stringify({ id_token: FAKE_JWT }) };
  };
  w.makeServer = (extra) => new SL.SmartLinkServer({
    clientId: FAKE_CLIENT_ID, getRefreshToken: () => FAKE_REFRESH, connectTls: w.connectTls, post: w.post,
    platform: 'Windows', timeouts: { keepAliveMs: 30, connectReadyMs: 150, radioListMs: 150, radioTlsMs: 150, wanValidateMs: 150, testUdpMs: 150 }, ...extra,
  });
  return w;
}

(async () => {
  console.log('Radio list (D0 field names, trailing |)');
  {
    const list = SL.parseRadioList(SERVER[0]);
    check(list.length === 1, 'one radio; the empty entry after the trailing | is dropped');
    const r = list[0];
    check(r.serial === SERIAL && r.model === 'FLEX-8600M' && r.callsign === 'K3SBP', 'serial, model, callsign');
    check(r.status === 'In_Use' && r.tlsPort === 4994 && r.udpPort === 4993, 'status and forwarded ports 4994 / 4993');
    check(r.upnpTlsPort === -1 && r.upnpUdpPort === -1 && r.upnpSupported === false, 'no UPnP');
    check(r.licensedClients === 1, 'licensed_clients=1');
    check(r.guiClients.length === 1 && r.guiClients[0].station === 'POTACAT', 'gui_client_stations names who holds it');
    check(SL.whoHolds(r) === 'POTACAT on shack-pc.localdomain', `whoHolds: "${SL.whoHolds(r)}"`);
    check(/in use by POTACAT on shack-pc\.localdomain/.test(SL.busySentence(r)), 'the F3000001 sentence says who');
    check(SL.choosePorts(r).via === 'forwarded' && SL.choosePorts(r).tls === 4994, 'forwarded ports are chosen first');
    check(SL.choosePorts({ ...r, tlsPort: -1, udpPort: -1, upnpTlsPort: 21000, upnpUdpPort: 21001 }).via === 'upnp', 'then UPnP');
    check(SL.choosePorts({ ...r, tlsPort: -1, udpPort: -1 }) === null, 'neither: null (a hole punch would be needed)');
    const named = SL.parseRadioList('radio list radio_name=Shack_Flex serial=1 model=FLEX-6600 status=Available|serial=2 nickname=Old_Name model=FLEX-6400|');
    check(named.length === 2 && named[0].name === 'Shack Flex' && named[1].name === 'Old Name', 'radio_name (and the reference\'s nickname) with underscores as spaces');
    check(/Shack Flex \(FLEX-6600\), available/.test(SL.describeRadio(named[0])), 'describeRadio for the rig editor');
  }

  console.log('Sign-in (Part 1)');
  {
    const u = new URL(SL.authorizeUrl({ clientId: FAKE_CLIENT_ID, state: 's1' }));
    check(u.host === 'frtest.auth0.com' && u.pathname === '/authorize', 'FlexRadio\'s Auth0 authorize endpoint');
    check(u.searchParams.get('response_type') === 'token' && u.searchParams.get('redirect_uri') === 'https://frtest.auth0.com/mobile', 'implicit flow, /mobile redirect');
    check(u.searchParams.get('scope') === 'openid offline_access email given_name family_name picture' && u.searchParams.get('state') === 's1', 'scope and state');
    let threw = null; try { SL.authorizeUrl({}); } catch (e) { threw = e.code; }
    check(threw === 'not-configured', 'no client ID: not-configured');
    const ok = SL.parseRedirect('https://frtest.auth0.com/mobile#refresh_token=RT1&id_token=X.Y.Z&token_type=Bearer&state=s1', 's1');
    check(ok.refreshToken === 'RT1' && Object.keys(ok).length === 1, 'only the refresh token is kept from the fragment');
    check(!!SL.parseRedirect('https://frtest.auth0.com/mobile#refresh_token=RT1&state=other', 's1').error, 'a state that does not match is refused');
    check(!!SL.parseRedirect('https://frtest.auth0.com/mobile#id_token=X&state=s1', 's1').error, 'no refresh token: refused');
    check(SL.isRedirect('https://frtest.auth0.com/mobile#a') && !SL.isRedirect('https://frtest.auth0.com/login'), 'isRedirect');
    const w = world();
    const jwt = await SL.refreshJwt({ clientId: FAKE_CLIENT_ID, refreshToken: FAKE_REFRESH, post: w.post });
    check(jwt === FAKE_JWT, '/delegation returns the JWT');
    check(w.posted.url === 'https://frtest.auth0.com/delegation' && w.posted.form.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer'
      && w.posted.form.target === FAKE_CLIENT_ID && w.posted.form.scope === 'openid email given_name family_name picture', 'the delegation form');
    const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
    check(await codeOf(SL.refreshJwt({ clientId: FAKE_CLIENT_ID, refreshToken: FAKE_REFRESH, post: world({ refreshStatus: 401 }).post })) === 'sign-in', 'refused refresh token: sign in again');
    check(await codeOf(SL.refreshJwt({ clientId: FAKE_CLIENT_ID, refreshToken: FAKE_REFRESH, post: world({ refreshStatus: 503 }).post })) === 'server-timeout', 'Auth0 down: did not answer');
    check(await codeOf(SL.refreshJwt({ clientId: FAKE_CLIENT_ID, refreshToken: '', post: w.post })) === 'signed-out', 'no refresh token: signed out');
  }

  console.log('Redaction');
  {
    const t = SL.redact('application register name=POTACAT platform=Windows token=abc.def.ghi user auth0|5f00aa email a.b@example.com handle=WANHANDLE0001 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig radio_license_id=XYZ', ['mysecretid']);
    check(!/abc\.def|auth0\|5f|a\.b@|WANHANDLE|eyJhbGci|XYZ/.test(t), 'tokens, JWTs, user ids, email, WAN handle and licence id are removed: ' + t);
    check(SL.redact('client id is mysecretid', ['mysecretid']) === 'client id is <secret>', 'extra secrets (the client ID) are removed');
  }

  console.log('Server session: register, keep-alive, list, connect_ready (Part 2)');
  {
    const w = world();
    const srv = w.makeServer();
    const logs = [];
    srv.on('log', (l) => logs.push(l));
    const radios = await srv.open();
    check(w.serverOpts.host === 'smartlink.flexradio.com' && w.serverOpts.port === 443 && w.serverOpts.servername === 'smartlink.flexradio.com' && w.serverOpts.rejectUnauthorized !== false,
      'TLS to smartlink.flexradio.com:443 with the certificate verified');
    check(w.server.written[0] === `application register name=POTACAT platform=Windows token=${FAKE_JWT}\n`, 'the first line is application register with the fresh JWT');
    check(radios.length === 1 && srv.user && srv.user.callsign === 'K3SBP', 'radio list and the account callsign');
    await sleep(80);
    check(w.server.written.filter((l) => l === 'ping from client\n').length >= 2, 'ping from client on the keep-alive interval');
    const { handle } = await srv.connectRadio(SERIAL);
    check(handle === 'WANHANDLE0001' && w.server.written.includes(`application connect serial=${SERIAL} hole_punch_port=0\n`), 'application connect ... hole_punch_port=0 -> connect_ready handle');
    check(!logs.join('\n').includes(FAKE_JWT) && !logs.join('\n').includes(FAKE_CLIENT_ID), 'the log carries no JWT and no client ID');
    srv.close();
    const w2 = world({ noConnectReady: true });
    const s2 = w2.makeServer();
    let code = null; try { await s2.connectRadio(SERIAL); } catch (e) { code = e.code; }
    check(code === 'server-timeout', 'no connect_ready in time: "did not answer"');
    s2.close();
    const w3 = world({ registrationInvalid: true });
    code = null; try { await w3.makeServer().open(); } catch (e) { code = e.code; }
    check(code === 'sign-in', 'registration_invalid: sign in again');
  }

  console.log('The radio: C1|wan validate first, V/H by first character, hand-off to SmartSdrClient (Part 3)');
  {
    const w = world();
    const srv = w.makeServer();
    let pinSeen = null;
    const t = SL.smartLinkTransport({ server: srv, serial: SERIAL, connectTls: w.connectTls, getPins: () => ({}), onPin: (p) => { pinSeen = p; }, timeouts: { radioTlsMs: 200, wanValidateMs: 200 }, udp: { registerEveryMs: 1000, giveUpMs: 50 } });
    const c = new SmartSdrClient();
    c.on('error', () => {});
    let interlock = null;
    c.on('interlock', (kv) => { interlock = kv; });
    c.setTransport(t);
    c.connect('smartlink');
    await sleep(120);
    const rad = w.radios[0];
    check(w.radioOpts.host === '203.0.113.10' && w.radioOpts.port === 4994 && w.radioOpts.rejectUnauthorized === false, 'TLS to the radio\'s public address and forwarded TLS port (self-signed)');
    check(rad.written[0] === 'C1|wan validate handle=WANHANDLE0001\n', 'the FIRST line to the radio is the numbered wan validate');
    check(c.connected && c._clientHandle === '4A30F977', 'V and H (sent before the reply) reached the parser; the client is connected');
    check(interlock && interlock.timeout === '0', 'the radio\'s interlock timeout=0 status reached the parser');
    check(rad.written[1] === 'C2|sub client all\n', 'the client\'s commands follow from C2');
    check(!rad.written.some((l) => /client udpport/.test(l)), 'no client udpport over the WAN');
    check(pinSeen && pinSeen.status === 'first' && pinSeen.pins[SERIAL] === 'AA:BB', 'the radio\'s certificate is pinned per serial on first use');
    check(c.transportKind === 'smartlink', 'transportKind smartlink');
    c.disconnect();
    srv.close();
  }
  {
    // A radio that answers the validate with an error (the reply a bare wan validate gets).
    const script = [...NUMBERED.slice(0, 7), 'R1|50000021|'];
    const w = world({ radioScript: script });
    const srv = w.makeServer();
    let code = null;
    try { await SL.dialRadio({ server: srv, serial: SERIAL, connectTls: w.connectTls, onLine: () => {}, timeouts: { radioTlsMs: 200, wanValidateMs: 200 } }); } catch (e) { code = e.code; }
    check(code === 'wan-validate', '50000021 to wan validate is a named error');
    check(/did not accept/.test(SL.TEXT['wan-validate']), 'its sentence: ' + SL.TEXT['wan-validate']);
    srv.close();
    // What happens when it is sent bare (D0): V, H, status, and 50000021 to the NEXT command.
    check(BARE[BARE.length - 1] === 'R1|50000021|' && BARE[0] === 'V1.4.0.0' && /^H/.test(BARE[1]), 'D0: a bare wan validate gets V, H and then 50000021');
  }
  {
    const cases = [
      ['radio-offline', { list: ['radio list serial=9999-9999-9999-9999 model=FLEX-6400 status=Available|'] }],
      ['needs-hole-punch', { list: [SERVER[0].replace('public_tls_port=4994', 'public_tls_port=-1').replace('public_udp_port=4993', 'public_udp_port=-1')] }],
      ['radio-unreachable', { radioError: true }],
      ['server-timeout', { noConnectReady: true }],
    ];
    for (const [want, o] of cases) {
      const w = world(o);
      const srv = w.makeServer();
      let code = null;
      try { await SL.dialRadio({ server: srv, serial: SERIAL, connectTls: w.connectTls, onLine: () => {}, timeouts: { radioTlsMs: 150, wanValidateMs: 150 } }); } catch (e) { code = e.code; }
      check(code === want, `${want}: "${SL.TEXT[want]}"`);
      srv.close();
    }
    const p = SL.pinCheck({ [SERIAL]: 'AA:BB' }, SERIAL, 'CC:DD');
    check(p.status === 'changed' && p.pins[SERIAL] === 'AA:BB', 'a changed certificate is reported and the old pin kept');
    check(SL.pinCheck({ [SERIAL]: 'AA:BB' }, SERIAL, 'AA:BB').status === 'match', 'the same certificate matches');
  }

  console.log('Errors reach SmartSdrClient as named errors');
  {
    const w = world({ list: ['radio list serial=9999-9999-9999-9999 model=FLEX-6400 status=Available|'] });
    const srv = w.makeServer();
    const c = new SmartSdrClient();
    const errs = [];
    c.on('error', (e) => errs.push(e));
    c.setTransport(SL.smartLinkTransport({ server: srv, serial: SERIAL, connectTls: w.connectTls }));
    c.connect('smartlink');
    await sleep(60);
    check(errs[0] && errs[0].code === 'radio-offline' && !c.connected, 'radio-offline arrives as an error event; not connected');
    c.disconnect();
    srv.close();
  }

  console.log('F3000001 and 500000AA, from the capture');
  {
    const busy = NUMBERED.find((l) => /^R2\|F3000001\|/.test(l));
    check(busy && SL.parseReply(busy).status === 0xF3000001, 'client gui refused F3000001 "The maximum number of connected clients has been reached"');
    // Over SmartLink POTACAT never rides along with another GUI client (audio
    // would be refused): a refused `client gui` is reported, not turned into bound.
    const g = new SmartSdrClient();
    const sent = [];
    g.connected = true;
    g._sock = { write: (d) => { sent.push(d.trim()); return true; } };
    g.setGuiOnly(true);
    g._handleLine('S4A30F977|client 0x055DCE57 connected local_ptt=1 client_id=00000000-0000-0000-0000-000000000002 program=SmartSDR-Win station=SHACK');
    check(g._discoveredGuiClients.length === 1, 'another GUI client is on the radio');
    g._promoteOrBind();
    check(g.mode === 'self' && sent.some((l) => /\|client gui$/.test(l)), 'gui-only: POTACAT asks for its own GUI seat instead of riding along');
    let rejected = null;
    g.on('gui-rejected', (x) => { rejected = x; });
    g._handleLine(`R${g._guiSeq}|F3000001|The maximum number of connected clients has been reached`);
    check(rejected && rejected.status === 0xF3000001 && g.mode === 'none', 'F3000001 is reported as gui-rejected, never a fall back to bound');
    g._sock = null; g.connected = false;
    const na = NUMBERED.find((l) => /500000AA/.test(l));
    check(na && SL.parseReply(na).status === 0x500000AA, 'remote_audio_rx refused 500000AA for a non-GUI client');
    // The Opus audio object names the 500000AA refusal.
    const fakeClient = new EventEmitter();
    fakeClient.connected = true; fakeClient.guiReady = true;
    fakeClient._sendAwait = async () => ({ status: 0x500000AA, payload: 'Invalid command for this client type (SSL vs TCP or GUI vs NON-GUI)' });
    fakeClient._send = () => 1;
    const a = new Opus.SmartLinkOpusAudio({ client: fakeClient, makeDecoder: () => ({ decode: () => Buffer.alloc(0) }) });
    let fb = null;
    a.on('audio-fallback', (x) => { fb = x; });
    a.start();
    await sleep(10);
    check(fb && /500000AA/.test(fb.reason), 'audio falls back with the 500000AA reason named');
    const notGui = new Opus.SmartLinkOpusAudio({ client: { connected: true, guiReady: false, on() {}, removeListener() {} } });
    let fb2 = null; notGui.on('audio-fallback', (x) => { fb2 = x; }); notGui.start();
    check(fb2 && /GUI client/.test(fb2.reason), 'audio is never asked for unless POTACAT is the GUI client');
  }

  console.log('Opus framing (class 0x8005, 28-byte header, 10 ms frames)');
  {
    const fx = lines('d0-opus.txt');
    const hdrHex = fx[0].match(/header: ([0-9a-f]+)/)[1];
    const sizes = fx[1].split(': ')[1].split(',').map(Number);
    check(hdrHex.length === 56, 'the captured header is 28 bytes');
    check(sizes.every((n) => n >= 50 && n <= 104), 'captured payload sizes are 50-104 bytes');
    const hdr = Buffer.from(hdrHex, 'hex');
    check(hdr.readUInt16BE(14) === 0x8005 && (hdr.readUInt32BE(8) & 0xFFFFFF) === 0x1C2D, 'class 0x8005, FlexRadio OUI');
    check(hdr.readUInt16BE(2) * 4 === 28 + 100, 'its size field covers header + 100-byte payload');
    const pkt = Buffer.concat([hdr, Buffer.alloc(100, 7)]);
    const p = Opus.parseOpusPacket(pkt);
    check(p && p.streamId === 0x04000008 && p.payload.length === 100, 'parseOpusPacket: stream 0x04000008, 100-byte payload');
    check(Opus.parseOpusPacket(Buffer.concat([Buffer.from(hdrHex.replace('8005', '8002'), 'hex'), Buffer.alloc(100)])) === null, 'a meter packet is not Opus');
    let OpusEncoder = null;
    try { ({ OpusEncoder } = require('@discordjs/opus')); } catch { /* not built here */ }
    if (!OpusEncoder) {
      console.log('  skip real Opus round trip (@discordjs/opus not loadable here)');
    } else {
      // Encode a 1 kHz tone the way the radio sends it, then run it through the
      // receive path exactly as main.js does.
      const enc = new OpusEncoder(24000, 2);
      try { enc.setBitrate(54000); } catch {}
      const frames = [];
      for (let f = 0; f < 50; f++) {
        const pcm = Buffer.alloc(240 * 4);
        for (let i = 0; i < 240; i++) { const v = Math.round(Math.sin(2 * Math.PI * 1000 * (f * 240 + i) / 24000) * 8000); pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2); }
        frames.push(enc.encode(pcm));
      }
      const packets = frames.map((payload) => {
        const h = Buffer.from(hdr);
        h.writeUInt16BE(Math.ceil((28 + payload.length) / 4), 2);
        const pad = (4 - (payload.length % 4)) % 4;
        return Buffer.concat([h, payload, Buffer.alloc(pad)]);
      });
      const fakeClient = new EventEmitter();
      fakeClient.connected = true; fakeClient.guiReady = true;
      const sent = [];
      fakeClient._sendAwait = async (cmd) => { sent.push(cmd); return { status: 0, payload: '04000008' }; };
      fakeClient._send = (cmd) => { sent.push(cmd); return 2; };
      const a = new Opus.SmartLinkOpusAudio({ client: fakeClient });
      const out = [];
      let fb = null;
      a.on('audio-frame', (f) => out.push(f));
      a.on('audio-fallback', (x) => { fb = x; });
      a.start('ignored', 1, 'ignored');
      await sleep(5);
      check(sent[0] === 'stream create type=remote_audio_rx compression=opus', 'stream create type=remote_audio_rx compression=opus on the GUI connection');
      for (const pk of packets) fakeClient.emit('opus-packet', pk);
      check(!fb && out.length === 50, `every packet decodes (${out.length} frames, fallback ${fb && fb.reason})`);
      check(out[0].sampleRate === 24000 && out[0].pcm instanceof Float32Array && out[0].pcm.length === 240, '24 kHz mono Float32, 240 samples per 10 ms frame: the DAX RX frame shape');
      let ss = 0, n = 0;
      for (const f of out.slice(10)) for (const v of f.pcm) { ss += v * v; n++; }
      const rmsDb = 20 * Math.log10(Math.sqrt(ss / n));
      check(rmsDb > -25 && rmsDb < -6, `the tone comes back at a sane level (${rmsDb.toFixed(1)} dBFS)`);
      a.stop();
      check(sent.includes('stream remove 0x4000008'), 'stop() removes the stream');
      const sizesOut = frames.map((b) => b.length);
      check(sizesOut.slice(5).every((s) => s >= 40 && s <= 120), `encoded payloads in the captured range (${Math.min(...sizesOut.slice(5))}-${Math.max(...sizesOut.slice(5))} bytes)`);
    }
  }

  console.log('Test connection: the chain as a non-GUI client, then the UDP path');
  {
    const w = world();
    const srv = w.makeServer();
    const udp = new EventEmitter();
    udp.bind = (_p, cb) => setImmediate(cb);
    udp.close = () => {};
    udp.send = (b, port, host) => {
      udp.lastSend = { text: b.toString(), port, host };
      const v = Buffer.alloc(32); v.writeUInt32BE(0x38500008, 0); v.writeUInt32BE(0x00001C2D, 8); v.writeUInt32BE(0x534C8002, 12);
      setImmediate(() => udp.emit('message', v));
    };
    const r = await SL.testRadio({ server: srv, serial: SERIAL, connectTls: w.connectTls, createUdp: () => udp, pins: {}, timeouts: { testUdpMs: 200 } });
    check(r.ok, 'ok: ' + r.text);
    check(udp.lastSend.host === '203.0.113.10' && udp.lastSend.port === 4993 && /^client udp_register handle=0x4A30F977$/.test(udp.lastSend.text), 'udp_register to the radio\'s public UDP port with its handle');
    check(!w.radios[0].written.some((l) => /client gui/.test(l)), 'the test never takes the GUI seat');
    check(/in use by POTACAT/.test(r.text), 'and it says who holds the radio');
    srv.close();
    const w2 = world();
    const silent = new EventEmitter(); silent.bind = (_p, cb) => setImmediate(cb); silent.close = () => {}; silent.send = () => {};
    const r2 = await SL.testRadio({ server: w2.makeServer(), serial: SERIAL, connectTls: w2.connectTls, createUdp: () => silent, timeouts: { testUdpMs: 80 } });
    check(!r2.ok && r2.code === 'udp-blocked' && /blocks the audio path/.test(r2.text), 'no UDP: "Connected, but your radio\'s network blocks the audio path."');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, 'smartlink session tests failed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
