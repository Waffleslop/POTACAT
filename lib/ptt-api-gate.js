'use strict';
/**
 * /api/ptt decision (2026-11-23). Pure: no I/O, no clock.
 *
 * The HTTP PTT shortcut (/api/ptt/on, /off, /toggle) serves native callers
 * such as Stream Deck and Apple Shortcuts. Cross-site browser requests are
 * refused before this runs (lib/echocat-web-gate.js crossSiteRefusal), but
 * that check depends on Origin and Sec-Fetch-Site, which browsers do not send
 * to a plain http:// URL for an <img> GET. So while ECHOCAT is in its
 * plain-HTTP fallback (its TLS certificate could not be made at start), any
 * web page open in a LAN browser could key the radio with one image tag.
 *
 * The rule:
 *   - HTTPS: unchanged. With "Require a password" on, every action needs the
 *     right ?token= (401 otherwise); without it, every action is served.
 *   - Plain HTTP: a call that would KEY the radio (on, or toggle while
 *     receiving) is refused (403, reason in plain words) unless the password
 *     is on and the right ?token= is given.
 *   - Releasing is never refused by the plain-HTTP rule: off, and toggle
 *     while transmitting, still unkey. Unkeying is the safe direction; a
 *     refused release could leave a radio keyed (by the ECHOCAT page, a phone,
 *     or an earlier call) until the 180 s safety release. The password rule
 *     still applies to a release exactly as on HTTPS, so nothing about a
 *     station with a password changes.
 *
 * Input:  { action, https, requireToken, tokenSet, tokenOk, pttActive }
 * Output: { status: 200, ptt: boolean }  the state to set
 *      or { status: 400 | 401 | 403, error: string, reason?: string }
 */

const PLAIN_HTTP_REFUSED = 'PTT over plain HTTP is refused: POTACAT could not start its secure (HTTPS) server, '
  + 'so it cannot tell this request from a web page. Restart POTACAT, or turn on the ECHOCAT password '
  + 'and add ?token=YOUR_PASSWORD to the link. Releasing PTT (off) still works.';

const TOKEN_REFUSED = 'Invalid or missing token. Use ?token=YOUR_TOKEN';
const BAD_ACTION = 'Use /api/ptt/on, /api/ptt/off, or /api/ptt/toggle';

function decidePttApi(input) {
  const o = input || {};
  const passwordOn = !!(o.requireToken && o.tokenSet);
  if (passwordOn && !o.tokenOk) return { status: 401, error: TOKEN_REFUSED, reason: 'token' };
  let ptt;
  if (o.action === 'on') ptt = true;
  else if (o.action === 'off') ptt = false;
  else if (o.action === 'toggle') ptt = !o.pttActive;
  else return { status: 400, error: BAD_ACTION, reason: 'action' };
  // Plain HTTP: keying needs the password. passwordOn here means the right
  // token was given (checked above).
  if (ptt === true && o.https !== true && !passwordOn) {
    return { status: 403, error: PLAIN_HTTP_REFUSED, reason: 'plain-http' };
  }
  return { status: 200, ptt };
}

module.exports = { decidePttApi, PLAIN_HTTP_REFUSED };
