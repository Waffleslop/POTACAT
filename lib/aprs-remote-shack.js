// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS "Listen on my radio" on a desktop driving a remote shack (#868). The
// radio is the shack's, so listening runs there: the APRS window's switch and
// band picker send the ECHOCAT wire's aprs-listen (the message ECHOCAT web
// sends, handled by the shack's lib/aprs-echocat.js), and the window shows the
// shack's own aprs-state and the stations its radio heard (aprs-stations).
// Every rule stays the shack's: its radio, its restore, its refusals, its
// Guest Pass handling. lib/remote-bridge.js maps the channels with these.
//
// Pure, no Electron.
'use strict';

const BANDS = ['2m', '30m'];

/** Said on this desktop when the shack's POTACAT has no APRS on the wire (older than 1.14.7). */
const SHACK_TOO_OLD = 'The shack\'s POTACAT cannot start listening from here. Update POTACAT at the shack, or turn listening on there.';

/** The switch: aprs-listen {on}. The band stays the one the shack shows (it is in its aprs-state). */
function listenMessage(on) {
  return { type: 'aprs-listen', on: !!on };
}

/**
 * The band picker: aprs-listen {on, band}. The shack sets the band and then
 * applies `on`, so `on` must be what the shack is doing now: a band pick
 * never switches listening on or off by itself.
 */
function bandMessage(band, shackOn) {
  const b = BANDS.indexOf(band) >= 0 ? band : '';
  if (!b) return null;
  return { type: 'aprs-listen', on: !!shackOn, band: b };
}

/** Whether the shack is listening (or trying to) by its aprs-state. */
function shackListening(state) {
  const l = state && state.listen;
  return !!(l && l.on);
}

/**
 * The APRS window's 'aprs-listen' payload from the shack's aprs-state. The
 * same fields the window gets at the shack (main's aprsListenPayload) except
 * where the radio is now (dialMhz, dialMode) and the moved card, which the
 * wire does not carry; a pause because the radio moved arrives as a refusal
 * with the shack's sentence, as on ECHOCAT.
 */
function listenFromState(state) {
  const l = (state && state.listen) || {};
  const bands = Array.isArray(l.bands) ? l.bands.filter((b) => BANDS.indexOf(b) >= 0) : [];
  return {
    on: !!l.on,
    state: String(l.state || 'off'),
    band: BANDS.indexOf(l.band) >= 0 ? l.band : '',
    bands,
    modeLabel: String(l.modeLabel || ''),
    mhz: String(l.mhz || ''),
    heard: Number(l.heard) || 0,
    lastAt: Number(l.lastAt) || 0,
    note: String(l.note || ''),
    sentence: String(l.sentence || ''),
    dialMhz: '',
    dialMode: '',
    moved: null,
    shack: true,
  };
}

/** The window's payload for a refusal said on this desktop (the link is down, the shack is too old). */
function refusedHere(sentence, last) {
  const base = last && typeof last === 'object' ? last : { on: false, state: 'off', band: '', bands: [], modeLabel: '', mhz: '', heard: 0, lastAt: 0, note: '', dialMhz: '', dialMode: '', moved: null };
  return Object.assign({}, base, { on: false, state: 'refused', sentence: String(sentence || ''), shack: true });
}

/**
 * The shack's station rows (lib/aprs-echocat.js slimStation) its RADIO heard,
 * as parsed packets for this window's store (lib/aprs-stations.js): each
 * carries `rf`, so the window marks it "heard by my radio" like a packet its
 * own Dire Wolf decoded. Rows heard only on APRS-IS are left out: this
 * desktop runs its own APRS-IS feed. A row is passed on once per new radio
 * hearing (its rf.lastHeard or rf.packets moved), so an APRS-IS update of a
 * station the radio heard earlier never counts as another radio packet.
 * `seen` (a Map, key -> 'lastHeard:packets') is kept by the caller and
 * cleared when the window subscribes again.
 */
function packetsFromStations(msg, seen) {
  const m = msg || {};
  const rows = [].concat(Array.isArray(m.stations) ? m.stations : [], Array.isArray(m.add) ? m.add : [], Array.isArray(m.update) ? m.update : []);
  const out = [];
  for (const r of rows) {
    if (!r || !r.rf || !r.call || typeof r.lat !== 'number' || typeof r.lon !== 'number') continue;
    const key = String(r.key || r.call);
    const mark = (Number(r.rf.lastHeard) || 0) + ':' + (Number(r.rf.packets) || 0);
    if (seen && seen.get(key) === mark) continue;
    if (seen) seen.set(key, mark);
    const sym = String(r.symbol || '');
    const obj = r.type === 'object' || r.type === 'item';
    const p = {
      from: String(r.call),
      type: String(r.type || 'position'),
      lat: r.lat, lon: r.lon,
      symbolTable: sym.charAt(0) || '/',
      symbol: sym.charAt(1) || '',
      comment: String(r.comment || ''),
      course: r.course == null ? undefined : r.course,
      speed: r.speed == null ? undefined : r.speed,
      altitude: r.altitude == null ? undefined : r.altitude,
      rf: { kind: r.rf.kind === 'digi' ? 'digi' : 'direct', digi: String(r.rf.digi || '') },
    };
    if (obj) { p.name = String(r.label || ''); p.live = true; }
    out.push(p);
  }
  if (seen && Array.isArray(m.gone)) for (const k of m.gone) seen.delete(String(k));
  return out;
}

module.exports = { SHACK_TOO_OLD, BANDS, listenMessage, bandMessage, shackListening, listenFromState, refusedHere, packetsFromStations };
