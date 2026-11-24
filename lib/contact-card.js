'use strict';
/**
 * Contact details (Discord "Jump", 2026-11-23; layout approved by Casey the
 * same day): what the Contact details window shows for one callsign, built
 * from what POTACAT already has.
 *
 *   qrz      the QRZ XML record (lib/qrz.js parseQrzCallsign), or null
 *   qrzState 'subscriber' | 'no-subscription' | 'login-failed' | 'off'
 *   history  the log's contacts with the call, newest first (main's
 *            lookupPastQsos: date, time, band, mode, ref, qsl, rstSent,
 *            rstRcvd, name, qth, state, grid)
 *   record   the Logbook QSO that was clicked (an ADIF record), or null
 *   prefix   what cty.dat says about the call: entity, dxcc, zones, centre
 *   ownGrid  the operator's grid square (Settings > Station)
 *   distUnit 'mi' | 'km' (Settings), also picks °F or °C
 *   weather  lib/contact-weather.js's answer, or null
 *
 * build() is pure. A field nobody knows is left out (the POTA cell, and the
 * other programs when QRZ answered, show a dash instead). Nothing here
 * writes the log.
 */
const { gridToLatLon, latLonToGrid, haversineDistanceMiles, bearing } = require('./grid');
const QsoIdentity = require('./qso-identity');
const { baseCall } = require('../renderer/jtcat-parser'); // the station's own call, as QRZ indexes it

const EARTH_MILES = 3958.8; // lib/grid.js's radius, so short + long path = one lap
const KM_PER_MILE = 1.609344;
const MAIDENHEAD = /^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/i;
const CALL_RE = /^[A-Z0-9]{1,8}(\/[A-Z0-9]{1,8}){0,2}$/;
const DASH = '—';

// US licence classes as QRZ writes them (one letter).
const US_CLASS = { E: 'Amateur Extra', A: 'Advanced', G: 'General', T: 'Technician', P: 'Technician Plus', N: 'Novice', C: 'Club licence' };

const NOTE_ADDS = 'A QRZ XML subscription adds the photo, full name and mailing address.';
const NOTE_OFF = NOTE_ADDS + ' Turn on QRZ.com lookups in Settings > Station.';
const NOTE_NO_SUB = NOTE_ADDS;
const NOTE_LOGIN = 'QRZ.com did not accept the login, so this shows what your log knows. Check it in Settings > Station.';
const QSL_FROM_QRZ = 'Mailing address and QSL route come from QRZ XML.';
const STATION_NOTE = 'From your log and the callsign prefix. Fields nobody knows are left out.';

function str(v) { return v == null ? '' : String(v).trim(); }
function digits(v) { return str(v).replace(/\D/g, ''); }
function fmtDate(d) { const x = digits(d); return x.length === 8 ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6)}` : ''; }
function fmtTime(t) { const x = digits(t); return x.length >= 4 ? `${x.slice(0, 2)}:${x.slice(2, 4)}` : ''; }
function fmtBand(b) { return str(b).toLowerCase(); }
function fmtMode(m) { return str(m).toUpperCase(); }
function thousands(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function twoFigures(n) { if (n < 100) return Math.round(n); const p = Math.pow(10, Math.floor(Math.log10(n)) - 1); return Math.round(n / p) * p; }
function joinAnd(items) { return items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]; }
function num(v) { const s = str(v); if (!s) return NaN; const n = Number(s); return Number.isFinite(n) ? n : NaN; }
function validLatLon(lat, lon) { return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0); }

/** Confirmation letters in the log index: L LoTW, P paper card, E eQSL. */
const QSL_NAMES = [['L', 'LoTW'], ['P', 'QSL card'], ['E', 'eQSL']];
function confirmedBy(letters) { const l = str(letters).toUpperCase(); return QSL_NAMES.filter(([k]) => l.includes(k)).map(([, n]) => n); }
function bandMode(q) { return [fmtBand(q.band), fmtMode(q.mode)].filter(Boolean).join(' '); }

/** The status pill and the line beside the call. */
function headerFor(history) {
  const list = Array.isArray(history) ? history.filter(Boolean) : [];
  const count = list.length;
  if (!count) return { count: 0, status: 'new', statusLabel: '', text: 'Not worked before.' };
  const times = count === 1 ? 'Worked once' : `Worked ${count} times`;
  const conf = list.find((q) => confirmedBy(q.qsl).length);
  if (conf) {
    const when = fmtDate(conf.date);
    const bm = bandMode(conf);
    let s = `${times}. Confirmed`;
    if (when) s += ' ' + when;
    if (bm) s += ' on ' + bm;
    s += ' by ' + joinAnd(confirmedBy(conf.qsl)) + '.';
    return { count, status: 'confirmed', statusLabel: 'Confirmed', text: s };
  }
  const last = list[0];
  const when = fmtDate(last.date);
  const bm = bandMode(last);
  let s = times;
  if (when || bm) s += (count === 1 ? ', ' : ', last ') + [when, bm && 'on ' + bm].filter(Boolean).join(' ');
  return { count, status: 'worked', statusLabel: 'Worked', text: s + '. Not confirmed yet.' };
}

/**
 * Where the station is, best source first: QRZ's own position, QRZ's grid,
 * the clicked QSO's grid, the newest logged grid, then the callsign prefix
 * (approximate). Returns { lat, lon, approx, from } or null.
 */
function stationPosition(input) {
  const q = input.qrz;
  if (q) {
    const lat = num(q.lat), lon = num(q.lon);
    if (validLatLon(lat, lon) && str(q.geoloc).toLowerCase() !== 'none') {
      const g = MAIDENHEAD.test(str(q.grid)) ? str(q.grid) : '';
      return { lat, lon, approx: false, from: g ? 'grid ' + g : 'QRZ.com' };
    }
  }
  const grids = [q && q.grid, input.record && input.record.GRIDSQUARE];
  for (const h of (Array.isArray(input.history) ? input.history : [])) grids.push(h && h.grid);
  for (const g0 of grids) {
    const g = str(g0);
    if (MAIDENHEAD.test(g)) {
      const p = gridToLatLon(g);
      if (p) return { lat: p.lat, lon: p.lon, approx: false, from: 'grid ' + g };
    }
  }
  const pf = input.prefix;
  if (pf && validLatLon(Number(pf.lat), Number(pf.lon))) {
    return { lat: Number(pf.lat), lon: Number(pf.lon), approx: true, from: `${pf.entity || 'the prefix'} (from the callsign)` };
  }
  return null;
}

/** The position the weather is asked for: the centre of the station's 4-character square. */
function where(input) {
  const p = stationPosition(input || {});
  if (!p) return null;
  const grid4 = latLonToGrid(p.lat, p.lon).slice(0, 4).toUpperCase();
  const c = gridToLatLon(grid4);
  return { lat: c.lat, lon: c.lon, grid4 };
}

function pathFor(input, pos) {
  const own = str(input.ownGrid);
  if (!pos || !MAIDENHEAD.test(own)) return null;
  const me = gridToLatLon(own);
  if (!me) return null;
  const miles = haversineDistanceMiles(me.lat, me.lon, pos.lat, pos.lon);
  const sp = Math.round(bearing(me.lat, me.lon, pos.lat, pos.lon)) % 360;
  const km = input.distUnit === 'km';
  const unit = km ? 'km' : 'mi';
  const f = km ? KM_PER_MILE : 1;
  const lapMiles = 2 * Math.PI * EARTH_MILES;
  const dist = (m) => (pos.approx ? `about ${thousands(twoFigures(m * f))}` : thousands(m * f)) + ' ' + unit;
  return {
    shortDeg: sp,
    shortPath: sp + '°',
    longPath: ((sp + 180) % 360) + '°',
    distance: dist(miles),
    longDistance: dist(lapMiles - miles),
    approx: !!pos.approx,
    from: pos.from,
  };
}

/** Is summer time likely in force at `now`? A guess by hemisphere and month: callers mark it approximate. */
function summerTimeLikely(now, lat) {
  const m = new Date(now).getUTCMonth(); // 0 = January
  if (Number.isFinite(lat) && lat < 0) return m >= 9 || m <= 2; // October to March
  return m >= 3 && m <= 9; // April to October
}

function utcLabel(min) {
  if (!min) return 'UTC';
  const sign = min < 0 ? '−' : '+';
  const a = Math.abs(min);
  const h = Math.floor(a / 60), mm = a % 60;
  return `UTC${sign}${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
}

/** "HH:MM" at a UTC offset in minutes. */
function localTimeText(now, offsetMinutes) {
  return new Date(now + offsetMinutes * 60000).toISOString().slice(11, 16);
}

function timeFor(input, pos) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  let off = null, how = '';
  const w = input.weather;
  const q = input.qrz;
  if (w && Number.isFinite(w.utcOffsetSeconds)) {
    off = Math.round(w.utcOffsetSeconds / 60); how = 'exact';
  } else if (q && Number.isFinite(num(q.gmtOffset))) {
    off = Math.round(num(q.gmtOffset) * 60);
    const dst = str(q.dst).toUpperCase() === 'Y';
    if (dst && summerTimeLikely(now, pos ? pos.lat : NaN)) off += 60;
    how = dst ? 'guess' : 'exact';
  } else if (pos) {
    off = Math.round(pos.lon / 15) * 60; how = 'longitude';
  }
  if (off == null) return null;
  const utc = utcLabel(off);
  const sub = how === 'longitude' ? 'local time, from longitude'
    : how === 'guess' ? `local time, about ${utc}` : `local time, ${utc}`;
  return { offsetMinutes: off, approx: how !== 'exact', text: localTimeText(now, off), utc, sub };
}

function nameFor(q, record, history) {
  if (q) {
    const n = [str(q.fname), str(q.name)].filter(Boolean).join(' ');
    if (n) return n;
  }
  if (record && str(record.NAME)) return str(record.NAME);
  for (const h of history) if (h && str(h.name)) return str(h.name);
  return '';
}

function townFor(q, record, history, pf) {
  if (q && (str(q.addr2) || str(q.state) || str(q.country))) {
    return [str(q.addr2), str(q.state), str(q.country)].filter(Boolean).join(', ');
  }
  let local = '';
  if (record) local = [str(record.QTH), str(record.STATE)].filter(Boolean).join(', ');
  if (!local) for (const h of history) { local = h ? [str(h.qth), str(h.state)].filter(Boolean).join(', ') : ''; if (local) break; }
  const country = (record && str(record.COUNTRY)) || (pf ? str(pf.entity) : '');
  return [local, country].filter(Boolean).join(', ');
}

function addressFor(q, name) {
  if (!q || !str(q.addr1)) return null; // only a subscriber's record has a street line
  const town = [str(q.addr2), [str(q.state), str(q.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const lines = [name, str(q.attn), str(q.addr1), [town, str(q.country)].filter(Boolean).join(', ')].filter(Boolean);
  return { lines, copy: lines.join('\n') };
}

/** Program references ({ POTA: 'US-1234', ... }): the clicked QSO's own first, then the newest logged ones. */
function programRefs(record, history) {
  const out = {};
  const put = (prog, ref) => { const p = str(prog).toUpperCase(), r = str(ref).toUpperCase(); if (p && r && !out[p]) out[p] = r; };
  if (record) {
    put(record.SIG, record.SIG_INFO);
    put('POTA', record.POTA_REF); put('SOTA', record.SOTA_REF); put('WWFF', record.WWFF_REF);
  }
  for (const h of history) {
    const m = h && str(h.ref).match(/^(\S+)\s+(.+)$/);
    if (m) put(m[1], m[2]);
  }
  return out;
}

function stationFor(q, record, history, pf) {
  const rows = [];
  const add = (label, value, always) => { const v = str(value); if (v || always) rows.push({ label, value: v || DASH }); };
  add('County', (q && q.county) || (record && record.CNTY));
  add('State', (q && q.state) || (record && record.STATE) || (history.find((h) => str(h.state)) || {}).state);
  const dxccNum = str(q && q.dxcc) || (pf && pf.dxcc != null ? String(pf.dxcc) : '');
  const dxccName = str(q && q.land) || (pf ? str(pf.entity) : '');
  add('DXCC', [dxccNum, dxccName].filter(Boolean).join(' '));
  const cq = str(q && q.cqzone) || str(record && record.CQZ) || (pf && pf.cqZone != null ? String(pf.cqZone) : '');
  const itu = str(q && q.ituzone) || str(record && record.ITUZ) || (pf && pf.ituZone != null ? String(pf.ituZone) : '');
  if (cq || itu) add('CQ / ITU zone', `${cq || DASH} / ${itu || DASH}`);
  const refs = programRefs(record, history);
  add('POTA', refs.POTA, true);
  add('SOTA', refs.SOTA, !!q);
  add('WWFF', refs.WWFF, !!q);
  add('IOTA', (q && q.iota) || refs.IOTA, !!q);
  return rows;
}

function qslVia(q) {
  if (!q) return '';
  const out = [];
  if (str(q.lotw) === '1') out.push('LoTW');
  if (str(q.mqsl) === '1') out.push('Mail');
  if (str(q.eqsl) === '1') out.push('eQSL');
  if (!out.length && str(q.qslmgr)) out.push(str(q.qslmgr));
  return out.join(', ');
}

function weatherFor(w, distUnit) {
  if (!w || !Number.isFinite(w.tempC)) return null;
  const f = distUnit !== 'km';
  const t = f ? Math.round(w.tempC * 9 / 5 + 32) + '°F' : Math.round(w.tempC) + '°C';
  const cond = str(w.text);
  return { text: cond ? `${t}, ${cond.charAt(0).toLowerCase()}${cond.slice(1)}` : t, fetchedAt: Number.isFinite(w.fetchedAt) ? w.fetchedAt : null };
}

/** "Open-Meteo, 4 min ago" */
function weatherAge(fetchedAt, now) {
  if (!Number.isFinite(fetchedAt)) return 'Open-Meteo';
  const min = Math.max(0, Math.floor((now - fetchedAt) / 60000));
  return 'Open-Meteo, ' + (min < 1 ? 'just now' : `${min} min ago`);
}

function contactsFor(history, record) {
  const id = record ? [digits(record.QSO_DATE), digits(record.TIME_ON).slice(0, 4), fmtBand(record.BAND)].join('|') : '';
  return history.map((h) => {
    const rst = [str(h.rstSent), str(h.rstRcvd)];
    const m = str(h.ref).match(/^(\S+)\s+(.+)$/);
    const row = {
      when: [fmtDate(h.date), fmtTime(h.time)].filter(Boolean).join(' '),
      band: fmtBand(h.band),
      mode: fmtMode(h.mode),
      rst: rst[0] || rst[1] ? `${rst[0] || DASH} / ${rst[1] || DASH}` : DASH,
      park: m ? m[2] : DASH,
      status: confirmedBy(h.qsl).length ? 'Confirmed' : 'Worked',
    };
    if (id && [digits(h.date), digits(h.time).slice(0, 4), fmtBand(h.band)].join('|') === id) row.current = true;
    return row;
  });
}

function build(input) {
  const inp = input || {};
  const call = str(inp.call).toUpperCase();
  const q = inp.qrz || null;
  const history = Array.isArray(inp.history) ? inp.history.filter(Boolean) : [];
  const record = inp.record || null;
  const pf = inp.prefix || null;
  const now = Number.isFinite(inp.now) ? inp.now : Date.now();
  const pos = stationPosition({ ...inp, history });
  const header = headerFor(history);
  const name = nameFor(q, record, history);

  const pills = [];
  if (q && str(q.class)) {
    const c = str(q.class);
    const us = /united states/i.test(str(q.land) || str(q.country));
    pills.push({ text: (us && US_CLASS[c.toUpperCase()]) || c, kind: '' });
  }
  if (q && str(q.nickname) && str(q.nickname) !== str(q.fname)) pills.push({ text: `Goes by ${str(q.nickname)}`, kind: '' });
  const grid = [q && q.grid, record && record.GRIDSQUARE, ...history.map((h) => h.grid)].map(str).find((g) => MAIDENHEAD.test(g)) || '';
  if (grid) pills.push({ text: grid, kind: 'grid' });

  const notes = [];
  const comment = record ? str(record.COMMENT) || str(record.NOTES) : '';
  if (comment) notes.push('Notes: ' + comment);
  const aliases = q ? str(q.aliases).split(',').map(str).filter(Boolean).join(', ') : '';
  if (aliases) notes.push('Also uses: ' + aliases);

  let qrzNote = '';
  if (inp.qrzState === 'subscriber') qrzNote = q ? '' : `QRZ.com has no record for ${call}.`;
  else if (inp.qrzState === 'no-subscription') qrzNote = NOTE_NO_SUB;
  else if (inp.qrzState === 'login-failed') qrzNote = NOTE_LOGIN;
  else qrzNote = NOTE_OFF;

  const full = inp.qrzState === 'subscriber' && !!q;
  const photo = q && /^https:\/\/[^\s"'<>]+$/i.test(str(q.image)) ? str(q.image) : '';
  const address = addressFor(q, name);
  const via = qslVia(q);
  const email = q ? str(q.email) : '';
  const hasQsl = !!(address || via || email);

  const weather = weatherFor(inp.weather, inp.distUnit);
  if (weather) weather.source = weatherAge(weather.fetchedAt, now);

  const source = full ? 'Looked up on QRZ.com (XML subscription).'
    : q ? 'Looked up on QRZ.com, without an XML subscription.'
      : 'No QRZ.com lookup: from your log and the callsign prefix.';

  return {
    call,
    status: header.status,
    statusLabel: header.statusLabel,
    headline: header.text,
    count: header.count,
    qrzUrl: q && call ? 'https://www.qrz.com/db/' + encodeURIComponent(baseCall(call)) : '',
    full,
    operator: { photo, name, town: townFor(q, record, history, pf), pills, notes, note: qrzNote },
    path: pathFor(inp, pos),
    time: timeFor({ ...inp, now }, pos),
    weather,
    station: stationFor(q, record, history, pf),
    stationNote: q ? '' : STATION_NOTE,
    qsl: { available: hasQsl, via, address, email, note: hasQsl ? '' : QSL_FROM_QRZ },
    contacts: contactsFor(history, record),
    source,
  };
}

/** The one-line summary under the Log QSO call field: "Name, Town. 45° 312 mi. Worked 3 times, confirmed." */
function summaryLine(input) {
  const vm = build(input);
  const parts = [];
  const who = [vm.operator.name, vm.operator.town].filter(Boolean).join(', ');
  if (who) parts.push(who + '.');
  if (vm.path) parts.push(`${vm.path.shortPath} ${vm.path.distance}.`);
  if (!vm.count) parts.push('Not worked before.');
  else parts.push((vm.count === 1 ? 'Worked once' : `Worked ${vm.count} times`) + (vm.status === 'confirmed' ? ', confirmed.' : ', not confirmed yet.'));
  return parts.join(' ');
}

/** What a Details button may ask for: a callsign, and for a Logbook row its idx and identity. */
function openRequest(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const call = str(msg.call).toUpperCase();
  if (!call || !CALL_RE.test(call)) return null;
  const i = typeof msg.idx === 'number' ? msg.idx : NaN;
  const idx = Number.isInteger(i) && i >= 0 ? i : null;
  const identity = QsoIdentity.isIdentity(msg.identity) ? msg.identity : null;
  return { call, idx, identity };
}

/**
 * The clicked QSO in the log, by its identity (#988, #996): the record at idx
 * when it matches, else the one record that matches. No identity, no record;
 * a record for another call is never returned.
 */
function recordFor(qsos, req) {
  if (!req || !req.identity) return null;
  const r = QsoIdentity.locate(qsos, req.idx == null ? -1 : req.idx, req.identity);
  if (!r || r.error) return null;
  const rec = qsos[r.index];
  if (!rec || str(rec.CALL).toUpperCase() !== req.call) return null;
  return rec;
}

module.exports = {
  build, summaryLine, where, stationPosition, openRequest, recordFor, localTimeText, utcLabel,
  NOTE_OFF, NOTE_NO_SUB, NOTE_LOGIN, QSL_FROM_QRZ, STATION_NOTE,
};
