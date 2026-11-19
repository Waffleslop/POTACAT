// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS phase 7: ONE manual beacon over the radio, 2 m (1200 baud FM) or 30 m
// (300 baud USB). Nothing here runs on a timer: the operator presses
// "Beacon now (radio)", confirms the line that shows band, frequency and
// power, and exactly one frame goes out.
//
//   K3SBP>APZPCT,WIDE1-1,WIDE2-1:!4030.  N/07502.  W-POTACAT   (2 m)
//   K3SBP>APZPCT,WIDE1-1:!4030.  N/07502.  W-POTACAT           (30 m)
//
// - The information field is phase 5's (lib/aprs-beacon.js buildBeacon):
//   symbol, comment, approximate position on by default. Only the header
//   differs: our tocall APZPCT, an RF path, and the station's own call.
// - Source: the Settings callsign, with its SSID when it has one (1-15),
//   never the internet -10 the APRS-IS beacon uses (aprs.org SSIDs.txt keeps
//   -10 for internet stations).
// - Path, 2 m: WIDE1-1,WIDE2-1, the New-N paradigm path for fixed and mobile
//   stations (Casey's brief).
// - Path, 30 m: WIDE1-1, one hop at most. HF APRS has no WIDE2 network: the
//   30 m RPR network's own page asks every station that wants digipeating to
//   use "only using WIDE1-1 in their path"
//   (privat.bahnhof.se/wb758759/effective-30m-network.html), and WB4APR's HF
//   notes have HF stations use a single short hop (GATE, or GATE,WIDE1-1;
//   README.HF in APRS 3.08). The two 30 m stations decoded on 2026-11-18
//   (W4TTU-10, VE2SIL-1) sent no path at all; iGates gate either.
//
// The cap (capFor): POTACAT unkeys on its own when one transmission runs past
// TXDELAY + the frame's air time (worst-case bit stuffing) + TXTAIL + the
// unkey hold, times 1.25, plus 250 ms. About 2 s on 2 m, 3.6 s on 30 m with
// the default comment, under 6 s on 30 m with the longest. It is a backstop
// timer of POTACAT's own, independent of Dire Wolf; lib/tx-limit.js has a
// looser per-kind ceiling behind it.
//
// The run (createRfBeacon): take the radio ('aprs'), start the shim and the
// transmit Dire Wolf, hand over the one frame, key at Dire Wolf's request
// (only when lib/aprs-rf-gate.js mayKey says so), unkey at its request or at
// the cap, and always end by letting the radio go and bringing the
// listen-only Dire Wolf back. Every key-down outside that is refused and
// logged. Pure apart from the injected deps.
'use strict';

const AprsBeacon = require('./aprs-beacon');
const { encodeAgwFrame } = require('./direwolf-agw-monitor');

const PATHS = Object.freeze({ '2m': Object.freeze(['WIDE1-1', 'WIDE2-1']), '30m': Object.freeze(['WIDE1-1']) });
const BAUD = Object.freeze({ '2m': 1200, '30m': 300 });
const TX_KIND = Object.freeze({ '2m': 'aprs2m', '30m': 'aprs30m' });
const BAND_LABEL = Object.freeze({ '2m': '2 m', '30m': '30 m' });
const REQUEST_TIMEOUT_MS = 75000; // Dire Wolf drops a frame after 60 s of busy channel (src/xmit.c); 15 s more for its start

/** The RF source: the Settings call's base, with its own SSID 1-15 if it has one. */
function rfSource(settingsCall, base) {
  const raw = String(settingsCall || '').trim().toUpperCase();
  const m = /-(\d{1,2})$/.exec(raw);
  const ssid = m ? Number(m[1]) : 0;
  return ssid >= 1 && ssid <= 15 ? `${base}-${ssid}` : base;
}

/**
 * The beacon packet for the air, or a refusal.
 * @returns {{ok:true, packet, source, dest, path:string[], info, band}|{ok:false, reason, sentence}}
 */
function buildRfBeacon({ settingsCall, band, lat, lon, symbol, comment, approx }) {
  if (!PATHS[band]) return { ok: false, reason: 'no-band', sentence: 'There is no APRS beacon for this band.' };
  const is = AprsBeacon.buildBeacon({ settingsCall, lat, lon, symbol, comment, approx });
  if (!is.ok) return is;
  const info = is.packet.slice(is.packet.indexOf(':') + 1);
  const base = is.call.replace(/-\d+$/, '');
  const source = rfSource(settingsCall, base);
  const path = PATHS[band].slice();
  const packet = `${source}>${AprsBeacon.TOCALL}${path.length ? ',' + path.join(',') : ''}:${info}`;
  return { ok: true, packet, source, dest: AprsBeacon.TOCALL, path, info, band };
}

/** What Dire Wolf's AGW 'V' command needs. */
function agwRequest(b) {
  return { callFrom: b.source, callTo: b.dest, via: b.path.slice(), info: b.info };
}

/**
 * The AGW 'V' frame (unproto with VIA; Dire Wolf server.c): data = 1 byte
 * digipeater count, 10 bytes per digipeater (NUL padded), then the
 * information field. PID F0 (no layer 3). Dire Wolf queues it at low
 * priority, so it waits for a clear channel (DWAIT / SLOTTIME / PERSIST).
 */
function encodeAgwUnproto({ callFrom, callTo, via = [], info }) {
  const digis = Buffer.alloc(1 + via.length * 10);
  digis[0] = via.length;
  via.forEach((d, i) => digis.write(String(d).slice(0, 9), 1 + i * 10, 'latin1'));
  return encodeAgwFrame({ datakind: 'V', pid: 0xf0, callFrom, callTo, data: Buffer.concat([digis, Buffer.from(String(info), 'latin1')]) });
}

/** AX.25 UI frame bytes for a TNC2 line: 7 per address, control + PID, info, FCS. */
function frameBytes(packet) {
  const s = String(packet || '');
  const i = s.indexOf(':');
  const head = s.slice(0, i);
  const info = s.slice(i + 1);
  const addrs = head.split(/[>,]/).length;
  return addrs * 7 + 2 + Buffer.byteLength(info, 'latin1') + 2;
}

/**
 * The hard cap for one transmission, in ms, and the air time it is built on.
 * Bits: the frame with worst-case bit stuffing (one extra bit per five),
 * plus the two framing flags.
 */
function capFor({ band, packet, txDelayMs, txTailMs, drainMs }) {
  const baud = BAUD[band];
  if (!baud) throw new Error(`No APRS baud rate for ${band}`);
  const bits = frameBytes(packet) * 8 * 6 / 5 + 16;
  const frameMs = Math.ceil(bits / baud * 1000);
  const airMs = (Number(txDelayMs) || 0) + frameMs + (Number(txTailMs) || 0) + (Number(drainMs) || 0);
  const capMs = Math.ceil((airMs * 1.25 + 250) / 100) * 100;
  return { airMs, frameMs, capMs };
}

function secs(ms) { return (ms / 1000).toFixed(1) + ' s'; }

/**
 * One beacon at a time. deps:
 *   now, setTimer, clearTimer, log(s)
 *   begin() -> bool          take the radio for 'aprs'
 *   end()                    let it go
 *   startShim(onPtt) -> Promise<port>, stopShim()
 *   startModem({shimPort}) -> Promise<{send(req)->bool, kill(), onExit(cb)}>
 *   restoreListen()          the listen-only Dire Wolf again
 *   mayKey() -> {ok, reason?, sentence?}   lib/aprs-rf-gate.js mayKey on live state
 *   key() -> bool            POTACAT's key-down (PTT + the modem audio)
 *   unkey({now}) -> Promise  PTT off (after the audio has played, or at once)
 *   onState(state)
 */
function createRfBeacon(deps) {
  const d = deps;
  let run = null; // { id, phase, keyed, keys, modem, timers, resolve, capMs, label }
  let seq = 0;

  const state = () => (run ? { phase: run.phase, keyed: run.keyed, band: run.band } : { phase: 'idle', keyed: false, band: '' });
  const tell = () => { try { d.onState && d.onState(state()); } catch {} };
  const clear = (r, k) => { if (r.timers[k]) { d.clearTimer(r.timers[k]); r.timers[k] = null; } };

  function finish(r, result) {
    if (!r || run !== r || r.done) return;
    r.done = true;
    clear(r, 'cap'); clear(r, 'request');
    if (r.keyed) { r.keyed = false; try { d.unkey({ now: true }); } catch (e) { d.log('unkey failed: ' + e.message); } }
    if (r.modem) { try { r.modem.kill(); } catch {} }
    try { d.stopShim(); } catch {}
    if (r.began) { try { d.end(); } catch {} }
    run = null;
    try { d.restoreListen(); } catch (e) { d.log('listening did not come back: ' + e.message); }
    tell();
    r.resolve(result);
  }

  function fail(r, reason, sentence) {
    finish(r, { ok: false, reason, sentence });
  }

  function capTrip(r) {
    r.timers.cap = null;
    if (run !== r || r.done) return;
    d.log(`the transmission reached its cap of ${secs(r.capMs)}: POTACAT unkeyed the radio on its own`);
    if (r.keyed) { r.keyed = false; try { d.unkey({ now: true }); } catch (e) { d.log('unkey failed: ' + e.message); } }
    fail(r, 'cap', `The beacon ran past ${secs(r.capMs)}, so POTACAT unkeyed the radio. Check the radio is back on receive.`);
  }

  /** The shim's set_ptt for owner 'aprs'. */
  function onShimPtt(on) {
    const r = run;
    if (on) {
      if (!r || r.done || r.phase !== 'waiting') {
        d.log(r && r.keys ? 'refused a second key-down: this beacon has already been sent' : 'refused a key-down: no beacon is in flight');
        return false;
      }
      const g = d.mayKey() || { ok: false, reason: 'refused', sentence: 'The gate gave no answer.' };
      if (!g.ok) {
        d.log('refused the key-down: ' + g.sentence);
        fail(r, g.reason || 'refused', g.sentence);
        return false;
      }
      let ok = false;
      try { ok = d.key() !== false; } catch (e) {
        // The key-down may have keyed the radio before it threw: unkey at once (a no-op when it did not).
        d.log('key-down failed: ' + e.message); ok = false;
        try { Promise.resolve(d.unkey({ now: true })).catch(() => {}); } catch (e2) { d.log('unkey failed: ' + e2.message); }
      }
      if (!ok) { fail(r, 'ptt-refused', 'The radio refused to transmit. The log has its reason.'); return false; }
      r.keyed = true; r.keys++; r.phase = 'keyed';
      clear(r, 'request');
      r.timers.cap = d.setTimer(() => capTrip(r), r.capMs);
      tell();
      return true;
    }
    if (!r || !r.keyed || r.phase !== 'keyed') return true;
    r.phase = 'unkeying';
    tell();
    let p;
    try { p = Promise.resolve(d.unkey({ now: false })); } catch (e) { p = Promise.reject(e); }
    p.then(() => {
      if (run !== r || r.done) return;
      r.keyed = false;
      finish(r, { ok: true });
    }, (e) => {
      d.log('unkey failed: ' + (e && e.message));
      fail(r, 'error', 'The radio could not be unkeyed cleanly. Check the radio is back on receive.');
    });
    return true;
  }

  /**
   * Send one beacon. opts: { packet (buildRfBeacon result), capMs, requestTimeoutMs }.
   * Resolves { ok } or { ok:false, reason, sentence } when the beacon is over.
   */
  function send({ packet, capMs, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
    if (run) return Promise.resolve({ ok: false, reason: 'busy', sentence: 'A beacon is going out now.' });
    if (!packet || !packet.ok) return Promise.resolve({ ok: false, reason: (packet && packet.reason) || 'packet', sentence: (packet && packet.sentence) || 'There is no beacon to send.' });
    return new Promise((resolve) => {
      const r = { id: ++seq, phase: 'starting', keyed: false, keys: 0, modem: null, timers: {}, resolve, capMs: Math.max(100, Number(capMs) || 0), band: packet.band, began: false, done: false };
      run = r;
      tell();
      if (!d.begin()) { run = null; tell(); resolve({ ok: false, reason: 'owner', sentence: 'Another mode has the radio.' }); return; }
      r.began = true;
      (async () => {
        const port = await d.startShim(onShimPtt);
        // Stopped while the shim was starting: finish() found none to close, so close this one.
        if (r.done) { if (!run) { try { d.stopShim(); } catch {} } return; }
        const modem = await d.startModem({ shimPort: port });
        if (r.done) { try { modem.kill(); } catch {} return; }
        r.modem = modem;
        modem.onExit((code) => {
          if (run !== r || r.done) return;
          d.log(`the transmit modem stopped (code ${code})${r.keyed ? ' while keyed: unkeyed at once' : ''}`);
          fail(r, 'error', 'The modem stopped during the beacon. The log has the reason.');
        });
        r.phase = 'waiting';
        r.timers.request = d.setTimer(() => {
          r.timers.request = null;
          d.log(`no key-down within ${Math.round(requestTimeoutMs / 1000)} s (the channel never went quiet): nothing was sent`);
          fail(r, 'no-clear-channel', 'The channel stayed busy, so nothing was sent.');
        }, requestTimeoutMs);
        tell();
        if (!modem.send(agwRequest(packet))) fail(r, 'error', 'The modem did not take the beacon. The log has the reason.');
      })().catch((e) => {
        d.log('the beacon did not start: ' + (e && e.message));
        fail(r, 'error', 'The beacon did not start. The log has the reason.');
      });
    });
  }

  /** Stop now (window closed, switch off, quit, an error outside): unkey at once. */
  function abort(why) {
    const r = run;
    if (!r || r.done) return false;
    d.log(`stopped (${why})${r.keyed ? ': unkeyed at once' : ''}`);
    fail(r, 'aborted', `The beacon was stopped: ${why}.`);
    return true;
  }

  return { send, abort, onShimPtt, state, inFlight: () => !!run, keyed: () => !!(run && run.keyed) };
}

module.exports = {
  PATHS, BAUD, TX_KIND, BAND_LABEL, REQUEST_TIMEOUT_MS,
  rfSource, buildRfBeacon, agwRequest, encodeAgwUnproto, frameBytes, capFor, createRfBeacon,
};
