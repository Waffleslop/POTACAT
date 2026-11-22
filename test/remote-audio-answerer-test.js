// Unit tests for the desktop-client WebRTC answerer module's ORCHESTRATION
// (renderer/remote-audio-answerer.js) — when it answers, ICE buffering,
// relay-only, mic gating, teardown, AND the double-CGNAT-critical property:
// the peer connection is built LAZILY so it's born with the shack's TURN
// iceServers (relay-capable) rather than retrofitting them after the fact.
// WebRTC + getUserMedia are mocked so this runs in pure Node (the REAL media
// path is covered by the Chromium loopback in test-output/answerer-loopback-test.js).
// Run: node test/remote-audio-answerer-test.js
'use strict';

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// ── Mock WebRTC + media into the global the module reads ─────────────
const calls = { addTrack: 0, addTransceiver: 0, addIce: [], setRemote: [], setLocal: [], setConfiguration: [], closed: 0, constructed: [] };
// Stats fixture: a connected session that relayed (both ends 'relay').
function makeStats(localType, remoteType) {
  const m = new Map();
  m.set('T1', { type: 'transport', selectedCandidatePairId: 'P1' });
  m.set('P1', { type: 'candidate-pair', id: 'P1', nominated: true, state: 'succeeded', localCandidateId: 'L1', remoteCandidateId: 'R1' });
  m.set('L1', { type: 'local-candidate', id: 'L1', candidateType: localType, protocol: 'udp' });
  m.set('R1', { type: 'remote-candidate', id: 'R1', candidateType: remoteType, protocol: 'udp' });
  return m;
}
let nextStats = makeStats('relay', 'relay');
class FakePC {
  constructor(config) { this.config = config; calls.constructed.push(config); this.remoteDescription = null; this.localDescription = null;
    this.connectionState = 'new'; this.iceConnectionState = 'new';
    this.ontrack = null; this.onicecandidate = null; this.onconnectionstatechange = null; this.oniceconnectionstatechange = null; }
  addTrack() { calls.addTrack++; }
  addTransceiver() { calls.addTransceiver++; }
  async setRemoteDescription(d) { calls.setRemote.push(d); this.remoteDescription = d; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nanswer-sdp' }; }
  async setLocalDescription(d) { calls.setLocal.push(d); this.localDescription = d; }
  async addIceCandidate(c) { calls.addIce.push(c); }
  setConfiguration(c) { calls.setConfiguration.push(c); }
  async getStats() { return nextStats; }
  close() { calls.closed++; }
}
let micEnabled = true; let micStopped = 0;
const fakeTrack = { kind: 'audio', get enabled() { return micEnabled; }, set enabled(v) { micEnabled = v; }, stop() { micStopped++; } };
const fakeStream = { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] };

global.RTCPeerConnection = FakePC;
global.MediaStream = function () {};

const { RemoteAudioAnswerer, playbackVolume } = require('../renderer/remote-audio-answerer.js');

const TURN = [{ urls: ['turn:turn.cloudflare.com:3478', 'turns:turn.cloudflare.com:5349'], username: 'u', credential: 'c' }];

(async () => {
  // ── start(): mic captured (muted), start-audio sent, pc NOT built yet ──
  console.log('=== start() defers the peer connection ===');
  const out = [];
  const states = [];
  const a = new RemoteAudioAnswerer({
    getUserMedia: async () => { micEnabled = true; return fakeStream; },
    onSignal: (d) => out.push(d),
    onTrack: () => {},
    onState: (s) => states.push(s),
  });
  await a.start();
  check(out.some(d => d.type === 'start-audio'), 'start() emits start-audio to the shack');
  check(micEnabled === false, 'mic is MUTED by default (no VOX) until PTT');
  check(a._pc === null, 'pc is NOT built in start() — deferred until the offer (double-CGNAT correctness)');

  // ── stun-config arrives AFTER start (the real wire order) ─────────────
  console.log('\n=== stun-config(TURN) after start, then offer → pc born relay-capable ===');
  a.setIceConfig({ iceServers: TURN });
  check(states.some(s => s.adopted && s.adopted.servers === 1 && s.adopted.relay === 1), 'setIceConfig reports adopted {servers:1, relay:1} for the [CAT] log');
  check(a._pc === null, 'still no pc just from stun-config (we are the answerer; pc waits for the offer)');
  await a.handleSignal({ type: 'sdp', sdp: { type: 'offer', sdp: 'v=0\r\noffer' } });
  check(a._pc !== null, 'offer builds the pc');
  const cfg = calls.constructed[calls.constructed.length - 1];
  check(cfg && Array.isArray(cfg.iceServers) && cfg.iceServers[0].username === 'u', 'pc CONSTRUCTED with the TURN iceServers (not retrofitted) — relay candidates can gather');
  check(calls.addTrack === 1, 'mic track added to the peer (TX path) when pc is built');
  const ans = out.find(d => d.type === 'sdp');
  check(ans && ans.sdp && ans.sdp.type === 'answer', 'emits an SDP answer back to the shack');
  check(calls.setLocal.some(d => d.type === 'answer'), 'answer applied via setLocalDescription');

  // ── selected-pair diagnostic on ICE connected ────────────────────────
  console.log('\n=== selected candidate pair reported (relay proof) ===');
  states.length = 0;
  nextStats = makeStats('relay', 'relay');
  a._pc.iceConnectionState = 'connected';
  a._pc.oniceconnectionstatechange();
  await new Promise(r => setTimeout(r, 0));
  check(states.some(s => s.selectedPair && s.selectedPair.local === 'relay' && s.selectedPair.remote === 'relay'),
    'connected → reports selectedPair {local:relay, remote:relay} (the double-CGNAT win)');

  // ── relayOnly forces relay transport policy at construction ───────────
  console.log('\n=== relayOnly (forced relay for testing) ===');
  calls.constructed.length = 0;
  const r = new RemoteAudioAnswerer({ getUserMedia: async () => fakeStream, onSignal: () => {}, onTrack: () => {}, onState: () => {} });
  r.setIceConfig({ iceServers: TURN, relayOnly: true });
  await r.start();
  await r.handleSignal({ type: 'sdp', sdp: { type: 'offer', sdp: 'o' } });
  const rcfg = calls.constructed[calls.constructed.length - 1];
  check(rcfg && rcfg.iceTransportPolicy === 'relay', 'relayOnly → pc built with iceTransportPolicy:relay');

  // ── live re-mint: stun-config while pc exists → setConfiguration ──────
  console.log('\n=== live re-mint applies via setConfiguration ===');
  calls.setConfiguration.length = 0;
  r.setIceConfig({ iceServers: TURN });
  check(calls.setConfiguration.length >= 1, 'a stun-config that arrives while the pc is live calls setConfiguration (re-mint path)');

  // ── ICE buffering: candidate before offer is held, drained after ─────
  console.log('\n=== ICE buffering ===');
  const b = new RemoteAudioAnswerer({ getUserMedia: async () => fakeStream, onSignal: () => {}, onTrack: () => {}, onState: () => {} });
  calls.addIce.length = 0;
  await b.start();
  await b.handleSignal({ type: 'ice', candidate: { candidate: 'early', sdpMid: '0', sdpMLineIndex: 0 } });
  check(calls.addIce.length === 0, 'ICE arriving BEFORE the offer is buffered, not applied');
  await b.handleSignal({ type: 'sdp', sdp: { type: 'offer', sdp: 'o' } });
  check(calls.addIce.some(c => c.candidate === 'early'), 'buffered ICE is drained after the offer applies');
  await b.handleSignal({ type: 'ice', candidate: { candidate: 'late', sdpMid: '0', sdpMLineIndex: 0 } });
  check(calls.addIce.some(c => c.candidate === 'late'), 'ICE arriving AFTER the offer is applied immediately');

  // ── PTT mic gating ──────────────────────────────────────────────────
  console.log('\n=== PTT mic gating ===');
  micEnabled = false;
  a.setMicEnabled(true);
  check(micEnabled === true, 'setMicEnabled(true) opens the mic for PTT');
  a.setMicEnabled(false);
  check(micEnabled === false, 'setMicEnabled(false) closes the mic');

  // ── onTrack fires playback ──────────────────────────────────────────
  console.log('\n=== onTrack ===');
  let track = null;
  const c = new RemoteAudioAnswerer({ getUserMedia: async () => fakeStream, onSignal: () => {}, onTrack: (s) => { track = s; }, onState: () => {} });
  c.setIceConfig({ iceServers: TURN });
  await c.start();
  await c.handleSignal({ type: 'sdp', sdp: { type: 'offer', sdp: 'o' } });
  c._pc.ontrack({ streams: [fakeStream], track: fakeTrack });
  check(track === fakeStream, 'ontrack forwards the rig stream to playback');

  // ── stop() tears down ───────────────────────────────────────────────
  console.log('\n=== stop() ===');
  const before = calls.closed;
  micStopped = 0;
  a.stop();
  check(calls.closed === before + 1, 'stop() closes the peer connection');
  check(micStopped === 1, 'stop() stops the mic track');
  check(a._pc === null, 'pc reference cleared');

  // ── Receive audio is silent while this computer transmits ───────────
  // (IC-7610 remote, 2026-11-15: open speakers fed the mic back to the shack.)
  console.log('\n=== playbackVolume ===');
  check(playbackVolume({ volume: 0.8, muted: false, transmitting: false }) === 0.8, 'receive plays at the chosen volume');
  check(playbackVolume({ volume: 0.8, muted: false, transmitting: true }) === 0, 'receive is silent while transmitting');
  check(playbackVolume({ volume: 0.8, muted: true, transmitting: false }) === 0, 'muted stays silent');
  check(playbackVolume({ volume: 3 }) === 1, 'volume clamps to 1');
  check(playbackVolume({ volume: -1 }) === 0, 'volume clamps to 0');
  check(playbackVolume({}) === 1, 'no volume set plays at full');
  const clientHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'remote-audio-client.html'), 'utf8');
  check(/onPtt\(\(on\) => \{[\s\S]*?transmitting = !!on;[\s\S]*?applyVolume\(\);/.test(clientHtml), 'the client window silences receive audio on PTT');
  check(!/el\.volume = cfg\.muted/.test(clientHtml), 'the client window sets volume only through playbackVolume');

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
