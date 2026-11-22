'use strict';
/**
 * "Fill missing states from QRZ" (the WAS view's button and the map legend's
 * QRZ button): which QSOs it can fill, what it fills them with, and the one
 * sentence it answers with (#389).
 *
 * An operator was told "No states found for the 1 QSO still without one" and
 * could find no US contact without a state in any logbook (Discord
 * 2026-11-11). Two faults:
 *  - Australian contacts were counted. The roster deliberately does not track
 *    VK states (lib/worked-roster.js), so no state QRZ gave one could ever be
 *    written: a VK contact with no STATE stayed "still without one" for good.
 *    Only the entities the roster tracks (US, Alaska, Hawaii, Canada) count.
 *  - The answer never said WHICH QSO. It now names them (call, date, band)
 *    and why each is left, e.g. a portable call whose QRZ state is not in the
 *    country it was worked from, or a park that spans two states.
 *
 * Pure: main.js supplies the lookups. test/state-backfill-test.js.
 */

const NAME_AT_MOST = 3; // QSOs named in the answer; the rest are counted

/**
 * One log record. Returns null when it is not a candidate (has a STATE, or
 * its entity has no states the roster tracks); otherwise
 *   { state, fromPark, reason, call, ent }
 * with state '' and a reason when it cannot be filled.
 *
 * ctx:
 *   entityOf(call)       -> DXCC entity name ('United States', 'Canada', ...)
 *   tracksEntity(ent)    -> bool (WorkedRoster.tracksEntity)
 *   stateKeys(ent, st)   -> [] when st is not a state of ent (WorkedRoster.stateKeys)
 *   parkStateOf(rec)     -> null (not a park contact), '' (park spans states or unknown), 'XX'
 *   baseCall(call)       -> the station's own call (JtcatParser.baseCall)
 * lookups: Map baseCall -> QRZ record | null (not found); a call absent from
 *   the map was not looked up on this press.
 */
function decide(rec, ctx, lookups) {
  if (!rec || rec.STATE) return null;
  const ent = ctx.entityOf(rec.CALL);
  if (!ctx.tracksEntity(ent)) return null;
  const call = ctx.baseCall(String(rec.CALL || '').toUpperCase());
  const ps = ctx.parkStateOf(rec);
  const word = ent === 'Canada' ? 'province' : 'state';
  if (ps !== null) {
    if (!ps) return { state: '', reason: `the park ${parkRef(rec)} is not in one ${word}`, call, ent };
    if (!ctx.stateKeys(ent, ps).length) return { state: '', reason: `the park is in ${ps}, not a ${ent} ${word}`, call, ent };
    return { state: ps, fromPark: true, call, ent };
  }
  if (!lookups || !lookups.has(call)) return { state: '', reason: 'not looked up yet', call, ent };
  const q = lookups.get(call);
  if (!q) return { state: '', reason: 'not found on QRZ', call, ent };
  const st = String(q.state || '').trim().toUpperCase();
  if (!st) return { state: '', reason: `QRZ lists no ${word}`, call, ent };
  if (!ctx.stateKeys(ent, st).length) return { state: '', reason: `QRZ lists ${st}, not a ${ent} ${word}`, call, ent };
  return { state: st, fromPark: false, call, ent };
}

/** Whether this record needs a QRZ lookup (a candidate that is not a park contact). */
function wantsLookup(rec, ctx) {
  if (!rec || rec.STATE) return false;
  if (!ctx.tracksEntity(ctx.entityOf(rec.CALL))) return false;
  return ctx.parkStateOf(rec) === null;
}

function parkRef(rec) {
  return String(rec.SIG_INFO || rec.POTA_REF || '').trim().toUpperCase();
}

/** "VE3ABC on 2026-05-01, 20m (Canada; QRZ lists no province)" */
function describe(rec, d) {
  const date = String(rec.QSO_DATE || '');
  const when = /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : '';
  const band = String(rec.BAND || '').trim().toLowerCase();
  const where = [when, band].filter(Boolean).join(', ');
  const why = [d.ent && d.ent !== 'United States' ? d.ent : '', d.reason].filter(Boolean).join('; ');
  return `${String(rec.CALL || '').toUpperCase()}${where ? ' on ' + where : ''}${why ? ' (' + why + ')' : ''}`;
}

function plural(n, one, many) { return n === 1 ? one : many; }

/**
 * The sentence for the button. r = { filled, remaining, left: [text], more }
 * where left lists every QSO still without a state (describe()).
 */
function resultText(r) {
  const filled = r.filled || 0;
  const remaining = r.remaining || 0;
  const left = r.left || [];
  const named = left.slice(0, NAME_AT_MOST).join('; ');
  const rest = left.length > NAME_AT_MOST ? `; and ${left.length - NAME_AT_MOST} more` : '';
  const which = named ? `: ${named}${rest}` : '';
  const more = r.more ? ' (press again for more)' : '';
  if (!filled) {
    if (!remaining) return 'Every QSO already has a state.';
    return `No state found for the ${remaining} QSO${plural(remaining, '', 's')} still without one${which}${more}.`;
  }
  return `Filled ${filled} QSO${plural(filled, '', 's')}` +
    (remaining ? `, ${remaining} still without a state${which}` : '') + `${more}.`;
}

module.exports = { decide, wantsLookup, describe, resultText, NAME_AT_MOST };
