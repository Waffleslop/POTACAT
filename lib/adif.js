'use strict';

const fs = require('fs');

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
 * Parse an ADIF file and return a Set of all worked callsigns (uppercase).
 * Unlike parseAdifFile(), this includes ALL QSOs regardless of QSL status.
 */
function parseWorkedCallsigns(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  let body = content;
  const eohIdx = content.toUpperCase().indexOf('<EOH>');
  if (eohIdx !== -1) body = content.substring(eohIdx + 5);

  const records = body.split(/<eor>/i).filter((r) => r.trim().length > 0);
  const calls = new Set();
  for (const rec of records) {
    const f = parseRecord(rec);
    if (f.CALL) calls.add(f.CALL.toUpperCase());
  }
  return calls;
}

module.exports = { parseAdifFile, parseWorkedCallsigns, normalizeMode, normalizeBand };
