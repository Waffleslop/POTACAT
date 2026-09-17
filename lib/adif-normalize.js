'use strict';

// Repair pseudo-ADIF field names in QSO records.
//
// Until 2026-09-17 the cloud sync journal built a QSO's cloud copy by
// UPPERCASING the app's internal qsoData keys: callsign -> CALLSIGN,
// qsoDate -> QSODATE, frequency -> FREQUENCY (kHz). None of those are ADIF.
// Every other device that pulled such a row wrote it into its own log with
// no CALL field, and parseAllRawQsos() skips records without CALL, so those
// contacts were invisible to the logbook, the worked-before checks and the
// duplicate matcher — and the next log rewrite deleted them.
//
// Same table and rules as potacat-cloudlog lib/adif-normalize.js and the
// mobile app's utils/adifNormalize.ts: a pseudo key only fills its ADIF name
// when the real key is absent (good data is never clobbered), and mapped
// pseudo keys are dropped. Keys this table doesn't know are left alone.

const PSEUDO_TO_ADIF = {
  CALLSIGN: 'CALL',
  QSODATE: 'QSO_DATE',
  TIMEON: 'TIME_ON',
  TIMEOFF: 'TIME_OFF',
  RSTSENT: 'RST_SENT',
  RSTRCVD: 'RST_RCVD',
  SIGINFO: 'SIG_INFO',
  MYSIG: 'MY_SIG',
  MYSIGINFO: 'MY_SIG_INFO',
  MYGRIDSQUARE: 'MY_GRIDSQUARE',
  STATIONCALLSIGN: 'STATION_CALLSIGN',
  TXPOWER: 'TX_PWR',
  CONTESTID: 'CONTEST_ID',
  SRXSTRING: 'SRX_STRING',
  STXSTRING: 'STX_STRING',
  ARRLSECT: 'ARRL_SECT',
  MYWWFFREF: 'MY_WWFF_REF',
  MYSOTAREF: 'MY_SOTA_REF',
  MYLLOTAREF: 'MY_LLOTA_REF',
  POTAREF: 'POTA_REF',
  SOTAREF: 'SOTA_REF',
  WWFFREF: 'WWFF_REF',
  // Desktop-only additions: other qsoData keys the old journal could emit.
  MYPOTAREF: 'MY_POTA_REF',
  LLOTAREF: 'LLOTA_REF',
  COUNTY: 'CNTY',
  EVENTID: 'APP_POTACAT_EVENT',
  EVENTITEM: 'APP_POTACAT_EVENT_ITEM',
  UUID: 'APP_POTACAT_UUID',
};

// Tags whose presence in raw ADIF text means a file needs repair. The four
// here were on every journaled record, so testing them is sufficient.
const PSEUDO_TAG_RE = /<(CALLSIGN|QSODATE|TIMEON|FREQUENCY):\d/i;

const isEmpty = (v) => v === undefined || v === null || v === '';

/** FREQUENCY only ever came from qsoData.frequency, in kHz. ADIF FREQ is MHz. */
function khzToMhz(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n / 1000).toFixed(6);
}

/**
 * Returns a copy with real ADIF field names, or the input object itself when
 * nothing needed changing (callers can test identity to detect a repair).
 */
function normalizeAdifFields(fields) {
  if (!fields || typeof fields !== 'object') return fields;
  let out = null;
  for (const [pseudo, adif] of Object.entries(PSEUDO_TO_ADIF)) {
    if (fields[pseudo] === undefined) continue;
    out = out || { ...fields };
    if (isEmpty(out[adif])) out[adif] = out[pseudo];
    delete out[pseudo];
  }
  if (fields.FREQUENCY !== undefined) {
    out = out || { ...fields };
    if (isEmpty(out.FREQ)) {
      const mhz = khzToMhz(out.FREQUENCY);
      if (mhz) out.FREQ = mhz;
    }
    delete out.FREQUENCY;
  }
  return out || fields;
}

/** Cheap pre-check on raw file text, so a clean log is never re-parsed. */
function textHasPseudoFields(text) {
  return PSEUDO_TAG_RE.test(text || '');
}

module.exports = { normalizeAdifFields, textHasPseudoFields, PSEUDO_TO_ADIF };
