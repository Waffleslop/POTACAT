'use strict';
/**
 * Bringing in contacts logged in N3FJP on its own (W6ING 2026-10-25: "I also
 * use N3FJP as stand alone and would like for it to sync ... without having
 * to upload an ADI file everytime").
 *
 * POTACAT already forwards to N3FJP over its TCP API (port 1100). The same
 * API lists the log: `<CMD><LIST><INCLUDEALL></CMD>` (every record, every
 * filled field) and `<CMD><LIST><INCLUDEALL><VALUE>n</VALUE></CMD>` (the
 * most recent n). N3FJP's help page does not show the REPLY, so this parser
 * assumes as little as possible: it reads every `<TAG>value</TAG>` leaf in
 * order, names a tag with or without N3FJP's `fld` column prefix, starts a
 * new record at each CALL, and also accepts plain ADIF (`<call:5>` ... <EOR>).
 * A record without a call, a date and a time, or without a band or
 * frequency, is dropped rather than guessed at. `requestList` is the one
 * socket; main.js decides when to pull and imports the records.
 */

const { freqToBand } = require('./bands');

// N3FJP column (minus `fld`, lower case) -> ADIF field.
const COLUMN_TO_ADIF = {
  call: 'CALL',
  datestr: 'QSO_DATE', date: 'QSO_DATE', qsodate: 'QSO_DATE', dateon: 'QSO_DATE',
  timeonstr: 'TIME_ON', timeon: 'TIME_ON', time: 'TIME_ON',
  timeoffstr: 'TIME_OFF', timeoff: 'TIME_OFF',
  band: 'BAND',
  mode: 'MODE', submode: 'SUBMODE',
  frequency: 'FREQ', freq: 'FREQ',
  rsts: 'RST_SENT', rstsent: 'RST_SENT',
  rstr: 'RST_RCVD', rstrcvd: 'RST_RCVD', rstreceived: 'RST_RCVD',
  name: 'NAME', firstname: 'NAME',
  qth: 'QTH', city: 'QTH',
  state: 'STATE',
  county: 'CNTY', cnty: 'CNTY',
  countryworked: 'COUNTRY', country: 'COUNTRY',
  dxcc: 'DXCC',
  gridr: 'GRIDSQUARE', grid: 'GRIDSQUARE', gridsquare: 'GRIDSQUARE',
  comments: 'COMMENT', comment: 'COMMENT',
  operator: 'OPERATOR',
  stationcallsign: 'STATION_CALLSIGN',
  power: 'TX_PWR', txpwr: 'TX_PWR',
  cqz: 'CQZ', ituz: 'ITUZ', continent: 'CONT', cont: 'CONT',
  sig: 'SIG', siginfo: 'SIG_INFO',
  potaref: 'POTA_REF', sotaref: 'SOTA_REF', wwffref: 'WWFF_REF',
  mysig: 'MY_SIG', mysiginfo: 'MY_SIG_INFO', mypotaref: 'MY_POTA_REF', mygridsquare: 'MY_GRIDSQUARE',
  qslr: 'QSL_RCVD', qslrcvd: 'QSL_RCVD', qsls: 'QSL_SENT', qslsent: 'QSL_SENT',
  lotwqslrcvd: 'LOTW_QSL_RCVD', lotwqslsent: 'LOTW_QSL_SENT',
};

function columnKey(tag) {
  return String(tag || '').toLowerCase().replace(/^fld/, '').replace(/[^a-z0-9]/g, '');
}

// Year-first only (2026/10/25, 2026-10-25, 20261025). A day-or-month-first
// date is ambiguous between US and European settings, so it is dropped.
function normDate(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/) || s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}${mo.padStart(2, '0')}${d.padStart(2, '0')}`;
}

function normTime(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return m[1].padStart(2, '0') + m[2] + (m[3] || '00');
  m = s.match(/^(\d{4}|\d{6})$/);
  return m ? (m[1] + '00').slice(0, 6) : null;
}

function normBand(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) return s + 'm';   // N3FJP keeps "20" for 20 m
  return s.replace(/\s+/g, '');
}

function normFreqMhz(v) {
  const f = parseFloat(String(v || '').replace(',', '.'));
  if (!Number.isFinite(f) || f <= 0) return null;
  return f > 1000 ? f / 1000 : f;                  // a kHz value, just in case
}

/** One field map (any tag names) -> an ADIF record, or null when unusable. */
function toAdifRecord(fields) {
  const r = {};
  for (const [tag, raw] of Object.entries(fields)) {
    const val = String(raw == null ? '' : raw).trim();
    if (!val) continue;
    const adif = COLUMN_TO_ADIF[columnKey(tag)];
    if (adif && !(adif in r)) r[adif] = val;
  }
  if (!r.CALL) return null;
  r.CALL = r.CALL.toUpperCase();
  const date = normDate(r.QSO_DATE);
  const time = normTime(r.TIME_ON);
  if (!date || !time) return null;
  r.QSO_DATE = date;
  r.TIME_ON = time;
  if (r.TIME_OFF) { const t = normTime(r.TIME_OFF); if (t) r.TIME_OFF = t; else delete r.TIME_OFF; }
  const mhz = normFreqMhz(r.FREQ);
  if (mhz) r.FREQ = String(+mhz.toFixed(6)); else delete r.FREQ;
  r.BAND = normBand(r.BAND) || (mhz ? (freqToBand(mhz) || '') : '');
  if (!r.BAND) delete r.BAND;
  if (!r.FREQ && !r.BAND) return null;
  if (r.MODE) {
    const m = r.MODE.toUpperCase();
    r.MODE = m === 'PH' ? 'SSB' : m;               // N3FJP's search groups say PH
  }
  return r;
}

/** Records from a LIST reply. Returns { records, dropped }. */
function parseListReply(text) {
  const s = String(text || '');
  const groups = [];
  if (/<eor>/i.test(s) && /<[a-z_]+:\d+/i.test(s)) {
    // Plain ADIF.
    for (const chunk of s.split(/<eor>/i)) {
      const f = {};
      const re = /<([a-z_][a-z0-9_]*):(\d+)(?::[a-z])?>/gi;
      let m;
      while ((m = re.exec(chunk))) {
        const len = parseInt(m[2], 10);
        f[m[1].toUpperCase()] = chunk.substr(re.lastIndex, len);
        re.lastIndex += len;
      }
      if (Object.keys(f).length) groups.push(f);
    }
  } else {
    // XML-ish leaves in order; a new record starts at each CALL.
    const re = /<([A-Za-z_][\w]*)>([^<]*)<\/\1>/g;
    let cur = null, m;
    while ((m = re.exec(s))) {
      const key = columnKey(m[1]);
      if (key === 'call' && cur && Object.keys(cur).some((k) => columnKey(k) === 'call')) {
        groups.push(cur); cur = null;
      }
      if (!cur) cur = {};
      cur[m[1]] = decodeEntities(m[2]);
    }
    if (cur) groups.push(cur);
  }
  const records = [];
  let dropped = 0;
  for (const g of groups) {
    if (!Object.keys(g).some((k) => columnKey(k) === 'call')) continue; // a wrapper, not a QSO
    const r = toAdifRecord(g);
    if (r) records.push(r); else dropped++;
  }
  return { records, dropped };
}

function decodeEntities(v) {
  return String(v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** The command for a pull: the whole log the first time, then the most recent `recent`. */
function listCommand({ recent } = {}) {
  return recent > 0
    ? `<CMD><LIST><INCLUDEALL><VALUE>${Math.floor(recent)}</VALUE></CMD>\r\n`
    : '<CMD><LIST><INCLUDEALL></CMD>\r\n';
}

/**
 * Send a LIST command and read the whole reply. N3FJP keeps the socket open
 * after answering, so the reply is over once it has been quiet for a moment;
 * an empty CR+LF then ends the connection, as its API asks.
 */
function requestList(host, port, cmd, { quietMs = 2000, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const chunks = [];
    let settled = false, quiet = null, overall = null;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(quiet); clearTimeout(overall);
      try { sock.write('\r\n'); } catch {}
      try { sock.end(); } catch {}
      if (err) reject(err); else resolve(Buffer.concat(chunks).toString('utf-8'));
    };
    const sock = net.createConnection({ host, port }, () => sock.write(cmd, 'utf-8'));
    sock.on('data', (d) => {
      chunks.push(d);
      clearTimeout(quiet);
      quiet = setTimeout(() => done(), quietMs);
    });
    sock.on('close', () => done());
    sock.on('error', (err) => done(new Error(`N3FJP: ${err.message}`)));
    // A whole log can be large; the first byte is what we wait for.
    overall = setTimeout(() => done(chunks.length ? null : new Error('N3FJP did not answer the log request')), timeoutMs);
  });
}

module.exports = { parseListReply, toAdifRecord, listCommand, requestList, normDate, normTime, normBand };
