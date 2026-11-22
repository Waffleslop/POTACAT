'use strict';
// Plain words for what POTACAT Cloud answers when a desktop pairs with a shack
// through the account (POST /v1/devices/:shackId/authorize) or registers
// itself (POST /v1/devices). The operator used to read
// "Pair failed: cloud authorize failed: client_not_registered" (2026-11-17).
// The renderer adds "Pair failed: " itself, so these sentences stand alone.

const LINK = 'use the pairing link from the shack';

const TEXT = {
  client_not_registered: 'This computer is not listed in your POTACAT Cloud account yet. Sign out of Cloud and back in, then try again, or ' + LINK + '.',
  shack_not_found: 'That shack is no longer in your POTACAT Cloud account. Open POTACAT on the shack, make sure it is signed in to Cloud, then refresh the list and try again.',
  same_device: 'This computer is the shack you picked. Pair from a different computer.',
  device_id_in_use: 'This computer\'s Cloud ID belongs to a different POTACAT Cloud account. Sign out of Cloud and back in, then try again, or ' + LINK + '.',
  device_limit_reached: 'Your POTACAT Cloud account already lists as many computers and phones as it can hold. Use the pairing link from the shack instead.',
  validation_error: 'This computer has no Cloud ID yet. Sign out of Cloud and back in, then try again, or ' + LINK + '.',
  server: 'POTACAT Cloud could not finish this just now. Try again in a minute, or ' + LINK + '.',
  auth: 'Your POTACAT Cloud sign-in has expired. Sign in again in Settings > Cloud, then try again.',
  network: 'This computer could not reach POTACAT Cloud. Check the internet connection, then try again.',
  // Removed from the account: signed out (lib/cloud-revoked.js).
  device_revoked: require('./cloud-revoked').SIGNED_OUT_TEXT,
};

// Older and newer spellings of the same answer.
const ALIAS = {
  cannot_pair_self: 'same_device',
  'clientDeviceId required': 'validation_error',
  authorize_failed: 'server',
  register_failed: 'server',
  AUTH_EXPIRED: 'auth',
  ENOTFOUND: 'network', EAI_AGAIN: 'network', ECONNREFUSED: 'network',
  ECONNRESET: 'network', ETIMEDOUT: 'network', ENETUNREACH: 'network',
  'Request timeout': 'network',
};

/** The Cloud error code carried by an error, a bare message, or a string. */
function cloudErrorCode(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err.trim();
  if (err.code && typeof err.code === 'string') return err.code;
  const msg = String(err.message || '').trim();
  // 5xx: "POTACAT cloud error (HTTP 500): authorize_failed"
  const m = /^POTACAT cloud error \(HTTP \d+\): (\S+)$/.exec(msg);
  if (m) return m[1];
  if (/^POTACAT cloud (?:is|error)/.test(msg)) return 'authorize_failed';
  return msg;
}

function _known(code) {
  const key = ALIAS[code] || code;
  return Object.prototype.hasOwnProperty.call(TEXT, key) ? TEXT[key] : null;
}

/** What the operator reads when Cloud refuses or fails a pair attempt. */
function cloudPairErrorText(err) {
  const code = cloudErrorCode(err);
  return _known(code)
    || 'Cloud pairing did not work (' + (code || 'unknown') + '). Try again, or ' + LINK + '.';
}

/** What the operator reads when this computer could not register itself first. */
function cloudRegisterErrorText(err) {
  const code = cloudErrorCode(err);
  const known = (ALIAS[code] || code) === 'server' ? null : _known(code);
  return known
    || 'POTACAT Cloud could not add this computer to your account (' + (code || 'unknown') + '). Try again in a minute, or ' + LINK + '.';
}

/**
 * Registration found this device id held by another account (two computers
 * that once shared one settings file). The fix is a new id for this computer.
 */
function shouldRotateDeviceId(err) {
  return !!err && cloudErrorCode(err) === 'device_id_in_use';
}

module.exports = { cloudErrorCode, cloudPairErrorText, cloudRegisterErrorText, shouldRotateDeviceId };
