'use strict';
// What the operator sees for a manual "Check for Updates" (GitHub #186).
// Pure: no network, no Electron. main.js feeds it the updater's events or the
// GitHub API response and sends the resulting message to the renderer.

const RELEASES_URL = 'https://github.com/Waffleslop/POTACAT/releases/latest';

function isNewerVersion(current, latest) {
  const a = String(current).split('.').map(Number);
  const b = String(latest).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}

/** Turn an updater / network error into one plain sentence. */
function describeUpdateError(err) {
  const raw = String((err && (err.message || err)) || '');
  const code = (err && err.code) || '';
  const text = raw + ' ' + code;
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|socket hang up|timed? ?out/i.test(text)) {
    return 'Could not reach GitHub to check for updates. Check your internet connection (or firewall / antivirus) and try again.';
  }
  if (/rate limit|\b429\b/i.test(text) || (/\b403\b/.test(text) && /github/i.test(text))) {
    return 'GitHub is limiting update checks from your network right now. Try again in an hour.';
  }
  if (/latest\.yml|latest-mac\.yml|latest-linux|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|\b404\b/i.test(text)) {
    return 'The newest release is not published for automatic updates yet (it may still be uploading).';
  }
  if (/sha512|checksum|signature|not signed|code ?sign/i.test(text)) {
    return 'The update failed its integrity / signature check.';
  }
  const first = raw.split('\n')[0].trim();
  return first ? 'The update check failed: ' + first.slice(0, 200) : 'The update check failed for an unknown reason.';
}

/**
 * Interpret a GitHub "releases/latest" API response. Anything that is not a
 * clean 200 with a tag is an error — a rate-limited 403 used to fall through
 * to "You're up to date!".
 */
function interpretLatestRelease({ statusCode, body, currentVersion }) {
  if (statusCode === 403 || statusCode === 429) {
    let msg = '';
    try { msg = JSON.parse(body).message || ''; } catch { /* not JSON */ }
    if (statusCode === 429 || /rate limit/i.test(msg)) {
      return { outcome: 'error', message: describeUpdateError(new Error('rate limit')) };
    }
    return { outcome: 'error', message: 'GitHub refused the update check (HTTP 403).' };
  }
  if (statusCode !== 200) {
    return { outcome: 'error', message: `GitHub answered the update check with an error (HTTP ${statusCode}).` };
  }
  let data;
  try { data = JSON.parse(body); } catch {
    return { outcome: 'error', message: 'The update check got an unreadable answer (a captive portal, proxy or filter may be in the way).' };
  }
  const tag = data && typeof data.tag_name === 'string' ? data.tag_name : '';
  const version = tag.replace(/^v/, '');
  if (!version) {
    return { outcome: 'error', message: 'The update check got an answer without a version in it.' };
  }
  if (isNewerVersion(currentVersion, version)) {
    return {
      outcome: 'available',
      version,
      url: data.html_url || `https://github.com/Waffleslop/POTACAT/releases/tag/${tag}`,
      headline: data.name || '',
    };
  }
  return { outcome: 'up-to-date', version };
}

/**
 * The toast for one manual-check outcome.
 * Returns { text, warn, sticky, durationMs, openUrl }.
 */
function manualCheckMessage(outcome, info) {
  const i = info || {};
  const cur = i.currentVersion ? 'v' + i.currentVersion : 'this version';
  switch (outcome) {
    case 'checking':
      return { text: `Checking for updates (you have POTACAT ${cur})…`, warn: false, sticky: true, durationMs: 0, openUrl: null };
    case 'up-to-date':
      return { text: `You're up to date: POTACAT ${cur} is the latest version.`, warn: false, sticky: false, durationMs: 8000, openUrl: null };
    case 'available': {
      const v = i.latestVersion ? 'v' + i.latestVersion : 'A new version';
      const next = i.canAutoInstall
        ? 'Click Upgrade in the green bar at the top of the window to download and install it.'
        : 'Click Download in the green bar at the top of the window to get it.';
      return { text: `POTACAT ${v} is available (you have ${cur}). ${next}`, warn: false, sticky: false, durationMs: 10000, openUrl: null };
    }
    case 'error':
      return {
        text: `${i.message || 'The update check failed.'} Click here to open the download page and update by hand (you have ${cur}).`,
        warn: true, sticky: true, durationMs: 0, openUrl: RELEASES_URL,
      };
    default:
      throw new Error('unknown update-check outcome: ' + outcome);
  }
}

module.exports = { RELEASES_URL, isNewerVersion, describeUpdateError, interpretLatestRelease, manualCheckMessage };
