'use strict';

const fs = require('fs');

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
    adifField('POTA_REF', qso.potaRef),
    adifField('SOTA_REF', qso.sotaRef),
    adifField('WWFF_REF', qso.wwffRef),
    adifField('OPERATOR', qso.operator),
    adifField('NAME', qso.name),
    adifField('STATE', qso.state),
    adifField('CNTY', qso.county),
    adifField('GRIDSQUARE', qso.gridsquare),
    adifField('COUNTRY', qso.country),
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

/**
 * Append a single imported QSO record to an ADIF file.
 * Writes a clean record with all 15 preserved fields.
 */
function appendImportedQso(filePath, qso) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, ADIF_HEADER, 'utf-8');
  }
  const fields = [
    adifField('CALL', qso.call),
    adifField('QSO_DATE', qso.qsoDate),
    adifField('TIME_ON', qso.timeOn),
    adifField('BAND', qso.band),
    adifField('MODE', qso.mode),
    adifField('FREQ', qso.freq),
    adifField('DXCC', qso.dxcc),
    adifField('COUNTRY', qso.country),
    adifField('CONT', qso.cont),
    adifField('QSL_RCVD', qso.qslRcvd),
    adifField('LOTW_QSL_RCVD', qso.lotwQslRcvd),
    adifField('GRIDSQUARE', qso.gridsquare),
    adifField('RST_SENT', qso.rstSent),
    adifField('RST_RCVD', qso.rstRcvd),
    adifField('COMMENT', qso.comment),
  ].filter(Boolean).join(' ');

  const record = `\n${fields} <EOR>\n`;
  fs.appendFileSync(filePath, record, 'utf-8');
}

/**
 * Rewrite an entire ADIF file from an array of raw QSO field objects.
 * Each QSO is a flat object of ADIF field names → values (all uppercase keys).
 * Uses atomic write (temp file + rename) to prevent data loss.
 */
function rewriteAdifFile(filePath, qsos) {
  let content = ADIF_HEADER;
  for (const fields of qsos) {
    const parts = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value != null && value !== '') parts.push(adifField(key, value));
    }
    content += '\n' + parts.join(' ') + ' <EOR>\n';
  }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

module.exports = { appendQso, buildAdifRecord, adifField, appendImportedQso, rewriteAdifFile, ADIF_HEADER };
