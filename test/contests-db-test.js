// Contest catalog + date-rule resolver (lib/contests-db.js, data/contests.json).
//
// Started with the POTA Support Your Parks fix (W7RTA 2026-07-14: a stale
// monthly-first-weekend rule showed Summer SYP on 2026-08-01 instead of
// Jul 18-19). Grew with the 2026-09-26 catalog audit: ten date rules were
// wrong (Texas QP showed LIVE a week after it ended), weekly events had
// the wrong day, two entries described events that no longer exist, and
// short monthly events jumped a year ahead for ~34 h after each session.
//
// Every sponsor date pinned below is from the sponsor's own publication:
// ARRL's six-year calendar (contests.arrl.org/calendar.php), the NCJ Sprint
// rules PDF, ssbsprint.com, UKEICC, hawaiiqsoparty.org, gaqsoparty.com, etc.
//
// Run: node test/contests-db-test.js
'use strict';

const db = require('../lib/contests-db');
const { resolveOccurrence, resolveOccurrences, resolveStartForYear, parseRule, validateCatalog, validateEntry } = db;
const catalog = require('../data/contests.json').contests;

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function iso(d) { return d ? d.toISOString().slice(0, 10) : String(d); }
function isoMin(d) { return d ? d.toISOString().slice(0, 16) + 'Z' : String(d); }
const get = (id) => catalog.find((c) => c.id === id);
const startFor = (id, year) => resolveStartForYear(get(id).whenComputed, year);
const DAY = 86400000;

console.log('nth-weekend-of resolver (POTA published SYP dates):');
{
  // POTA's own schedule (docs.pota.app / W7RTA's report): 3rd FULL weekend.
  check(iso(resolveStartForYear('nth-weekend-of:7:3', 2026)) === '2026-07-18', 'Summer 2026 = Jul 18');
  check(iso(resolveStartForYear('nth-weekend-of:10:3', 2026)) === '2026-10-17', 'Autumn 2026 = Oct 17');
  check(iso(resolveStartForYear('nth-weekend-of:1:3', 2027)) === '2027-01-16', 'Winter 2027 = Jan 16');
  check(iso(resolveStartForYear('nth-weekend-of:4:3', 2027)) === '2027-04-17', 'Spring 2027 = Apr 17');
  // Full-weekend subtlety: Oct 2026 has 5 Saturdays but Sat Oct 31's Sunday
  // is Nov 1 — only 4 FULL weekends, so "last" must be Oct 24, not Oct 31.
  check(iso(resolveStartForYear('nth-weekend-of:10:-1', 2026)) === '2026-10-24',
    'last FULL weekend of Oct 2026 = Oct 24 (Sat Oct 31 excluded — its Sunday is in November)');
  check(resolveStartForYear('nth-weekend-of:10:5', 2026) === null, '5th full weekend of Oct 2026 does not exist');
}

console.log('catalog shape (pota-plaque replaced by four seasonal entries):');
{
  check(!get('pota-plaque'), 'stale pota-plaque entry is gone');
  const syp = catalog.filter(c => c.id.startsWith('pota-syp-'));
  check(syp.length === 4, 'exactly four pota-syp-* entries');
  const rules = Object.fromEntries(syp.map(c => [c.id, c.whenComputed]));
  check(rules['pota-syp-winter'] === 'nth-weekend-of:1:3', 'winter rule');
  check(rules['pota-syp-spring'] === 'nth-weekend-of:4:3', 'spring rule');
  check(rules['pota-syp-summer'] === 'nth-weekend-of:7:3', 'summer rule');
  check(rules['pota-syp-autumn'] === 'nth-weekend-of:10:3', 'autumn rule');
  check(syp.every(c => c.durationHours === 48 && c.category === 'pota-sota'),
    'all four: 48h duration (Sat 0000Z through Sunday UTC), pota-sota category');
}

console.log('resolveOccurrence from the report date (now = 2026-07-14):');
{
  const now = new Date('2026-07-14T00:00:00Z');
  const summer = resolveOccurrence(get('pota-syp-summer'), now);
  check(iso(summer.start) === '2026-07-18' && summer.end.toISOString() === '2026-07-20T00:00:00.000Z',
    `summer resolves to Jul 18 (covers Sun) — was 2026-08-01 in the bug (got ${iso(summer.start)})`);
  check(iso(resolveOccurrence(get('pota-syp-autumn'), now).start) === '2026-10-17', 'autumn → Oct 17 2026');
  // Winter/Spring 2026 already passed — resolver must roll to 2027.
  check(iso(resolveOccurrence(get('pota-syp-winter'), now).start) === '2027-01-16', 'winter rolls over → Jan 16 2027');
  check(iso(resolveOccurrence(get('pota-syp-spring'), now).start) === '2027-04-17', 'spring rolls over → Apr 17 2027');
  // Mid-event: Saturday afternoon of the summer weekend must read as running.
  const during = resolveOccurrence(get('pota-syp-summer'), new Date('2026-07-18T18:00:00Z'));
  check(iso(during.start) === '2026-07-18', 'mid-weekend query still resolves the LIVE occurrence');
}

console.log('nth-weekday-of with a day offset (Route 66 On The Air = Saturday after Labor Day):');
{
  // Labor Day is the 1st Monday of September; the event opens the Saturday
  // AFTER it. `nth-weekend-of:9:2` reads a week LATE whenever September
  // opens on a Sunday or Monday (2024: Sep 14 vs the real Sep 7; 2025:
  // Sep 13 vs Sep 6) — the anchor has to be the holiday.
  check(iso(resolveStartForYear('nth-weekday-of:9:1:Mon+5', 2024)) === '2024-09-07', '2024 = Sep 7 (2nd weekend rule says Sep 14)');
  check(iso(resolveStartForYear('nth-weekday-of:9:1:Mon+5', 2025)) === '2025-09-06', '2025 = Sep 6 (2nd weekend rule says Sep 13)');
  check(iso(resolveStartForYear('nth-weekday-of:9:1:Mon+5', 2026)) === '2026-09-12', '2026 = Sep 12');
  check(iso(resolveStartForYear('nth-weekday-of:9:1:Mon+5', 2027)) === '2027-09-11', '2027 = Sep 11');
  check(iso(resolveStartForYear('nth-weekday-of:9:1:Mon', 2026)) === '2026-09-07', 'no offset still = Labor Day itself');
  check(iso(resolveStartForYear('nth-weekday-of:9:1:Mon-2', 2026)) === '2026-09-05', 'negative offset walks backwards');
  check(iso(resolveStartForYear('nth-weekday-of:11:4:Thu+1', 2026)) === '2026-11-27', 'Black Friday 2026 = Nov 27');
  check(resolveStartForYear('nth-weekday-of:9:1:Mon+', 2026) === null, 'a dangling sign is not a rule');

  const card = get('route-66-ota');
  check(card && card.whenComputed === 'nth-weekday-of:9:1:Mon+5', 'catalog card uses the offset verb (was custom:, which resolves to nothing)');
  const live = resolveOccurrence(card, new Date('2026-09-12T15:00:00Z'));
  check(live && iso(live.start) === '2026-09-12' && live.end.toISOString() === '2026-09-21T00:00:00.000Z',
    `opening day resolves the LIVE 9-day occurrence (got ${live && iso(live.start)})`);
  check(iso(resolveOccurrence(card, new Date('2026-09-25T00:00:00Z')).start) === '2027-09-11',
    'after the event it rolls to 2027 = Sep 11');
}

// ---------------------------------------------------------------------------
console.log('catalog validation (the same check the feed job refuses to publish without):');
{
  const errs = validateCatalog(catalog);
  check(errs.length === 0, `validateCatalog: no errors${errs.length ? ' — ' + JSON.stringify(errs.slice(0, 5)) : ''}`);
  const ids = catalog.map((c) => c.id);
  check(new Set(ids).size === ids.length, `ids are unique (${ids.length} entries)`);
  check(catalog.every((c) => /^https?:\/\//.test(c.website) && /^https?:\/\//.test(c.rulesUrl)), 'every website/rulesUrl is http(s)');
  check(catalog.every((c) => db.KNOWN_CATEGORIES.includes(c.category)), 'every category is a known one');
  check(catalog.every((c) => parseRule(c.whenComputed)), 'every whenComputed parses');
  check(catalog.every((c) => (parseRule(c.whenComputed).kind === 'custom' && c.durationHours == null) || c.durationHours > 0),
    'every durationHours > 0 (null allowed only on custom: rules)');
  check(catalog.every((c) => !/flspota\.org/i.test(c.website + c.rulesUrl)), 'no flspota.org (lapsed domain, now a spam redirect)');

  // The validator itself catches what it claims to.
  const good = { ...get('cq-ww-ssb') };
  check(validateEntry(good).length === 0, 'a good entry validates');
  check(validateEntry({ ...good, category: 'party' }).some((e) => /category/.test(e)), 'unknown category rejected');
  check(validateEntry({ ...good, rulesUrl: 'ftp://x' }).some((e) => /rulesUrl/.test(e)), 'non-http rulesUrl rejected');
  check(validateEntry({ ...good, whenComputed: 'nth-weekend-of:10' }).some((e) => /unparseable/.test(e)), 'bad rule rejected');
  check(validateEntry({ ...good, durationHours: 0 }).some((e) => /durationHours/.test(e)), 'zero duration rejected');
  check(validateEntry({ ...good, explicitWindows: [{ start: '2027-01-01T00:00Z', end: '2027-01-02T00:00Z' }] })
    .some((e) => /explicitWindows needs a custom/.test(e)), 'explicitWindows beside a real rule rejected (history would lose the rule)');
  check(validateEntry({ ...good, whenComputed: 'custom:x', explicitWindows: [{ start: 'soon', end: 'later' }] })
    .some((e) => /ISO pairs/.test(e)), 'malformed explicitWindows rejected');
  check(validateCatalog([good, good]).some((e) => e.errors.includes('duplicate id')), 'duplicate id rejected');
}

console.log('every rule resolves within the feed horizon (400 days from 2026-09-26):');
{
  const from = new Date('2026-09-26T00:00:00Z');
  const to = new Date(from.getTime() + 400 * DAY);
  const dead = catalog.filter((c) => parseRule(c.whenComputed).kind !== 'custom')
    .filter((c) => resolveOccurrences(c, from, to).length === 0).map((c) => c.id);
  check(dead.length === 0, `every non-custom rule has an occurrence${dead.length ? ' — none for ' + dead.join(', ') : ''}`);
  const windowed = catalog.filter((c) => c.explicitWindows);
  check(windowed.length >= 3 && windowed.every((c) => parseRule(c.whenComputed).kind === 'custom'),
    'explicitWindows appear only on custom: rules');
}

// ---------------------------------------------------------------------------
console.log('sponsor dates for the entries fixed 2026-09-26:');
{
  const at = (id, year) => isoMin(startFor(id, year));
  // Texas: "third weekend (Sat and Sun) in September" — the catalog said the
  // last full weekend and showed TXQP LIVE on Sep 26, a week after it ended.
  check(at('tx-qso-party', 2026) === '2026-09-19T14:00Z', 'Texas QP 2026 = Sep 19 1400z (was Sep 26)');
  check(resolveOccurrence(get('tx-qso-party'), new Date('2026-09-26T15:00:00Z')).start.getUTCFullYear() === 2027,
    'Texas QP is NOT live on 2026-09-26');
  check(at('ny-qso-party', 2026) === '2026-10-17T14:00Z', 'New York QP 2026 = Oct 17 1400z (third Saturday; was Oct 10)');
  check(at('ga-qso-party', 2027) === '2027-04-10T18:00Z', 'Georgia QP 2027 = Apr 10 (gaqsoparty.com: 2nd weekend of April)');
  check(at('winter-field-day', 2027) === '2027-01-23T16:00Z', 'Winter Field Day 2027 = Jan 23 (4th full weekend; last full weekend would be Jan 30)');
  check(at('uba-ssb', 2027) === '2027-01-30T13:00Z', 'UBA SSB 2027 = last Saturday of January (was November)');
  check(at('uba-ssb', 2026) === '2026-01-31T13:00Z', 'UBA SSB 2026 = Jan 31, a Saturday whose Sunday is in February');
  check(at('uba-cw', 2027) === '2027-02-27T13:00Z', 'UBA CW 2027 = last Saturday of February (was January)');
  check(at('ham-king-of-spain-cw', 2027) === '2027-05-15T12:00Z', 'King of Spain CW 2027 = May 15 (3rd full weekend of May; was February)');
  check(at('ham-king-of-spain-ssb', 2026) === '2026-06-27T12:00Z', 'King of Spain SSB 2026 = Jun 27 (4th full weekend of June)');
  check(at('ham-king-of-spain-ssb', 2030) === '2030-06-22T12:00Z', 'King of Spain SSB 2030 = Jun 22 — the 4th, not the last (Jun 29)');
  check(at('hi-qso-party', 2027) === '2027-08-21T16:00Z', 'Hawaii QP 2027 = Aug 21 (hawaiiqsoparty.org; second-to-last full weekend)');
  check(at('hi-qso-party', 2026) === '2026-08-22T16:00Z', 'Hawaii QP 2026 = Aug 22');
  check(at('qrp-arci-spring', 2027) === '2027-04-10T00:00Z', 'QRP ARCI Spring 2027 = 2nd Saturday of April');
  // NCJ Sprint rules PDF: CW Feb 8 2026, Sep 13 2026 (Saturday evening US).
  check(at('na-sprint-cw-feb', 2026) === '2026-02-08T00:00Z', 'NA Sprint CW Feb 2026 = Feb 8 0000z (was Feb 1)');
  check(at('na-sprint-cw-feb', 2027) === '2027-02-07T00:00Z', 'NA Sprint CW Feb 2027 = Feb 7');
  check(at('na-sprint-cw-sep', 2026) === '2026-09-13T00:00Z', 'NA Sprint CW Sep 2026 = Sep 13');
  check(at('naqp-rtty-summer', 2026) === '2026-07-18T18:00Z', 'NAQP RTTY summer 2026 = Jul 18 (NCJ: 3rd full weekend of July; was last Saturday)');
  // ssbsprint.com publishes both dates.
  const ssbNow = new Date('2026-09-26T00:00:00Z');
  check(isoMin(resolveOccurrence(get('na-sprint-ssb-fall'), ssbNow).start) === '2026-11-01T00:00Z', 'NA SSB Sprint fall = 2026-11-01 0000z');
  check(isoMin(resolveOccurrence(get('na-sprint-ssb-mar'), ssbNow).start) === '2027-03-21T00:00Z', 'NA SSB Sprint spring = 2027-03-21 0000z');
  check(isoMin(resolveOccurrence(get('ukei-dx-ssb'), ssbNow).start) === '2026-10-31T12:00Z', 'UK/EI DX SSB = 2026-10-31 (UKEICC-published, no rule)');
  check(!get('arrl-uhf') && get('arrl-222-up'), 'retired ARRL UHF Contest replaced by the 222 MHz & Up Distance Contest');
  check(!get('ag-cw-qso-party') && get('agcw-htp-80') && get('agcw-htp-40') && get('agcw-hny'),
    'non-existent AGCW QSO Party replaced by the real AGCW events');
  check(!get('phone-fray').rulesUrl.includes('perluna'), 'Phone Fray off the dead perluna.com domain');
}

console.log('ARRL\'s own six-year calendar (contests.arrl.org/calendar.php):');
{
  const years = [2026, 2027, 2028, 2029, 2030, 2031];
  const cal = {
    'arrl-dx-cw': ['02-21', '02-20', '02-19', '02-17', '02-16', '02-15'],
    'arrl-dx-ssb': ['03-07', '03-06', '03-04', '03-03', '03-02', '03-01'],
    'arrl-ss-cw': ['11-07', '11-06', '11-04', '11-03', '11-02', '11-01'],
    'arrl-ss-ssb': ['11-21', '11-20', '11-18', '11-17', '11-16', '11-15'],
    'arrl-10m': ['12-12', '12-11', '12-09', '12-08', '12-14', '12-13'],
    'arrl-160m': ['12-04', '12-03', '12-01', '11-30', '12-06', '12-05'],
    'arrl-222-up': ['08-01', '08-07', '08-05', '08-04', '08-03', '08-02'],
    'arrl-digital': ['06-06', '06-05', '06-03', '06-02', '06-01', '06-07'],
    'arrl-field-day': ['06-27', '06-26', '06-24', '06-23', '06-22', '06-28'],
    'iaru-hf-championship': ['07-11', '07-10', '07-08', '07-14', '07-13', '07-12'],
    'arrl-jan-vhf': ['01-17', '01-16', '01-15', '01-20', '01-19', '01-18'],
    'arrl-june-vhf': ['06-13', '06-12', '06-10', '06-09', '06-08', '06-14'],
    'arrl-sep-vhf': ['09-12', '09-11', '09-09', '09-08', '09-14', '09-13'],
    'arrl-kids-day-jan': ['01-03', '01-02', '01-08', '01-06', '01-05', '01-04'],
    'arrl-kids-day-jun': ['06-20', '06-19', '06-17', '06-16', '06-15', '06-21'],
    'arrl-rookie-cw': ['12-20', '12-19', '12-17', '12-16', '12-22', '12-21'],
    'arrl-rookie-rtty': ['08-16', '08-22', '08-20', '08-19', '08-18', '08-17'],
    'arrl-rookie-ssb': ['04-19', '04-18', '04-09', '04-22', '04-14', '04-20'],
    'arrl-rtty-roundup': ['01-03', '01-02', '01-08', '01-06', '01-05', '01-04'],
    'arrl-scr-feb': ['02-09', '02-08', '02-14', '02-12', '02-11', '02-10'],
    'arrl-scr-oct': ['10-19', '10-18', '10-16', '10-15', '10-21', '10-20'],
    'arrl-skn': ['01-01', '01-01', '01-01', '01-01', '01-01', '01-01'],
    'arrl-10ghz-aug': ['08-15', '08-21', '08-19', '08-18', '08-17', '08-16'],
    'arrl-10ghz-sep': ['09-19', '09-18', '09-16', '09-15', '09-21', '09-20'],
  };
  for (const [id, dates] of Object.entries(cal)) {
    const got = years.map((y) => iso(startFor(id, y)).slice(5));
    const want = dates;
    check(got.join() === want.join(), `${id}: ${want.join(' ')}${got.join() === want.join() ? '' : '  (got ' + got.join(' ') + ')'}`);
  }
  check(isoMin(startFor('arrl-160m', 2029)) === '2029-11-30T22:00Z', 'ARRL 160 opens 2200z FRIDAY (Nov 30 2029, before Sat Dec 1)');
  check(isoMin(startFor('arrl-rookie-ssb', 2028)) === '2028-04-09T18:00Z', 'Rookie SSB 2028 steps aside for Easter (;2028=04-09 override keeps its 1800z)');
}

console.log('the new DSL forms:');
{
  const r = (rule, year) => isoMin(resolveStartForYear(rule, year));
  // n = -2: second-to-last full weekend (LZ DX, Hawaii QP).
  check(r('nth-weekend-of:11:-2', 2026) === '2026-11-21T00:00Z', 'nth-weekend-of:11:-2 → Nov 21 2026 (LZ DX)');
  check(r('nth-weekday-of:5:-2:Sun', 2026) === '2026-05-24T00:00Z', 'nth-weekday-of:5:-2:Sun → second-to-last Sunday');
  check(resolveStartForYear('nth-weekend-of:2:-5', 2026) === null, 'n beyond the month is null, not a wrap-around');
  // Day of the weekend.
  check(r('nth-weekend-of:10:3:Sun:1700z', 2026) === '2026-10-18T17:00Z', ':Sun = Sunday of the 3rd full weekend (Illinois QP Oct 18)');
  check(r('nth-weekend-of:12:3:Sat', 2026) === '2026-12-19T00:00Z', ':Sat = Saturday only (OK DX RTTY)');
  check(r('nth-weekend-of:1:-1:Sat-1:2200z', 2027) === '2027-01-29T22:00Z', ':Sat-1 = the Friday before (CQ 160 CW 2027)');
  // Anchored to a calendar date.
  check(r('weekday-nearest:09-27:Sat', 2026) === '2026-09-26T00:00Z', 'weekday-nearest: Sep 27 2026 is a Sunday → Sat Sep 26 (ROTA 2026, sponsor-confirmed)');
  check(r('weekday-nearest:09-27:Sat', 2024) === '2024-09-28T00:00Z', 'weekday-nearest: Friday Sep 27 2024 → Sat Sep 28');
  check(r('weekday-nearest:08-15:Sat:0300z', 2027) === '2027-08-14T03:00Z', 'weekday-nearest: WIA Remembrance Day 2027 = Aug 14 (sponsor: "14th & 15th August 2027")');
  check(r('weekday-nearest:04-25:Sat', 2029) === '2029-04-28T00:00Z', 'weekday-nearest: Wednesday → the following Saturday (3 days, not 4 back)');
  check(r('weekday-on-or-after:01-02:Sat', 2028) === '2028-01-08T00:00Z', 'weekday-on-or-after: skips a New Year\'s Day Saturday (Kids Day / RTTY RU 2028)');
  check(r('weekday-on-or-after:08-08:Sat', 2026) === '2026-08-08T00:00Z', 'weekday-on-or-after: NLLW 2026 = Aug 8-9 (arlhs.com)');
  check(r('weekday-on-or-before:06-20:Sat', 2026) === '2026-06-20T00:00Z', 'weekday-on-or-before: Jun 20 2026 is a Saturday → itself (WV QP)');
  check(r('weekday-on-or-before:06-20:Sat', 2027) === '2027-06-19T00:00Z', 'weekday-on-or-before: Sunday Jun 20 2027 → Sat Jun 19');
  check(r('nth-weekday-of:2:1:Sat+22:1500z', 2027) === '2027-02-28T15:00Z', 'offset + time: NC QP 2027 = Feb 28 1500z');
  // Year bound.
  const a250 = get('arrl-america250-was');
  check(a250.whenComputed === 'range:01-01:12-31@2026', 'America250 WAS is bounded to 2026');
  check(iso(resolveOccurrence(a250, new Date('2026-09-26T00:00:00Z')).start) === '2026-01-01', 'America250 is live in 2026');
  check(resolveOccurrence(a250, new Date('2027-01-01T00:00:01Z')).start === null, 'America250 resolves to nothing after 2026');
  check(resolveStartForYear(a250.whenComputed, 2027) === null && iso(resolveStartForYear(a250.whenComputed, 2026)) === '2026-01-01',
    'resolveStartForYear honours the bound (contest history never builds a 2027 window)');
  check(iso(resolveStartForYear('fixed:04-18@2026-2027', 2027)) === '2027-04-18' && resolveStartForYear('fixed:04-18@2026-2027', 2028) === null,
    '@YYYY-YYYY range bound');
  check(resolveOccurrences({ whenComputed: 'weekly:Wed:1300z@2026', durationHours: 1 },
    new Date('2026-12-20T00:00:00Z'), new Date('2027-01-20T00:00:00Z')).every((o) => o.start.getUTCFullYear() === 2026),
  'a year bound also cuts off a weekly rule');
  // Per-year override.
  check(r('nth-weekend-of:4:3:Sun:1800z;2028=04-09;2030=04-14', 2029) === '2029-04-22T18:00Z', 'override leaves other years on the rule');
  check(r('nth-weekend-of:4:3:Sun:1800z;2028=04-09;2030=04-14', 2030) === '2030-04-14T18:00Z', 'override applies with the rule\'s start time');
  // Grammar edges.
  check(YEAR_BOUND(), 'YEAR_BOUND_RULE_RE covers every annual form and no recurring one');
  for (const bad of ['weekly:Wed:2500z', 'fixed:13-01', 'nth-weekend-of:4:3;2028=4-9', 'weekly:Wed:1300z;2027=01-01',
    'monthly-nth:3:Sun;2027=01-01', 'fixed:04-18@2027-2026', 'nth-weekend-of:4:3:Mon', 'weekday-nearest:9-27:Sat',
    'nth-weekday-of:4:3:Sun:2460z', 'weekly:', '']) {
    check(parseRule(bad) === null, `rejects "${bad}"`);
  }
  check(parseRule('custom:anything').kind === 'custom', 'custom: parses as custom');
}
function YEAR_BOUND() {
  const annual = ['nth-weekend-of:1:1', 'nth-weekday-of:1:1:Sat', 'weekday-nearest:01-01:Sat', 'weekday-on-or-after:01-01:Sat',
    'weekday-on-or-before:01-01:Sat', 'fixed:01-01', 'range:01-01:01-02'];
  const recurring = ['weekly:Wed:1300z', 'monthly-nth:1:Sat', 'monthly-first-weekend', 'custom:x'];
  return annual.every((x) => db.YEAR_BOUND_RULE_RE.test(x) && parseRule(x).kind === 'annual')
    && recurring.every((x) => !db.YEAR_BOUND_RULE_RE.test(x) && resolveStartForYear(x, 2026) === null);
}

console.log('multi-session weekly (CWT, K1USN SST):');
{
  const cwt = get('cwt-mini');
  const from = new Date('2026-09-26T00:00:00Z');
  const occ = resolveOccurrences(cwt, from, new Date(from.getTime() + 7 * DAY));
  check(occ.map((o) => isoMin(o.start)).join() === '2026-09-30T13:00Z,2026-09-30T19:00Z,2026-10-01T03:00Z,2026-10-01T07:00Z',
    'CWT: all four weekly sessions, in order');
  check(occ.every((o) => o.end - o.start === 3600000), 'each session is its own 1-hour occurrence');
  const sst = get('k1usn-sst');
  check(resolveOccurrences(sst, from, new Date(from.getTime() + 7 * DAY)).map((o) => isoMin(o.start)).join()
    === '2026-09-28T00:00Z,2026-10-02T20:00Z', 'SST: Monday 0000z and Friday 2000z (was Sunday 2000z)');
  // A session in progress is LIVE, not "next week" (the old weekly resolver
  // only ever looked forward, so a running CWT never showed as live).
  const mid = resolveOccurrence(cwt, new Date('2026-09-30T13:30:00Z'));
  check(isoMin(mid.start) === '2026-09-30T13:00Z', 'mid-session CWT resolves the running session');
  check(isoMin(resolveOccurrence(cwt, new Date('2026-09-30T14:00:00Z')).start) === '2026-09-30T13:00Z',
    'at the exact end instant the session still counts (end >= now, as before)');
  check(isoMin(resolveOccurrence(cwt, new Date('2026-09-30T14:00:01Z')).start) === '2026-09-30T19:00Z', 'after it ends: the 1900z session');
}

console.log('resolveOccurrences windowing (the feed job\'s horizons):');
{
  const from = new Date('2026-09-26T00:00:00Z');
  const to60 = new Date(from.getTime() + 60 * DAY);
  const wrt = resolveOccurrences(get('wrt'), from, to60);
  check(wrt.length >= 8 && wrt.length <= 9, `a weekly event inside 60 days: ${wrt.length} occurrences`);
  const cwt60 = resolveOccurrences(get('cwt-mini'), from, to60);
  check(cwt60.length >= 32 && cwt60.length <= 36, `a four-session weekly event returns every session (${cwt60.length} in 60 days)`);
  const sorted = (a) => a.every((o, i) => !i || a[i - 1].start <= o.start);
  check(sorted(resolveOccurrences(get('cwt-mini'), from, to60)), 'sorted by start');
  const annual = resolveOccurrences(get('cq-ww-ssb'), from, new Date(from.getTime() + 400 * DAY));
  check(annual.map((o) => iso(o.start)).join() === '2026-10-24,2027-10-30', 'annual rule over 400 days: this year and next');
  const since = resolveOccurrences(get('tx-qso-party'), new Date('2026-09-20T12:00:00Z'), to60);
  check(since.length === 1 && iso(since[0].start) === '2026-09-19', 'an occurrence still running at `from` is included (end after from)');
  check(resolveOccurrences(get('tx-qso-party'), new Date('2026-09-21T00:00:00Z'), to60).length === 0, 'one that ended before `from` is not');
  check(resolveOccurrences(get('sota-eu-hf-cw'), from, to60).length === 0, 'custom: with no windows → []');
  const cc = resolveOccurrences(get('chasing-cornwallis'), from, to60);
  check(cc.map((o) => iso(o.start)).join() === '2026-10-06,2026-10-18', 'explicitWindows: every announced window in the horizon (K4M, K4Y)');
  check(resolveOccurrences(get('chasing-cornwallis'), new Date('2026-10-12T00:00:00Z'), to60).length === 1, 'explicitWindows: past windows drop out');
  const monthly = resolveOccurrences(get('skcc-wes'), from, to60);
  check(monthly.map((o) => iso(o.start)).join() === '2026-10-10,2026-11-14', 'monthly-nth over 60 days');
}

console.log('monthly rules never jump a year after a short session (coordinator regression 2026-09-26):');
{
  // Old resolver: the monthly branch accepted a start up to 36 h in the past;
  // if that session had already ENDED, the next-year retry returned the same
  // month a year out — the Contests view showed RFTB as 2027-09-19 for ~34 h
  // after every short monthly event.
  // The exact reported case, with RFTB's rule as it stood on master
  // (`monthly-nth:3:Sun`, 0000z start, 2 h): 0600z Sep 20 is after the session.
  const oldRftb = { whenComputed: 'monthly-nth:3:Sun', durationHours: 2 };
  const reported = resolveOccurrence(oldRftb, new Date('2026-09-20T06:00:00Z'));
  check(isoMin(reported.start) === '2026-10-18T00:00Z', `reported case: 2026-09-20T06:00Z → Oct 18 2026, not 2027-09-19 (got ${isoMin(reported.start)})`);
  // The catalog entry now starts at 2300z Sunday (7 pm Eastern), so the same
  // instant is BEFORE that day's session — and the day after, it is October.
  const rftb = get('run-for-the-bacon');
  check(isoMin(resolveOccurrence(rftb, new Date('2026-09-20T06:00:00Z')).start) === '2026-09-20T23:00Z',
    'catalog RFTB at 0600z Sep 20 → that evening\'s 2300z session');
  const next = resolveOccurrence(rftb, new Date('2026-09-21T06:00:00Z'));
  check(isoMin(next.start) === '2026-10-18T23:00Z', `catalog RFTB after the Sep session → Oct 18 2026 2300z (got ${isoMin(next.start)})`);
  const live = resolveOccurrence(rftb, new Date('2026-09-21T00:30:00Z'));
  check(isoMin(live.start) === '2026-09-20T23:00Z', 'RFTB mid-session (Mon 0030z) is the LIVE September session');
  const mfw = { whenComputed: 'monthly-first-weekend', durationHours: 2 };
  const after = resolveOccurrence(mfw, new Date('2026-10-04T06:00:00Z'));
  check(iso(after.start) === '2026-11-07', `monthly-first-weekend queried a day after a short Oct session → Nov 7 2026 (got ${iso(after.start)})`);
  check(iso(resolveOccurrence({ whenComputed: 'monthly-first-weekend', durationHours: 48 }, new Date('2026-10-04T06:00:00Z')).start) === '2026-10-03',
    'monthly-first-weekend mid-weekend → the running October weekend');
  check(iso(resolveOccurrence({ whenComputed: 'monthly-nth:-1:Wed', durationHours: 2 }, new Date('2026-12-31T00:00:00Z')).start) === '2027-01-27',
    'monthly rule across the year boundary → next January, not next December');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
