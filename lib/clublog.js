// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Club Log upload — realtime.php (one QSO at log time) and putlogs.php
// (whole-log bulk). Both are plain HTTPS POSTs authenticated with the
// user's email + an Application Password (clublog.org > Settings >
// Application Passwords — NEVER their main password; our UI copy says
// so) + POTACAT's application API key. The key is granted per-app by
// the Club Log team and must stay out of this public repo, so main.js
// resolves it from api.potacat.com at runtime (settings override for
// dev). Pure builders + response mapping here; main owns the sockets.
'use strict';

const crypto = require('crypto');

const CLUBLOG_REALTIME_URL = 'https://clublog.org/realtime.php';
const CLUBLOG_PUTLOGS_URL = 'https://clublog.org/putlogs.php';

/** urlencoded body for realtime.php — one ADIF record per call. */
function buildRealtimeForm({ email, password, callsign, api, adif }) {
  const p = new URLSearchParams();
  p.set('email', String(email || ''));
  p.set('password', String(password || ''));
  p.set('callsign', String(callsign || '').toUpperCase());
  p.set('api', String(api || ''));
  p.set('adif', String(adif || ''));
  return p.toString();
}

/** Multipart body for putlogs.php (bulk ADIF upload). Hand-rolled —
 *  a form-data dep for one endpoint is not worth it. Boundary is
 *  caller-supplied so tests are byte-deterministic. */
function buildPutlogsMultipart({ email, password, callsign, api, filename, fileContent }, boundary) {
  const b = boundary || '----potacat-clublog-boundary';
  const parts = [];
  const field = (name, value) =>
    `--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  parts.push(Buffer.from(field('email', String(email || ''))));
  parts.push(Buffer.from(field('password', String(password || ''))));
  parts.push(Buffer.from(field('callsign', String(callsign || '').toUpperCase())));
  parts.push(Buffer.from(field('api', String(api || ''))));
  parts.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename || 'potacat.adi'}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n'));
  parts.push(Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(String(fileContent || '')));
  parts.push(Buffer.from(`\r\n--${b}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${b}`, body: Buffer.concat(parts) };
}

/** HTTP status + body → honest outcome. Club Log speaks mostly through
 *  status codes; the body carries the reason on rejects. A duplicate on
 *  the realtime API is success from the operator's point of view — the
 *  QSO is at Club Log — so it maps ok:true with dupe:true. */
function mapClublogResponse(status, body, context) {
  const text = String(body || '').trim();
  const what = context === 'bulk' ? 'Log uploaded to Club Log.' : 'QSO sent to Club Log.';
  if (status === 200) return { ok: true, message: what };
  if (status === 400 && /dupe|duplicate/i.test(text)) {
    return { ok: true, dupe: true, message: 'Already at Club Log (duplicate).' };
  }
  if (status === 400) return { ok: false, message: `Club Log rejected it: ${text || 'no reason given'}.` };
  if (status === 403) return { ok: false, auth: true, message: 'Club Log refused the login — check email, Application Password, and callsign.' };
  if (status >= 500) return { ok: false, message: `Club Log server error (${status}) — try again later.` };
  return { ok: false, message: `Unexpected Club Log response (${status}): ${text}`.trim() };
}

/** One account's login as a fingerprint (#142): a 403 pauses realtime uploads
 *  for that account until this changes, i.e. until the operator saves a
 *  different email, Application Password or callsign. */
function credentialKey({ email, password, callsign } = {}) {
  return crypto.createHash('sha256')
    .update([String(email || '').trim().toLowerCase(), String(password || ''), String(callsign || '').trim().toUpperCase()].join('\n'))
    .digest('hex');
}

module.exports = {
  credentialKey,
  CLUBLOG_REALTIME_URL,
  CLUBLOG_PUTLOGS_URL,
  buildRealtimeForm,
  buildPutlogsMultipart,
  mapClublogResponse,
};
