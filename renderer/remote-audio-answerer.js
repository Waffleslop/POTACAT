// WebRTC ANSWERER for the desktop-as-client audio leg (remote-desktop
// Phase 2). The shack is the OFFERER (lib/remote-audio bridge); this desktop
// receives its SDP offer + ICE + TURN iceServers (via stun-config), answers,
// plays the rig RX audio, and sends its mic for PTT TX.
//
// Deliberately PURE: no IPC, no DOM lookups, no globals. The transport is
// injected (onSignal to send to the shack, onTrack to play received audio,
// getUserMedia for the mic). That keeps the renderer shim
// (remote-audio-client.html) thin AND makes this unit-testable against a
// real loopback offerer in a browser (test-output/answerer-loopback-test.js)
// instead of only being eyeballed. Mirrors the proven answerer in
// renderer/remote.js, minus the UI.
(function (global) {
  'use strict';

  class RemoteAudioAnswerer {
    constructor(opts) {
      opts = opts || {};
      this._onSignal = opts.onSignal || function () {}; // (data) -> send to shack (wrapped in `signal` upstream)
      this._onTrack = opts.onTrack || function () {};   // (MediaStream) -> play rig audio
      this._onState = opts.onState || function () {};    // (state) -> diagnostics/status
      // Injectable for tests; defaults to the platform getUserMedia.
      this._getUserMedia = opts.getUserMedia ||
        ((c) => global.navigator.mediaDevices.getUserMedia(c));
      this._pc = null;
      this._mic = null;
      this._iceServers = [];
      this._relayOnly = false;
      this._started = false;
      this._pairReported = false;
      // ICE that arrives before we've applied the remote offer must be
      // buffered, or addIceCandidate throws and the candidate is lost.
      this._pendingIce = [];
      this._micDeviceId = '';
    }

    // The microphone to open at start() ('' = the system default). A chosen
    // device that cannot be opened is reported, never swapped for another
    // (the audio rule: a chosen device is never silently replaced).
    setMicDeviceId(id) { this._micDeviceId = String(id || ''); }

    // Adopt ICE config from the shack's stun-config. Full TURN iceServers
    // when present (Model A), else legacy STUN, else local-only.
    //
    // CRITICAL for double-CGNAT: the peer connection is created LAZILY (in
    // handleSignal, on the offer) — NOT in start() — precisely so that by the
    // time `new RTCPeerConnection(...)` runs, these relay iceServers are
    // already in `this._iceServers` and the pc is born able to gather `relay`
    // candidates. The shack sends stun-config(TURN) BEFORE the offer, so the
    // ordering holds. The setConfiguration() call below only matters for a
    // LIVE re-mint mid-session (the pc already exists); a fresh negotiation
    // never depends on it. (Earlier this built the pc eagerly in start() with
    // empty iceServers and relied on setConfiguration to retrofit TURN — that
    // worked in Chromium but was fragile; relay is too important to leave to a
    // best-effort retrofit.)
    setIceConfig(cfg) {
      cfg = cfg || {};
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
        this._iceServers = cfg.iceServers;
      } else if (cfg.useStun) {
        this._iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      } // else: leave as-is (don't let a bare useStun ping wipe a TURN list)
      if (typeof cfg.relayOnly === 'boolean') this._relayOnly = cfg.relayOnly;
      // Diagnostic: how many servers, how many are relay (turn:/turns:). Lets
      // the [CAT] log confirm the answerer actually adopted relay creds — the
      // make-or-break fact for double-CGNAT.
      this._onState({ adopted: { servers: this._iceServers.length, relay: this._relayServerCount() } });
      if (this._pc) {
        // Live re-mint only — the pc already gathered with the prior config.
        try { this._pc.setConfiguration(this._rtcConfig()); } catch (e) { /* not all engines allow live setConfiguration */ }
      }
    }

    // Count relay (turn:/turns:) servers in the adopted iceServers list.
    _relayServerCount() {
      let n = 0;
      for (const s of (this._iceServers || [])) {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        if (urls.some((u) => /^turns?:/i.test(String(u || '')))) n++;
      }
      return n;
    }

    _rtcConfig() {
      const c = { iceServers: this._iceServers };
      if (this._relayOnly) c.iceTransportPolicy = 'relay'; // force relay for testing
      return c;
    }

    // Begin: grab the mic (for PTT), build the peer, ask the shack to start.
    async start() {
      if (this._started) return;
      this._started = true;
      try {
        const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        if (this._micDeviceId) audio.deviceId = { exact: this._micDeviceId };
        this._mic = await this._getUserMedia({ audio });
        // Muted until PTT — no VOX, no accidental open mic.
        this._mic.getAudioTracks().forEach((t) => { t.enabled = false; });
      } catch (e) {
        this._onState({ error: 'mic: ' + (e && e.message || e) });
        // RX-only still works (recvonly transceiver below).
      }
      // NOTE: do NOT build the peer connection here. It's created lazily in
      // handleSignal() once the shack's stun-config (TURN creds) has arrived,
      // so the pc is born relay-capable. See setIceConfig().
      this._onSignal({ type: 'start-audio' });
    }

    _ensurePc() {
      if (this._pc) return this._pc;
      const RTCPC = global.RTCPeerConnection || (global.window && global.window.RTCPeerConnection);
      const pc = new RTCPC(this._rtcConfig());
      this._pc = pc;
      if (this._mic && this._mic.getTracks().length) {
        for (const t of this._mic.getTracks()) pc.addTrack(t, this._mic);
      } else {
        // No mic → still negotiate an audio m-line so we RECEIVE rig audio.
        try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch (e) {}
      }
      pc.ontrack = (ev) => {
        const stream = (ev.streams && ev.streams[0]) || new (global.MediaStream || global.window.MediaStream)([ev.track]);
        this._onTrack(stream);
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this._onSignal({ type: 'ice', candidate: {
            candidate: ev.candidate.candidate,
            sdpMid: ev.candidate.sdpMid,
            sdpMLineIndex: ev.candidate.sdpMLineIndex,
          } });
        }
      };
      pc.onconnectionstatechange = () => { this._onState({ connectionState: pc.connectionState }); };
      pc.oniceconnectionstatechange = () => {
        this._onState({ iceConnectionState: pc.iceConnectionState });
        // Once connected, report which candidate types won — the definitive
        // proof of whether double-CGNAT actually relayed. host/srflx = direct;
        // relay = went through TURN. Surfaced to the [CAT] log via main.
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          this._reportSelectedPair(pc);
        }
      };
      return pc;
    }

    // Pull the selected ICE candidate pair from getStats and report its
    // local/remote candidate types. Best-effort; no-op where getStats is
    // unavailable (e.g. the unit-test FakePC).
    _reportSelectedPair(pc) {
      if (!pc || typeof pc.getStats !== 'function' || this._pairReported) return;
      pc.getStats().then((stats) => {
        let selId = null; const pairs = {}, cands = {};
        stats.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) selId = r.selectedCandidatePairId;
          else if (r.type === 'candidate-pair') pairs[r.id] = r;
          else if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
        });
        let pair = selId && pairs[selId];
        if (!pair) { for (const id in pairs) { if (pairs[id].nominated && pairs[id].state === 'succeeded') { pair = pairs[id]; break; } } }
        if (!pair) return;
        const lc = cands[pair.localCandidateId] || {}, rc = cands[pair.remoteCandidateId] || {};
        this._pairReported = true;
        this._onState({ selectedPair: { local: lc.candidateType || '?', remote: rc.candidateType || '?', protocol: lc.protocol || '?' } });
      }).catch(() => {});
    }

    // Inbound WebRTC payload from the shack: { type:'sdp', sdp } | { type:'ice', candidate }.
    async handleSignal(data) {
      if (!data || !data.type) return;
      const pc = this._ensurePc();
      try {
        if (data.type === 'sdp' && data.sdp) {
          if (data.sdp.type === 'offer') {
            await pc.setRemoteDescription(data.sdp);
            for (const c of this._pendingIce.splice(0)) {
              try { await pc.addIceCandidate(c); } catch (e) {}
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this._onSignal({ type: 'sdp', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
          } else if (data.sdp.type === 'answer') {
            // We answer, so this is unusual; apply defensively for renegotiation.
            await pc.setRemoteDescription(data.sdp);
          }
        } else if (data.type === 'ice' && data.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(data.candidate);
          } else {
            this._pendingIce.push(data.candidate);
          }
        }
      } catch (e) {
        this._onState({ error: 'signal: ' + (e && e.message || e) });
      }
    }

    // PTT: open/close the mic track during transmit.
    setMicEnabled(on) {
      if (this._mic) this._mic.getAudioTracks().forEach((t) => { t.enabled = !!on; });
    }

    stop() {
      this._started = false;
      this._pairReported = false;
      if (this._pc) { try { this._pc.close(); } catch (e) {} this._pc = null; }
      if (this._mic) { this._mic.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); this._mic = null; }
      this._pendingIce = [];
    }
  }

  // CommonJS (renderer require / future test) + browser global (script tag).
  if (typeof module !== 'undefined' && module.exports) module.exports = { RemoteAudioAnswerer };
  global.RemoteAudioAnswerer = RemoteAudioAnswerer;
})(typeof window !== 'undefined' ? window : globalThis);
