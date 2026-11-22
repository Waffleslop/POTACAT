'use strict';
// Guest Pass: tell Cloud "the radio is free" once per idle offer (#541, B5 row 6).
//
// When the owner has held a lent radio for 5 idle minutes, the station offers
// it back to the guest (lib/remote-server.js _ownerIdleOffered). A guest whose
// phone app is closed never sees that offer, so the station asks Cloud to push
// to the guest's phone:
//
//   POST /v1/passes/:code/notify   (owner's Bearer JWT)   { "kind": "radio_free" }
//
// Contract: docs/handoffs/CLOUD_TO_DESKTOP_HANDOFF_2026-11-14_RADIO_FREE_NOTIFY.md
// - The station sends no text and no personal data; Cloud owns the wording.
// - One call per offer. Never retried, never queued: 200 is done, and 429
//   (rate limited), 409 (no guest session), 410 (pass over) and 404 (not this
//   owner's pass, or a Cloud without the route) are all "skip".
// - 10-second timeout (Cloud waits up to about 8 s on Expo).
// - Never throws: a failed push must never get in the way of the radio.

const TIMEOUT_MS = 10000;

const SKIP_REASONS = {
  429: 'rate limited (one push per guest session every 5 minutes)',
  409: 'no guest session is open',
  410: 'the pass is over',
  404: 'Cloud does not know this pass here',
};

function notifyPath(code) {
  return `/v1/passes/${encodeURIComponent(code)}/notify`;
}

/**
 * @param {object} deps
 * @param {() => (null|((method:string, path:string, body:object) => Promise<any>))} deps.getRequest
 *   An authed request function for the signed-in owner, or null when not signed in.
 * @param {number} [deps.timeoutMs]
 */
function createRadioFreeNotifier(deps) {
  const timeoutMs = (deps && deps.timeoutMs) || TIMEOUT_MS;
  const seen = new Set();

  async function notify(session) {
    const code = session && session.code;
    if (!code) return { outcome: 'skipped', reason: 'no pass code' };
    const key = `${code}|${session.offeredAt || ''}`;
    if (seen.has(key)) return { outcome: 'skipped', reason: 'already sent for this offer' };
    seen.add(key);
    if (seen.size > 50) seen.delete(seen.values().next().value);

    const request = deps && typeof deps.getRequest === 'function' ? deps.getRequest() : null;
    if (typeof request !== 'function') return { outcome: 'skipped', reason: 'not signed in to POTACAT Cloud' };

    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { const e = new Error('timeout'); e.code = 'timeout'; reject(e); }, timeoutMs);
    });
    try {
      const res = await Promise.race([request('POST', notifyPath(code), { kind: 'radio_free' }), timeout]);
      const sent = res && Number.isFinite(res.sent) ? res.sent : 0;
      const devices = res && Number.isFinite(res.devices) ? res.devices : 0;
      return { outcome: 'sent', sent, devices };
    } catch (err) {
      const status = err && err.status;
      if (SKIP_REASONS[status]) return { outcome: 'skipped', reason: SKIP_REASONS[status], status };
      return { outcome: 'failed', reason: (err && (err.code || err.message)) || 'unknown', status: status || null };
    } finally {
      clearTimeout(timer);
    }
  }

  return { notify };
}

/** One log line for the outcome; no personal data. */
function describeOutcome(r) {
  if (!r) return '';
  if (r.outcome === 'sent') {
    return r.devices === 0
      ? 'Guest Pass: Cloud asked to tell the guest the radio is free; the guest has no phone registered for alerts'
      : `Guest Pass: Cloud told the guest the radio is free (${r.sent} of ${r.devices} phone${r.devices === 1 ? '' : 's'})`;
  }
  if (r.outcome === 'skipped') return `Guest Pass: no "radio is free" alert sent: ${r.reason}`;
  return `Guest Pass: the "radio is free" alert to Cloud failed (${r.reason}); not retried`;
}

module.exports = { createRadioFreeNotifier, describeOutcome, notifyPath, TIMEOUT_MS };
