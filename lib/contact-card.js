'use strict';
/**
 * Contact details (Discord "Jump", 2026-11-23): what the Contact details
 * window shows for one callsign, built from what POTACAT already has.
 *
 *   qrz      the QRZ XML record (lib/qrz.js parseQrzCallsign), or null
 *   history  the log's contacts with the call, newest first (main's
 *            lookupPastQsos: date, time, band, mode, ref, qsl, name, qth,
 *            state, grid)
 *   record   the Logbook QSO that was clicked (an ADIF record), or null
 *   prefix   what cty.dat says about the call: entity, dxcc, zones, centroid
 *   ownGrid  the operator's grid square (Settings > Station)
 *   weather  lib/contact-weather.js's answer, or null
 *
 * build() is pure. A field nobody knows is left out of the result; the
 * window draws only what is there. Nothing here writes the log.
 */
const { gridToLatLon, latLonToGrid, haversineDistanceMiles, bearing } = require('./grid');
const QsoIdentity = require('./qso-identity');
const { baseCall } = require('../renderer/jtcat-parser'); // the station's own call, as QRZ indexes it

const EARTH_MILES = 3958.8; // lib/grid.js's radius, so short + long path = one lap
const KM_PER_MILE = 1.609344;
const MAIDENHEAD = /^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/i;
const CALL_RE = /^[A-Z0-9]{1,8}(\/[A-Z0-9]{1,8}){0,2}$/;

// US licence classes as QRZ writes them (one letter).
const US_CLASS = { E: 'Amateur Extra', A: 'Advanced', G: 'General', T: 'Technician', P: 'Technician Plus', N: 'Novice' };

const NOTE_OFF = 'Turn on QRZ.com lookups (Settings > Station) for the name and town. A QRZ XML Data subscription adds the photo and the mailing address.';
const NOTE_NO_SUB = 'A QRZ XML Data subscription adds the photo and the mailing address.';
const NOTE_LOGIN = 'QRZ.com did not accept the login, so this shows only what the log knows. Check it in Settings > Station.';

function str(v) { return v == null ? '' : String(v).trim(); }
function digits(v) { return str(v).replace(/\D/g, ''); }
function fmtDate(d) { const x = digits(d); return x.length === 8 ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6)}` : ''; }
function fmtTime(t) { const x = digits(t); return x.length >= 4 ? `${x.slice(0, 2)}:${x.slice(2, 4)}` : ''; }
function fmtBand(b) { return str(b).toLowerCase(); }
function fmtMode(m) { return str(m).toUpperCase(); }
function thousands(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function deg(b) { return String(Math.round(b) % 360).padStart(3, '0') + '°'; }
function joinList(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}
function num(v) { const s = str(v); if (!s) return NaN; const n = Number(s); return Number.isFinite(n) ? n : NaN; }
function validLatLon(lat, lon) { return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0); }

/** "Confirmed by" names, from the index's qsl letters (L LoTW, P card, E eQSL). */
const QSL_NAMES = [['L', 'LoTW'], ['P', 'QSL card'], ['E', 'eQSL']];

function headerFor(history) {
  const list = Array.isArray(history) ? history.filter(Boolean) : [];
  const count = list.length;
  if (!count) return { count: 0, confirmed: false, text: 'Not worked before.' };
  const last = list[0];
  let s = count === 1 ? 'Worked once' : `Worked ${count} times`;
  const when = fmtDate(last.date);
  const bandMode = [fmtBand(last.band), fmtMode(last.mode)].filter(Boolean).join(' ');
  const parts = [];
  if (when) parts.push('last on ' + when);
  if (bandMode) parts.push(bandMode);
  if (parts.length) s += ', ' + parts.join(', ');
  const letters = list.map((q) => str(q.qsl).toUpperCase()).join('');
  const via = QSL_NAMES.filter(([l]) => letters.includes(l)).map(([, n]) => n);
  const confirmed = via.length > 0;
  s += confirmed ? `. Confirmed by ${joinList(via)}.` : '. Not confirmed yet.';
  return { count, confirmed, text: s };
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
  const sp = bearing(me.lat, me.lon, pos.lat, pos.lon);
  const km = input.distUnit === 'km';
  const unit = km ? 'km' : 'mi';
  const f = km ? KM_PER_MILE : 1;
  const lapMiles = 2 * Math.PI * EARTH_MILES;
  return {
    shortPath: deg(sp),
    longPath: deg((sp + 180) % 360),
    distance: `${thousands(miles * f)} ${unit}`,
    longDistance: `${thousands((lapMiles - miles) * f)} ${unit}`,
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
  const sign = min < 0 ? '-' : '+';
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
  let off = null, approx = true;
  const w = input.weather;
  const q = input.qrz;
  if (w && Number.isFinite(w.utcOffsetSeconds)) {
    off = Math.round(w.utcOffsetSeconds / 60); approx = false;
  } else if (q && Number.isFinite(num(q.gmtOffset))) {
    off = Math.round(num(q.gmtOffset) * 60);
    const dst = str(q.dst).toUpperCase() === 'Y';
    if (dst && summerTimeLikely(now, pos ? pos.lat : NaN)) off += 60;
    approx = dst;
  } else if (pos) {
    off = Math.round(pos.lon / 15) * 60;
  }
  if (off == null) return null;
  return { offsetMinutes: off, approx, text: localTimeText(now, off), utc: utcLabel(off) };
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

function addressFor(q, name) {
  if (!q || !str(q.addr1)) return null; // only a subscriber's record has a street line
  const town = [str(q.addr2), [str(q.state), str(q.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const lines = [name, str(q.attn), str(q.addr1), town, str(q.country)].filter(Boolean);
  return { lines, copy: lines.join('\n') };
}

function qthFor(q, record, history) {
  if (q && (str(q.addr2) || str(q.state) || str(q.country))) {
    return [str(q.addr2), str(q.state), str(q.country)].filter(Boolean).join(', ');
  }
  if (record) {
    const r = [str(record.QTH), str(record.STATE)].filter(Boolean).join(', ');
    if (r) return r;
  }
  for (const h of history) {
    const r = h && [str(h.qth), str(h.state)].filter(Boolean).join(', ');
    if (r) return r;
  }
  return '';
}

/** "POTA US-1234" style references: the clicked QSO's own, else the last logged one. */
function refsFor(record, history) {
  if (record) {
    const own = [];
    if (str(record.SIG) && str(record.SIG_INFO)) own.push(`${str(record.SIG).toUpperCase()} ${str(record.SIG_INFO).toUpperCase()}`);
    for (const [f, p] of [['POTA_REF', 'POTA'], ['SOTA_REF', 'SOTA'], ['WWFF_REF', 'WWFF']]) {
      const v = str(record[f]).toUpperCase();
      if (v && !own.some((x) => x.endsWith(' ' + v))) own.push(`${p} ${v}`);
    }
    if (own.length) return own.join(', ') + ' (this contact)';
  }
  for (const h of history) if (h && str(h.ref)) return str(h.ref) + ' (last contact)';
  return '';
}

function thisContactFor(record) {
  if (!record) return '';
  const when = [fmtDate(record.QSO_DATE), fmtTime(record.TIME_ON)].filter(Boolean).join(' ');
  const parts = [];
  if (when) parts.push(when + (fmtTime(record.TIME_ON) ? ' UTC' : ''));
  const bandMode = [fmtBand(record.BAND), fmtMode(record.MODE)].filter(Boolean).join(' ');
  if (bandMode) parts.push(bandMode);
  const refs = refsFor(record, []);
  if (refs) parts.push(refs.replace(/ \(this contact\)$/, ''));
  return parts.join(', ');
}

function qslVia(q) {
  if (!q) return '';
  const out = [];
  if (str(q.lotw) === '1') out.push('LoTW');
  if (str(q.mqsl) === '1') out.push('Mail');
  if (str(q.eqsl) === '1') out.push('eQSL');
  return out.join(', ');
}

function weatherFor(w, distUnit) {
  if (!w || !Number.isFinite(w.tempC)) return null;
  const f = distUnit !== 'km';
  const t = f ? Math.round(w.tempC * 9 / 5 + 32) + ' °F' : Math.round(w.tempC) + ' °C';
  const cond = str(w.text);
  return { text: cond ? `${t}, ${cond.charAt(0).toLowerCase()}${cond.slice(1)}` : t };
}

function build(input) {
  const inp = input || {};
  const call = str(inp.call).toUpperCase();
  const q = inp.qrz || null;
  const history = Array.isArray(inp.history) ? inp.history.filter(Boolean) : [];
  const record = inp.record || null;
  const pf = inp.prefix || null;
  const pos = stationPosition({ ...inp, history });

  const name = nameFor(q, record, history);
  const facts = [];
  const add = (key, label, value) => { const v = str(value); if (v) facts.push({ key, label, value: v }); };

  const address = addressFor(q, name);
  if (!address) add('qth', 'Location', qthFor(q, record, history));
  add('county', 'County', (q && q.county) || (record && record.CNTY));
  const grid = (q && MAIDENHEAD.test(str(q.grid)) && str(q.grid)) || (record && MAIDENHEAD.test(str(record.GRIDSQUARE)) && str(record.GRIDSQUARE)) || '';
  add('grid', 'Grid', grid);
  const dxccNum = str(q && q.dxcc) || (pf && pf.dxcc != null ? String(pf.dxcc) : '');
  const dxccName = str(q && q.land) || (pf ? str(pf.entity) : '');
  add('dxcc', 'DXCC', [dxccNum, dxccName].filter(Boolean).join(' '));
  const cq = str(q && q.cqzone) || str(record && record.CQZ) || (pf && pf.cqZone != null ? String(pf.cqZone) : '');
  const itu = str(q && q.ituzone) || str(record && record.ITUZ) || (pf && pf.ituZone != null ? String(pf.ituZone) : '');
  add('zones', 'Zones', [cq && 'CQ ' + cq, itu && 'ITU ' + itu].filter(Boolean).join(', '));
  add('iota', 'IOTA', q && q.iota);
  add('refs', 'Reference', refsFor(record, history));
  add('qslvia', 'QSL via', qslVia(q));
  add('qslmgr', 'QSL route', q && q.qslmgr);
  add('aliases', 'Also uses', q && str(q.aliases).split(',').map(str).filter(Boolean).join(', '));

  let licence = '';
  if (q && str(q.class)) {
    const c = str(q.class);
    const us = /united states/i.test(str(q.land) || str(q.country));
    licence = (us && US_CLASS[c.toUpperCase()]) || c;
  }

  let qrzNote = '';
  if (inp.qrzState === 'subscriber') qrzNote = q ? '' : `QRZ.com has no record for ${call}.`;
  else if (inp.qrzState === 'no-subscription') qrzNote = NOTE_NO_SUB;
  else if (inp.qrzState === 'login-failed') qrzNote = NOTE_LOGIN;
  else qrzNote = NOTE_OFF;

  const photo = q && /^https:\/\/[^\s"'<>]+$/i.test(str(q.image)) ? str(q.image) : '';
  const notes = record ? str(record.COMMENT) || str(record.NOTES) : '';

  return {
    call,
    header: headerFor(history),
    photo,
    name,
    nickname: q ? str(q.nickname) : '',
    licence,
    address,
    facts,
    email: q ? str(q.email) : '',
    links: call ? [{ label: 'QRZ page', url: 'https://www.qrz.com/db/' + encodeURIComponent(baseCall(call)) }] : [],
    path: pathFor(inp, pos),
    time: timeFor(inp, pos),
    weather: weatherFor(inp.weather, inp.distUnit),
    thisContact: thisContactFor(record),
    notes,
    qrzNote,
  };
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
 * The clicked QSO in the log, by its identity (#988): the record at idx when
 * it matches, else the one record that matches. No identity, no record; a
 * record for another call is never returned.
 */
function recordFor(qsos, req) {
  if (!req || !req.identity) return null;
  const r = QsoIdentity.locate(qsos, req.idx == null ? -1 : req.idx, req.identity);
  if (!r || r.error) return null;
  const rec = qsos[r.index];
  if (!rec || str(rec.CALL).toUpperCase() !== req.call) return null;
  return rec;
}

module.exports = { build, where, stationPosition, openRequest, recordFor, localTimeText, utcLabel, NOTE_OFF, NOTE_NO_SUB, NOTE_LOGIN };
