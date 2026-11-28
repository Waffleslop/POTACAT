'use strict';
// The desktop's version on its POTACAT Cloud device row (Cloud ask 2026-11-26).
// POST /v1/devices and POST /v1/devices/:deviceId/heartbeat take an optional
// appVersion string, such as "1.14.7" or "1.15.0-beta.2". Cloud ignores a
// value that is not a version and keeps the stored one when it is missing,
// so an empty or unreadable version is left out, never sent as "".

/** The version string to send, or '' when there is none worth sending. */
function cleanAppVersion(version) {
  if (typeof version !== 'string') return '';
  const v = version.trim();
  return v.length > 0 && v.length <= 64 ? v : '';
}

/** A copy of body with appVersion added when there is a version to send. */
function withAppVersion(body, version) {
  const out = Object.assign({}, body || {});
  const v = cleanAppVersion(version);
  if (v) out.appVersion = v;
  return out;
}

/** The JSON body for POST /v1/devices/:deviceId/heartbeat. */
function deviceHeartbeatBody(version) {
  return withAppVersion({}, version);
}

module.exports = { cleanAppVersion, withAppVersion, deviceHeartbeatBody };
