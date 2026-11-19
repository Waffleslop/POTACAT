// SPDX-License-Identifier: Apache-2.0
/**
 * Where POTACAT finds its FlexRadio SmartLink client ID.
 *
 * The client ID is the only secret in POTACAT's SmartLink code (FlexRadio,
 * 2026-11-16: the implementation may be public; the client ID may not). It is
 * never in the repository. In order:
 *   1. process.env.SMARTLINK_CLIENT_ID (a developer's shell, CI).
 *   2. smartlink.json in the packaged app's resources folder, written at release
 *      build time from the SMARTLINK_CLIENT_ID repository secret
 *      (.github/workflows/release.yml), never committed.
 *   3. Development on Windows only: D:\keyfiles\potacat-smartlink.env, line
 *      SMARTLINK_CLIENT_ID=<id>.
 * None of them: SmartLink says "SmartLink is not available in this build."
 *
 * Nothing here logs the ID. describeSource() names where it came from, never
 * what it is.
 */
'use strict';

const path = require('path');

const RESOURCE_FILE = 'smartlink.json';
const DEV_ENV_FILE = 'D:\\keyfiles\\potacat-smartlink.env';
const NOT_AVAILABLE = 'SmartLink is not available in this build.';

/** A plausible Auth0 client ID: letters, digits, '-' and '_', 16 to 128 long. */
function looksLikeClientId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(s.trim());
}

function _fromEnvText(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*SMARTLINK_CLIENT_ID\s*=\s*(.*?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * @param {object} [o]
 * @param {object} [o.env]           process.env
 * @param {string} [o.resourcesPath] process.resourcesPath of a packaged app
 * @param {string} [o.platform]      process.platform
 * @param {boolean} [o.packaged]     app.isPackaged
 * @param {function} [o.readFile]    (path) => string, throws when absent
 * @returns {{clientId:string|null, source:'env'|'resource'|'dev-keyfile'|null}}
 */
function resolveClientId(o = {}) {
  const env = o.env || process.env;
  const readFile = o.readFile || ((p) => require('fs').readFileSync(p, 'utf8'));
  const platform = o.platform || process.platform;
  if (looksLikeClientId(env.SMARTLINK_CLIENT_ID)) return { clientId: env.SMARTLINK_CLIENT_ID.trim(), source: 'env' };
  if (o.resourcesPath) {
    try {
      const j = JSON.parse(readFile(path.join(o.resourcesPath, RESOURCE_FILE)));
      if (j && looksLikeClientId(j.clientId)) return { clientId: j.clientId.trim(), source: 'resource' };
    } catch { /* not in this build */ }
  }
  if (platform === 'win32' && !o.packaged) {
    try {
      const id = _fromEnvText(readFile(o.devEnvFile || DEV_ENV_FILE));
      if (looksLikeClientId(id)) return { clientId: id.trim(), source: 'dev-keyfile' };
    } catch { /* no developer key file */ }
  }
  return { clientId: null, source: null };
}

function describeSource(source) {
  switch (source) {
    case 'env': return 'the SMARTLINK_CLIENT_ID environment variable';
    case 'resource': return 'this build';
    case 'dev-keyfile': return 'the developer key file';
    default: return 'nowhere';
  }
}

module.exports = { RESOURCE_FILE, DEV_ENV_FILE, NOT_AVAILABLE, looksLikeClientId, resolveClientId, describeSource, _fromEnvText };
