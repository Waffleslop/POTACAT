'use strict';
//
// ADIF field text must never carry control characters.
//
// A NUL (or any C0 control) inside a logged value is invisible on every
// screen and fatal on the cloud: Postgres jsonb refuses "\u0000", the whole
// /v1/sync/push batch fails as a 500, and the journal retries it once a
// minute for ever — 2,402 "unsupported Unicode escape sequence" errors in
// the week to 2026-10-20 from one stuck client. Values reach the log from a
// dozen sources (decoder text, pasted names, QRZ fields, CAT replies) and
// buildAdifFields only ever did String(value). Tab, CR and LF are kept:
// they are legal in a COMMENT and the ADIF writer handles them. Pure.

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function cleanText(value) {
  if (value == null) return '';
  return String(value).replace(CONTROL_RE, '');
}

/** A copy of `fields` with every value cleaned; non-objects pass through. */
function cleanAdifFields(fields) {
  if (!fields || typeof fields !== 'object') return fields;
  const out = {};
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    out[k] = (typeof v === 'string') ? v.replace(CONTROL_RE, '') : v;
  }
  return out;
}

module.exports = { cleanText, cleanAdifFields, CONTROL_RE };
