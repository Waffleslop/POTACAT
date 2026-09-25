'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { freqToBand } = require('./bands');

const ADIF_HEADER = `ADIF Export from POTACAT
<ADIF_VER:5>3.1.4
<PROGRAMID:7>POTACAT
<EOH>
`;

/**
 * Format a single ADIF field: <FIELD:length>value
 */
function adifField(name, value) {
  if (value == null || value === '') return '';
  const str = String(value);
  return `<${name}:${str.length}>${str}`;
}

/**
 * Normalize a mode string to ADIF's MODE/SUBMODE vocabulary. PSK31/PSK63/…
 * are SUBMODEs of MODE=PSK — LoTW and most loggers reject MODE=PSK31, so
 * the split happens here, the one choke point every record-writer funnels
 * through. An explicit qso.submode always wins.
 */
function adifModeSubmode(mode, submode) {
  const m = String(mode || '').toUpperCase();
  if (!submode && /^PSK\d+[A-Z]*$/.test(m)) return { mode: 'PSK', submode: m };
  // JS8 is a SUBMODE of MFSK in ADIF (3.1.1+). Bare MODE=JS8 is rejected by
  // LoTW and most loggers — same failure class the PSK31 mapping fixes.
  // UNCONDITIONAL for JS8: the JS8 speed (Normal/Fast/Turbo/Slow/Ultra) is NOT
  // an ADIF distinction, and some callers tag it as `submode` (js8-qso.js) —
  // if that leaked through it would write invalid MODE=JS8/SUBMODE=NORMAL. So
  // JS8 always collapses to MFSK/JS8 regardless of any submode passed in.
  if (m === 'JS8') return { mode: 'MFSK', submode: 'JS8' };
  return { mode, submode };
}

/**
 * The ADIF fields of a QSO object, as a plain { FIELD: value } map with empty
 * values dropped. This is the ONE mapping from the app's qsoData shape to
 * ADIF: the log file record (buildAdifRecord) and the cloud sync copy are
 * both built from it, so the two cannot disagree field for field.
 *
 * @param {object} qso - QSO data object (frequency in kHz)
 * @returns {object} ADIF field map (FREQ in MHz, TIME_ON as HHMMSS)
 */
function buildAdifFields(qso) {
  // Frequency in MHz for ADIF (input is kHz). A missing or unparseable
  // frequency is LEFT OUT — (parseFloat('') / 1000).toFixed(6) is the string
  // "NaN", which this used to write (N7VBN 2026-09-22: every contact logged
  // on the Act screen with no radio reading carried FREQ NaN and no BAND).
  const khz = parseFloat(qso.frequency);
  const freqMHz = Number.isFinite(khz) && khz > 0 ? (khz / 1000).toFixed(6) : '';
  // BAND from the frequency when the caller did not say (POTA needs one of
  // the two, and several log paths only set the frequency).
  const band = qso.band || (freqMHz ? (freqToBand(khz / 1000) || '') : '');

  // TIME_ON should be 6 chars (HHMMSS) for maximum compatibility
  let timeOn = qso.timeOn || '';
  if (timeOn.length === 4) timeOn += '00';

  const ms = adifModeSubmode(qso.mode, qso.submode);

  const pairs = [
    ['CALL', qso.callsign],
    ['FREQ', freqMHz],
    ['MODE', ms.mode],
    ['SUBMODE', ms.submode],
    ['QSO_DATE', qso.qsoDate],
    ['TIME_ON', timeOn],
    ['RST_SENT', qso.rstSent],
    ['RST_RCVD', qso.rstRcvd],
    ['TX_PWR', qso.txPower],
    ['BAND', band],
    ['SIG', qso.sig],
    ['SIG_INFO', qso.sigInfo],
    ['POTA_REF', qso.potaRef || (qso.sig === 'POTA' ? qso.sigInfo : '')],
    ['SOTA_REF', qso.sotaRef || (qso.sig === 'SOTA' ? qso.sigInfo : '')],
    ['WWFF_REF', qso.wwffRef || (qso.sig === 'WWFF' ? qso.sigInfo : '')],
    ['LLOTA_REF', qso.llotaRef || (qso.sig === 'LLOTA' ? qso.sigInfo : '')],
    ['OPERATOR', qso.operator],
    ['NAME', qso.name],
    ['STATE', qso.state],
    ['CNTY', qso.county],
    ['GRIDSQUARE', qso.gridsquare],
    ['COUNTRY', qso.country],
    ['COMMENT', qso.comment],
    // Contest exchange (ARRL Field Day: class + ARRL/RAC section, no RST)
    ['CONTEST_ID', qso.contestId],
    ['CLASS', qso.class],
    ['ARRL_SECT', qso.arrlSect],
    ['STX_STRING', qso.stxString],
    ['SRX_STRING', qso.srxString],
    ['MY_SIG', qso.mySig],
    ['MY_SIG_INFO', qso.mySigInfo],
    ['MY_POTA_REF', qso.myPotaRef || (qso.mySig === 'POTA' ? qso.mySigInfo : '')],
    ['MY_SOTA_REF', qso.mySotaRef || (qso.mySig === 'SOTA' ? qso.mySigInfo : '')],
    ['MY_WWFF_REF', qso.myWwffRef || (qso.mySig === 'WWFF' ? qso.mySigInfo : '')],
    ['MY_LLOTA_REF', qso.myLlotaRef || (qso.mySig === 'LLOTA' ? qso.mySigInfo : '')],
    ['MY_GRIDSQUARE', qso.myGridsquare],
    ['MY_STATE', qso.myState],
    ['STATION_CALLSIGN', qso.stationCallsign],
    // Special-event provenance (identity-proven match at log time — see
    // saveQsoRecord's event stamping). App-defined fields: 13 Colonies etc.
    // aren't in ADIF's CONTEST_ID vocabulary and misusing it upsets loggers.
    ['APP_POTACAT_EVENT', qso.eventId],
    ['APP_POTACAT_EVENT_ITEM', qso.eventItem],
    ['APP_POTACAT_UUID', qso.uuid || crypto.randomUUID()],
  ];
  const fields = {};
  for (const [name, value] of pairs) {
    if (value == null || value === '') continue;
    fields[name] = String(value);
  }
  return fields;
}

/** Serialize an ADIF field map to `<F:n>v <F:n>v ... <EOR>` (no newlines). */
function serializeAdifFields(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && value !== '') parts.push(adifField(key, value));
  }
  return `${parts.join(' ')} <EOR>`;
}

/**
 * Build an ADIF record string from a QSO object.
 * Returns the fields + <EOR> (no leading/trailing newlines).
 */
function buildAdifRecord(qso) {
  return serializeAdifFields(buildAdifFields(qso));
}

/**
 * The ADIF field map of a QSO read from another logger's SQLite database
 * (parseSqliteFile's shape).
 */
function sqliteQsoToAdifFields(qso) {
  const pairs = [
    ['CALL', qso.call],
    ['QSO_DATE', qso.qsoDate],
    ['TIME_ON', qso.timeOn],
    ['BAND', qso.band],
    ['MODE', qso.mode],
    ['FREQ', qso.freq],
    ['DXCC', qso.dxcc],
    ['COUNTRY', qso.country],
    ['CONT', qso.cont],
    ['QSL_RCVD', qso.qslRcvd],
    ['LOTW_QSL_RCVD', qso.lotwQslRcvd],
    ['GRIDSQUARE', qso.gridsquare],
    ['RST_SENT', qso.rstSent],
    ['RST_RCVD', qso.rstRcvd],
    ['COMMENT', qso.comment],
  ];
  const fields = {};
  for (const [name, value] of pairs) {
    if (value != null && value !== '') fields[name] = String(value);
  }
  return fields;
}

/**
 * Append raw QSO field maps to an ADIF file in ONE write, preserving every
 * field. Creates the file with a header if it doesn't exist.
 */
function appendRawQsos(filePath, records) {
  if (!records.length) return;
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, ADIF_HEADER, 'utf-8');
  }
  const text = records.map((fields) => '\n' + serializeAdifFields(fields) + '\n').join('');
  fs.appendFileSync(filePath, text, 'utf-8');
}

/** Append a single raw QSO field map (see appendRawQsos). */
function appendRawQso(filePath, fields) {
  appendRawQsos(filePath, [fields]);
}

/**
 * Rewrite an entire ADIF file from an array of raw QSO field objects.
 * Each QSO is a flat object of ADIF field names -> values (all uppercase keys).
 * Uses atomic write (temp file + rename) to prevent data loss.
 */
function rewriteAdifFile(filePath, qsos) {
  let content = ADIF_HEADER;
  for (const fields of qsos) content += '\n' + serializeAdifFields(fields) + '\n';
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Write a complete ADIF file from pre-built QSO objects.
 * Records already have MY_SIG, MY_SIG_INFO, SIG, SIG_INFO set (from cross-product).
 */
function writeActivationAdifRaw(filePath, qsos) {
  let content = ADIF_HEADER;
  for (const qso of qsos) {
    content += '\n' + buildAdifRecord(qso) + '\n';
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

module.exports = {
  buildAdifFields, buildAdifRecord, serializeAdifFields, adifField, adifModeSubmode,
  sqliteQsoToAdifFields, appendRawQso, appendRawQsos, rewriteAdifFile, writeActivationAdifRaw, ADIF_HEADER,
};
