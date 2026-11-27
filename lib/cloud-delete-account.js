'use strict';
// Settings > Cloud > "Delete account..." (CLOUD_TO_DESKTOP 2026-11-26).
//
// Signed in, the desktop asks Cloud to email a one-time deletion link:
// POST /v1/account/deletion-request with the Bearer token, no body. Nothing
// is deleted until the member opens that link and confirms on the web page.
// Signed out, the link opens DELETE_PAGE in the browser instead.
//
// This module only turns what came back into the sentence the operator reads.
// Copy stays factual: no timing, refund or payment promises; the web confirm
// page covers those.

const DELETE_PAGE = 'https://api.potacat.com/delete-account';
const REQUEST_PATH = '/v1/account/deletion-request';
const NOTHING_DELETED = 'Nothing was deleted.';

const CONFIRM_TEXT = 'Email a link to delete your POTACAT Cloud account and its Cloud logbook copy '
  + '(the log on this computer is not touched)?';

function _withNothingDeleted(text) {
  const t = String(text || '').trim();
  if (!t) return NOTHING_DELETED;
  return /nothing was deleted/i.test(t) ? t : t + ' ' + NOTHING_DELETED;
}

// Cloud errors are flat ({ error, message, hint }); accept the nested
// envelope ({ error: { code, message, hint } }) too so a server change does
// not turn into "[object Object]".
function _errorFields(body) {
  const b = body && typeof body === 'object' ? body : {};
  const nested = b.error && typeof b.error === 'object' ? b.error : null;
  return {
    code: nested ? (nested.code || '') : (typeof b.error === 'string' ? b.error : ''),
    message: String((nested && nested.message) || b.message || ''),
    hint: String((nested && nested.hint) || b.hint || ''),
  };
}

/**
 * Normalise an error thrown by CloudSyncClient into { status, body } or
 * { network: true }. The client puts status + body on 4xx errors, folds 5xx
 * into the message as "(HTTP 5xx)", and says AUTH_EXPIRED / Not authenticated
 * / Token refresh failed when the session is gone.
 */
function responseFromError(err) {
  const e = err || {};
  if (e.status) return { status: e.status, body: e.body || {} };
  const msg = String(e.message || e || '');
  if (e.code === 'device_revoked' || /^AUTH_EXPIRED$|^Not authenticated|^Token refresh failed/.test(msg)) {
    return { status: 401, body: {} };
  }
  const m = msg.match(/\(HTTP (\d{3})\)/);
  if (m) {
    const detail = msg.match(/\(HTTP \d{3}\):\s*(.+)$/);
    return { status: Number(m[1]), body: detail ? { message: detail[1] } : {} };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|timeout/i.test(msg)) {
    return { network: true };
  }
  return { status: 0, body: { message: msg } };
}

/**
 * The operator's sentence for one deletion request.
 * @param {{status?: number, body?: object, network?: boolean}} res
 * @returns {{ok: boolean, text: string, code?: string}}
 */
function deletionOutcome(res) {
  const r = res || {};
  if (r.network) {
    return { ok: false, code: 'network', text: 'No connection. Check your network and try again. ' + NOTHING_DELETED };
  }
  const status = Number(r.status) || 0;
  if (status >= 200 && status < 300) {
    const data = (r.body && r.body.data) || {};
    const to = String(data.to || '').trim() || 'your account email';
    const hours = Number(data.expiresInHours);
    const within = (!hours || hours === 1) ? 'within an hour' : `within ${hours} hours`;
    return { ok: true, text: `We sent a link to ${to}. Open it ${within} to finish.` };
  }
  const f = _errorFields(r.body);
  if (status === 409 && f.code === 'no_email_on_account') {
    const message = f.message || 'This account has no email address to send the deletion link to.';
    const hint = f.hint || 'Write to POTACAT support from the address you use, with your callsign.';
    return { ok: false, code: f.code, text: message + ' ' + hint };
  }
  if (status === 401) {
    return { ok: false, code: 'signed_out', text: 'You are signed out of POTACAT Cloud. Sign in and try again. ' + NOTHING_DELETED };
  }
  if (status >= 500) {
    return { ok: false, code: f.code || 'server_error', text: _withNothingDeleted(f.message || 'Could not send the deletion link.') };
  }
  const base = f.message || (status ? `Could not send the deletion link (HTTP ${status}).` : 'Could not send the deletion link.');
  return { ok: false, code: f.code || 'error', text: _withNothingDeleted(base) };
}

module.exports = {
  DELETE_PAGE,
  REQUEST_PATH,
  CONFIRM_TEXT,
  responseFromError,
  deletionOutcome,
};
