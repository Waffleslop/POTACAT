// potacat-dxpeditions — Cloudflare Worker
//
// Aggregates active / upcoming DXpeditions from public sources and serves
// a single canonical feed that POTACAT desktop clients can subscribe to.
//
// v2 sources (each scraped independently every 6h):
//   - DX-World RSS  (https://dx-world.net/feed/)
//   - DXNews RSS    (https://dxnews.com/rss.xml)
//   - NG3K ADXO RSS (https://www.ng3k.com/adxo.xml)
//
// Each source is wrapped in its own try/catch so a single outage / parse
// regression can't take the cron down. KV state tracks per-source
// lastFetchedAt / lastError / lastCount; /healthz surfaces them.
//
// HTTP handler reads from KV only — never blocks on a live fetch, so
// source outages translate to stale records, not 5xx responses.
//
// Endpoints:
//   GET /feeds/dxpeditions.xml   — custom XML schema (see toXml below)
//   GET /feeds/dxpeditions.json  — same data, JSON. Desktop client target.
//   GET /healthz                 — top-level + per-source state
//
// CORS: open (`*`). Output is public DXpedition info; no auth needed.

import {
  isBareCall, parseNg3kItem, parseArticle, extractArticle, combineDetails,
} from './details.js';

const KV_KEY = 'feed:v1';
const SCHEMA_VERSION = '1';
const FEED_TTL_DAYS = 60; // drop records this many days after first seen
const USER_AGENT = 'POTACAT-DXpeditions/1.0 (+https://potacat.com)';

// Words that look like callsigns but aren't. RSS titles tend to include
// expedition codenames like "AS-104" (IOTA) or "EU-013" — filter out.
const BLOCKLIST = new Set([
  'IOTA', 'SOTA', 'POTA', 'WWFF', 'DXCC', 'CQWW', 'DXing', 'IARU',
  'ITU', 'WPX', 'ARRL', 'YOTA', 'OQRS', 'LOTW', 'EQSL', 'OPDX', 'TDDX',
]);

// Article pages fetched per cron run (new posts first, then backfill of
// records stored before structured details existed). One fetch serves every
// call in a multi-call post.
const ARTICLE_FETCH_BUDGET = 30;
const ARTICLE_MAX_TRIES = 3;

// ---------- Generic RSS parser ----------

async function fetchUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml,text/xml,*/*' },
    cf: { cacheTtl: 60 }, // dedupe back-to-back cron + edge-request traffic
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  // Bot walls answer 2xx with an HTML page (DX-World's host serves a
  // SiteGround captcha with HTTP 202 to Cloudflare egress IPs). Without
  // this check that parses as "0 items" and looks like a quiet news day.
  if (!/<rss\b|<feed\b|<rdf:RDF\b/i.test(body.slice(0, 2000))) {
    const ct = res.headers.get('content-type') || '?';
    throw new Error(`non-RSS response (HTTP ${res.status}, ${ct.split(';')[0]})`);
  }
  return body;
}

// Tiny regex-based RSS parser. Avoids pulling a real XML parser into the
// Worker — all three v2 feeds are well-formed and only need <item>/<title>/
// <link>/<pubDate> for our purposes.
function parseRss(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const body = m[1];
    const title = textOf(body, 'title');
    const link = textOf(body, 'link');
    const pubDate = textOf(body, 'pubDate');
    const description = textOf(body, 'description');
    if (!title) continue;
    items.push({ title, link, pubDate, description });
  }
  return items;
}

function textOf(body, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = body.match(re);
  if (!m) return '';
  let s = m[1].trim();
  s = s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
  return decodeEntities(s);
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Extract every plausible operating callsign from a free-form title.
//
// Returns an array because real DXpedition posts routinely list multiple
// calls ("V6AIU & V63JX", "3G0Z & XR0Z", "3B9KW & 3B9/M0CFW") and we want
// to highlight any of them when they appear in cluster spots.
//
// Slash forms (FP/WF2A, HB0/DL2SBY, 3B9/M0CFW, EI9KA/MM, W1AW/4) are
// preserved verbatim AND each bare-callsign component is emitted
// separately — clusters carry the call in whichever form the spotter
// typed.
function extractCallsigns(title) {
  if (!title) return [];
  const out = new Set();
  const tokens = title.toUpperCase().split(/[^A-Z0-9/]+/);
  for (let tok of tokens) {
    if (!tok || tok.length < 3 || tok.length > 12) continue;
    if (BLOCKLIST.has(tok)) continue;
    if (tok.includes('/')) {
      const parts = tok.split('/').filter(Boolean);
      if (parts.length < 2 || parts.length > 3) continue;
      const hasBareCall = parts.some(isBareCall);
      if (!hasBareCall) continue;
      out.add(tok);
      for (const p of parts) if (isBareCall(p)) out.add(p);
    } else if (isBareCall(tok)) {
      out.add(tok);
    }
  }
  return [...out];
}

// ---------- Source registry ----------
//
// Each entry knows its URL plus how to extract callsigns from its items.
// Format-aware extractors avoid false positives: NG3K titles include the
// QSL-manager's callsign (real, but not the on-air call), so we narrow
// the search window to the second "--"-delimited field of the title.

const SOURCES = [
  {
    name: 'dx-world',
    // www. host: the bare domain intermittently serves a captcha to
    // Cloudflare egress; www. returns the feed.
    url: 'https://www.dx-world.net/feed/',
    extract: (item) => extractCallsigns(item.title),
  },
  {
    name: 'dxnews',
    url: 'https://dxnews.com/rss.xml',
    // DXNews titles lead with the call: "<CALL> <topic>. From DXNews.com".
    // The generic extractor lands on the lead token first; we accept any
    // additional bare-calls or slash-forms in the title for cases where
    // a single post covers multiple ops.
    extract: (item) => extractCallsigns(item.title),
  },
  {
    name: 'ng3k',
    url: 'https://www.ng3k.com/adxo.xml',
    // NG3K title schema is canonical:
    //   "<Country>: <dates> -- <CALL> -- QSL via: <MANAGER>"
    // Pulling from the whole title would also pick up the QSL manager's
    // call (real callsign, but not the DXpedition op) — false positive.
    // Restrict to the call field between the first two "--" separators.
    extract: (item) => {
      const parts = item.title.split(/\s*--\s*/);
      const window = parts.length >= 2 ? parts[1] : item.title;
      return extractCallsigns(window);
    },
  },
];

// ---------- Normalize / merge ----------

function normalize(items, source, now) {
  const out = [];
  for (const it of items) {
    const calls = source.extract(it);
    if (!calls.length) continue;
    const published = parseDate(it.pubDate) || now;
    // NG3K items carry no pubDate; `now` above is only a first-seen stand-in
    // and must not count as "newer" when merging (see headlineRank).
    // Trim down the description: strip HTML tags / collapse whitespace /
    // cap at ~800 chars so we don't store full blog posts (DX-World runs
    // 1-2KB of post body per item). Tooltips and inline note rendering
    // happen client-side; raw structured data is what we owe them.
    const description = compactDescription(it.description);
    // Per-source structured parse. NG3K's description is fielded; news
    // items get a first pass over the RSS excerpt, replaced by the full
    // article once enrichFromArticles fetches it.
    const detail = source.name === 'ng3k'
      ? { ...parseNg3kItem(it.description, it.link), parsedFrom: 'feed' }
      : {
        ...parseArticle(description, [], new Date(published).toISOString()),
        articleLink: it.link || '',
        parsedFrom: 'excerpt',
      };
    // Bare calls split out of a slash form ("WE9G" from "3A/WE9G") exist
    // for spot matching; aliasOf points at the form that says where.
    const slashForms = calls.filter((c) => c.includes('/'));
    for (const call of calls) {
      const aliasOf = call.includes('/') ? null : slashForms.find((f) => f.split('/').includes(call)) || null;
      out.push({
        call,
        aliasOf,
        title: it.title,
        description,
        link: it.link || '',
        publishedAt: new Date(published).toISOString(),
        source: source.name,
        titleSource: source.name,
        firstSeen: now,
        _d: { [source.name]: detail },
      });
    }
  }
  return out;
}

function compactDescription(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 800) s = s.slice(0, 800).replace(/\s+\S*$/, '') + '…';
  return s;
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// Which record's headline (title/link/publishedAt) should a merged record
// carry. NG3K is a calendar, not news, and has no pubDate, so its headline
// only stands in when no news source covers the call. Records written
// before titleSource existed are recognised by NG3K's " -- " title shape.
function headlineRank(r) {
  const src = r.titleSource || (/ -- /.test(r.title || '') ? 'ng3k' : 'news');
  if (src === 'ng3k') return -1;
  return Date.parse(r.publishedAt) || 0;
}

// Merge new records with existing KV state. Preserves firstSeen of records
// the client has already been told about (so client-side max-age windows
// stay stable across cron runs) and drops anything past FEED_TTL_DAYS.
//
// When the same callsign appears in multiple sources, the most-recent
// publishedAt wins for title/link, but `source` becomes a comma-joined
// list so the client (and /healthz) can see the corroboration.
function mergeWithExisting(existing, fresh, now) {
  const byCall = new Map();
  for (const r of existing || []) {
    if (!r || !r.call) continue;
    byCall.set(r.call, r);
  }
  for (const r of fresh) {
    const prev = byCall.get(r.call);
    if (!prev) {
      byCall.set(r.call, r);
      continue;
    }
    // Merge source list; freshest publishedAt wins for the headline fields.
    const sources = new Set(String(prev.source || '').split(',').filter(Boolean));
    sources.add(r.source);
    const rankPrev = headlineRank(prev);
    const rankCurr = headlineRank(r);
    // Two NG3K headlines: take the fresh one (its dates may have moved).
    const newer = rankCurr > rankPrev || (rankCurr === -1 && rankPrev === -1) ? r : prev;
    byCall.set(r.call, {
      ...prev,
      title: newer.title,
      // Description travels with the headline so title and body describe
      // the same story; fall back to whichever side has one.
      description: newer.description || r.description || prev.description || '',
      link: newer.link,
      publishedAt: newer.publishedAt,
      titleSource: newer.titleSource || (headlineRank(newer) === -1 ? 'ng3k' : ''),
      _d: mergeDetails(prev._d, r._d),
      aliasOf: r.aliasOf !== undefined ? r.aliasOf : (prev.aliasOf || null),
      source: [...sources].sort().join(','),
    });
  }
  // Past the TTL a record survives only while its operation is still
  // ahead or on the air (NG3K lists some months out).
  const cutoff = now - FEED_TTL_DAYS * 24 * 3600 * 1000;
  const today = new Date(now).toISOString().slice(0, 10);
  return [...byCall.values()]
    .filter((r) => {
      if (r.firstSeen >= cutoff) return true;
      const { end } = combineDetails(r.aliasOf || r.call, r._d);
      return !!end && end >= today;
    })
    .sort((a, b) => b.firstSeen - a.firstSeen);
}

// Per-source details: a fresh parse replaces the stored one, except that
// a full-article parse of the same article beats a fresh excerpt parse.
function mergeDetails(prev, fresh) {
  const out = { ...(prev || {}) };
  for (const [src, d] of Object.entries(fresh || {})) {
    const p = out[src];
    if (p && p.parsedFrom === 'article' && d.parsedFrom !== 'article' && p.articleLink === d.articleLink) continue;
    out[src] = d;
  }
  return out;
}

// ---------- Articles ----------

const NEWS_HOSTS = { 'dx-world.net': 'dx-world', 'dxnews.com': 'dxnews' };

function newsSourceOf(link) {
  try {
    return NEWS_HOSTS[new URL(link).hostname.replace(/^www\./, '')] || null;
  } catch {
    return null;
  }
}

async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (!/entry-content|<article\b/i.test(html)) throw new Error('no article body (captcha?)');
  return extractArticle(html);
}

// Replace excerpt parses with full-article parses, within the fetch
// budget. Mutates records. Returns { fetched, failed }.
async function enrichFromArticles(records) {
  let budget = ARTICLE_FETCH_BUDGET;
  let fetched = 0;
  let failed = 0;
  const cache = new Map();
  // Records stored before details existed: seed a slot from the headline
  // link so they get backfilled too.
  for (const r of records) {
    r._d = r._d || {};
    const src = newsSourceOf(r.link);
    if (src && !r._d[src]) r._d[src] = { articleLink: r.link, parsedFrom: 'none' };
  }
  for (const r of records) {
    for (const src of Object.values(NEWS_HOSTS)) {
      const d = r._d[src];
      if (!d || d.parsedFrom === 'article' || !d.articleLink) continue;
      if ((d.articleTries || 0) >= ARTICLE_MAX_TRIES) continue;
      let parsed = cache.get(d.articleLink);
      if (!parsed) {
        if (budget <= 0) continue;
        budget--;
        try {
          const { text, hrefs } = await fetchArticle(d.articleLink);
          parsed = { ...parseArticle(text, hrefs, r.publishedAt), articleLink: d.articleLink, parsedFrom: 'article' };
          fetched++;
        } catch {
          failed++;
          r._d[src] = { ...d, articleTries: (d.articleTries || 0) + 1 };
          continue;
        }
        cache.set(d.articleLink, parsed);
      }
      r._d[src] = parsed;
    }
  }
  return { fetched, failed };
}

// ---------- Output ----------

// Public shape of a record: stored fields minus internals, plus the
// combined structured details.
function publicRecord(r) {
  const { _d, titleSource, ...rest } = r;
  return { ...rest, aliasOf: r.aliasOf || null, ...combineDetails(r.aliasOf || r.call, _d) };
}

function toJson(state) {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    generated: new Date(state.generatedAt || Date.now()).toISOString(),
    count: state.records.length,
    sources: state.sources || {},
    records: state.records.map(publicRecord),
  });
}

function toXml(state) {
  const esc = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<dxpeditions version="${SCHEMA_VERSION}" generated="${esc(new Date(state.generatedAt || Date.now()).toISOString())}" count="${state.records.length}">`,
  ];
  for (const rec of state.records) {
    const r = publicRecord(rec);
    lines.push(
      `  <op call="${esc(r.call)}" published="${esc(r.publishedAt)}" firstSeen="${esc(new Date(r.firstSeen).toISOString())}" source="${esc(r.source)}"`
        + ` entity="${esc(r.entity)}" dxcc="${esc(r.dxcc)}" start="${esc(r.start)}" end="${esc(r.end)}">`,
      `    <title>${esc(r.title)}</title>`,
      `    <link>${esc(r.link)}</link>`,
      '  </op>',
    );
  }
  lines.push('</dxpeditions>');
  return lines.join('\n');
}

// ---------- KV state ----------

async function readState(env) {
  const raw = await env.DXPEDITIONS.get(KV_KEY);
  if (!raw) return { records: [], generatedAt: 0, lastFetchedAt: 0, lastError: '', sources: {} };
  try {
    const parsed = JSON.parse(raw);
    parsed.sources = parsed.sources || {};
    return parsed;
  } catch {
    return { records: [], generatedAt: 0, lastFetchedAt: 0, lastError: 'corrupt kv payload', sources: {} };
  }
}

async function writeState(env, state) {
  await env.DXPEDITIONS.put(KV_KEY, JSON.stringify(state));
}

// ---------- HTTP handler ----------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Max-Age': '86400',
};

const worker = {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

    const url = new URL(request.url);
    const state = await readState(env);

    if (url.pathname === '/feeds/dxpeditions.xml') {
      return new Response(toXml(state), {
        headers: {
          ...CORS,
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }
    if (url.pathname === '/feeds/dxpeditions.json') {
      return new Response(toJson(state), {
        headers: {
          ...CORS,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }
    if (url.pathname === '/healthz') {
      const sourcesHealth = {};
      for (const [k, v] of Object.entries(state.sources || {})) {
        sourcesHealth[k] = {
          lastFetchedAt: v.lastFetchedAt ? new Date(v.lastFetchedAt).toISOString() : null,
          lastError: v.lastError || null,
          lastCount: v.lastCount || 0,
          lastOkAt: v.lastOkAt ? new Date(v.lastOkAt).toISOString() : null,
          consecutiveFailures: v.consecutiveFailures || 0,
        };
      }
      return new Response(
        JSON.stringify({
          ok: !state.lastError,
          schemaVersion: SCHEMA_VERSION,
          lastFetchedAt: state.lastFetchedAt ? new Date(state.lastFetchedAt).toISOString() : null,
          generatedAt: state.generatedAt ? new Date(state.generatedAt).toISOString() : null,
          count: state.records.length,
          lastError: state.lastError || null,
          sources: sourcesHealth,
        }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    return new Response('Not Found', { status: 404 });
  },

  // Cron handler — fetch each registered source independently, merge their
  // outputs, write back to KV.
  //
  // Per-source failure does NOT bubble: it gets recorded in
  // sources[name].lastError but other sources still run and the merge
  // proceeds with whatever did succeed. Only when ALL sources fail do we
  // preserve the previous payload unchanged.
  async scheduled(_event, env, _ctx) {
    const now = Date.now();
    const prev = await readState(env);
    const sources = { ...(prev.sources || {}) };
    const allFresh = [];
    let anyOk = false;

    for (const src of SOURCES) {
      try {
        const xml = await fetchUrl(src.url);
        const items = parseRss(xml);
        if (!items.length) throw new Error('feed parsed but held no items');
        const fresh = normalize(items, src, now);
        allFresh.push(...fresh);
        sources[src.name] = {
          lastFetchedAt: now, lastOkAt: now, lastError: '', lastCount: fresh.length, consecutiveFailures: 0,
        };
        anyOk = true;
      } catch (err) {
        const prevSrc = sources[src.name] || {};
        sources[src.name] = {
          lastFetchedAt: now,
          lastError: String(err && err.message ? err.message : err),
          lastCount: prevSrc.lastCount || 0,
          lastOkAt: prevSrc.lastOkAt || 0,
          consecutiveFailures: (prevSrc.consecutiveFailures || 0) + 1,
        };
      }
    }

    // Build top-level lastError only when EVERY source failed. Partial
    // failures stay reported in sources[] but ok=true at the top level —
    // the public feed is still fresh, just less complete.
    const failures = Object.entries(sources).filter(([_, s]) => s.lastError);
    const topError = !anyOk
      ? failures.map(([n, s]) => `${n}: ${s.lastError}`).join('; ')
      : '';

    const merged = anyOk ? mergeWithExisting(prev.records, allFresh, now) : (prev.records || []);
    let articles = { fetched: 0, failed: 0 };
    try {
      articles = await enrichFromArticles(merged);
    } catch (err) {
      articles.error = String(err && err.message ? err.message : err);
    }
    await writeState(env, {
      records: merged,
      generatedAt: anyOk ? now : (prev.generatedAt || 0),
      lastFetchedAt: now,
      lastError: topError,
      sources,
      articles,
    });
  },

  // Exposed so the temporary __bootstrap-cron endpoint (if re-added) can
  // call into the same code path as the real cron without duplicating logic.
  _SOURCES: SOURCES,
};

export default worker;
