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
  // contests (optional): the Contests catalog, so an undated contest station
  // takes its contest's next occurrence (contestWindowFor).
  function buildDxpeditionEntries(metadata, activity, nowMs, contests) {
    const out = [];
    const acts = activity || {};
    for (const [call, m] of Object.entries(metadata || {})) {
      if (!m || m.aliasOf) continue; // a bare call split from a slash form is not its own operation
      const sources = String(m.sources || '').split(',').filter(Boolean);
      const clublogOnly = sources.length === 1 && sources[0] === 'clublog';
      const a = acts[call] || null;
      const heardAt = a && a.lastSpottedAt ? Date.parse(a.lastSpottedAt) : null;
      const heardNow = !!(heardAt && nowMs - heardAt <= HEARD_LIVE_MS);
      const startD = m.startDate || null; const endD = m.endDate || m.startDate || null;
      let start = startD ? `${startD}T00:00:00Z` : null;
      let end = endD ? `${endD}T23:59:59Z` : null;
      // A contest station's own window can be the whole trip (NG3K lists JW5X with
      // the team's 7-12 Oct stay); the contest weekend is when it is on the air.
      const ownDays = start ? (Date.parse(end) - Date.parse(start)) / DAY_MS : null;
      const contestWin = m.kind === 'contest' && (!start || ownDays > 4) ? contestWindowFor(m.contest, contests, nowMs) : null;
      if (contestWin) { start = contestWin.start; end = contestWin.end; }
      if (end && Date.parse(end) < nowMs - ENDED_KEEP_MS && !heardNow) continue;
      // Club Log's list (uploaded logs in the last 7 days) is a "recently
      // active" signal with no dates; without it, an undated feed item that
      // nobody hears is only listed under "Show ended and unscheduled".
      const durationHours = start && end ? Math.round((Date.parse(end) - Date.parse(start) + 1000) / 3600000) : 0;
      out.push({
        id: `dxp:${call}`,
        name: call,
        sponsor: m.kind === 'contest'
          ? ['Contest station', m.contest || '', m.entity || ''].filter(Boolean).join(' · ') + (m.viaCall ? ` · contest call of ${m.viaCall}` : '')
          : (m.entity ? `DXpedition · ${m.entity}` : 'DXpedition') + (m.contest ? ` · also in ${m.contest}` : ''),
        category: m.kind === 'contest' ? 'contest-station' : 'dxpedition',
        start, end, durationHours,
        whenRule: contestWin ? `During ${contestWin.name}` : start ? '' : (clublogOnly ? 'Uploading logs to Club Log' : 'Dates not announced'),
        modes: splitList(m.modes),
        bands: splitList(m.bands),
        notes: [m.operators ? `By ${m.operators}` : '', m.qsl ? `QSL ${m.qsl}` : ''].filter(Boolean).join(' · '),
        dxp: {
          call, entity: m.entity || '', dates: m.dates || '', operators: m.operators || '', qsl: m.qsl || '',
          sources, link: m.link || '', clublogOnly, kind: m.kind === 'contest' ? 'contest' : 'dxpedition', contest: m.contest || '',
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

  // ── Contest station or DXpedition (Casey 2026-10-07: "There's a difference
  // between contest stations and DXpeditions and we need to make that clear and
  // label spots correctly"). The feed (DX-World, DXNews, NG3K) announces both.
  //   contest station  on the air for a contest: "will be active during the
  //                    CQWW CW contest", "Entry: SOAB", "Category: M/2", NG3K
  //                    "QRV for CQWW DX RTTY Contest" on a 2-day window, or the
  //                    contest call another announcement names ("... contest
  //                    as CQ3W", "Activity as JW5X during the ... Contest").
  //   DXpedition       everything else, including a DXpedition that ALSO enters
  //                    a contest ("Participation in the CQWW CW contest" during a
  //                    two-week stay) — that one keeps a contest note.
  const CONTEST_NAME_RE = /\b(CQ ?WW(?: DX)?(?: (?:SSB|CW|RTTY))?|CQ ?WPX(?: (?:SSB|CW|RTTY))?|WPX(?: (?:SSB|CW|RTTY))?|ARRL (?:International )?DX(?: (?:SSB|CW|Phone))?|ARRL 10[- ]?(?:m|Meter)|ARRL 160|IARU HF|WAE(?: DX)?(?: (?:SSB|CW|RTTY))?|Oceania DX(?: (?:SSB|CW))?|OCDX|Scandinavian Activity Contest(?: (?:SSB|CW))?|SSB Scandinavian Activity Contest|SAC (?:SSB|CW)|RDXC|Russian DX|JIDX|All Asian|IOTA Contest|Worked All Germany|WAG|Stew Perry|CQ 160|NAQP|Sweepstakes|King of Spain|PACC|UBA DX|HA DX|EU HF)\b/i;
  const CALLTOK = '([A-Z0-9]{1,4}\\/[A-Z0-9]{3,8}|[A-Z0-9]{3,8}(?:\\/[A-Z0-9]{1,4})?)';
  const CONTEST_AS_CALL = [
    new RegExp(`contest\\s+as\\s+${CALLTOK}`, 'gi'),
    new RegExp(`(?:activity|active|QRV)\\s+as\\s+${CALLTOK}\\s+(?:during|in|for)\\s+the\\s+[^.;]{0,60}?contest`, 'gi'),
  ];
  const CONTEST_PURPOSE = [
    /\b(?:will be|be|is|are)?\s*(?:active|QRV|on the air)\b[^.;]{0,90}\b(?:during|for|in)\s+the\s+[^.;]{0,60}?contest/i,
    /\bfor\s+the\s+[^.;]{0,50}?contest\b[^.;]{0,90}\bwill be active\b/i,
    /\brunning\s+the\s+[^.;]{0,60}?contest/i,
    /\bQRV\s+for\s+[^.;]{0,50}?contest/i,
    /\b(?:entry|category)\s*:\s*(?:SO|MO|M\/|M2|MS|SOAB|SOSB|MOST|MULTI|SINGLE)/i,
    /\b(?:SOAB|SOSB|SO2R|M\/S|M\/2|M\/M|MOST|SOAB\s+[HL]P)\b[^.;]{0,30}\b(?:entry\s+)?in\s+[^.;]{0,40}?contest/i,
  ];
  // A DXpedition that enters a contest on the side.
  const ALSO_CONTEST = /\b(?:participation|participate|participating)\s+in\s+the\b|\balso\s+(?:participate|be active in|enter)\b|\bholiday[- ]style\b|\bnon-contest\b|\bpre-contest\b/i;

  function contestName(text) {
    const m = CONTEST_NAME_RE.exec(String(text || ''));
    if (!m) return /\bcontest\b/i.test(String(text || '')) ? 'a contest' : null;
    return m[1].replace(/^CQ ?WW/i, 'CQ WW').replace(/^CQ ?WPX/i, 'CQ WPX').replace(/^SSB Scandinavian Activity Contest$/i, 'Scandinavian Activity Contest SSB').replace(/\s+/g, ' ');
  }

  function daysOf(w) {
    if (!w || !w.start) return null;
    return Math.round((Date.parse(w.end || w.start) - Date.parse(w.start)) / DAY_MS) + 1;
  }

  // records: feed records { call, title, description }.
  // → Map(CALL → { kind: 'contest'|'dxpedition', contest: name|null, viaCall?: CALL })
  //   including contest calls that only appear inside another announcement.
  function classifyOperations(records) {
    const out = new Map();
    const contestCalls = new Map(); // call → { contest, viaCall }
    for (const r of records || []) {
      if (!r || !r.call) continue;
      const text = `${r.title || ''} || ${r.description || ''}`;
      for (const re of CONTEST_AS_CALL) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(text))) {
          const c = m[1].toUpperCase();
          if (!/\d/.test(c) || !/[A-Z]/.test(c)) continue;
          if (!contestCalls.has(c)) contestCalls.set(c, { contest: contestName(text.slice(Math.max(0, m.index - 80), m.index + 120)) || contestName(text), viaCall: String(r.call).toUpperCase() });
        }
      }
    }
    for (const r of records || []) {
      if (!r || !r.call) continue;
      const call = String(r.call).toUpperCase();
      const text = `${r.title || ''} || ${r.description || ''}`;
      const name = contestName(text);
      let kind = 'dxpedition';
      if (contestCalls.has(call)) kind = 'contest';
      else if (name) {
        const days = daysOf(parseDxpDates(text));
        // "... contest as CQ3W" names ANOTHER call: this record is the DXpedition.
        const namesOther = [...contestCalls.values()].some((v) => v.viaCall === call);
        const purpose = CONTEST_PURPOSE.some((re) => re.test(text));
        const sideline = ALSO_CONTEST.test(text);
        if (!namesOther && purpose && !sideline) kind = 'contest';
        else if (!namesOther && purpose && sideline && days != null && days <= 4) kind = 'contest';
        else if (!namesOther && days != null && days <= 3 && !sideline) kind = 'contest';
      }
      out.set(call, { kind, contest: name });
    }
    for (const [c, v] of contestCalls) {
      const prev = out.get(c);
      out.set(c, { kind: 'contest', contest: (prev && prev.contest) || v.contest, viaCall: v.viaCall !== c ? v.viaCall : undefined });
    }
    return out;
  }

  // A contest station's announcement rarely carries dates ("during the CQWW SSB
  // contest"), but the Contests catalog knows when that contest runs. Name →
  // catalog ids (data/contests.json); the next occurrence counts only if it
  // starts within 120 days, so a station announced for this year's contest is
  // never moved to next year's.
  const CONTEST_IDS = [
    [/^CQ WW(?: DX)? SSB/i, ['cq-ww-ssb']], [/^CQ WW(?: DX)? CW/i, ['cq-ww-cw']], [/^CQ WW(?: DX)? RTTY/i, ['cq-ww-rtty']],
    [/^CQ WW/i, ['cq-ww-ssb', 'cq-ww-cw', 'cq-ww-rtty']],
    [/WPX SSB/i, ['cq-wpx-ssb']], [/WPX CW/i, ['cq-wpx-cw']], [/WPX RTTY/i, ['cq-wpx-rtty']], [/WPX/i, ['cq-wpx-ssb', 'cq-wpx-cw', 'cq-wpx-rtty']],
    [/Scandinavian Activity Contest SSB|SAC SSB/i, ['sac-ssb']], [/Scandinavian Activity Contest CW|SAC CW/i, ['sac-cw']],
    [/Scandinavian Activity Contest/i, ['sac-ssb', 'sac-cw']],
    [/Oceania DX SSB/i, ['oceania-dx-ssb']], [/Oceania DX CW/i, ['oceania-dx-cw']], [/Oceania|OCDX/i, ['oceania-dx-ssb', 'oceania-dx-cw']],
    [/Worked All Germany|^WAG$/i, ['wag']], [/IARU HF/i, ['iaru-hf-championship']], [/All Asian/i, ['all-asian-cw', 'all-asian-ssb']],
    [/IOTA Contest/i, ['iota']], [/Stew Perry/i, ['stew-perry']], [/CQ 160/i, ['cq-160-cw', 'cq-160-ssb']],
  ];
  const CATALOG_WINDOW_MS = 120 * DAY_MS;
  function contestWindowFor(name, contests, nowMs) {
    if (!name || !Array.isArray(contests)) return null;
    const hit = CONTEST_IDS.find(([re]) => re.test(name));
    if (!hit) return null;
    let best = null;
    for (const c of contests) {
      if (!c || !hit[1].includes(c.id) || !c.start || !c.end) continue;
      const s = Date.parse(c.start); const e = Date.parse(c.end);
      if (!(e > nowMs) || s - nowMs > CATALOG_WINDOW_MS) continue;
      if (!best || s < Date.parse(best.start)) best = c;
    }
    return best ? { start: best.start, end: best.end, id: best.id, name: best.name } : null;
  }

  // The feed lists an operator's HOME call beside the operation's slash call
  // ("FS/K0CD – St Martin" also yields a K0CD record). Labelled, K0CD's ordinary
  // spots from home would read DXP or CONTEST. A record is an alias when the
  // feed says so (aliasOf) or when it is the home part of a slash call from the
  // same announcement (same title or link). → Map(alias → parent call)
  function findAliases(records) {
    const out = new Map();
    const slashBy = new Map(); // home part → [records with that slash call]
    for (const r of records || []) {
      if (!r || !r.call) continue;
      const call = String(r.call).toUpperCase();
      if (r.aliasOf) out.set(call, String(r.aliasOf).toUpperCase());
      if (!call.includes('/')) continue;
      const home = call.split('/').filter((p) => /\d/.test(p) && /[A-Z]/.test(p) && p.length >= 3).sort((a, b) => b.length - a.length)[0];
      if (!home) continue;
      if (!slashBy.has(home)) slashBy.set(home, []);
      slashBy.get(home).push(r);
    }
    for (const r of records || []) {
      if (!r || !r.call) continue;
      const call = String(r.call).toUpperCase();
      if (call.includes('/') || out.has(call)) continue;
      const same = (slashBy.get(call) || []).find((s) => (r.title && s.title === r.title) || (r.link && s.link === r.link));
      if (same) out.set(call, String(same.call).toUpperCase());
    }
    return out;
  }

  return { parseDxpDates, buildDxpeditionEntries, dxpStatus, classifyOperations, contestName, contestWindowFor, findAliases, HEARD_LIVE_MS };
}));
