// ECHOCAT protocol contract tests (remote-desktop Phase 1 foundation).
//
// lib/echocat-protocol.js is the wire contract shared by the desktop server,
// the desktop-as-client (RemoteClient), the web client, and the mobile app.
// These hermetic tests lock that contract down so a careless schema edit
// can't silently break a paired shack or the mobile app — and verify that
// RemoteClient's outbound frames actually conform to the registry (direction
// + field shapes), which is the half a human can't eyeball across files.
//
// Run: node test/echocat-protocol-test.js
'use strict';

const P = require('../lib/echocat-protocol');
const { RemoteClient } = require('../lib/remote-client');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// ── Registry integrity ──────────────────────────────────────────────
console.log('=== registry integrity ===');
const dirs = new Set([P.Dir.S2C, P.Dir.C2S, P.Dir.BOTH]);
let allHaveDir = true, allFieldsSane = true;
for (const [type, def] of Object.entries(P.MESSAGES)) {
  if (!dirs.has(def.dir)) { allHaveDir = false; console.log('    bad dir on ' + type); }
  if (def.fields) {
    for (const [fname, spec] of Object.entries(def.fields)) {
      if (!spec || typeof spec.type !== 'string') { allFieldsSane = false; console.log(`    bad field spec ${type}.${fname}`); }
    }
  }
}
check(allHaveDir, 'every message has a valid direction');
check(allFieldsSane, 'every declared field has a type spec');
check(P.PROTOCOL_VERSION === 1, 'PROTOCOL_VERSION is 1');
check(P.isKnownType('tune') && !P.isKnownType('nope'), 'isKnownType works');

// ── validate(): required / types / optional / oneOf ─────────────────
console.log('\n=== validate() ===');
check(P.validate({ type: 'tune', freqKhz: '14074.000' }).ok, 'tune with freqKhz string is valid');
check(!P.validate({ type: 'tune' }).ok, 'tune missing required freqKhz is invalid');
check(!P.validate({ type: 'tune', freqKhz: 14074 }).ok, 'tune with numeric freqKhz is invalid (must be string)');
check(P.validate({ type: 'tune', freqKhz: '14074.000', mode: 'USB', bearing: 90 }).ok, 'tune with optional mode+bearing valid');
check(!P.validate({ type: 'tune', freqKhz: '1', bearing: 'NE' }).ok, 'tune with non-number bearing invalid');
check(!P.validate({ type: 'nope' }).ok, 'unknown type invalid');
check(!P.validate(null).ok && !P.validate(42).ok, 'non-object invalid');
check(!P.validate({}).ok, 'missing type invalid');
check(P.validate({ type: 'ptt', state: true }).ok && !P.validate({ type: 'ptt', state: 1 }).ok, 'ptt requires boolean state');

// ── Direction enforcement ───────────────────────────────────────────
console.log('\n=== direction enforcement ===');
check(P.validate({ type: 'tune', freqKhz: '1' }, P.Dir.C2S).ok, 'c2s tune accepted as c2s');
check(!P.validate({ type: 'tune', freqKhz: '1' }, P.Dir.S2C).ok, 'c2s tune REJECTED as s2c (client can\'t receive it)');
check(P.validate({ type: 'spots', data: [] }, P.Dir.S2C).ok, 's2c spots accepted as s2c');
check(!P.validate({ type: 'spots', data: [] }, P.Dir.C2S).ok, 's2c spots REJECTED as c2s (server can\'t receive it)');
check(P.validate({ type: 'hello', protocolVersion: 1 }, P.Dir.C2S).ok &&
      P.validate({ type: 'hello', protocolVersion: 1 }, P.Dir.S2C).ok, 'BOTH-dir hello accepted either way');

// ── parse() / encode() ──────────────────────────────────────────────
console.log('\n=== parse() / encode() ===');
check(!P.parse('{not json').ok, 'parse rejects invalid JSON');
check(!P.parse('{"type":"nope"}').ok, 'parse rejects unknown type');
const round = P.parse(P.encode({ type: 'set-mode', mode: 'CW' }));
check(round.ok && round.msg.mode === 'CW', 'encode→parse round-trips');
let threw = false;
try { P.encode({ type: 'tune' }); } catch (e) { threw = e.code === 'PROTOCOL_INVALID'; }
check(threw, 'encode throws PROTOCOL_INVALID on a bad message');
check(typeof P.encode({ type: 'status', whatever: 1 }, { skipValidate: true }) === 'string', 'encode skipValidate bypasses validation');

// ── Handshake builders + Phase-1 fields ─────────────────────────────
console.log('\n=== handshake + Phase-1 fields ===');
const sh = P.buildServerHello({ serverVersion: '1.8.13', rigModel: 'Flex 8600M', capabilities: ['x'] });
check(sh.type === 'hello' && sh.protocolVersion === 1 && sh.rigModel === 'Flex 8600M', 'buildServerHello carries rigModel');
check(P.validate(sh).ok, 'server hello validates');
const ch = P.buildClientHello({ clientVersion: 'desktop/1.8.13', clientPlatform: 'desktop-win', capabilities: ['qso-attributed'] });
check(P.validate(ch).ok && Array.isArray(ch.capabilities), 'client hello validates + carries capabilities');
// auth-ok Phase-1 fields (drive re-pair nudge + trust badges) are optional but must type-check.
check(P.validate({ type: 'auth-ok', expiresAt: 1718e9, accountLinked: true, trusted: false }).ok, 'auth-ok accepts expiresAt/accountLinked/trusted');
check(P.validate({ type: 'auth-ok' }).ok, 'auth-ok valid with all fields absent (legacy/guest)');
check(!P.validate({ type: 'auth-ok', expiresAt: 'soon' }).ok, 'auth-ok rejects non-number expiresAt');

// ── checkCompatibility ──────────────────────────────────────────────
console.log('\n=== checkCompatibility ===');
check(P.checkCompatibility(1).compatible === true, 'same version compatible');
check(P.checkCompatibility(0).compatible === true && P.checkCompatibility(0).downgrade === true, 'one behind → compatible+downgrade');
check(P.checkCompatibility(3).compatible === false, 'two ahead → incompatible');
check(P.checkCompatibility('x').compatible === false, 'non-integer → incompatible');

// ── New Phase-1 messages (scan + watchlist sync) ────────────────────
console.log('\n=== Phase-1 additions: scan + watchlist sync ===');
check(P.validate({ type: 'scan:control', action: 'start' }, P.Dir.C2S).ok, 'scan:control start valid (c2s)');
check(P.validate({ type: 'scan:control', action: 'skip', spotId: 'US-0512' }, P.Dir.C2S).ok, 'scan:control skip + spotId valid');
check(!P.validate({ type: 'scan:control', action: 'pause' }).ok, 'scan:control rejects unknown action (oneOf)');
check(!P.validate({ type: 'scan:control', action: 'start' }, P.Dir.S2C).ok, 'scan:control is c2s-only');
check(P.validate({ type: 'scan:state', running: true, currentRef: 'US-0512', dwellRemaining: 4.2, skip: [] }, P.Dir.S2C).ok, 'scan:state full payload valid (s2c)');
check(P.validate({ type: 'scan:state', running: false }, P.Dir.S2C).ok, 'scan:state minimal payload valid');
check(!P.validate({ type: 'scan:state', running: 'yes' }).ok, 'scan:state rejects non-boolean running');
check(!P.validate({ type: 'scan:state', running: true }, P.Dir.C2S).ok, 'scan:state is s2c-only');
check(P.validate({ type: 'watchlist:sync', callsigns: ['K3SBP'] }, P.Dir.C2S).ok &&
      P.validate({ type: 'watchlist:sync', callsigns: ['K3SBP'], groups: [] }, P.Dir.S2C).ok, 'watchlist:sync flows BOTH ways');
check(!P.validate({ type: 'watchlist:sync' }).ok, 'watchlist:sync requires callsigns');

// ── Phase-2 audio leg: stun-config + signal (registered contract) ───
console.log('\n=== Phase-2 audio leg: stun-config + signal ===');
check(P.validate({ type: 'stun-config', useStun: true }, P.Dir.S2C).ok, 'stun-config minimal (useStun) valid s2c');
check(P.validate({ type: 'stun-config', useStun: true, iceTtlMs: 3600000,
  iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }] }, P.Dir.S2C).ok, 'stun-config with iceServers+iceTtlMs valid');
check(!P.validate({ type: 'stun-config', iceServers: 'nope' }).ok, 'stun-config rejects non-array iceServers');
check(!P.validate({ type: 'stun-config', useStun: true }, P.Dir.C2S).ok, 'stun-config is s2c-only');
check(P.validate({ type: 'signal', data: { type: 'start-audio' } }, P.Dir.C2S).ok &&
      P.validate({ type: 'signal', data: { type: 'sdp', sdp: {} } }, P.Dir.S2C).ok, 'signal flows BOTH ways (offer/answer/ice/start-audio envelope)');

// ── RemoteClient frames conform to the contract ─────────────────────
// The desktop-as-client builds frames in lib/remote-client.js; assert each
// is a registered c2s message that passes validate() with the right shape.
console.log('\n=== RemoteClient outbound frames conform ===');
const rc = new RemoteClient({ id: 't1', name: 'Test Shack' });
const sent = [];
rc._send = (m) => sent.push(m); // intercept; never touches the network

rc.sendTune({ frequency: 14074000, mode: 'USB', bearing: 90 });
rc.sendTune({ frequency: 0 }); // falsy → must be a no-op (no frame)
rc.sendSetMode('CW');
rc.sendPtt(true);
rc.sendEstop();
rc.sendSetVfo('B');
rc.sendSwapVfo();

check(sent.length === 6, 'sendTune(0) is a no-op; 6 real frames emitted');
const tune = sent.find(m => m.type === 'tune');
check(tune && typeof tune.freqKhz === 'string' && tune.freqKhz === '14074.000', 'sendTune emits freqKhz as a STRING in kHz (not Hz, not number)');
let allConform = true;
for (const m of sent) {
  const v = P.validate(m, P.Dir.C2S);
  if (!v.ok) { allConform = false; console.log(`    nonconforming frame ${m.type}: ${v.error}`); }
}
check(allConform, 'every RemoteClient frame validates as a c2s message');
check(sent.find(m => m.type === 'ptt').state === true, 'sendPtt(true) → boolean state');
check(sent.find(m => m.type === 'set-vfo').vfo === 'B', 'sendSetVfo carries vfo string');

console.log('\n' + '='.repeat(52));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
