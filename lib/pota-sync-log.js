'use strict';
// What the pota.app Connect step may write to the log (GitHub #406).
//
// The log goes into Report a Bug, which operators paste into public channels.
// The Connect step scans pota.app's localStorage, sessionStorage, IndexedDB
// and cookies for the sign-in token; it used to log the first 80 to 200
// characters of every stored value, which can be the start of a token. Now it
// logs the names and the lengths only, never any part of a value.
//
// Cognito names carry the user's id (CognitoIdentityServiceProvider.<client>.
// <user>.idToken); the user part is masked too. Pure, no Electron, so it is
// testable (lib/pota-sync.js needs Electron to load).

const COGNITO_NAME = /^(CognitoIdentityServiceProvider\.[^.]+\.)[^.]+(\.[^.]+)$/;

/** A storage key or cookie name, with a Cognito user id masked. */
function safeStoreName(name) {
  return String(name == null ? '' : name).replace(COGNITO_NAME, '$1<user>$2');
}

/** "name (N chars), name (N chars)" for a { name: value } map. Values are
 *  measured, never shown. */
function describeStoredValues(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return '(none)';
  return entries
    .map(([k, v]) => `${safeStoreName(k)} (${v == null ? 0 : String(v).length} chars)`)
    .join(', ');
}

/** A page URL without its query string or fragment: an OAuth redirect
 *  carries ?code= (and sometimes #id_token=) there. */
function urlWithoutQuery(url) {
  return String(url == null ? '' : url).split(/[?#]/)[0];
}

module.exports = { safeStoreName, describeStoredValues, urlWithoutQuery };
