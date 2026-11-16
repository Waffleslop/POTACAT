'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { freqToBand } = require('./bands');
const { cleanText } = require('./adif-clean');
const { adifModeSubmode } = require('./adif-mode');

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

// adifModeSubmode lives in lib/adif-mode.js with its reverse, adifAppMode
// (#381); re-exported here for the callers that already import it.

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

  // qso.adifMode: the MODE of the record this QSO was read from (main.js
  // rawQsoToQsoData, Past Activations). Its MODE/SUBMODE pair is already ADIF,
  // so it is written back as it was (MFSK/JS8, DIGITALVOICE/FREEDV), only
  // repaired where adifModeSubmode repairs (bare JS8, PSK31). qso.mode is then
  // the app mode, for everything that is not ADIF.
  const ms = adifModeSubmode(qso.adifMode || qso.mode, qso.submode);

  const pairs = [
    ['CALL', qso.callsign],
    ['FREQ', freqMHz],
    ['MODE', ms.mode],
    ['SUBMODE', ms.submode],
    ['QSO_DATE', qso.qsoDate],
    ['TIME_ON', timeOn],
    ['QSO_DATE_OFF', qso.qsoDateOff],
    ['TIME_OFF', qso.timeOff],
    ['RST_SENT', qso.rstSent],
    ['RST_RCVD', qso.rstRcvd],
    ['TX_PWR', qso.txPower],
    ['MY_RIG', qso.myRig],
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
    ['DXCC', qso.dxcc],
    ['QTH', qso.qth],
    ['CQZ', qso.cqz],
    ['ITUZ', qso.ituz],
    ['CONT', qso.cont],
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
    // "ST,County" as LoTW spells it (lib/station-county.js): the operator's
    // own county, home or the park's, never guessed.
    ['MY_CNTY', qso.myCounty],
    ['STATION_CALLSIGN', qso.stationCallsign],
    ['OWNER_CALLSIGN', qso.ownerCallsign],
    // Special-event provenance (identity-proven match at log time — see
    // saveQsoRecord's event stamping). App-defined fields: 13 Colonies etc.
    // aren't in ADIF's CONTEST_ID vocabulary and misusing it upsets loggers.
    ['APP_POTACAT_EVENT', qso.eventId],
    ['APP_POTACAT_EVENT_ITEM', qso.eventItem],
    // A Guest Pass contact: the lent station's licensee, kept as one private
    // field in the GUEST's record (Casey 2026-10-27); never set otherwise.
    ['APP_POTACAT_STATION_LICENSEE', qso.stationLicensee],
    // A Guest Pass contact, marked so the guest's own POTACAT forwards it to
    // their external loggers when it pulls it (#553, lib/cloud-pull-forward.js).
    ['APP_POTACAT_GUEST_PASS', qso.guestPass ? '1' : ''],
    ['APP_POTACAT_UUID', qso.uuid || crypto.randomUUID()],
  ];
  const fields = {};
  for (const [name, value] of pairs) {
    if (value == null || value === '') continue;
    // Control characters never reach the file or the cloud (lib/adif-clean.js).
    const s = cleanText(value);
    if (s !== '') fields[name] = s;
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
    if (value == null || value === '') continue;
    const s = cleanText(value);
    if (s !== '') fields[name] = s;
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
/**
 * The date in POTA's CALL@PARK-YYYYMMDD.adi name: the UTC date of the
 * activation's first QSO, never the export time (an export made the next
 * morning carried the wrong day). Falls back to `now` when no QSO has a date.
 */
function activationFileDate(qsos, now = new Date()) {
  let best = '';
  for (const q of qsos || []) {
    const d = String((q && q.qsoDate) || '').replace(/\D/g, '');
    if (d.length !== 8) continue;
    const key = d + String((q && q.timeOn) || '').replace(/\D/g, '').padEnd(6, '0');
    if (!best || key < best) best = key;
  }
  return best ? best.slice(0, 8) : now.toISOString().slice(0, 10).replace(/-/g, '');
}

function writeActivationAdifRaw(filePath, qsos) {
  let content = ADIF_HEADER;
  for (const qso of qsos) {
    content += '\n' + buildAdifRecord(qso) + '\n';
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

module.exports = {
  buildAdifFields, buildAdifRecord, serializeAdifFields, adifField, adifModeSubmode,
  sqliteQsoToAdifFields, appendRawQso, appendRawQsos, rewriteAdifFile, writeActivationAdifRaw, activationFileDate, ADIF_HEADER,
};
