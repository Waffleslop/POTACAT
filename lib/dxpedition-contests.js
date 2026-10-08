'use strict';
// DXpeditions for the Contests view (Casey 2026-10-07: "add to the Contest
// page the DXpeditions that are live and upcoming"). Pure and dual-mode:
// main uses parseDxpDates() when it summarizes the feed, the renderer uses
// buildDxpeditionEntries() through window.DxpContests. test/dxpedition-contests-test.js.
//
// Dates: the feed (dxpeditions.potacat.com) declares start/end but leaves them
// null as of 2026-10-07, so the NG3K date text is parsed:
//   "Oct 30-Nov 5, 2026"   "Jan 8-14, 2027"   "Oct 9, 2026"
//   "Dec 28, 2026-Jan 4, 2027"   "Dec 28-Jan 4, 2027" (start in the prior year)
// DX-World prose ("on October 9 and ... October 11") is not guessed at: those
// operations show as "dates not announced" unless they are heard on the air.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DxpContests = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HEARD_LIVE_MS = 2 * 60 * 60 * 1000;   // spotted in the last 2 h = on the air now
  const ENDED_KEEP_MS = 14 * DAY_MS;          // ended operations stay listed (under "Show ended") for 2 weeks

  function iso(y, m, d) {
    const dt = new Date(Date.UTC(y, m, d));
    if (dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null; // Feb 30 etc.
    return dt.toISOString().slice(0, 10);
  }
  function mon(s) { return MONTHS[String(s || '').slice(0, 3).toLowerCase()]; }

  // → { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } or null
  function parseDxpDates(text) {
    const t = String(text || '');
    const M = '([A-Z][a-z]{2,8})';
    let m;
    // "Dec 28, 2026-Jan 4, 2027"
    if ((m = new RegExp(`${M}\\s+(\\d{1,2}),\\s*(\\d{4})\\s*[-–]\\s*${M}\\s+(\\d{1,2}),\\s*(\\d{4})`).exec(t))) {
      const a = iso(+m[3], mon(m[1]), +m[2]); const b = iso(+m[6], mon(m[4]), +m[5]);
      return a && b && a <= b ? { start: a, end: b } : null;
    }
    // "Oct 30-Nov 5, 2026" (and "Dec 28-Jan 4, 2027": start in the prior year)
    if ((m = new RegExp(`${M}\\s+(\\d{1,2})\\s*[-–]\\s*${M}\\s+(\\d{1,2}),?\\s*(\\d{4})`).exec(t))) {
      const y = +m[5]; const ma = mon(m[1]); const mb = mon(m[3]);
      if (ma == null || mb == null) return null;
      const a = iso(ma > mb ? y - 1 : y, ma, +m[2]); const b = iso(y, mb, +m[4]);
      return a && b ? { start: a, end: b } : null;
    }
    // "Jan 8-14, 2027"
    if ((m = new RegExp(`${M}\\s+(\\d{1,2})\\s*[-–]\\s*(\\d{1,2}),?\\s*(\\d{4})`).exec(t))) {
      const mm = mon(m[1]); if (mm == null) return null;
      const a = iso(+m[4], mm, +m[2]); const b = iso(+m[4], mm, +m[3]);
      return a && b && a <= b ? { start: a, end: b } : null;
    }
    // "Oct 9, 2026"
    if ((m = new RegExp(`${M}\\s+(\\d{1,2}),\\s*(\\d{4})`).exec(t))) {
      const mm = mon(m[1]); if (mm == null) return null;
      const a = iso(+m[3], mm, +m[2]);
      return a ? { start: a, end: a } : null;
    }
    return null;
  }

  function splitList(s) {
    if (Array.isArray(s)) return s.filter(Boolean).map(String);
    return String(s || '').split(/[\s,/]+/).map((x) => x.trim()).filter(Boolean);
  }

  // metadata: { CALL: { entity, dates, startDate, endDate, operators, bands,
  //                     modes, qsl, sources, link } }  (main's expeditionMeta)
  // activity: { CALL: { lastSpottedAt, lastBand, lastMode, count24h } }
  //           (api.potacat.com/v1/dxpeditions/spots.json; may be empty)
  // → contest-shaped rows; `dxp` carries what the row/drawer need.
  function buildDxpeditionEntries(metadata, activity, nowMs) {
    const out = [];
    const acts = activity || {};
    for (const [call, m] of Object.entries(metadata || {})) {
      if (!m) continue;
      const sources = String(m.sources || '').split(',').filter(Boolean);
      const clublogOnly = sources.length === 1 && sources[0] === 'clublog';
      const a = acts[call] || null;
      const heardAt = a && a.lastSpottedAt ? Date.parse(a.lastSpottedAt) : null;
      const heardNow = !!(heardAt && nowMs - heardAt <= HEARD_LIVE_MS);
      const startD = m.startDate || null; const endD = m.endDate || m.startDate || null;
      const start = startD ? `${startD}T00:00:00Z` : null;
      const end = endD ? `${endD}T23:59:59Z` : null;
      if (end && Date.parse(end) < nowMs - ENDED_KEEP_MS && !heardNow) continue;
      // Club Log's list (uploaded logs in the last 7 days) is a "recently
      // active" signal with no dates; without it, an undated feed item that
      // nobody hears is only listed under "Show ended and unscheduled".
      const durationHours = start && end ? Math.round((Date.parse(end) - Date.parse(start) + 1000) / 3600000) : 0;
      out.push({
        id: `dxp:${call}`,
        name: call,
        sponsor: m.entity ? `DXpedition · ${m.entity}` : 'DXpedition',
        category: 'dxpedition',
        start, end, durationHours,
        whenRule: start ? '' : (clublogOnly ? 'Uploading logs to Club Log' : 'Dates not announced'),
        modes: splitList(m.modes),
        bands: splitList(m.bands),
        notes: [m.operators ? `By ${m.operators}` : '', m.qsl ? `QSL ${m.qsl}` : ''].filter(Boolean).join(' · '),
        dxp: {
          call, entity: m.entity || '', dates: m.dates || '', operators: m.operators || '', qsl: m.qsl || '',
          sources, link: m.link || '', clublogOnly,
          heard: heardAt ? { at: heardAt, band: a.lastBand || null, mode: a.lastMode || null, count24h: a.count24h || 0 } : null,
          heardNow,
        },
      });
    }
    return out;
  }

  // Status for a DXpedition row: the contest status from its dates, promoted
  // to live when the call is being spotted now, or when Club Log says it is
  // active and there are no dates. `base` is the renderer's contest status.
  function dxpStatus(entry, base, nowMs) {
    const d = entry.dxp || {};
    if (d.heardNow) return { ...base, kind: 'live', label: 'on air', dxpLabel: 'on air' };
    if (base.kind === 'live') return { ...base, dxpLabel: 'running' };
    if (!entry.start && d.clublogOnly) return { kind: 'live', label: 'active', dxpLabel: 'active', start: null, end: null };
    return base;
  }

  return { parseDxpDates, buildDxpeditionEntries, dxpStatus, HEARD_LIVE_MS };
}));
