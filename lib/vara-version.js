// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// VARA's 1 January 2027 cut-off (Casey's request 2026-11-22). VARA HF 4.9.1
// and VARA FM 4.4.1 change the waveform from that date (set by the PC's clock);
// older VARA HF and VARA FM stop connecting to gateways that have updated.
//
// How the version is known, never guessed: VARA answers `VERSION` on its TCP
// command port with `VERSION VARA HF v4.8.9` (the line Pat logs as "got cmd:
// VERSION VARA HF v4.8.9"; Pat's VARA driver asks the same way and strips the
// `VERSION ` word). lib/vara-process.js probeVaraPort already asks it before
// every session. A VARA that says nothing, or a reply this cannot read, gives
// no notice.
//
// Information only: it never blocks a connection. Pure; tests:
// test/vara-version-test.js.

'use strict';

/** The first versions that keep working from 1 January 2027. */
const VARA_MIN_2027 = Object.freeze({ hf: Object.freeze([4, 9, 1]), fm: Object.freeze([4, 4, 1]) });
const CUTOFF_WORDS = '1 January 2027';
// The one place POTACAT already sends operators for VARA (Settings > Winlink,
// and on the open-external allowlist in main.js).
const UPDATE_WHERE = 'Update VARA from its author\'s site, rosmodem.wordpress.com.';

/** True from 1 January 2027 on this PC's clock (VARA itself goes by the local date). */
function varaCutoffPassed(now = new Date()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  return t >= new Date(2027, 0, 1, 0, 0, 0).getTime();
}

/**
 * `VERSION VARA HF v4.8.9` / `VARA FM v4.4.1` / `VARA v4.9.0` →
 * { kind: 'hf'|'fm'|'sat'|null, major, minor, patch, version: '4.8.9' }.
 * It must say VARA and carry three numbers; anything else → null.
 */
function parseVaraVersionText(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(?:VERSION\s+)?VARA(?:\s+(HF|FM|SAT))?\s+v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?!\d)/i.exec(text);
  if (!m) return null;
  const major = Number(m[2]), minor = Number(m[3]), patch = Number(m[4]);
  return { kind: m[1] ? m[1].toLowerCase() : null, major, minor, patch, version: `${major}.${minor}.${patch}` };
}

function older(v, min) {
  const a = [v.major, v.minor, v.patch];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== min[i]) return a[i] < min[i];
  }
  return false;
}

/**
 * The notice for a VARA that is too old for 2027, or null.
 * @param {string} versionText  what VARA answered (probe.version)
 * @param {{kind?:'hf'|'fm', now?:Date}} o  kind: the port it answered on, used
 *   only when the reply does not say HF or FM
 */
function varaUpdateNotice(versionText, { kind, now = new Date() } = {}) {
  const v = parseVaraVersionText(versionText);
  if (!v) return null;
  const k = v.kind || (kind === 'hf' || kind === 'fm' ? kind : null);
  if (k !== 'hf' && k !== 'fm') return null; // VARA SAT, or no way to tell
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return null;
  const min = VARA_MIN_2027[k];
  if (!older(v, min)) return null;
  const name = k === 'fm' ? 'VARA FM' : 'VARA HF';
  if (varaCutoffPassed(t)) {
    return `Your ${name} (version ${v.version}) is too old to work since ${CUTOFF_WORDS}. ${UPDATE_WHERE}`;
  }
  return `Your ${name} is version ${v.version}. ${name} before ${min.join('.')} stops working on ${CUTOFF_WORDS}. ${UPDATE_WHERE}`;
}

/**
 * Once per app run per modem. take(kind, text) records the latest text (null
 * clears it, for a newer VARA found later) and answers whether to announce it
 * now: true only the first time a kind has a notice. current() is what the
 * Winlink window shows while that modem is picked.
 */
function createVaraNoticeOnce() {
  const told = { hf: false, fm: false };
  const latest = { hf: null, fm: null };
  return {
    take(kind, text) {
      if (kind !== 'hf' && kind !== 'fm') return false;
      latest[kind] = text || null;
      if (!text || told[kind]) return false;
      told[kind] = true;
      return true;
    },
    current() { return { hf: latest.hf, fm: latest.fm }; },
  };
}

module.exports = {
  VARA_MIN_2027,
  varaCutoffPassed,
  parseVaraVersionText,
  varaUpdateNotice,
  createVaraNoticeOnce,
};
