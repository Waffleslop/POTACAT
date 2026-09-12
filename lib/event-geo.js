'use strict';

// Where an EVENT STATION actually is (2026-09-12, Route 66 On The Air).
//
// A DX-cluster spot carries only callsign + frequency + comment, so the
// map places it by the callsign's DXCC/call-area centroid, then QRZ's
// address grid. Both are wrong for a special-event station: W6K is a
// California call-area centroid by prefix and somebody's house by QRZ,
// while for nine days it is Oklahoma City. A checklist event definition
// knows the place — `tracking.items[].lat/lon` — so a spot for one of its
// stations is placed there, and that placement is TERMINAL (the QRZ
// refinement must not move it back to the club trustee's home).
//
// Not gated on opt-in: location is a fact about the station, not a
// preference of the operator. Near-active with the renderer's badge grace
// (EVENT_BADGE_GRACE_MS) so a station spotted the evening before the
// opening already lands in the right city. Rovers carry no coordinates
// and are never placed — a rover's whereabouts is not something to invent.

const DEFAULT_GRACE_MS = 24 * 3600000;

function finite(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * @param {Array}  events  active event catalog (main.js activeEvents)
 * @param {string} call    spotted callsign (any case; CALL/suffix accepted)
 * @param {object} [opts]  { now?: Date|number, graceMs?: number }
 * @returns {null | {eventId, eventName, itemId, itemName, lat, lon, locationDesc}}
 */
function eventStationGeo(events, call, opts = {}) {
  const c = String(call || '').toUpperCase().trim();
  if (!c || !Array.isArray(events) || !events.length) return null;
  const now = opts.now != null ? +opts.now : Date.now();
  const grace = finite(opts.graceMs) ? opts.graceMs : DEFAULT_GRACE_MS;
  for (const ev of events) {
    if (!ev || !ev.id) continue;
    const board = ev.board || (ev.tracking && ev.tracking.type) || 'regions';
    if (board !== 'checklist') continue;
    const near = (ev.schedule || []).some((s) => {
      const start = new Date(s.start).getTime();
      const end = new Date(s.end).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && now >= start - grace && now <= end + grace;
    });
    if (!near) continue;
    const items = (ev.tracking && ev.tracking.items) || [];
    const item = items.find((it) => it && it.id &&
      (c === String(it.id).toUpperCase() || c.startsWith(String(it.id).toUpperCase() + '/')));
    if (!item) continue;
    if (!finite(item.lat) || !finite(item.lon)) return null; // rover: known station, unknown place
    const eventName = ev.name || ev.id;
    return {
      eventId: ev.id,
      eventName,
      itemId: item.id,
      itemName: item.name || '',
      lat: item.lat,
      lon: item.lon,
      locationDesc: item.name ? `${item.name} (${eventName})` : eventName,
    };
  }
  return null;
}

module.exports = { eventStationGeo, DEFAULT_GRACE_MS };
