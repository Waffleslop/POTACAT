'use strict';
/**
 * What POTACAT's own windows may do: which permissions they get, where they
 * may navigate and what happens to a link that asks for a new window.
 *
 * Every app window loads a page from the app's own folder (file://) on
 * Electron's default session, so one set of rules covers them all:
 *
 * - Permissions: only the ones a POTACAT feature uses (ALLOWED below), and
 *   only for a page inside the app folder. Anything else, or any other page,
 *   is refused, and each refused permission is written to the session log
 *   once per run.
 * - Navigation: a window stays on the app's pages. A link to a web page or a
 *   mailto: goes to the open-external path (main.js openExternalIfAllowed,
 *   whose allowlist is lib/external-url.js); anything else is dropped.
 * - New windows (window.open, target="_blank"): never. A web link goes to the
 *   open-external path, anything else is dropped.
 *
 * Windows on their own session (the Winlink forms window) keep their own
 * rules and are left alone here.
 */
const path = require('path');

// Permission -> the feature that needs it. Anything not listed is refused.
const ALLOWED = Object.freeze({
  media: 'sound-card and microphone audio (rig audio, JTCAT, SSTV, FreeDV, voice keyer, ECHOCAT audio, Winlink modem, audio test); audio only, never the camera',
  midi: 'MIDI CW paddles and controllers (Web MIDI)',
  // Electron 39 asks for 'midiSysex' when a page calls requestMIDIAccess()
  // with no options (seen in a scratch run, 2026-11-23), so the paddles need it.
  midiSysex: 'MIDI CW paddles and controllers (Electron reports every Web MIDI request this way)',
  hid: 'sound-card PTT through a CM108 GPIO (WebHID; the device handler limits it to C-Media and SSS chips)',
  'clipboard-sanitized-write': 'the Copy buttons (navigator.clipboard.writeText)',
  'speaker-selection': 'choosing the audio output device (setSinkId)',
  fullscreen: 'full screen',
});

/** A file: URL's path with forward slashes, or null for anything else (UNC hosts included). */
function filePathOf(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'file:') return null;
  if (u.host && u.host !== 'localhost') return null;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return null; }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return path.posix.normalize(p.replace(/\\/g, '/'));
}

/** True when url is a file: URL inside appRoot (the app folder, or app.asar when packaged). */
function isAppUrl(url, appRoot, platform = process.platform) {
  const p = filePathOf(url);
  if (!p || !appRoot) return false;
  let root = path.posix.normalize(String(appRoot).replace(/\\/g, '/'));
  if (!root.endsWith('/')) root += '/';
  const win = platform === 'win32' || platform === 'darwin';
  const a = win ? p.toLowerCase() : p;
  const b = win ? root.toLowerCase() : root;
  return a.startsWith(b);
}

/** A bare file origin: "file://" or "file:///" (no page path). */
function isFileOrigin(origin) {
  return origin === 'file://' || origin === 'file:///';
}

/**
 * Is this page the app's own? Electron is not consistent about what it passes:
 * a check can carry the page URL, a bare "file:///" origin, the page URL in
 * the origin field, or nothing but an embedding origin. Every non-empty value
 * must be a file: page inside the app folder or a bare file origin; anything
 * else (a web page, a file outside the app) refuses. With nothing to check, it
 * refuses. A bare file origin is accepted because the navigation guard keeps
 * every window on this session on the app's own pages.
 */
function pageVerdict(values, appRoot, platform) {
  const seen = values.filter((x) => typeof x === 'string' && x && x !== 'null');
  if (!seen.length) return { ok: false, reason: 'no page to check' };
  for (const v of seen) {
    if (isFileOrigin(v)) continue;
    if (!isAppUrl(v, appRoot, platform)) return { ok: false, reason: 'not a POTACAT page' };
  }
  return { ok: true };
}

/**
 * The link for the open-external path when it is a web page or a mailto:,
 * else null. It goes on as given: lib/external-url.js parses and normalises
 * it for the allowlist, and the event and DXpedition links compare it as is.
 */
function externalUrlOf(url) {
  const s = String(url);
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return s;
  return null;
}

/**
 * May this page have this permission?
 * opts: { permission, requestingUrl, webContentsUrl, requestingOrigin, securityOrigin,
 *         embeddingOrigin, mediaTypes, mediaType, appRoot, platform }
 * Returns { allow, reason }.
 */
function permissionVerdict(opts) {
  const o = opts || {};
  const permission = String(o.permission || '');
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, permission)) return { allow: false, reason: 'not used by POTACAT' };
  const page = pageVerdict([o.requestingUrl, o.webContentsUrl, o.requestingOrigin, o.securityOrigin, o.embeddingOrigin], o.appRoot, o.platform);
  if (!page.ok) return { allow: false, reason: page.reason };
  if (permission === 'media') {
    const types = [].concat(o.mediaTypes || [], o.mediaType ? [o.mediaType] : []);
    if (types.some((t) => t !== 'audio')) return { allow: false, reason: 'camera or screen, not used' };
  }
  return { allow: true, reason: ALLOWED[permission] };
}

/**
 * Where may a window go?
 * { allow: true } for the app's own pages; otherwise { allow: false, external }
 * where external is the link for the open-external path, or null to drop it.
 */
function navigationVerdict(url, appRoot, platform) {
  if (isAppUrl(url, appRoot, platform)) return { allow: true, external: null };
  return { allow: false, external: externalUrlOf(url) };
}

/** window.open / target="_blank": never a new window; a web link goes to the open-external path. */
function windowOpenVerdict(url) {
  return { action: 'deny', external: externalUrlOf(url) };
}

/** A logger that writes each refused permission (and reason) once per run. */
function createDenialLog(log) {
  const seen = new Set();
  return function denied(permission, reason, where) {
    const key = permission + '|' + reason;
    if (seen.has(key)) return false;
    seen.add(key);
    try { log(`refused permission "${permission}" (${reason})${where ? ' for ' + String(where).slice(0, 160) : ''}`); } catch {}
    return true;
  };
}

function urlOf(wc) {
  try { return wc && typeof wc.getURL === 'function' ? wc.getURL() : ''; } catch { return ''; }
}

/**
 * Put the rules on the default session and on every window that opens on it.
 * deps: { app, session, appRoot, platform?, openExternal(url), log(msg) }
 * Call once, before the first window.
 */
function install(deps) {
  const { app, session, appRoot, openExternal } = deps;
  const platform = deps.platform || process.platform;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const denied = createDenialLog(log);
  const toExternal = (url) => { try { openExternal(url); } catch (e) { log('open-external failed: ' + (e && e.message)); } };

  session.setPermissionRequestHandler((wc, permission, cb, details) => {
    const d = details || {};
    // 'openExternal' (a page handing a link to another program) is not in
    // ALLOWED: the pages send links through the open-external IPC and its
    // allowlist (window.api.openExternal), never straight to the OS.
    const v = permissionVerdict({ permission, requestingUrl: d.requestingUrl, webContentsUrl: urlOf(wc), securityOrigin: d.securityOrigin, mediaTypes: d.mediaTypes, appRoot, platform });
    if (!v.allow) denied(permission, v.reason, d.requestingUrl || urlOf(wc));
    cb(v.allow);
  });
  session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const d = details || {};
    const v = permissionVerdict({ permission, requestingUrl: d.requestingUrl, webContentsUrl: urlOf(wc), requestingOrigin, securityOrigin: d.securityOrigin, embeddingOrigin: d.embeddingOrigin, mediaType: d.mediaType, appRoot, platform });
    if (!v.allow) denied(permission, v.reason, d.requestingUrl || requestingOrigin);
    return v.allow;
  });

  app.on('web-contents-created', (_e, contents) => {
    // A window on its own session (the Winlink forms window) sets its own
    // navigation and window-open rules; leave it alone.
    if (!contents || contents.session !== session) return;
    guardContents(contents, { appRoot, platform, toExternal, log });
  });
}

/** Navigation guard and window-open handler for one webContents on the app's session. */
function guardContents(contents, { appRoot, platform, toExternal, log }) {
  const seen = new Set();
  const dropped = (what, url) => {
    if (seen.has(what)) return;
    seen.add(what);
    try { log(`did not ${what}: ${String(url).slice(0, 160)} (not a POTACAT page or a web link)`); } catch {}
  };
  const guard = (e, url) => {
    const v = navigationVerdict(url, appRoot, platform);
    if (v.allow) return;
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (v.external) toExternal(v.external);
    else dropped('follow a link', url);
  };
  contents.on('will-navigate', (e, u) => guard(e, (e && e.url) || u));
  contents.on('will-redirect', (e, u) => guard(e, (e && e.url) || u));
  contents.on('will-attach-webview', (e) => { if (e && typeof e.preventDefault === 'function') e.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    const v = windowOpenVerdict(url);
    if (v.external) toExternal(v.external);
    else dropped('open a new window', url);
    return { action: v.action };
  });
}

module.exports = {
  ALLOWED,
  filePathOf,
  isAppUrl,
  isFileOrigin,
  pageVerdict,
  externalUrlOf,
  permissionVerdict,
  navigationVerdict,
  windowOpenVerdict,
  createDenialLog,
  install,
  guardContents,
};
