// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The APRS window's layout (Casey 2026-11-19, the approved mock-up: "way
// better"): what each status card, banner and button shows, from the state
// main already sends (listen, iGate, beacon, radio beacon, the APRS-IS link,
// the rig's power) and what the map and list know. The window's script
// (renderer/aprs-window.js) only puts these words and flags into the page.
//
//  - Three cards across the top, no heading (the title bar says APRS):
//    "My radio" (listening, the band, frequency and baud, the S-meter; off:
//    where the radio goes back to; one on/off switch in every state, with a
//    band select beside it on a two-band rig (2026-11-20); red while the
//    beacon has it keyed), "APRS-IS" (link, server, packets a minute, iGate)
//    and "Heard by my radio" (stations this session, the last one).
//  - Banners under them: the internet timer, only while an interval is set;
//    the red on-the-air banner, only while a radio beacon has PTT.
//  - The Beacon panel's two one-click buttons, each with a short line under
//    it: what it will do, or, disabled, why not (the gate's own sentence);
//    the internet one just "Last beacon: HH:MM:SS" (2026-11-20).
//  - The Stations list's "Within" choices in round numbers of the operator's
//    units, each mapped to whole kilometres for the APRS-IS range filter.
//  - "Show the last" (Casey 2026-11-20): 15 min to 6 hours of stations, 1 hour
//    by default; a station older than half of it is drawn fainter (ageFade).
//
// Nothing here sends, keys or decides a refusal: main does (lib/aprs-rf-gate.js
// and the rest). Pure. Dual-mode: require() in tests and main, window.AprsWindowState
// in the window.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsWindowState = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KM_PER_MI = 1.609344;
  const BAND_LABEL = { '2m': '2 m', '30m': '30 m' };
  const BAUD = { '2m': 1200, '30m': 300 };

  // ── the "Within" range ─────────────────────────────────────────────────────
  // Round numbers in the operator's own units (Casey: no more "93 mi" from
  // 150 km). A mile choice goes to APRS-IS as whole kilometres, rounded UP so
  // the filter always covers at least the distance the operator picked
  // (25 mi = 40.2 km -> 41 km). The same choice always gives the same km, so
  // the select reads back exactly what was picked.
  const RANGE_CHOICES = Object.freeze({ mi: Object.freeze([25, 50, 100, 250, 500]), km: Object.freeze([25, 50, 100, 250, 500, 800]) });

  function unitOf(u) { return u === 'km' ? 'km' : 'mi'; }

  /** The APRS-IS filter range, in whole km, for a choice in the operator's units. */
  function rangeKmFor(value, unit) {
    const n = Number(value);
    if (!(n > 0)) return 0;
    return unitOf(unit) === 'km' ? Math.round(n) : Math.ceil(n * KM_PER_MI);
  }

  /** The select's options: [{ km, value, label }] in the operator's units. */
  function rangeOptions(unit) {
    const u = unitOf(unit);
    return RANGE_CHOICES[u].map((v) => ({ km: rangeKmFor(v, u), value: v, label: v + ' ' + u }));
  }

  /**
   * The choice nearest a saved range (km), in the operator's units: a range
   * saved before the round-number choices (150 km, shown as "93 mi") becomes
   * 100 mi once. A tie goes to the larger choice. Returns { km, value, label }.
   */
  function nearestRange(km, unit) {
    const u = unitOf(unit);
    const opts = rangeOptions(u);
    const k = Number(km);
    if (!(k > 0)) return opts.find((o) => o.value === 100) || opts[0];
    const inUnit = u === 'km' ? k : k / KM_PER_MI;
    let best = opts[0];
    for (const o of opts) {
      const d = Math.abs(o.value - inUnit), bd = Math.abs(best.value - inUnit);
      if (d < bd || (d === bd && o.value > best.value)) best = o;
    }
    return best;
  }

  /**
   * The one-time conversion: a saved range that is not one of the choices
   * becomes the nearest one; a choice stays as it is (so this runs once).
   * Returns { km, changed }.
   */
  function convertSavedRange(savedKm, unit) {
    const opts = rangeOptions(unit);
    const k = Math.round(Number(savedKm));
    if (opts.some((o) => o.km === k)) return { km: k, changed: false };
    return { km: nearestRange(savedKm, unit).km, changed: true };
  }

  // ── small words ────────────────────────────────────────────────────────────
  function ago(ms) {
    const sec = Math.max(0, Math.round(Number(ms) / 1000));
    if (sec < 60) return sec <= 1 ? 'just now' : sec + ' s ago';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
  }
  /** "16:10", the local clock (24 hours, as the mock-up). */
  function clock(ms) {
    const d = new Date(Number(ms));
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
/** "16:10:42", the local clock with seconds (Casey 2026-11-20: "Last beacon: TT:TT:TT"). */
  function clockSec(ms) {
    const d = new Date(Number(ms));
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  /** The one line under "Beacon on the internet": "Last beacon: 16:10:42", or "Not sent yet". */
  function lastBeaconText(lastAt) {
    const t = Number(lastAt) || 0;
    return t > 0 ? 'Last beacon: ' + clockSec(t) : 'Not sent yet';
  }
  function distText(km, unit) {
    if (km == null || !isFinite(km)) return '';
    const v = unitOf(unit) === 'km' ? km : km / KM_PER_MI;
    const n = v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US');
    return n + ' ' + unitOf(unit);
  }
  function bandLabel(b) { return BAND_LABEL[b] || ''; }
  function watts(w) {
    const n = Number(w) || 0;
    return (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + ' W';
  }
  function secs(ms) { return (Math.round(Number(ms) / 100) / 10).toFixed(1) + ' s'; }

  // ── the radio beacon's flight ──────────────────────────────────────────────
  /** A radio beacon is on its way (starting, waiting for the channel, keyed or unkeying). */
  function rfInFlight(rf) { return !!(rf && ((rf.phase && rf.phase !== 'idle') || rf.sending)); }
  /** POTACAT holds PTT for the beacon now. */
  function rfKeyed(rf) { return !!(rf && rf.keyed); }

  // ── card 1: My radio ───────────────────────────────────────────────────────
  /** The S-meter bar's fill, 0..100, from the 0-255 wire value (S9 at 120, the VFO window's scale). */
  function sMeterPct(v) {
    const n = Number(v);
    if (!isFinite(n) || n < 0) return 0;
    return Math.round(n <= 120 ? (n / 120) * 70 : Math.min(100, 70 + ((n - 120) / 135) * 30));
  }

  /**
   * listen: main's 'aprs-listen' payload; rf: 'aprs-rf'; meter: { smeter, sLabel };
   * Returns { kind: 'tx'|'busy'|'on'|'off', dot, title, lines[], switchOn, switchShown,
   *           bands: [{band, label}], otherBands: [{band, label}], smeter: {shown, pct, text}|null }.
   */
  function radioCard(o = {}) {
    const c = radioCardBody(o);
    // One control in every state (Casey 2026-11-20: "it's a slider when on and a
    // button when off. Make it a slider"): the switch is always there; it cannot
    // be moved while a beacon has the radio, or with no APRS band. The band
    // select sits beside it when the rig has more than one APRS band.
    const l = o.listen || {};
    const bands = c.bandList;
    const locked = c.kind === 'tx' || c.kind === 'busy';
    c.switchShown = true;
    c.switchDisabled = locked || !bands.length;
    c.bandSelect = bands.length > 1 ? { options: bands, value: l.band || bands[0].band, disabled: locked } : null;
    delete c.bandList;
    return c;
  }
  function radioCardBody({ listen = {}, rf = null, smeter = null, sText = '', available = {} } = {}) {
    const l = listen || {};
    const band = l.band || '';
    const bl = bandLabel(band);
    const bands = (Array.isArray(l.bands) ? l.bands : []).map((b) => ({ band: b, label: bandLabel(b) || b }));
    if (rfInFlight(rf)) {
      const rb = rf.bandLabel || bl;
      const narrow = rf.txNarrow ? ' · filter ' + rf.txNarrow.lo + '-' + rf.txNarrow.hi + ' Hz for this beacon' : '';
      if (rfKeyed(rf)) {
        return { kind: 'tx', dot: 'tx', title: 'Transmitting on ' + rb, lines: [(rf.mhz ? rf.mhz + ' MHz' : rb) + narrow, 'Listening resumes when it ends'],
          switchShown: false, switchOn: true, bands: [], otherBands: [], smeter: null, bandList: bands };
      }
      return { kind: 'busy', dot: 'wait', title: 'Getting ready to beacon on ' + rb, lines: [(rf.mhz ? rf.mhz + ' MHz' : rb) + narrow, 'Listening resumes when the beacon is done'],
        switchShown: false, switchOn: true, bands: [], otherBands: [], smeter: null, bandList: bands };
    }
    const active = !!l.on && (l.state === 'starting' || l.state === 'listening' || l.state === 'paused');
    if (active) {
      const title = l.state === 'listening' ? 'Listening on my radio' : l.state === 'starting' ? 'Tuning my radio to APRS' : 'Listening paused';
      const lines = [[bl, l.mhz ? l.mhz + ' MHz' : '', BAUD[band] ? BAUD[band] + ' baud' : ''].filter(Boolean).join(' · ')];
      if (l.note) lines.push(l.note);
      const s = available && available.smeter === false
        ? { shown: true, pct: 0, text: 'No S-meter from this radio', none: true }
        : { shown: true, pct: sMeterPct(smeter), text: sText || '—', none: false };
      return { kind: 'on', dot: l.state === 'listening' ? 'ok' : 'wait', title, lines, switchShown: true, switchOn: true,
        bands: [], otherBands: bands.filter((b) => b.band !== band), smeter: s, bandList: bands };
    }
    // The radio moved off the APRS frequency (main.js aprsListenMovedOff): paused, switch off;
    // turning it on tunes back to APRS. Main writes both lines (lib/aprs-listen.js movedLine).
    if (!l.on && l.moved && l.moved.title) {
      return { kind: 'off', dot: 'wait', title: l.moved.title, lines: [l.moved.line].filter(Boolean), switchShown: false, switchOn: false,
        bands, otherBands: [], smeter: null, bandList: bands };
    }
    const lines = [];
    if (l.sentence) lines.push(l.sentence);
    else if (!bands.length) lines.push('Your radio has neither 2 m nor 30 m, or it is not connected.');
    if (bands.length && l.dialMhz) lines.push('Your radio goes back to ' + l.dialMhz + ' MHz' + (l.dialMode ? ' ' + l.dialMode : '') + ' when you stop.');
    else if (bands.length) lines.push('Your radio goes back where it was when you stop.');
    return { kind: 'off', dot: l.sentence ? 'bad' : 'off', title: 'Not listening on my radio', lines, switchShown: false, switchOn: false,
      bands, otherBands: [], smeter: null, bandList: bands };
  }

  // ── card 2: APRS-IS ────────────────────────────────────────────────────────
  function igateLine(ig) {
    if (!ig || !ig.on) return 'iGate off';
    if (ig.sentence) return 'iGate: ' + ig.sentence;
    if (ig.paused) return ig.paused; // a Guest Pass
    if (!ig.active) return 'iGate on: waits for my radio to listen';
    if (ig.link === 'unverified') return 'iGate on: login not verified, nothing sent';
    if (ig.link !== 'verified') return 'iGate on: connecting';
    const n = Number(ig.gated) || 0;
    return 'iGate on: ' + n + (n === 1 ? ' packet' : ' packets') + ' from my radio sent up';
  }
  /**
   * link: main's 'aprs-status' ({state, server, retryInMs}); rate: packets in the last minute; ig: 'aprs-igate'.
   * Returns { kind, dot, title, lines[], switchOn, connectShown }.
   */
  function isCard(o = {}) {
    const c = isCardBody(o);
    // The same one switch as My radio, on or off (Casey 2026-11-20); no grid: it cannot connect yet.
    c.switchShown = true;
    c.switchDisabled = !!(o.link && o.link.state === 'no-grid');
    c.connectShown = false;
    return c;
  }
  function isCardBody({ link = null, rate = 0, ig = null } = {}) {
    const st = link && link.state;
    const n = Number(rate) || 0;
    const per = n + (n === 1 ? ' packet' : ' packets') + ' a minute';
    if (st === 'connected') {
      return { kind: 'on', dot: 'ok', title: 'Connected to APRS-IS', lines: [(link.server ? 'Server ' + link.server + ' · ' : '') + per, igateLine(ig)], switchOn: true, connectShown: false };
    }
    if (st === 'connecting') return { kind: 'on', dot: 'wait', title: 'Connecting to APRS-IS', lines: [igateLine(ig)], switchOn: true, connectShown: false };
    if (st === 'waiting') return { kind: 'on', dot: 'wait', title: 'Not connected to APRS-IS', lines: ['Trying again in ' + Math.round((Number(link.retryInMs) || 0) / 1000) + ' s', igateLine(ig)], switchOn: true, connectShown: false };
    if (st === 'refused') return { kind: 'on', dot: 'bad', title: 'APRS-IS refused the login', lines: ['Trying again in a minute', igateLine(ig)], switchOn: true, connectShown: false };
    if (st === 'no-grid') return { kind: 'off', dot: 'bad', title: 'Not connected to APRS-IS', lines: ['Set your grid square in Settings to see the stations near you.', igateLine(ig)], switchOn: false, connectShown: false };
    return { kind: 'off', dot: 'off', title: 'Not connected to APRS-IS', lines: ['Shows stations near you from the internet. Receive only until you beacon.', igateLine(ig)], switchOn: false, connectShown: true };
  }

  // ── card 3: Heard by my radio ──────────────────────────────────────────────
  /** heard: { count, last: {label, at, distanceKm} | null }; listening: the radio listens now. */
  function heardCard({ heard = null, listening = false, unit = 'mi', now = Date.now() } = {}) {
    const h = heard || {};
    const n = Number(h.count) || 0;
    if (!n) {
      return { kind: 'none', count: 0, title: 'Nothing yet', countText: '', lines: [listening
        ? 'Listening. Stations your radio decodes get a green ring on the map.'
        : 'Turn on listening to decode packets yourself. They get a green ring on the map.'] };
    }
    const lines = [];
    if (h.last && h.last.label) {
      lines.push('Last: ' + [h.last.label, ago(now - (Number(h.last.at) || now)), distText(h.last.distanceKm, unit)].filter(Boolean).join(', '));
    }
    return { kind: 'some', count: n, title: '', countText: n === 1 ? 'station this session' : 'stations this session', lines };
  }

  // ── banners ────────────────────────────────────────────────────────────────
  /**
   * The internet timer, whenever an interval is set (and only then).
   * beacon: main's 'aprs-beacon'; band: the radio's APRS band ('' = none).
   */
  function timerBanner({ beacon = null, band = '' } = {}) {
    const b = beacon || {};
    const min = Number(b.settings && b.settings.intervalMin) || 0;
    if (!(min > 0)) return null;
    const bl = bandLabel(band);
    const detail = (b.timerOn && b.nextAt ? 'Next at ' + clock(b.nextAt) + '. ' : '')
      + 'The radio only sends when you press ' + (bl ? 'Beacon on ' + bl : 'a radio Beacon button') + '.';
    return { title: 'Beaconing over the internet every ' + min + ' min' + (b.call ? ' as ' + b.call : '') + '.', detail, button: 'Stop the timer' };
  }

  /** The red on-the-air banner, only while a radio beacon has PTT. */
  function onAirBanner({ rf = null, rfCall = '', now = Date.now() } = {}) {
    if (!rfKeyed(rf)) return null;
    const at = Number(rf.keyedAt) || 0;
    const el = at ? Math.max(0, now - at) : 0;
    const air = Number(rf.airMs) || 0;
    return {
      title: 'On the air: APRS beacon on ' + (rf.bandLabel || 'the radio') + (rfCall ? ' as ' + rfCall : ''),
      time: at ? secs(el) + (air ? ' of about ' + secs(air) : '') : (air ? 'about ' + secs(air) : ''),
      button: 'Stop transmitting',
    };
  }

  // ── the Beacon panel ───────────────────────────────────────────────────────
  /** "-6: special activity, satellite, camping" -> "special activity" (the header's short word). */
  function ssidMeaning(call, choices) {
    const m = /-(\d{1,2})$/.exec(String(call || ''));
    const n = m ? Number(m[1]) : 0;
    const c = (choices || []).find((x) => x.ssid === n);
    if (!c) return '';
    return c.label.replace(/^none: /, '').split(/[,(]/)[0].trim();
  }

  /**
   * rf: 'aprs-rf'; beacon: 'aprs-beacon'; clickHeld: a click is on its way to main.
   * Returns { rf: {label, sub, disabled, reason, title}, net: {...}, detail, last, result }.
   */
  function beaconPanel({ rf = null, beacon = null, clickHeld = false, now = Date.now(), ssidChoices = [] } = {}) {
    const r = rf || {};
    const b = beacon || {};
    const busy = rfInFlight(r) || !!clickHeld;
    const bl = r.bandLabel || '';
    const pv = r.allowed && r.preview ? r.preview : null;
    const out = {};
    if (busy) {
      out.rf = { label: 'Sending on ' + (bl || 'the radio') + '...', sub: r.keyed ? 'On the air now' : 'Waiting for a clear channel before keying', disabled: true, reason: '', title: 'A beacon is going out now.' };
    } else if (!r.allowed) {
      out.rf = { label: bl ? 'Beacon on ' + bl : 'Beacon on the radio', sub: r.why || 'Not available now.', disabled: true, reason: r.why || 'Not available now.', title: r.why || 'Not available now.' };
    } else {
      const pw = Number(r.powerW) > 0 ? ' at ' + r.powerW + ' W' : '';
      out.rf = { label: 'Beacon on ' + bl, sub: (r.mhz ? r.mhz + ' MHz' : bl) + pw + ', one click', disabled: false, reason: '',
        title: 'One click sends one APRS packet with your position over your radio' + (pv ? ': ' + pv.detail : '.') };
    }
    // Mode, call, path and air time, under the button before the click (the
    // button itself says one click, so the preview's last sentence is not repeated).
    out.detail = pv && !busy ? String(pv.detail).replace(/ One click transmits one packet\.$/, '') : '';

    let netReason = '';
    if (!b.call) netReason = 'Set your callsign in Settings first.';
    else if (!b.position) netReason = 'Set your grid square in Settings, or pick a point on the map.';
    out.net = {
      label: 'Beacon on the internet',
      // Under the button, short (Casey 2026-11-20): the last time, or why the button cannot send.
      sub: netReason || (b.sending ? 'Sending to APRS-IS' : lastBeaconText(b.lastAt)),
      disabled: !!(netReason || b.sending), reason: netReason,
      title: netReason || 'Send your position to APRS-IS now, over the internet' + (b.call ? ' as ' + b.call : '') + '. Nothing is transmitted on the air.',
    };

    // The last radio beacon: its peaks and how long it held the radio.
    let last = '';
    if (r.lastAt) {
      // The band only when it is not the one the button sends on now.
      const bits = ['Last radio beacon ' + ago(now - r.lastAt) + (r.lastBand && r.lastBand !== r.band ? ' on ' + bandLabel(r.lastBand) : '')];
      if (Number(r.lastHeldMs) > 0) bits.push(secs(r.lastHeldMs));
      const pk = r.lastPeak || {};
      if (Number(pk.fwdW) > 0) bits.push(watts(pk.fwdW) + ' out');
      if (Number(pk.swr) > 0) bits.push('SWR ' + (pk.swr >= 10 ? '>10' : Number(pk.swr).toFixed(1)));
      last = bits.join(' · ');
    }
    out.last = last;
    // A result or refusal from the last click (main keeps it 20 s).
    out.result = !busy && r.sentence ? { text: r.sentence, tone: /refused|not sent|nothing was sent|was stopped|ran past|could not|did not/i.test(r.sentence) ? 'bad' : 'warn' } : null;

    // The internet beacon's own line: only a refusal (its last time is on its button).
    out.netLine = { text: b.sentence || '', bad: !!b.sentence };
    if (b.lastAt && b.backAt && b.backAt >= b.lastAt && !netReason) out.net.title += ' The last one came back from APRS-IS and is on the map.';

    // The header: who each beacon goes out as (the ending's meaning is in the select under it).
    const rc = b.rfCall || '';
    out.as = rc ? 'Beacons as ' + rc + (b.call && b.call !== rc ? ' (internet ' + b.call + ')' : '') : (b.call ? 'Beacons as ' + b.call : '');
    const mean = ssidMeaning(rc, ssidChoices);
    out.asTitle = rc ? 'The radio beacon goes out as ' + rc + (mean ? ' (' + mean + ')' : '') + (b.call ? '; the internet beacon and the iGate as ' + b.call : '') + '. Your Settings callsign is not changed.' : '';
    return out;
  }

  /**
   * The live meters while the beacon is keyed: power out against the set
   * power, and SWR. swr 0 = no reading; available.swr false = none from this radio.
   */
  function liveMeters({ fwdW = 0, swr = 0, setW = 0, available = {} } = {}) {
    const f = Number(fwdW) || 0, s = Number(swr) || 0, w = Number(setW) || 0;
    const a = available || {};
    const power = (f > 0 || a.power)
      ? { shown: true, pct: w > 0 ? Math.min(100, Math.round((f / w) * 100)) : (f > 0 ? 100 : 0), text: f > 0 ? watts(f) : '—', none: false }
      : { shown: true, pct: 0, text: 'No RF out reading from this radio', none: true };
    let cls = '';
    if (s > 0) cls = s <= 1.5 ? 'ok' : s <= 3 ? 'warn' : 'high';
    const sw = (s > 0 || a.swr)
      ? { shown: true, pct: s > 0 ? Math.min(100, Math.round(((s - 1) / 2) * 100)) : 0, text: s > 0 ? (s >= 10 ? '>10' : s.toFixed(1)) : '—', cls, none: false }
      : { shown: true, pct: 0, text: 'No SWR from this radio', cls: '', none: true };
    return { power, swr: sw, note: w > 0 ? 'Set to ' + watts(w) + ', read back from the radio before keying.' : 'POTACAT has no power reading from this radio.' };
  }

  // ── the APRS settings panel: position precision ────────────────────────────
  /** "about 1 mile" or "about 2 km": one minute of latitude, in the operator's units. */
  function nearWords(unit) { return unit === 'km' ? 'about 2 km' : 'about 1 mile'; }
  /**
   * The four choices with what each reveals, for the operator's grid
   * (lib/aprs-beacon.js PRECISIONS). The checked one is the precision that
   * applies (beacon.precision from main: the saved choice, else the default,
   * Near my home; grid4 with only a 4-character grid).
   */
  function precisionChoices(beacon) {
    const b = beacon || {};
    const st = b.settings || {};
    // From the radio's GPS: the choices name the GPS grid (lib/aprs-position.js applies them to the fix).
    const fromGps = st.source === 'gps';
    const g = String(fromGps ? (b.gps && b.gps.fix && b.gps.grid) || '' : b.grid || '').toUpperCase();
    const g4 = g.slice(0, 4) || 'FN20';
    const g6 = g.length >= 6 ? g.slice(0, 4) + g.slice(4, 6).toLowerCase() : '';
    const cur = b.precision || st.precision || (st.approx === false ? 'exact' : 'near');
    const near = nearWords(b.unit);
    return [
      { id: 'grid4', label: 'Grid square, 4 characters (' + g4 + ')', note: 'Shows the middle of ' + g4 + ', an area about 110 km tall and up to 220 km wide.', checked: cur === 'grid4', disabled: !g },
      { id: 'grid6', label: 'Grid square, 6 characters (' + (g6 || g4 + 'xx') + ')', note: g6 ? 'Shows the middle of ' + g6 + ', an area about 4.6 km tall and up to 9 km wide, to the nearest minute.' : 'Your Settings grid square has 4 characters; add two more in Settings to use this.', checked: cur === 'grid6', disabled: !g6 },
      { id: 'near', label: 'Near my home (' + near + ')', note: 'aprs.fi shows you within ' + (b.unit === 'km' ? 'about 2 km' : 'about a mile') + ' of home, never at your door.', checked: cur === 'near', disabled: false },
      { id: 'exact', label: 'Exact position', note: fromGps ? "Shows your radio's GPS position, to about 20 m." : 'Shows the point you pick on the map, to about 20 m. Without a picked point, the middle of your grid square.', checked: cur === 'exact', disabled: false },
    ];
  }

  /**
   * The operator's own marker label on the map. The marker sits at home (the
   * best known position); when the beacon is less exact the label says what
   * the world sees: "K3SBP (beacon: about 1 mile)", "K3SBP (beacon: FN20)".
   */
  function homeLabel({ call, grid, precision, unit, gpsGrid } = {}) {
    const c = String(call || '').toUpperCase() || 'You';
    const g = String(gpsGrid || grid || '').toUpperCase();
    if (precision === 'near') return c + ' (beacon: ' + nearWords(unit) + ')';
    if (precision === 'grid4' && g.length >= 4) return c + ' (beacon: ' + g.slice(0, 4) + ')';
    if (precision === 'grid6' && g.length >= 6) return c + ' (beacon: ' + g.slice(0, 4) + g.slice(4, 6).toLowerCase() + ')';
    return c;
  }

  /**
   * Where the position comes from (lib/aprs-position.js): null (not shown)
   * unless a FlexRadio reports a GPS, or the GPS is already the choice. The
   * GPS choice can be picked only with a fix; without one its note is the
   * radio's own status ("Warming Up, 0 of 12 satellites").
   */
  function sourceChoices(beacon) {
    const b = beacon || {};
    const st = b.settings || {};
    const gps = b.gps || {};
    const cur = st.source === 'gps' ? 'gps' : 'settings';
    if (!gps.installed && cur !== 'gps') return null;
    const gpsNote = !gps.installed ? 'No radio with a GPS is connected. Nothing is sent until it is back with a fix.'
      : gps.fix ? 'Each beacon takes the latest fix (' + (gps.grid || '') + '), at the precision below. ' + (gps.line || '')
        : 'No fix yet: ' + (gps.line || '') + '. Nothing is sent from the GPS until it has a fix.';
    return [
      { id: 'settings', label: 'From Settings or the map', note: 'The grid square in Settings, or a point you pick on the map.', checked: cur === 'settings', disabled: false },
      { id: 'gps', label: "From my radio's GPS", note: gpsNote, checked: cur === 'gps', disabled: !gps.fix && cur !== 'gps' },
    ];
  }

  // ── TX power: minus / read back / plus ─────────────────────────────────────
  const POWER_LADDER = [0.1, 0.2, 0.5, 1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500];
  /**
   * The next power for the minus (-1) or plus (+1) button, from a
   * lib/rig-power-view.js powerView: the rig's own choices where it has them,
   * else round steps inside its min and max. null = nothing further that way.
   */
  function powerStep(view, dir) {
    if (!view || !view.shown || !view.enabled) return null;
    const cur = view.watts != null ? Number(view.watts) : null;
    let list;
    if (view.useSelect && view.choices && view.choices.length) list = view.choices.map(Number);
    else {
      const lo = Number(view.min), hi = Number(view.max);
      list = POWER_LADDER.filter((v) => v > lo && v < hi);
      list.unshift(lo); list.push(hi);
    }
    list = Array.from(new Set(list.filter((v) => isFinite(v)))).sort((a, b) => a - b);
    if (!list.length) return null;
    if (cur == null) return dir > 0 ? list[0] : null;
    if (dir > 0) { const n = list.find((v) => v > cur + 1e-9); return n == null ? null : n; }
    const below = list.filter((v) => v < cur - 1e-9);
    return below.length ? below[below.length - 1] : null;
  }

  // ── "Show the last" and age fading ─────────────────────────────────────────
  const SHOW_LAST_CHOICES = Object.freeze([15, 30, 60, 180, 360]);   // minutes
  const DEFAULT_SHOW_LAST_MIN = 60;                                  // the fixed hour before the choice
  // Full, then two fainter steps; the faintest stays readable on every theme.
  const FADE_ALPHA = Object.freeze([1, 0.75, 0.55]);

  function showLastLabel(min) { return min < 60 ? min + ' min' : (min / 60) + (min === 60 ? ' hour' : ' hours'); }
  /** The select's options: [{ min, label }]. */
  function showLastOptions() { return SHOW_LAST_CHOICES.map((min) => ({ min, label: showLastLabel(min) })); }
  /** A saved choice, or the 1 hour default for anything that is not one. */
  function normShowLast(v) {
    const n = Number(v);
    return SHOW_LAST_CHOICES.includes(n) ? n : DEFAULT_SHOW_LAST_MIN;
  }
  /** How faint a station heard ageMs ago is in a window of windowMin: { step 0|1|2, alpha }. */
  function ageFade(ageMs, windowMin) {
    const w = normShowLast(windowMin) * 60000;
    const a = Number(ageMs) || 0;
    const step = a >= w * 0.75 ? 2 : a >= w * 0.5 ? 1 : 0;
    return { step, alpha: FADE_ALPHA[step] };
  }

  // ── a station row ──────────────────────────────────────────────────────────
  /** Two lines: call + how heard; distance and age; the comment under. */
  function stationRow(r, { unit = 'mi', now = Date.now() } = {}) {
    const rf = r.rf;
    const via = rf ? (rf.kind === 'digi' ? 'my radio, via ' + (rf.digi || 'a digipeater') : 'my radio') : 'internet';
    const age = Math.max(0, now - (Number(r.lastHeard) || now));
    const m = Math.floor(age / 60000);
    const agoText = m < 1 ? 'now' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h';
    return { call: r.label || r.call || '', via, mine: !!rf, dist: distText(r.distanceKm, unit), ago: agoText, comment: r.comment || r.status || '' };
  }

  /** The list's header counts: "3 by my radio, 138 on the internet". */
  function stationCounts(rows) {
    let mine = 0, net = 0;
    for (const r of rows || []) { if (r && r.rf) mine++; else if (r) net++; }
    return { mine, net, text: (mine || net) ? mine + ' by my radio, ' + net + ' on the internet' : 'No stations yet' };
  }

  return {
    KM_PER_MI, RANGE_CHOICES, BAUD, POWER_LADDER,
    rangeKmFor, rangeOptions, nearestRange, convertSavedRange,
    ago, clock, clockSec, lastBeaconText, distText, bandLabel, sMeterPct, rfInFlight, rfKeyed,
    radioCard, isCard, igateLine, precisionChoices, homeLabel, nearWords, sourceChoices, heardCard, timerBanner, onAirBanner, beaconPanel, liveMeters, powerStep, ssidMeaning,
    stationRow, stationCounts,
    SHOW_LAST_CHOICES, DEFAULT_SHOW_LAST_MIN, FADE_ALPHA, showLastOptions, normShowLast, ageFade,
  };
});
