'use strict';
// Which QSOs that arrive by Cloud pull go on to the external loggers
// (GitHub #267, NA4DQ).
//
// A QSO the phone logs THROUGH this desktop is saved by saveQsoRecord, which
// forwards it to MacLoggerDX (and the other loggers: lib/logger-forward.js).
// Off-grid, the phone keeps the QSO and pushes it to the Cloud later; this PC
// gets it only through the pull (lib/cloud-ipc.js mergePulledQsos), which
// wrote the local log and forwarded nothing. So an off-grid activation reached
// the Cloud log and the POTACAT log but never MacLoggerDX.
//
// Casey's rule (2026-11-08): forward only this station's own QSOs, never one
// logged at another PC (that PC already forwarded it to ITS loggers). A cloud
// record names no device (the pull returns uuid, adifFields, version,
// isDeleted, updatedAt), so "ours" is read from the record and this PC:
//
//   1. NOT A DESKTOP RECORD. Every desktop write carries APP_POTACAT_UUID in
//      its ADIF (lib/adif-writer.js buildAdifFields, lib/qso-log.js, the full
//      upload); an older desktop journal carried pseudo names (CALLSIGN,
//      QSODATE, TIMEON, FREQUENCY, UUID). The ECHOCAT app's own records
//      (potacat-app QsoBuilder) carry none of these. So a record with any of
//      them came from a desktop and is never forwarded here.
//   2. THIS STATION. STATION_CALLSIGN is set and its base call is this
//      profile's (myCallsign or the profile's call): K4ABC/P matches K4ABC.
//      No STATION_CALLSIGN, no forward.
//   3. A PHONE PAIRED HERE. This profile has at least one paired ECHOCAT
//      device; a PC nothing ever paired with never forwards a phone's QSO.
//   4. NOT A BACKFILL. Nothing is forwarded by a pull that starts with no
//      cursor (the first sync of an account on this PC, or the first after a
//      sign-in), and only QSOs whose QSO_DATE/TIME_ON is at or after the
//      moment this PC first pulled with this rule (per account) count. A
//      user's whole history never floods the logger.
//   5. ONCE. Every forwarded uuid is recorded before the send; a uuid already
//      recorded is never sent again.
//
// The live path's own phone copy (the phone journals its record too) is
// absorbed by the duplicate guard as a copy of the desktop's record, so it is
// never a candidate: the live QSO is not forwarded twice.

const fs = require('fs');
const path = require('path');
const { baseCall } = require('../renderer/jtcat-parser');

// Fields only a desktop write puts in a record's ADIF (see rule 1).
const DESKTOP_KEYS = new Set(['APP_POTACAT_UUID', 'UUID', 'CALLSIGN', 'QSODATE', 'TIMEON', 'FREQUENCY']);

/** True when the record's RAW cloud fields show a desktop wrote it. */
function isDesktopRecord(rawFields) {
  if (!rawFields || typeof rawFields !== 'object') return false;
  for (const k of Object.keys(rawFields)) {
    if (DESKTOP_KEYS.has(String(k).toUpperCase())) return true;
  }
  return false;
}

/** QSO_DATE + TIME_ON as epoch ms (UTC), NaN when either is unreadable. */
function qsoTimeMs(fields) {
  const d = String((fields && fields.QSO_DATE) || '').trim();
  const t = String((fields && fields.TIME_ON) || '').trim();
  if (!/^\d{8}$/.test(d) || !/^\d{4}(\d{2})?$/.test(t)) return NaN;
  const ms = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), t.length === 6 ? +t.slice(4, 6) : 0);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Is the record this station's: its STATION_CALLSIGN's base call is one of `myCalls`'? */
function isOwnStation(fields, myCalls) {
  const stn = baseCall((fields && fields.STATION_CALLSIGN) || '');
  if (!stn) return false;
  for (const c of myCalls || []) {
    const mine = baseCall(c || '');
    if (mine && mine === stn) return true;
  }
  return false;
}

/**
 * Judge one record the pull just added to the log.
 * @param {object} rawFields - the cloud's adifFields as pulled (before any stamping)
 * @param {object} fields - the normalized fields written to the log
 * @param {{myCalls: string[], sinceMs: number}} ctx
 * @returns {{forward: boolean, reason: string}}
 */
function judgePulledQso(rawFields, fields, { myCalls, sinceMs }) {
  if (isDesktopRecord(rawFields)) return { forward: false, reason: 'desktop' };
  if (!isOwnStation(fields, myCalls)) return { forward: false, reason: 'other-station' };
  const at = qsoTimeMs(fields);
  if (!Number.isFinite(at) || !Number.isFinite(sinceMs) || at < sinceMs) return { forward: false, reason: 'before' };
  return { forward: true, reason: 'ok' };
}

/**
 * The persistent record: per account, the moment forwarding started (rule 4),
 * and the uuids already forwarded (rule 5). One small JSON file in userData.
 */
class ForwardedStore {
  constructor(file, { cap = 20000 } = {}) {
    this.file = file;
    this.cap = cap;
    this.since = {};
    this.uuids = [];
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j.since === 'object' && j.since) this.since = j.since;
      if (j && Array.isArray(j.uuids)) this.uuids = j.uuids.filter((u) => typeof u === 'string');
    } catch { /* first run, or unreadable: start empty */ }
    this.set = new Set(this.uuids);
  }
  sinceFor(owner) { const v = this.since[owner]; const ms = Date.parse(v); return Number.isFinite(ms) ? ms : NaN; }
  startFor(owner, when = new Date()) { this.since[owner] = when.toISOString(); this.save(); }
  has(uuid) { return this.set.has(uuid); }
  add(uuids) {
    for (const u of uuids) { if (!this.set.has(u)) { this.set.add(u); this.uuids.push(u); } }
    if (this.uuids.length > this.cap) {
      const drop = this.uuids.splice(0, this.uuids.length - this.cap);
      for (const u of drop) this.set.delete(u);
    }
    this.save();
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ since: this.since, uuids: this.uuids }));
      fs.renameSync(tmp, this.file);
    } catch { /* best effort: the in-memory set still stops a resend this session */ }
  }
}

module.exports = { isDesktopRecord, qsoTimeMs, isOwnStation, judgePulledQso, ForwardedStore, DESKTOP_KEYS };
