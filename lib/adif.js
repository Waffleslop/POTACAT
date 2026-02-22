'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Normalize mode string: USB/LSB → SSB, etc.
 */
function normalizeMode(mode) {
  if (!mode) return '';
  const m = mode.toUpperCase().trim();
  if (m === 'USB' || m === 'LSB') return 'SSB';
  return m;
}

/**
 * Normalize band string: "20M" → "20m"
 */
function normalizeBand(band) {
  if (!band) return '';
  return band.toLowerCase().trim();
}

/**
 * Parse an ADIF field tag like <CALL:5>W1AW
 * Returns array of { field, value } objects for one record.
 */
function parseRecord(record) {
  const fields = {};
  const re = /<(\w+):(\d+)(?::[^>]*)?>/gi;
  let match;
  while ((match = re.exec(record)) !== null) {
    const field = match[1].toUpperCase();
    const len = parseInt(match[2], 10);
    const start = match.index + match[0].length;
    const value = record.substring(start, start + len);
    fields[field] = value;
  }
  return fields;
}

/**
 * Parse an ADIF file. Returns array of confirmed QSO objects:
 * { call, band, mode, dxcc, qsoDate }
 *
 * Only includes QSOs where QSL_RCVD='Y' or LOTW_QSL_RCVD='Y'.
 */
function parseAdifFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Skip header (everything before first <EOH> if present)
  let body = content;
  const eohIdx = content.toUpperCase().indexOf('<EOH>');
  if (eohIdx !== -1) {
    body = content.substring(eohIdx + 5);
  }

  // Split into records by <EOR>
  const records = body.split(/<eor>/i).filter((r) => r.trim().length > 0);

  const qsos = [];
  for (const rec of records) {
    const f = parseRecord(rec);
    if (!f.CALL) continue;

    // Only confirmed QSOs
    const qslRcvd = (f.QSL_RCVD || '').toUpperCase();
    const lotwRcvd = (f.LOTW_QSL_RCVD || '').toUpperCase();
    if (qslRcvd !== 'Y' && lotwRcvd !== 'Y') continue;

    qsos.push({
      call: f.CALL.toUpperCase(),
      band: normalizeBand(f.BAND || ''),
      mode: normalizeMode(f.MODE || ''),
      dxcc: f.DXCC ? parseInt(f.DXCC, 10) : null,
      qsoDate: f.QSO_DATE || '',
    });
  }

  return qsos;
}

/**
 * Parse an ADIF file and return a Map of worked callsigns → QSO entries.
 * Each entry has { date: 'YYYYMMDD', ref: 'K-1234' } for smart hide-worked filtering.
 * Unlike parseAdifFile(), this includes ALL QSOs regardless of QSL status.
 * @returns {Map<string, Array<{date: string, ref: string}>>}
 */
function parseWorkedQsos(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  let body = content;
  const eohIdx = content.toUpperCase().indexOf('<EOH>');
  if (eohIdx !== -1) body = content.substring(eohIdx + 5);

  const records = body.split(/<eor>/i).filter((r) => r.trim().length > 0);
  const qsoMap = new Map();
  for (const rec of records) {
    const f = parseRecord(rec);
    if (!f.CALL) continue;
    const call = f.CALL.toUpperCase();
    const entry = { date: f.QSO_DATE || '', ref: (f.SIG_INFO || '').toUpperCase() };
    if (!qsoMap.has(call)) qsoMap.set(call, []);
    qsoMap.get(call).push(entry);
  }
  return qsoMap;
}

/**
 * Parse an ADIF file and return ALL QSOs with preserved fields for import.
 * Returns array of objects with key fields extracted from each record.
 * Skips records without a CALL field.
 */
function parseAllQsos(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  let body = content;
  const eohIdx = content.toUpperCase().indexOf('<EOH>');
  if (eohIdx !== -1) body = content.substring(eohIdx + 5);

  const records = body.split(/<eor>/i).filter((r) => r.trim().length > 0);
  const qsos = [];
  for (const rec of records) {
    const f = parseRecord(rec);
    if (!f.CALL) continue;
    qsos.push({
      call: f.CALL,
      qsoDate: f.QSO_DATE || '',
      timeOn: f.TIME_ON || '',
      band: f.BAND || '',
      mode: f.MODE || '',
      freq: f.FREQ || '',
      dxcc: f.DXCC || '',
      country: f.COUNTRY || '',
      cont: f.CONT || '',
      qslRcvd: f.QSL_RCVD || '',
      lotwQslRcvd: f.LOTW_QSL_RCVD || '',
      gridsquare: f.GRIDSQUARE || '',
      rstSent: f.RST_SENT || '',
      rstRcvd: f.RST_RCVD || '',
      comment: f.COMMENT || '',
    });
  }
  return qsos;
}

/**
 * Check if a file path is a SQLite database (by extension).
 */
function isSqliteFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.sqlite' || ext === '.db';
}

/**
 * Load sql.js and open a SQLite database file.
 */
async function openSqliteDb(filePath) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(filePath);
  return new SQL.Database(buffer);
}

/**
 * Parse qsoconfirmations JSON from Log4OM.
 * Returns { qslRcvd, lotwQslRcvd } with 'Y' or 'N' values.
 */
function parseConfirmations(json) {
  let qslRcvd = 'N';
  let lotwQslRcvd = 'N';
  if (!json) return { qslRcvd, lotwQslRcvd };
  try {
    const arr = JSON.parse(json);
    for (const entry of arr) {
      if (entry.CT === 'LOTW' && entry.R === 'Yes') lotwQslRcvd = 'Y';
      if (entry.CT === 'QSL' && entry.R === 'Yes') qslRcvd = 'Y';
    }
  } catch { /* ignore malformed JSON */ }
  return { qslRcvd, lotwQslRcvd };
}

/**
 * Parse a Log4OM SQLite file. Returns same format as parseAllQsos():
 * array of { call, qsoDate, timeOn, band, mode, freq, dxcc, country, cont,
 *            qslRcvd, lotwQslRcvd, gridsquare, rstSent, rstRcvd, comment }
 */
async function parseSqliteFile(filePath) {
  const db = await openSqliteDb(filePath);
  try {
    const stmt = db.prepare(
      `SELECT callsign, band, mode, qsodate, freq, dxcc, country, cont,
              gridsquare, rstsent, rstrcvd, comment, qsoconfirmations
       FROM Log`
    );
    const qsos = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (!row.callsign) continue;

      // Parse qsodate: "2025-11-30 21:56:19Z" → qsoDate "20251130", timeOn "215619"
      let qsoDate = '';
      let timeOn = '';
      if (row.qsodate) {
        const d = String(row.qsodate).replace(/[-:T]/g, '').replace('Z', '');
        // d is now "20251130 215619" or "20251130215619"
        const digits = d.replace(/\s/g, '');
        if (digits.length >= 8) qsoDate = digits.substring(0, 8);
        if (digits.length >= 14) timeOn = digits.substring(8, 14);
      }

      // Parse freq: kHz (e.g. 7031.48) → MHz string ("7.03148")
      let freqMhz = '';
      if (row.freq != null) {
        freqMhz = (row.freq / 1000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
      }

      const conf = parseConfirmations(row.qsoconfirmations);

      qsos.push({
        call: String(row.callsign),
        qsoDate,
        timeOn,
        band: String(row.band || ''),
        mode: String(row.mode || ''),
        freq: freqMhz,
        dxcc: row.dxcc != null ? String(row.dxcc) : '',
        country: String(row.country || ''),
        cont: String(row.cont || ''),
        qslRcvd: conf.qslRcvd,
        lotwQslRcvd: conf.lotwQslRcvd,
        gridsquare: String(row.gridsquare || ''),
        rstSent: String(row.rstsent || ''),
        rstRcvd: String(row.rstrcvd || ''),
        comment: String(row.comment || ''),
      });
    }
    stmt.free();
    return qsos;
  } finally {
    db.close();
  }
}

/**
 * Parse a Log4OM SQLite file for DXCC tracker (confirmed QSOs only).
 * Returns same format as parseAdifFile():
 * array of { call, band, mode, dxcc, qsoDate }
 */
async function parseSqliteConfirmed(filePath) {
  const db = await openSqliteDb(filePath);
  try {
    const stmt = db.prepare(
      `SELECT callsign, band, mode, qsodate, dxcc, qsoconfirmations FROM Log`
    );
    const qsos = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (!row.callsign) continue;

      const conf = parseConfirmations(row.qsoconfirmations);
      if (conf.qslRcvd !== 'Y' && conf.lotwQslRcvd !== 'Y') continue;

      let qsoDate = '';
      if (row.qsodate) {
        const digits = String(row.qsodate).replace(/[-:T\sZ]/g, '');
        if (digits.length >= 8) qsoDate = digits.substring(0, 8);
      }

      qsos.push({
        call: String(row.callsign).toUpperCase(),
        band: normalizeBand(String(row.band || '')),
        mode: normalizeMode(String(row.mode || '')),
        dxcc: row.dxcc != null ? parseInt(row.dxcc, 10) : null,
        qsoDate,
      });
    }
    stmt.free();
    return qsos;
  } finally {
    db.close();
  }
}

module.exports = { parseAdifFile, parseWorkedQsos, parseAllQsos, parseSqliteFile, parseSqliteConfirmed, isSqliteFile, normalizeMode, normalizeBand };
