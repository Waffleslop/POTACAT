// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Winlink forms (#346): the rules POTACAT keeps about Pat's forms (pure, unit-tested).
//
// Pat does the forms: its catalog, its HTML input pages (/api/forms) and the
// message it builds from them. POTACAT only decides whether to offer them.
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

'use strict';

/** The oldest Pat POTACAT offers or serves forms on. */
const FORMS_MIN_PAT = '1.0.1';

/**
 * Pat's own version from `pat version` output (or any text holding it), or a
 * bare "1.0.1" / "v1.0.1". The Go version in the same line ("go1.26.3") is
 * never read as Pat's.
 * @returns {{major:number, minor:number, patch:number, pre:string, text:string}|null}
 */
function parsePatVersion(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;
  const re = /(?:^|\bPat\s+)v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?=$|[\s(])/;
  const m = s.match(re);
  if (!m) return null;
  const [, a, b, c, pre = ''] = m;
  const out = { major: Number(a), minor: Number(b), patch: Number(c), pre, text: `${a}.${b}.${c}${pre ? '-' + pre : ''}` };
  return out;
}

/** <0, 0, >0 like SemVer: numbers first, then a pre-release sorts below its release. */
function comparePatVersions(x, y) {
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] - y[k];
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
  const v = parsePatVersion(versionText);
  if (!v) {
    return { ok: false, version: '', why: `Winlink forms need Pat ${FORMS_MIN_PAT} or newer, and POTACAT could not tell which Pat this is.` };
  }
  if (comparePatVersions(v, parsePatVersion(FORMS_MIN_PAT)) < 0) {
    return { ok: false, version: v.text, why: `Winlink forms need Pat ${FORMS_MIN_PAT} or newer. This Pat is ${v.text}.` };
  }
  return { ok: true, version: v.text, why: '' };
}

module.exports = { FORMS_MIN_PAT, parsePatVersion, comparePatVersions, formsAllowed };
