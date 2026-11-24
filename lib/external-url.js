'use strict';
/**
 * Which links the app may hand to the operating system (main's
 * `open-external` IPC), and which local files it may reveal in Explorer or
 * Finder.
 *
 * Web links: each entry below is a URL prefix read as scheme + host + path.
 * A candidate URL is parsed with the WHATWG URL parser and passes only when
 *   - it parses, and carries no user name or password (https://a@b),
 *   - its scheme is the entry's (an http entry also accepts https),
 *   - its hostname equals the entry's host exactly (so a lookalike such as
 *     tailscale.com.example.net, or a trailing dot, is refused). An entry
 *     whose host starts with "*." also accepts subdomains of that host;
 *   - it has no explicit port unless the entry names the same one,
 *   - its path starts with the entry's path: an entry path ending in "/" is
 *     a folder, one without is that page or anything beneath it.
 * mailto entries match the address exactly; query parameters may follow.
 *
 * The gate fails closed with no message, so a link the app shows must have
 * an entry here (test/external-links-allowed-test.js checks every
 * data-external link in the windows).
 *
 * Local files: only a path inside one of the roots main passes in (POTACAT's
 * own folders) may be revealed. UNC and other network paths are refused.
 */
const path = require('path');

const ALLOWED = [
  'https://www.qrz.com/', 'https://caseystanton.com/', 'https://github.com/Waffleslop/POTACAT/',
  'https://hamlib.github.io/', 'https://github.com/Hamlib/', 'https://discord.gg/',
  // flrig (W1HKJ) downloads: the rig editor's "FLRig (a shared radio)" help.
  // w1hkj.com no longer hosts them; SourceForge is the project's home.
  'https://sourceforge.net/projects/fldigi/',
  // Mercury HF data modem (Rhizomatica): download and docs links in Settings.
  'https://github.com/Rhizomatica/', 'https://rhizomatica.github.io/',
  // Winlink: Pat, ardopcf and the Winlink network (Settings > Station > Winlink).
  'https://getpat.io/', 'https://github.com/la5nta/', 'https://github.com/pflarue/', 'https://winlink.org/', 'https://www.winlink.org/',
  // VARA (the operator brings their own copy) and the virtual audio cable it
  // needs: links in Settings > Station > Winlink. Neither is downloaded by POTACAT.
  'https://rosmodem.wordpress.com/', 'https://vb-audio.com/',
  // JS8Call: download and docs links in Settings. The project site is http-only.
  'https://github.com/js8call/', 'http://js8call.com/', 'https://js8call.com/',
  'https://potacat.com/', 'https://docs.potacat.com/', 'https://buymeacoffee.com/potacat', 'https://docs.google.com/spreadsheets/',
  'https://pota.app/', 'https://www.sotadata.org.uk/', 'https://wwff.co/', 'https://llota.app/',
  // Whole sites (no path): tailscale.com only, not login.tailscale.com.
  'https://tailscale.com', 'https://worldradioleague.com',
  // Tailscale admin DNS page (MagicDNS / HTTPS certs help in Settings).
  'https://login.tailscale.com/admin/',
  // TrustedQSL download: the LoTW upload block in Settings > Logging.
  'https://www.arrl.org/tqsl-download', 'https://lotw.arrl.org/',
  // Club Log: Application Passwords page link in Settings > Logging.
  'https://clublog.org/',
  // FCC Part 97 section 97.119 (station identification): the link in Settings > Share Rig.
  'https://www.ecfr.gov/current/title-47/',
  'https://api.potacat.com/',
  'https://login.potacat.com/',
  // WebSDR / KiwiSDR directories (http-only sites).
  'http://rx.linkfanel.net', 'http://kiwisdr.com', 'http://websdr.org',
  // ECHOCAT mobile app store links (Settings footer promo).
  'https://apps.apple.com/', 'https://play.google.com/',
  // Rig editor Setup instructions: "email us your setup".
  'mailto:k3sbp@potacat.com',
];

const RULE_RE = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\d+))?(\/[^?#]*)?$/i;

/** An allowlist entry as { scheme, host, subdomains, port, path } or { scheme: 'mailto', address }. */
function parseRule(entry) {
  const s = String(entry);
  if (/^mailto:/i.test(s)) return { scheme: 'mailto', address: s.slice(7).toLowerCase() };
  const m = RULE_RE.exec(s);
  if (!m) throw new Error('external-url: bad allowlist entry ' + s);
  return { scheme: m[1].toLowerCase(), subdomains: !!m[2], host: m[3].toLowerCase(), port: m[4] || '', path: m[5] || '/' };
}

const RULES = ALLOWED.map(parseRule);

// Control characters, whitespace at either end, and backslashes are refused
// before parsing: the URL parser forgives them, the OS handler might not.
const BAD_CHARS = /[\x00-\x1f\x7f\\]/;

function parse(url) {
  if (typeof url !== 'string' || !url || url.length > 4096) return null;
  if (BAD_CHARS.test(url) || url.trim() !== url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.username || u.password) return null;
  // An empty user part ("https://:@host/") parses to no userinfo at all;
  // refuse any "@" before the path all the same.
  const auth = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  if (auth && auth[1].includes('@')) return null;
  return u;
}

function pathMatches(candidate, rulePath) {
  if (rulePath.endsWith('/')) return candidate.startsWith(rulePath);
  return candidate === rulePath || candidate.startsWith(rulePath + '/');
}

function hostMatches(host, rule) {
  if (host === rule.host) return true;
  return rule.subdomains && host.endsWith('.' + rule.host);
}

function ruleMatches(u, rule) {
  const scheme = u.protocol.slice(0, -1);
  if (rule.scheme === 'mailto') {
    return scheme === 'mailto' && decodeURIComponent(u.pathname).toLowerCase() === rule.address;
  }
  if (scheme !== rule.scheme && !(rule.scheme === 'http' && scheme === 'https')) return false;
  if (!hostMatches(u.hostname, rule)) return false;
  if (u.port !== rule.port) return false;
  return pathMatches(u.pathname, rule.path);
}

/**
 * The URL as the OS should receive it (the parser's normalised href), or
 * null when the allowlist refuses it.
 */
function checked(url, rules = RULES) {
  const u = parse(url);
  if (!u) return null;
  try {
    return rules.some((r) => ruleMatches(u, r)) ? u.href : null;
  } catch { return null; }
}

/** True when `url` may be opened in the operator's browser or mail program. */
function allowed(url) {
  return checked(url) !== null;
}

/**
 * The local path a `file://` link names, when it lies inside one of `roots`;
 * else null. Accepts the forms the windows send: 'file://' + an OS path
 * (C:\Users\..., /home/...) and a proper file URL (file:///C:/..., file:///home/...).
 */
function fileRevealPath(url, roots, platform = process.platform) {
  if (typeof url !== 'string' || !/^file:\/\//i.test(url) || /[\x00-\x1f]/.test(url)) return null;
  const P = platform === 'win32' ? path.win32 : path.posix;
  let p = url.slice(7);
  if (/%[0-9a-f]{2}/i.test(p)) { try { p = decodeURIComponent(p); } catch { return null; } }
  if (platform === 'win32') {
    if (/^\/[a-z]:/i.test(p)) p = p.slice(1); // file:///C:/...
    p = p.replace(/\//g, '\\');
    if (!/^[a-z]:\\/i.test(p)) return null; // UNC (\\host\share), device (\\?\) and relative paths
  } else if (!p.startsWith('/') || p.startsWith('//')) {
    return null;
  }
  const full = P.resolve(p);
  const norm = (x) => (platform === 'win32' ? x.toLowerCase() : x);
  for (const root of roots || []) {
    if (typeof root !== 'string' || !root || !P.isAbsolute(root)) continue;
    const rel = P.relative(norm(P.resolve(root)), norm(full));
    if (rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel))) return full;
  }
  return null;
}

module.exports = { ALLOWED, allowed, checked, fileRevealPath, parseRule };
