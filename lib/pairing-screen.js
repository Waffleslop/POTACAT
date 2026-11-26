/**
 * lib/pairing-screen.js — simpler pairing for ECHOCAT (2026-11-25).
 *
 * Pure, dual-mode: `require()` in main and tests, `window.PairingScreen` in
 * the main window (index.html loads it like cloud-billing-ui.js).
 *
 * Three things live here, so every surface says and builds the same:
 *  1. The pairing LINK inside the QR. Since 2026-11-25 it is an https link
 *     whose parameters ride after "#", so they never reach a server:
 *       https://api.potacat.com/pair.html#token=...&name=...&host=...&fp=...
 *     Every key is a potacat://pair key, unchanged in name and meaning, so the
 *     landing page (and a phone) can rebuild the potacat://pair form from the
 *     same data. One page-only key, `web`, carries the best ECHOCAT Web
 *     address; it is dropped when the potacat:// form is rebuilt.
 *     Parameters in the "?" part are REFUSED by parsePairLink: a token in a
 *     query string lands in web server logs.
 *  2. The best ECHOCAT Web address for "Use a browser instead".
 *  3. The pairing screen's live state (waiting / phone found / paired /
 *     connected) and the one line of text each state shows.
 *
 * The wire contract is docs/echocat-protocol.md > "Pairing link".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PairingScreen = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LINK_ORIGIN = 'https://api.potacat.com';
  const LINK_PATH = '/pair.html';
  const LEGACY_PREFIX = 'potacat://pair?';

  // Every potacat://pair key, in the order the desktop writes them. The https
  // link uses exactly these names; nothing is renamed or re-encoded.
  const PAIR_KEYS = ['token', 'name', 'host', 'fp', 'spki', 'cloudHost', 'tsHost', 'tsIp', 'tsCertPublic', 'exp'];
  // Keys only the landing page reads. Never forwarded into potacat://pair.
  const PAGE_ONLY_KEYS = ['web'];

  // How long the "Connected" line stays before the window closes itself.
  const CLOSE_AFTER_CONNECT_MS = 2500;

  function _str(v) { return v == null ? '' : String(v); }

  function _orderedParams(params, keys) {
    const sp = new URLSearchParams();
    const src = params || {};
    for (const k of keys) {
      const v = _str(src[k]);
      if (v) sp.set(k, v);
    }
    return sp;
  }

  /** The https pairing link: same keys as potacat://pair, after "#". */
  function buildPairLink(params, opts) {
    const o = opts || {};
    const sp = _orderedParams(params, PAIR_KEYS);
    if (o.web) sp.set('web', _str(o.web));
    return LINK_ORIGIN + LINK_PATH + '#' + sp.toString();
  }

  /** The older potacat://pair form, for ECHOCAT versions that only know it. */
  function buildLegacyPairUri(params) {
    return LEGACY_PREFIX + _orderedParams(params, PAIR_KEYS).toString();
  }

  /**
   * Parse either form into { form, params } or { error }.
   * form: 'https' | 'legacy'. params holds only PAIR_KEYS (+ web for https).
   */
  function parsePairLink(input) {
    const raw = _str(input).trim();
    if (!raw) return { error: 'empty' };
    if (/^potacat:\/\/pair\?/i.test(raw)) {
      const sp = new URLSearchParams(raw.slice(raw.indexOf('?') + 1).split('#')[0]);
      const params = {};
      for (const k of PAIR_KEYS) if (sp.get(k)) params[k] = sp.get(k);
      if (!params.token) return { error: 'no-token' };
      return { form: 'legacy', params };
    }
    let u;
    try { u = new URL(raw); } catch { return { error: 'not-a-link' }; }
    if (u.protocol !== 'https:' || u.host.toLowerCase() !== 'api.potacat.com' || u.pathname !== LINK_PATH) {
      return { error: 'not-a-pair-link' };
    }
    // A token in the query string would have reached the server and its logs.
    if (u.search && u.search.length > 1) return { error: 'params-in-query' };
    const sp = new URLSearchParams(u.hash.replace(/^#/, ''));
    const params = {};
    for (const k of PAIR_KEYS) if (sp.get(k)) params[k] = sp.get(k);
    if (!params.token) return { error: 'no-token' };
    const out = { form: 'https', params };
    if (sp.get('web')) out.web = sp.get('web');
    return out;
  }

  /** What the landing page's "Open ECHOCAT" button builds from the link. */
  function legacyFromLink(link) {
    const p = parsePairLink(link);
    if (p.error) return '';
    return buildLegacyPairUri(p.params);
  }

  /**
   * The best ECHOCAT Web address for this desktop. The Cloud address wins
   * when the tunnel is live (a real certificate, works anywhere); else the
   * first home-network address; else the Tailscale address. '' when ECHOCAT
   * access is off or nothing is reachable.
   * web: the shape the ECHOCAT card builds (renderer/app.js).
   */
  function bestWeb(web) {
    if (!web || web.access === 'off') return { url: '', kind: '' };
    if (web.cloudUrl) return { url: _str(web.cloudUrl), kind: 'cloud' };
    if (Array.isArray(web.addresses) && web.addresses.length && web.port) {
      return { url: 'https://' + web.addresses[0] + ':' + web.port, kind: 'lan' };
    }
    if (web.tailscaleUrl) return { url: _str(web.tailscaleUrl), kind: 'tailscale' };
    return { url: '', kind: '' };
  }
  function bestWebUrl(web) { return bestWeb(web).url; }

  /** The sentence under "Use a browser instead" for each kind of address. */
  function browserHint(kind) {
    switch (kind) {
      case 'cloud': return 'Open this address in any browser, at home or away, and sign in with your POTACAT Cloud account.';
      case 'lan': return 'Open this address in a browser on the same Wi-Fi as this computer. The first time, the browser warns about the certificate; continue to the page.';
      case 'tailscale': return 'Open this address in a browser on a phone or computer signed in to your Tailscale network.';
      default: return 'No browser address is available. Choose who can reach this computer under Settings > ECHOCAT.';
    }
  }

  // ── Live state ────────────────────────────────────────────────────
  // waiting  -> the code is on screen
  // found    -> a phone on the network asked to pair (needs the Approve click)
  // paired   -> a phone redeemed the code; waiting for it to connect
  // connected-> that phone is connected; the window closes itself
  function initialState() { return { phase: 'waiting', name: '', code: '', deviceId: '' }; }

  function nextState(state, ev) {
    const s = state || initialState();
    const e = ev || {};
    switch (e.type) {
      case 'open':
        return initialState();
      case 'request':
        // A connected screen stays connected; anything else shows the request.
        if (s.phase === 'connected') return s;
        return { phase: 'found', name: _str(e.name), code: _str(e.code), deviceId: '' };
      case 'request-resolved':
        if (s.phase !== 'found') return s;
        if (e.approved) return { phase: 'paired', name: s.name, code: '', deviceId: _str(e.deviceId) };
        return initialState();
      case 'paired':
        if (s.phase === 'connected') return s;
        return { phase: 'paired', name: _str(e.name), code: '', deviceId: _str(e.deviceId) };
      case 'connected':
        // Only the phone this screen paired counts as "connected".
        if (s.phase !== 'paired' || !e.deviceId || e.deviceId !== s.deviceId) return s;
        return { phase: 'connected', name: _str(e.name) || s.name, code: '', deviceId: s.deviceId };
      default:
        return s;
    }
  }

  function formatCode(code) {
    const c = _str(code).replace(/\D/g, '');
    return c.length === 6 ? c.slice(0, 3) + ' ' + c.slice(3) : c;
  }

  /** One plain line for the state. */
  function stateLine(state) {
    const s = state || initialState();
    switch (s.phase) {
      case 'found':
        return (s.name || 'A phone') + ' wants to pair. Check that it shows ' + formatCode(s.code) + ', then click Approve.';
      case 'paired':
        return 'Paired with ' + (s.name || 'your phone') + '. Waiting for it to connect.';
      case 'connected':
        return 'Connected: ' + (s.name || 'your phone') + '.';
      default:
        return 'Waiting for your phone.';
    }
  }

  return {
    LINK_ORIGIN, LINK_PATH, PAIR_KEYS, PAGE_ONLY_KEYS, CLOSE_AFTER_CONNECT_MS,
    buildPairLink, buildLegacyPairUri, parsePairLink, legacyFromLink, bestWeb, bestWebUrl, browserHint,
    initialState, nextState, stateLine, formatCode,
  };
}));
