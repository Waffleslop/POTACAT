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
//
// Sent means the RADIO transmitted, not that POTACAT asked it to. On
// 2026-11-19 an 8600M on 10.1476 MHz answered the key-down with "The
// transmitter is not ready" and "Interlock is preventing transmission"
// (interlock NOT_READY, 0.0 W out), and the beacon was still logged as sent.
// main feeds the radio's own readback in: noteRadioTx (a Flex interlock
// TRANSMITTING, a CAT rig's TX readback) and noteRadioRefusal (the radio's
// refusal text). A refusal before any readback ends the beacon at once with
// the radio's words; an over with no readback is not sent; a rig that cannot
// report transmit (txProofFor) is keyed but not confirmed, never "sent".
'use strict';

const AprsBeacon = require('./aprs-beacon');
const { encodeAgwFrame } = require('./direwolf-agw-monitor');
const FlexTxFilter = require('./flex-tx-filter');

const PATHS = Object.freeze({ '2m': Object.freeze(['WIDE1-1', 'WIDE2-1']), '30m': Object.freeze(['WIDE1-1']) });
const BAUD = Object.freeze({ '2m': 1200, '30m': 300 });
const TX_KIND = Object.freeze({ '2m': 'aprs2m', '30m': 'aprs30m' });
const BAND_LABEL = Object.freeze({ '2m': '2 m', '30m': '30 m' });
const INTERLOCK_WAIT_MS = 2000; // after the narrow filter: how long the radio has to read READY before the beacon gives up
const REQUEST_TIMEOUT_MS = 75000; // Dire Wolf drops a frame after 60 s of busy channel (src/xmit.c); 15 s more for its start

// The 30 m transmit passband for the beacon, Hz above the USB carrier.
// 30 m APRS: dial 10.1476 MHz USB, tones 1600 and 1800 Hz (lib/direwolf-process.js
// 'MODEM 300 1600:1800'), so the signal sits at 10.1492-10.1494 MHz. The
// 30 m band ends at 10.150 MHz. On 2026-11-19 an 8600M with its TX filter at
// 100-3100 Hz refused the key-down (interlock OUT_OF_BAND): that passband's
// top edge is 10.1476 + 3.1 kHz = 10.1507 MHz, past the band edge.
// 1400-2000 Hz: centred on the 1700 Hz tone centre, 600 Hz wide. Carson's
// rule for 300 baud AFSK with 200 Hz shift gives 2 x (100 + 150) = 500 Hz
// (1450-1950), so 1400-2000 passes the keying sidebands with 50 Hz each side,
// and the top edge is 10.1496 MHz: 400 Hz inside the band edge.
const TX_PASSBAND = Object.freeze({ '30m': Object.freeze({ lo: 1400, hi: 2000 }) });
const TX_PASSBAND_SENTENCES = Object.freeze({
  noControl: 'this radio gives POTACAT no way to set its transmit passband: it may refuse 30 m if its transmit filter is wide (above about 2400 Hz the top edge passes 10.150 MHz)',
  notReported: 'the Flex has not reported its transmit filter, so POTACAT cannot put it back and leaves it alone: the radio may refuse 30 m if the filter is wide',
  notAllowed: 'the Flex does not allow transmit filter changes now (tx_filter_changes_allowed=0): it may refuse 30 m if its transmit filter is wide',
  cannotRestore: 'the Flex reports a transmit filter outside FlexLib limits, so POTACAT could not put it back and leaves it alone: the radio may refuse 30 m if the filter is wide',
});

/**
 * What to do with the transmit passband for one beacon. flex: the Flex
 * station's view { connected, filter:{lo,hi}|null, allowed:true|false|null },
 * or null for a radio POTACAT cannot set a TX passband on.
 *   { action:'none' }                          2 m, or any band without a plan
 *   { action:'unsupported', log }              change nothing, log one line
 *   { action:'narrow', saved, target }         set target now, put saved back after
 */
function planTxPassband({ band, flex } = {}) {
  const target = TX_PASSBAND[band];
  if (!target) return { action: 'none' };
  if (!flex || !flex.connected) return { action: 'unsupported', log: TX_PASSBAND_SENTENCES.noControl };
  const f = flex.filter;
  const edge = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  if (!f || !edge(f.lo) || !edge(f.hi)) return { action: 'unsupported', log: TX_PASSBAND_SENTENCES.notReported };
  if (flex.allowed === false) return { action: 'unsupported', log: TX_PASSBAND_SENTENCES.notAllowed };
  if (!FlexTxFilter.validTxFilter({ lo: Number(f.lo), hi: Number(f.hi) })) return { action: 'unsupported', log: TX_PASSBAND_SENTENCES.cannotRestore };
  return { action: 'narrow', saved: { lo: Number(f.lo), hi: Number(f.hi) }, target: { lo: target.lo, hi: target.hi } };
}

/**
 * Confirm a put-back of the operator's TX filter after its zero reply, from
 * something that refreshes. On-air 2026-11-20 (8600M): after the put-back
 * the cached transmit status still read lo=1400 hi=2000 until the next mode
 * change, while the interlock went back to OUT_OF_BAND 120 ms after it; so
 * the cached block is never the proof. Either one confirms:
 *   'fresh transmit status'  a lo=/hi= line newer than the re-subscribe
 *                            (statusSeq > sinceSeq) that reads the saved filter;
 *   'interlock OUT_OF_BAND'  the saved filter is out of band on this dial
 *                            (outOfBandExpected), the interlock was not
 *                            already NOT_READY when the put-back started,
 *                            and it now reads NOT_READY OUT_OF_BAND.
 * read() -> { statusSeq, filter:{lo,hi}|null, interlockState, interlockReason }.
 * Resolves { confirmed: true, by } or { confirmed: false } after timeoutMs.
 */
async function confirmTxRestore({ saved, sinceSeq = 0, outOfBandExpected = false, interlockAtStart = '', read, setTimer, now, timeoutMs = 2000, stepMs = 50 }) {
  const useInterlock = !!outOfBandExpected && interlockAtStart !== 'NOT_READY';
  const until = now() + timeoutMs;
  for (;;) {
    let s = null;
    try { s = read() || null; } catch {}
    if (s) {
      const f = s.filter;
      if (Number(s.statusSeq) > Number(sinceSeq) && f && Number(f.lo) === Number(saved.lo) && Number(f.hi) === Number(saved.hi)) return { confirmed: true, by: 'fresh transmit status' };
      if (useInterlock && s.interlockState === 'NOT_READY' && String(s.interlockReason || '').trim() === 'OUT_OF_BAND') return { confirmed: true, by: 'interlock OUT_OF_BAND' };
    }
    if (now() >= until) return { confirmed: false };
    await new Promise((res) => setTimer(res, stepMs));
  }
}

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

/** The radio's refusal in plain words: its own text first, the interlock state after. */
function refusalSentence({ message, interlockState, interlockReason } = {}) {
  const text = String(message || interlockReason || '').trim().replace(/\.+$/, '');
  const notReady = interlockState === 'NOT_READY';
  if (text) return `The radio refused to transmit: ${text}${notReady ? ' (not ready on this band)' : ''}.`;
  if (notReady) return 'The radio refused to transmit: it is not ready on this band.';
  return 'The radio refused to transmit, so nothing was sent.';
}

/**
 * Is this radio text a refusal to transmit? ("The transmitter is not ready",
 * "Interlock is preventing transmission"; other radio messages in the same
 * second are not.)
 */
function isTxRefusalText(text) {
  return /transmi|interlock/i.test(String(text || ''));
}

/**
 * Can this radio prove it transmitted, and how long must an over last before
 * a missing readback means it did not?
 *   flexInterlock  the Flex's interlock state is known: it pushes
 *                  TRANSMITTING the moment it keys.
 *   catReadsPtt    the rig controller reads the radio's TX state while
 *                  transmitting; the readback comes on the poll, so an over
 *                  shorter than 1.5 polls + 300 ms may see none.
 */
function txProofFor({ flexInterlock, catReadsPtt, catPollMs } = {}) {
  if (flexInterlock) return { canConfirm: true, minMs: 0 };
  if (catReadsPtt) return { canConfirm: true, minMs: Math.round((Number(catPollMs) || 1000) * 1.5) + 300 };
  return { canConfirm: false, minMs: 0 };
}

const SENT_SENTENCES = Object.freeze({
  notKeyed: 'The radio never went to transmit, so nothing was sent.',
  noReadback: 'POTACAT keyed the radio, but this radio does not report when it transmits, so the beacon cannot be confirmed.',
  tooShort: 'POTACAT keyed the radio, but the beacon was shorter than the radio\'s transmit readback, so it cannot be confirmed.',
});

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
 *   txProof() -> {canConfirm, minMs}   txProofFor on the connected radio (absent: cannot confirm)
 *   narrowTx(band) -> null | Promise<{saved, ok, reason?, reply?}>   optional: set the beacon's TX
 *                            passband (planTxPassband) and answer with the radio's reply; null (or no
 *                            saved) when nothing was sent. reason 'refused' = a non-zero reply.
 *   restoreTx(saved)         put the operator's filter back (once, on every way out; may return a Promise)
 *   txInterlock() -> {state, reason}|null   optional: the radio's interlock now (a Flex), read after the narrow filter
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
    // The operator's transmit filter goes back after the unkey above and before
    // the radio is let go, on every way out (sent, refused, cap, timeout, error, abort).
    if (r.txSaved) {
      const saved = r.txSaved;
      r.txSaved = null;
      putBack(saved);
    }
    if (r.began) { try { d.end(); } catch {} }
    run = null;
    try { d.restoreListen(); } catch (e) { d.log('listening did not come back: ' + e.message); }
    tell();
    r.resolve(result);
  }

  /**
   * Wait (d.setTimer, up to INTERLOCK_WAIT_MS) for the radio's interlock to
   * read READY. ok unless it still reads NOT_READY at the end; a radio that
   * reports no interlock (d.txInterlock absent or null) is ok at once.
   */
  async function waitInterlock(r) {
    if (!d.txInterlock) return { ok: true };
    const until = d.now() + INTERLOCK_WAIT_MS;
    for (;;) {
      let st = null;
      try { st = d.txInterlock(); } catch {}
      if (!st || !st.state || st.state === 'READY') return { ok: true, state: st && st.state };
      if (d.now() >= until) return { ok: st.state !== 'NOT_READY', state: st.state, reason: st.reason || '' };
      await new Promise((res) => d.setTimer(res, 50));
      if (r.done) return { ok: false, state: 'stopped' };
    }
  }

  /** The operator's transmit filter back (restoreTx may answer later; a failure is logged, never thrown). */
  function putBack(saved) {
    try { Promise.resolve(d.restoreTx(saved)).catch((e) => d.log('the transmit filter was not put back: ' + (e && e.message))); }
    catch (e) { d.log('the transmit filter was not put back: ' + e.message); }
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
      r.keyed = true; r.keys++; r.phase = 'keyed'; r.keyedAt = d.now();
      clear(r, 'request');
      r.timers.cap = d.setTimer(() => capTrip(r), r.capMs);
      tell();
      return true;
    }
    if (!r || !r.keyed || r.phase !== 'keyed') return true;
    r.phase = 'unkeying'; r.unkeyAt = d.now();
    tell();
    let p;
    try { p = Promise.resolve(d.unkey({ now: false })); } catch (e) { p = Promise.reject(e); }
    p.then(() => {
      if (run !== r || r.done) return;
      r.keyed = false;
      finish(r, outcome(r));
    }, (e) => {
      d.log('unkey failed: ' + (e && e.message));
      fail(r, 'error', 'The radio could not be unkeyed cleanly. Check the radio is back on receive.');
    });
    return true;
  }

  /** Sent only when the radio said it transmitted. */
  function outcome(r) {
    if (r.radioTx) return { ok: true, confirmed: true };
    let proof = { canConfirm: false, minMs: 0 };
    try { if (d.txProof) proof = d.txProof() || proof; } catch {}
    if (!proof.canConfirm) { d.log('keyed, but this radio does not report transmit: not confirmed'); return { ok: true, confirmed: false, sentence: SENT_SENTENCES.noReadback }; }
    const heldMs = (r.unkeyAt || d.now()) - (r.keyedAt || 0);
    if (heldMs < (Number(proof.minMs) || 0)) { d.log(`keyed ${heldMs} ms, shorter than the radio's transmit readback (${proof.minMs} ms): not confirmed`); return { ok: true, confirmed: false, sentence: SENT_SENTENCES.tooShort }; }
    d.log('the radio never reported transmit: nothing was sent');
    return { ok: false, reason: 'not-keyed', sentence: SENT_SENTENCES.notKeyed };
  }

  /** The radio's own readback says it is transmitting (Flex interlock TRANSMITTING, CAT TX readback). */
  function noteRadioTx(on) {
    const r = run;
    if (!on || !r || r.done || !r.keys) return;
    r.radioTx = true;
  }

  /**
   * The radio refused to transmit ({message, interlockState, interlockReason}).
   * Counts only while this beacon holds PTT and before the radio reported
   * transmit; then the beacon ends at once with the radio's words.
   */
  function noteRadioRefusal(info) {
    const r = run;
    if (!r || r.done || !r.keys || r.radioTx || r.phase !== 'keyed') return false;
    const sentence = refusalSentence(info || {});
    d.log(sentence);
    fail(r, 'not-keyed', sentence);
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
        // 30 m: narrow the transmit passband before anything can key, and wait
        // for the radio's reply. Taken (zero reply): the saved filter is held on
        // the run, so finish() puts it back whatever happens next. Refused
        // (non-zero reply): nothing changed, nothing to put back, and no key-down.
        // No reply: no key-down, and the saved filter goes back in case it did change.
        if (d.narrowTx) {
          let n = null;
          try { n = await d.narrowTx(packet.band); } catch (e) { d.log('the transmit filter was not narrowed: ' + (e && e.message)); }
          if (n && n.saved) {
            if (!n.ok) {
              const back = n.reason !== 'refused';
              d.log(`the radio did not take the narrow transmit filter (${n.reply || n.reason || 'no reason'}): not keyed${back ? ', its filter is put back' : ', nothing changed'}`);
              if (r.done) { if (back) putBack(n.saved); return; }
              if (back) r.txSaved = n.saved;
              fail(r, 'tx-filter', 'The radio did not take the narrow 30 m transmit filter, so nothing was sent. The log has its reply.');
              return;
            }
            // Stopped while the set was on its way: finish() has run, so put it back here.
            if (r.done) { putBack(n.saved); return; }
            r.txSaved = n.saved;
            // Then the radio judges: wait for its interlock to read READY on the
            // narrow filter. Still NOT_READY (any reason): never keyed, the
            // saved filter goes back (finish), the radio's reason in plain words.
            const il = await waitInterlock(r);
            if (r.done) return;
            if (!il.ok) {
              const sentence = refusalSentence({ interlockState: il.state, interlockReason: il.reason });
              d.log(`the radio's interlock still reads ${il.state}${il.reason ? ' (' + il.reason + ')' : ''} on the narrow filter: not keyed, its filter is put back`);
              fail(r, 'not-keyed', sentence);
              return;
            }
          }
        }
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

  return { send, abort, onShimPtt, noteRadioTx, noteRadioRefusal, state, inFlight: () => !!run, keyed: () => !!(run && run.keyed) };
}

module.exports = {
  PATHS, BAUD, TX_KIND, BAND_LABEL, REQUEST_TIMEOUT_MS, INTERLOCK_WAIT_MS, confirmTxRestore, TX_PASSBAND, TX_PASSBAND_SENTENCES, planTxPassband,
  SENT_SENTENCES, rfSource, buildRfBeacon, agwRequest, encodeAgwUnproto, frameBytes, capFor, refusalSentence, isTxRefusalText, txProofFor, createRfBeacon,
};
