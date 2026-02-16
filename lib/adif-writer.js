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
 * Append a single QSO record to an ADIF file.
 * Creates the file with a header if it doesn't exist.
 *
 * @param {string} filePath - Path to the .adi file
 * @param {object} qso - QSO data object
 * @param {string} qso.callsign
 * @param {string} qso.frequency - Frequency in kHz
 * @param {string} qso.mode
 * @param {string} qso.qsoDate - YYYYMMDD
 * @param {string} qso.timeOn - HHMM
 * @param {string} qso.rstSent
 * @param {string} qso.rstRcvd
 * @param {string} qso.txPower
 * @param {string} qso.band - e.g. "20m"
 * @param {string} [qso.sig] - "POTA" or "SOTA"
 * @param {string} [qso.sigInfo] - Park/summit reference
 * @param {string} [qso.comment]
 */
function appendQso(filePath, qso) {
  // Create file with header if it doesn't exist
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, ADIF_HEADER, 'utf-8');
  }

  // Frequency in MHz for ADIF (input is kHz)
  const freqMHz = (parseFloat(qso.frequency) / 1000).toFixed(6);

  // Build the record
  const fields = [
    adifField('CALL', qso.callsign),
    adifField('FREQ', freqMHz),
    adifField('MODE', qso.mode),
    adifField('QSO_DATE', qso.qsoDate),
    adifField('TIME_ON', qso.timeOn),
    adifField('RST_SENT', qso.rstSent),
    adifField('RST_RCVD', qso.rstRcvd),
    adifField('TX_PWR', qso.txPower),
    adifField('BAND', qso.band),
    adifField('SIG', qso.sig),
    adifField('SIG_INFO', qso.sigInfo),
    adifField('COMMENT', qso.comment),
  ].filter(Boolean).join(' ');

  const record = `\n${fields} <EOR>\n`;
  fs.appendFileSync(filePath, record, 'utf-8');
}

module.exports = { appendQso };
