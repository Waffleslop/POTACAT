'use strict';

const fs = require('fs');

const ADIF_HEADER = `ADIF Export from POTA CAT
<ADIF_VER:5>3.1.4
<PROGRAMID:8>POTA CAT
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
 * Build an ADIF record string from a QSO object.
 * Returns the fields + <EOR> (no leading/trailing newlines).
 *
 * @param {object} qso - QSO data object
 * @returns {string} ADIF record string ending with <EOR>
 */
function buildAdifRecord(qso) {
  // Frequency in MHz for ADIF (input is kHz)
  const freqMHz = (parseFloat(qso.frequency) / 1000).toFixed(6);

  // TIME_ON should be 6 chars (HHMMSS) for maximum compatibility
  let timeOn = qso.timeOn || '';
  if (timeOn.length === 4) timeOn += '00';

  const fields = [
    adifField('CALL', qso.callsign),
    adifField('FREQ', freqMHz),
    adifField('MODE', qso.mode),
    adifField('QSO_DATE', qso.qsoDate),
    adifField('TIME_ON', timeOn),
    adifField('RST_SENT', qso.rstSent),
    adifField('RST_RCVD', qso.rstRcvd),
    adifField('TX_PWR', qso.txPower),
    adifField('BAND', qso.band),
    adifField('SIG', qso.sig),
    adifField('SIG_INFO', qso.sigInfo),
    adifField('COMMENT', qso.comment),
  ].filter(Boolean).join(' ');

  return `${fields} <EOR>`;
}

/**
 * Append a single QSO record to an ADIF file.
 * Creates the file with a header if it doesn't exist.
 */
function appendQso(filePath, qso) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, ADIF_HEADER, 'utf-8');
  }
  const record = `\n${buildAdifRecord(qso)}\n`;
  fs.appendFileSync(filePath, record, 'utf-8');
}

module.exports = { appendQso, buildAdifRecord, adifField };
