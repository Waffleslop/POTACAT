// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Winlink forms (#346): the rules POTACAT keeps about Pat's forms (pure, unit-tested).
//
// Pat does the forms: its catalog, its HTML input pages (/api/forms) and the
// message it builds from them. POTACAT decides whether to offer them, shapes
// Pat's catalog for the picker, and decides what the window that shows Pat's
// form page may load. No Winlink form file or text is in this repository:
// Pat downloads the Standard Forms onto the operator's machine (POST
// /api/formsUpdate), and POTACAT shows Pat's own page for them.
//
// Phase 0 rule: no forms on a Pat older than 1.0.1. Pat v1.0.0 serves a
// form's HTML same-origin with its own unauthenticated API, so a form page
// (third-party HTML and script) could connect, send or delete mail through
// Pat. v1.0.1 (la5nta/pat 2ad31e8, "Sandbox endpoints rendering HTML Forms")
// sends /api/forms and /api/forms/* with a CSP sandbox and no
// allow-same-origin, so the page has a null origin and cannot. The version
// comes from what Pat says about itself: `pat version` prints
// "Pat v1.0.1 (2ad31e8) windows/amd64 - go1.26.3" (cli/version.go), and its
// web UI shows the same string. A Pat whose version cannot be read gets no
// forms: an operator's own Pat (Settings > Winlink > Advanced) may be anything.
//
// Phase 1, Pat v1.0.1 facts used here (github.com/la5nta/pat at 2ad31e8):
//   - api/api.go 116-121: GET /api/formcatalog, POST /api/form, GET /api/form,
//     GET /api/forms (sandboxed), GET /api/forms/<asset> (sandboxed),
//     POST /api/formsUpdate. Line 96: GET /api/mailbox/{box}/{mid}/{attachment}
//     (sandboxed), which renders a form attachment with ?rendertohtml=true.
//   - internal/forms/forms.go PostFormDataHandler / GetFormDataHandler: the
//     form instance is the cookie named "forminstance"; the built message is
//     kept under its value. api/mailbox.go postOutboundMessageHandler: a POST
//     /api/mailbox/out carrying the same cookie gets the form's attachments
//     (the RMS_Express_Form XML) added by Pat itself.
//   - web/src/js/modules/utils/index.js formXmlToFormName: Pat's own test for
//     a form attachment's file name, copied in formAttachment() below.
//
// Dual-mode: require() in main and tests, window.WinlinkForms in the mail window.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./grid'));
  else root.WinlinkForms = factory(null);
})(typeof self !== 'undefined' ? self : this, function (grid) {
  'use strict';

  /** The oldest Pat POTACAT offers or serves forms on. */
  var FORMS_MIN_PAT = '1.0.1';

  /**
   * Pat's own version from `pat version` output (or any text holding it), or a
   * bare "1.0.1" / "v1.0.1". The Go version in the same line ("go1.26.3") is
   * never read as Pat's.
   * @returns {{major:number, minor:number, patch:number, pre:string, text:string}|null}
   */
  function parsePatVersion(text) {
    if (typeof text !== 'string') return null;
    var s = text.trim();
    if (!s) return null;
    var re = /(?:^|\bPat\s+)v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?=$|[\s(])/;
    var m = s.match(re);
    if (!m) return null;
    var pre = m[4] || '';
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: pre, text: m[1] + '.' + m[2] + '.' + m[3] + (pre ? '-' + pre : '') };
  }

  /** <0, 0, >0 like SemVer: numbers first, then a pre-release sorts below its release. */
  function comparePatVersions(x, y) {
    var keys = ['major', 'minor', 'patch'];
    for (var i = 0; i < keys.length; i++) {
      if (x[keys[i]] !== y[keys[i]]) return x[keys[i]] - y[keys[i]];
    }
    if (x.pre === y.pre) return 0;
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return x.pre < y.pre ? -1 : 1;
  }

  /**
   * May POTACAT offer or serve Winlink forms with this Pat? `versionText` is
   * what the running Pat said about itself (see the header).
   * @returns {{ok:boolean, version:string, why:string}}
   */
  function formsAllowed(versionText) {
    var v = parsePatVersion(versionText);
    if (!v) {
      return { ok: false, version: '', why: 'Winlink forms need Pat ' + FORMS_MIN_PAT + ' or newer, and POTACAT could not tell which Pat this is.' };
    }
    if (comparePatVersions(v, parsePatVersion(FORMS_MIN_PAT)) < 0) {
      return { ok: false, version: v.text, why: 'Winlink forms need Pat ' + FORMS_MIN_PAT + ' or newer. This Pat is ' + v.text + '.' };
    }
    return { ok: true, version: v.text, why: '' };
  }

  /**
   * The version line of Pat's web UI: web/src/index.html renders
   * <p id="version">{{.AppName}} {{.Version}}</p>, the same text as
   * `pat version` (web/web.go templateHandler, buildinfo.VersionString). Read
   * from the running Pat, so it is the Pat POTACAT talks to. '' when absent.
   */
  function patVersionFromUi(html) {
    var m = /<p\s+id="version"\s*>([^<]{1,200})<\/p>/i.exec(String(html || ''));
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  }

  // ── the catalog ────────────────────────────────────────────────────────────

  /**
   * Pre-pinned favourites, by folder and file name (not by path or version:
   * a forms release can move or rename a file, so a missing one falls back to
   * a search for its name). These are names in Pat's catalog, not form text.
   */
  var FAVOURITE_FORMS = [
    { folder: 'General Forms', name: 'Winlink Check-in' },
    { folder: 'ICS USA Forms', name: 'ICS213 General Message' },
  ];

  /** Pat's template_path uses the OS separator (backslash on Windows); shown and compared with "/". */
  function slashPath(p) { return String(p || '').replace(/\\/g, '/'); }

  /**
   * Pat's GET /api/formcatalog tree (forms.go FormFolder: name, path, version,
   * form_count, forms [{name, template_path}], folders) as one sorted list.
   * `path` is kept exactly as Pat gave it: it goes back to Pat as ?template=.
   * @returns {{version:string, count:number, forms:Array<{name:string, folder:string, path:string}>}}
   */
  function flattenCatalog(cat) {
    var out = [];
    var seen = {};
    function walk(f, depth) {
      if (!f || typeof f !== 'object' || depth > 12) return;
      (Array.isArray(f.forms) ? f.forms : []).forEach(function (t) {
        if (!t || typeof t.template_path !== 'string' || !t.template_path) return;
        if (seen[t.template_path]) return;
        seen[t.template_path] = true;
        var sp = slashPath(t.template_path);
        var i = sp.lastIndexOf('/');
        var file = sp.slice(i + 1).replace(/\.txt$/i, '');
        out.push({ name: String(t.name || file), folder: i > 0 ? sp.slice(0, i) : '', path: t.template_path });
      });
      (Array.isArray(f.folders) ? f.folders : []).forEach(function (s) { walk(s, depth + 1); });
    }
    walk(cat, 0);
    out.sort(function (a, b) {
      var fa = a.folder.toLowerCase(), fb = b.folder.toLowerCase();
      if (fa !== fb) return fa < fb ? -1 : 1;
      var na = a.name.toLowerCase(), nb = b.name.toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    var version = cat && typeof cat.version === 'string' && cat.version !== 'unknown' ? cat.version : '';
    return { version: version, count: out.length, forms: out };
  }

  /**
   * Each favourite as a form from the list: the same folder and name first,
   * then the same name in any folder; a favourite with neither is
   * {missing:true, search:<its name>}, so the picker can search for it.
   */
  function resolveFavourites(forms, favs) {
    var list = Array.isArray(forms) ? forms : [];
    return (Array.isArray(favs) ? favs : FAVOURITE_FORMS).map(function (f) {
      var n = String(f.name || '').toLowerCase();
      var d = String(f.folder || '').toLowerCase();
      var exact = list.filter(function (x) { return x.name.toLowerCase() === n && x.folder.toLowerCase() === d; })[0];
      var any = exact || list.filter(function (x) { return x.name.toLowerCase() === n; })[0];
      return any ? { name: any.name, folder: any.folder, path: any.path } : { name: f.name, folder: f.folder, missing: true, search: f.name };
    });
  }

  /**
   * Forms whose name or folder holds every word of the query (any case). A
   * name that starts with the query comes first. An empty query matches none.
   */
  function searchForms(forms, query, limit) {
    var words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var q = words.join(' ');
    var hits = (Array.isArray(forms) ? forms : []).filter(function (f) {
      var hay = (f.name + ' ' + f.folder).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
    var rank = hits.map(function (f, i) { return { f: f, i: i, s: f.name.toLowerCase().indexOf(q) === 0 ? 0 : 1 }; });
    rank.sort(function (a, b) { return a.s - b.s || a.i - b.i; });
    return rank.map(function (r) { return r.f; }).slice(0, limit > 0 ? limit : 60);
  }

  /** What the picker shows: installed or not, the version, favourites, every form. */
  function shapeCatalog(cat, favs) {
    var flat = flattenCatalog(cat);
    return { installed: flat.count > 0, version: flat.version, count: flat.count, favourites: flat.count ? resolveFavourites(flat.forms, favs) : [], forms: flat.forms };
  }

  /**
   * POST /api/formsUpdate's answer (forms.go UpdateResponse {newestVersion,
   * action: "none"|"update"}) or its error, in one plain sentence. Pat's
   * error for an unreachable getpat.io is "can't fetch winlink forms version
   * page" (forms.go getLatestFormsInfo).
   */
  function formsUpdateMessage(res, err) {
    if (err) {
      var t = String((err && err.message) || err);
      if (/can't fetch winlink forms version page|no such host|dial tcp|i\/o timeout|connection refused|network is unreachable|Client\.Timeout|can't download update ZIP/i.test(t)) {
        return { ok: false, text: 'Pat could not reach getpat.io, where it gets the Winlink Standard Forms. Check this computer\'s internet connection and try again.' };
      }
      if (/did not answer within/i.test(t)) return { ok: false, text: 'Pat did not finish getting the forms in time. Try again.' };
      return { ok: false, text: 'Pat could not get the forms: ' + t.slice(0, 200) };
    }
    var v = res && typeof res.newestVersion === 'string' ? res.newestVersion : '';
    if (res && res.action === 'update') return { ok: true, text: 'Got the Winlink Standard Forms' + (v ? ', version ' + v : '') + '.', version: v };
    if (res && res.action === 'none') return { ok: true, text: 'You have the newest Winlink Standard Forms' + (v ? ' (' + v + ')' : '') + '.', version: v };
    return { ok: false, text: 'Pat gave an answer POTACAT does not understand. Try again.' };
  }

  // ── a filled form ──────────────────────────────────────────────────────────

  /** The cookie Pat keys a form instance on (forms.go, api/mailbox.go). */
  var FORM_COOKIE = 'forminstance';

  /** A new form instance id: 32 hex characters from 16 random bytes. */
  function newFormInstanceId(randomBytes) {
    var b = randomBytes(16);
    var s = '';
    for (var i = 0; i < 16; i++) s += ('0' + (b[i] & 255).toString(16)).slice(-2);
    return s;
  }

  function isFormInstanceId(s) { return typeof s === 'string' && /^[0-9a-f]{32}$/.test(s); }

  /** The Cookie header for one form instance ('' for anything that is not one). */
  function formCookieHeader(id) { return isFormInstanceId(id) ? FORM_COOKIE + '=' + id : ''; }

  /**
   * A template .txt's own word on editing: "Readonly: True" (or Yes) before
   * "Msg:". Pat reads the line and ignores it (internal/forms/builder.go,
   * case "Readonly"); Winlink Express locks the body, so POTACAT does too.
   */
  function templateReadOnly(text) {
    var lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*([A-Za-z]+)\s*:(.*)$/.exec(lines[i]);
      if (!m) continue;
      var k = m[1].toLowerCase();
      if (k === 'msg') return false;
      if (k === 'readonly') return /^\s*(true|yes)\s*$/i.test(m[2]);
    }
    return false;
  }

  /** Has the operator changed a read-only form's body? Line endings do not count. */
  function bodyChanged(original, now) {
    var n = function (x) { return String(x == null ? '' : x).replace(/\r\n/g, '\n'); };
    return n(original) !== n(now);
  }

  /** GET /api/form's answer (builder.go Message: msg_to, msg_cc, msg_subject, msg_body) for the compose pane. */
  function formResultToCompose(data, o) {
    var d = data && typeof data === 'object' ? data : {};
    return {
      to: String(d.msg_to || '').trim(),
      cc: String(d.msg_cc || '').trim(),
      subject: String(d.msg_subject || '').trim(),
      body: String(d.msg_body || ''),
      readOnly: !!(o && o.readOnly),
    };
  }

  /**
   * A received message's form attachment, by Pat's own rule (formXmlToFormName):
   * RMS_Express_Form_<name>.xml or RMS_Express_Form_<name>-<n>.xml.
   * @returns {{file:string, form:string}|null}
   */
  function formAttachment(attachments) {
    var list = Array.isArray(attachments) ? attachments : [];
    for (var i = 0; i < list.length; i++) {
      var n = String((list[i] && list[i].name) || list[i] || '');
      var m = /^RMS_Express_Form_([\w .]+)-\d+\.xml$/i.exec(n) || /^RMS_Express_Form_([\w .]+)\.xml$/i.exec(n);
      if (m) return { file: n, form: m[1] };
    }
    return null;
  }

  /**
   * The reply form a received form names (#346 phase 2): form_parameters >
   * reply_template in its RMS_Express_Form XML (Pat v1.0.1
   * internal/forms/builder.go writes it from the template's "ReplyTemplate:"
   * line; forms.go RenderForm reads it back, adding ".0" when it has no
   * extension). '' when the form has none (then there is no Reply with form).
   */
  function formReplyTemplate(xml) {
    var s = String(xml || '');
    var p = /<form_parameters\b[^>]*>([\s\S]*?)<\/form_parameters>/i.exec(s);
    if (!p) return '';
    var m = /<reply_template\b[^>]*>([^<]*)<\/reply_template>/i.exec(p[1]);
    if (!m) return '';
    var v = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
    return /^[\w .()-]{1,120}$/.test(v) ? v : '';
  }

  /** The "<box>/<mid>" Pat takes as in-reply-to (api/mailbox.go, forms.go): '' for anything else. */
  function inReplyToRef(box, mid) {
    return BOX_RE.test(String(box)) && MID_RE.test(String(mid)) ? box + '/' + mid : '';
  }

  // ── the form window: what it may load ─────────────────────────────────────

  var BOX_RE = /^[A-Za-z0-9_-]{1,32}$/;
  var MID_RE = /^[A-Za-z0-9_-]{1,32}$/;

  function patOrigin(port) {
    var n = Number(port);
    return Number.isInteger(n) && n > 0 && n < 65536 ? 'http://127.0.0.1:' + n : '';
  }

  /** The page that fills in a new form: GET /api/forms?template=<Pat's template_path>. */
  function fillUrl(origin, templatePath, inReplyTo) {
    if (!origin || typeof templatePath !== 'string' || !templatePath || templatePath.length > 400) return '';
    var q = 'template=' + encodeURIComponent(templatePath);
    if (inReplyTo) q += '&in-reply-to=' + encodeURIComponent(inReplyTo);
    return origin + '/api/forms?' + q;
  }

  /**
   * A received form, rendered by Pat: GET /api/mailbox/<box>/<mid>/<xml>?rendertohtml=true
   * (api/mailbox.go attachmentHandler). With `inReplyTo` ("<box>/<mid>"),
   * Pat renders the form's reply template instead (forms.go RenderForm).
   */
  function viewUrl(origin, box, mid, file, inReplyTo) {
    if (!origin || !BOX_RE.test(String(box)) || !MID_RE.test(String(mid)) || !formAttachment([file])) return '';
    var u = origin + '/api/mailbox/' + encodeURIComponent(box) + '/' + encodeURIComponent(mid) + '/' + encodeURIComponent(file) + '?rendertohtml=true';
    if (inReplyTo) u += '&in-reply-to=' + encodeURIComponent(inReplyTo);
    return u;
  }

  function _url(u) { try { return new URL(String(u)); } catch (e) { return null; } }

  /**
   * What a URL is to the form window. Pat's own pages for forms are the only
   * pages it shows:
   *   'form'      GET /api/forms?template=...      a form to fill in
   *   'asset'     /api/forms/<file>                 a file a form references
   *   'submit'    /api/form?template=...            the form's own Submit
   *   'view'      /api/mailbox/<b>/<m>/<f>?rendertohtml=true   a received form
   *   'pat-other' anything else on Pat's origin (its API, its web UI)
   *   'external'  http(s) anywhere else
   *   'other'     any other scheme
   */
  function formUrlKind(url, origin) {
    var u = _url(url);
    if (!u) return 'other';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'other';
    if (!origin || u.origin !== origin) return 'external';
    var p = u.pathname;
    if (p === '/api/forms' && u.searchParams.get('template')) return 'form';
    if (p.indexOf('/api/forms/') === 0 && p.length > 11) return 'asset';
    if (p === '/api/form' && u.searchParams.get('template')) return 'submit';
    if (/^\/api\/mailbox\/[^/]+\/[^/]+\/[^/]+$/.test(p) && u.searchParams.get('rendertohtml') === 'true') return 'view';
    return 'pat-other';
  }

  /**
   * A navigation the page asks for (a link, its Submit, a window.open):
   * {allow:true} for Pat's form pages; {allow:false, external:url} for a web
   * page elsewhere (opened in the browser only after the operator says so,
   * never in this window); {allow:false} for everything else. A window that
   * only shows a received form ({submit:false}) does not post one.
   */
  function navigationVerdict(url, origin, o) {
    var k = formUrlKind(url, origin);
    if (k === 'submit' && o && o.submit === false) return { allow: false, kind: k };
    if (k === 'form' || k === 'asset' || k === 'submit' || k === 'view') return { allow: true, kind: k };
    if (k === 'external') return { allow: false, kind: k, external: String(url) };
    return { allow: false, kind: k };
  }

  /**
   * Every request the form window makes, by URL, method and resource type.
   * Only Pat's form pages, their files and Pat's web UI stylesheets/scripts
   * (/dist, which Pat's text-only form editor loads) reach Pat; a received
   * form is loaded only as the page itself. Nothing reaches anywhere else
   * (no tracking pixel, no script from the web), and nothing reaches the rest
   * of Pat's API (connect, send, delete, settings), which has no
   * authentication: a form page is third-party HTML and script, and Pat's
   * sandbox stops it reading answers, not sending requests. A window that
   * only shows a received form ({submit:false}) cannot post one either.
   */
  function requestAllowed(req, origin, o) {
    var submit = !(o && o.submit === false);
    var r = req || {};
    var url = String(r.url || '');
    if (/^(data|blob|devtools):/i.test(url)) return true;
    if (url === 'about:blank') return true;
    var method = String(r.method || 'GET').toUpperCase();
    var k = formUrlKind(url, origin);
    if (k === 'form' || k === 'asset') return method === 'GET';
    if (k === 'submit') return submit && method === 'POST';
    if (k === 'view') return method === 'GET' && r.resourceType === 'mainFrame';
    if (k === 'pat-other') {
      var u = _url(url);
      return method === 'GET' && !!u && u.pathname.indexOf('/dist/') === 0;
    }
    return false;
  }

  /**
   * Electron has no window.prompt(): it throws "prompt() is not supported".
   * The Winlink forms call it all the time (182 of the 1.1.22.0 pages: the
   * check-in's Submit asks "Message Subject:", every "Click to Add Date/Time"
   * asks with the time filled in). Without it a form cannot be submitted.
   * Until POTACAT has a prompt box of its own for the form window, prompt()
   * answers as if OK was pressed on what the form suggests (the time, the
   * subject); with no suggestion it answers as Cancel (null). Everything
   * stays editable: the form's fields, and To and Subject in the compose pane.
   * main.js runs this in the page after each load (an earlier script is
   * replaced by Electron's own).
   */
  var PROMPT_SHIM = 'window.prompt = function (message, suggestion) { return suggestion === undefined || suggestion === null ? null : String(suggestion); }; void 0;';

  // ── geolocation, answered from POTACAT's grid ─────────────────────────────

  var GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/i;

  /**
   * What a form asking for the location is told: the centre of the
   * operator's grid square from Settings, never the computer's location.
   * Accuracy is how far off the centre can be (as the Position report form
   * says it): 100 km for 4 characters, 5 km for 6, 1 km for 8. No grid, no answer.
   * @returns {{latitude:number, longitude:number, accuracy:number}|null}
   */
  function geolocationFromGrid(g) {
    var s = String(g || '').trim();
    if (!GRID_RE.test(s) || !grid) return null;
    var ll = grid.gridToLatLon(s.slice(0, 6));
    if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lon)) return null;
    var accuracy = s.length >= 8 ? 1000 : s.length >= 6 ? 5000 : 100000;
    return { latitude: Math.round(ll.lat * 1e5) / 1e5, longitude: Math.round(ll.lon * 1e5) / 1e5, accuracy: accuracy };
  }

  /**
   * A permission the form page asks for. Only geolocation can be granted, and
   * only when it is answered from the grid (geolocationFromGrid); every other
   * permission (camera, microphone, notifications, clipboard, ...) is refused.
   */
  function permissionAllowed(permission, geo) {
    return permission === 'geolocation' && !!geo;
  }

  return {
    FORMS_MIN_PAT: FORMS_MIN_PAT, parsePatVersion: parsePatVersion, comparePatVersions: comparePatVersions,
    formsAllowed: formsAllowed, patVersionFromUi: patVersionFromUi,
    FAVOURITE_FORMS: FAVOURITE_FORMS, slashPath: slashPath, flattenCatalog: flattenCatalog,
    resolveFavourites: resolveFavourites, searchForms: searchForms, shapeCatalog: shapeCatalog,
    formsUpdateMessage: formsUpdateMessage,
    FORM_COOKIE: FORM_COOKIE, newFormInstanceId: newFormInstanceId, isFormInstanceId: isFormInstanceId,
    formCookieHeader: formCookieHeader, templateReadOnly: templateReadOnly, bodyChanged: bodyChanged,
    formResultToCompose: formResultToCompose, formAttachment: formAttachment,
    formReplyTemplate: formReplyTemplate, inReplyToRef: inReplyToRef,
    patOrigin: patOrigin, fillUrl: fillUrl, viewUrl: viewUrl, formUrlKind: formUrlKind,
    navigationVerdict: navigationVerdict, requestAllowed: requestAllowed, PROMPT_SHIM: PROMPT_SHIM,
    geolocationFromGrid: geolocationFromGrid, permissionAllowed: permissionAllowed,
  };
});
