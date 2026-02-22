/**
 * POTACAT — Anonymous Telemetry Worker
 *
 * Cloudflare Worker + KV backend for opt-in usage statistics.
 *
 * What we collect:
 *   - Random anonymous ID (UUID, not tied to any callsign)
 *   - App version
 *   - Operating system (win32, darwin, linux)
 *   - Session duration (seconds)
 *   - Active/idle flag (was the user actually using the app?)
 *   - Aggregate QSO counts (total + per source)
 *   - Aggregate re-spot counts (per source)
 *
 * What we do NOT collect:
 *   - Callsigns, grid squares, IP addresses
 *   - Settings, frequencies, spots, or any radio data
 *   - No tracking, no fingerprinting, no third-party sharing
 *
 * KV Schema:
 *   key: "user:{telemetryId}"           — per-user record (TTL: 90 days)
 *   key: "day:{YYYY-MM-DD}:{userId}"    — daily active presence marker (TTL: 90 days)
 *   key: "summary:{YYYY-MM-DD}"         — daily rollup { dau, versions, platforms, ... } (TTL: 730 days)
 *   key: "summary-month:{YYYY-MM}"      — monthly rollup { mau, versions, platforms } (TTL: 730 days)
 *   key: "global:respots"               — legacy total (kept for backwards compat)
 *   key: "global:respots:{source}"      — per-source respot counts
 *   key: "global:qsos"                  — total QSOs logged
 *   key: "global:qsos:{source}"         — per-source QSO counts
 */

const VALID_SOURCES = ['pota', 'sota', 'wwff', 'llota'];
const DAY_TTL = 7776000;      // 90 days in seconds
const SUMMARY_TTL = 63072000;  // 730 days (~2 years) in seconds

async function incrementCounter(env, key) {
  const current = parseInt(await env.TELEMETRY.get(key) || '0', 10);
  await env.TELEMETRY.put(key, String(current + 1));
}

/** Format a Date as YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Format a Date as YYYY-MM */
function fmtMonth(d) {
  return d.toISOString().slice(0, 7);
}

/** List ALL keys with a given prefix (handles KV pagination) */
async function listAllKeys(env, prefix) {
  const keys = [];
  let cursor = null;
  do {
    const opts = { prefix };
    if (cursor) opts.cursor = cursor;
    const result = await env.TELEMETRY.list(opts);
    keys.push(...result.keys);
    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);
  return keys;
}

// ─── CORS ───────────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Dashboard HTML ─────────────────────────────────────────────────────────

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>POTACAT Telemetry Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; }
  h1 { color: #4fc3f7; margin-bottom: 8px; font-size: 1.6em; }
  .subtitle { color: #888; margin-bottom: 24px; font-size: 0.9em; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .card { background: #16213e; border-radius: 8px; padding: 16px; text-align: center; }
  .card .value { font-size: 2em; font-weight: 700; color: #4ecca3; }
  .card .label { font-size: 0.85em; color: #aaa; margin-top: 4px; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
  .chart-box { background: #16213e; border-radius: 8px; padding: 16px; }
  .chart-box h2 { color: #4fc3f7; font-size: 1.1em; margin-bottom: 12px; }
  .breakdown { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .breakdown-box { background: #16213e; border-radius: 8px; padding: 16px; }
  .breakdown-box h2 { color: #4fc3f7; font-size: 1.1em; margin-bottom: 12px; }
  .breakdown-list { list-style: none; }
  .breakdown-list li { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #1a1a2e; }
  .breakdown-list li span:last-child { color: #4ecca3; font-weight: 600; }
  .loading { text-align: center; padding: 60px; color: #888; }
  .error { color: #e94560; text-align: center; padding: 20px; }
  @media (max-width: 768px) {
    .charts { grid-template-columns: 1fr; }
    .breakdown { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<h1>POTACAT Telemetry</h1>
<p class="subtitle">Anonymous usage statistics — no callsigns, no PII</p>
<div id="content"><div class="loading">Loading data...</div></div>
<script>
(async () => {
  try {
    const res = await fetch('/api/timeseries');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    render(data);
  } catch (err) {
    document.getElementById('content').innerHTML = '<div class="error">Failed to load data: ' + err.message + '</div>';
  }
})();

function render(data) {
  const c = data.current;
  const el = document.getElementById('content');
  el.innerHTML = \`
    <div class="cards">
      <div class="card"><div class="value">\${c.totalUsers}</div><div class="label">Total Users</div></div>
      <div class="card"><div class="value">\${c.activeToday}</div><div class="label">Active Today</div></div>
      <div class="card"><div class="value">\${c.activeThisWeek}</div><div class="label">Active This Week</div></div>
      <div class="card"><div class="value">\${c.totalQsos.toLocaleString()}</div><div class="label">Total QSOs</div></div>
      <div class="card"><div class="value">\${c.totalRespots.toLocaleString()}</div><div class="label">Total Re-spots</div></div>
    </div>
    <div class="charts">
      <div class="chart-box"><h2>Daily Active Users (last 90 days)</h2><canvas id="dauChart"></canvas></div>
      <div class="chart-box"><h2>Monthly Active Users</h2><canvas id="mauChart"></canvas></div>
    </div>
    <div class="breakdown">
      <div class="breakdown-box"><h2>Versions</h2><ul class="breakdown-list" id="versionList"></ul></div>
      <div class="breakdown-box"><h2>Platforms</h2><ul class="breakdown-list" id="platformList"></ul></div>
    </div>
  \`;

  // DAU chart
  if (data.daily.length > 0) {
    new Chart(document.getElementById('dauChart'), {
      type: 'line',
      data: {
        labels: data.daily.map(d => d.date.slice(5)), // MM-DD
        datasets: [{
          label: 'DAU',
          data: data.daily.map(d => d.dau),
          borderColor: '#4ecca3',
          backgroundColor: 'rgba(78,204,163,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: data.daily.length > 30 ? 0 : 3,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#888', maxTicksLimit: 15 }, grid: { color: '#2a2a4e' } },
          y: { beginAtZero: true, ticks: { color: '#888', precision: 0 }, grid: { color: '#2a2a4e' } }
        }
      }
    });
  }

  // MAU chart
  if (data.monthly.length > 0) {
    new Chart(document.getElementById('mauChart'), {
      type: 'bar',
      data: {
        labels: data.monthly.map(m => m.month),
        datasets: [{
          label: 'MAU',
          data: data.monthly.map(m => m.mau),
          backgroundColor: '#4fc3f7',
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#888' }, grid: { color: '#2a2a4e' } },
          y: { beginAtZero: true, ticks: { color: '#888', precision: 0 }, grid: { color: '#2a2a4e' } }
        }
      }
    });
  }

  // Version / platform breakdowns
  function fillList(id, obj) {
    const ul = document.getElementById(id);
    const sorted = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    ul.innerHTML = sorted.map(([k, v]) => '<li><span>' + (k || 'unknown') + '</span><span>' + v + '</span></li>').join('');
  }
  fillList('versionList', c.versions);
  fillList('platformList', c.platforms);
}
</script>
</body>
</html>`;
}

// ─── Fetch Handler ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /ping — app sends telemetry on launch, heartbeat, and close
    if (request.method === 'POST' && url.pathname === '/ping') {
      try {
        const body = await request.json();
        const { id, version, os, sessionSeconds } = body;
        // active field: true if user was interacting, defaults to true for backwards compat
        const active = body.active !== false;

        // Validate
        if (!id || typeof id !== 'string' || id.length > 64) {
          return new Response('Bad request', { status: 400, headers: corsHeaders });
        }

        const key = `user:${id}`;
        const existing = await env.TELEMETRY.get(key, { type: 'json' });

        const record = existing || { version: '', os: '', lastSeen: '', totalSessions: 0, totalSeconds: 0, currentSessionSeconds: 0 };
        record.version = version || record.version;
        record.os = os || record.os;
        record.lastSeen = new Date().toISOString();
        if (sessionSeconds && typeof sessionSeconds === 'number' && sessionSeconds > 0) {
          // Heartbeat or close ping — add only the delta since last ping
          const capped = Math.min(sessionSeconds, 259200); // cap at 72h per session
          const prev = record.currentSessionSeconds || 0;
          if (capped > prev) {
            record.totalSeconds += capped - prev;
            record.currentSessionSeconds = capped;
          }
        } else {
          // Launch ping — count the session, reset current session tracker
          record.totalSessions += 1;
          record.currentSessionSeconds = 0;
        }

        // Store with 90-day TTL — inactive users auto-disappear
        await env.TELEMETRY.put(key, JSON.stringify(record), { expirationTtl: DAY_TTL });

        // Write daily presence marker if user is active
        if (active) {
          const today = fmtDate(new Date());
          await env.TELEMETRY.put(`day:${today}:${id}`, '1', { expirationTtl: DAY_TTL });
        }

        return new Response('ok', { status: 200, headers: corsHeaders });
      } catch {
        return new Response('Bad request', { status: 400, headers: corsHeaders });
      }
    }

    // POST /qso — app pings after logging a QSO
    if (request.method === 'POST' && url.pathname === '/qso') {
      try {
        let source = null;
        try {
          const body = await request.json();
          if (body.source && VALID_SOURCES.includes(body.source)) {
            source = body.source;
          }
        } catch { /* no body or invalid JSON — just count total */ }

        await incrementCounter(env, 'global:qsos');
        if (source) {
          await incrementCounter(env, `global:qsos:${source}`);
        }
        return new Response('ok', { status: 200, headers: corsHeaders });
      } catch {
        return new Response('Server error', { status: 500, headers: corsHeaders });
      }
    }

    // POST /respot — app pings after a successful re-spot
    if (request.method === 'POST' && url.pathname === '/respot') {
      try {
        let source = null;
        try {
          const body = await request.json();
          if (body.source && VALID_SOURCES.includes(body.source)) {
            source = body.source;
          }
        } catch { /* no body — legacy client, just count total */ }

        await incrementCounter(env, 'global:respots');
        if (source) {
          await incrementCounter(env, `global:respots:${source}`);
        }
        return new Response('ok', { status: 200, headers: corsHeaders });
      } catch {
        return new Response('Server error', { status: 500, headers: corsHeaders });
      }
    }

    // GET /stats — legacy JSON stats endpoint (preserved for backwards compat)
    if (request.method === 'GET' && url.pathname === '/stats') {
      const list = await env.TELEMETRY.list({ prefix: 'user:' });
      const users = [];
      const versionCounts = {};
      const osCounts = {};
      let totalSeconds = 0;
      let totalSessions = 0;

      for (const key of list.keys) {
        const record = await env.TELEMETRY.get(key.name, { type: 'json' });
        if (record) {
          users.push(record);
          versionCounts[record.version] = (versionCounts[record.version] || 0) + 1;
          osCounts[record.os] = (osCounts[record.os] || 0) + 1;
          totalSeconds += record.totalSeconds || 0;
          totalSessions += record.totalSessions || 0;
        }
      }

      const weekAgo = Date.now() - 7 * 86400000;
      const activeLastWeek = users.filter(u => new Date(u.lastSeen).getTime() > weekAgo).length;

      const totalRespots = parseInt(await env.TELEMETRY.get('global:respots') || '0', 10);
      const totalQsos = parseInt(await env.TELEMETRY.get('global:qsos') || '0', 10);

      const qsos = {};
      const respots = {};
      for (const src of VALID_SOURCES) {
        qsos[src] = parseInt(await env.TELEMETRY.get(`global:qsos:${src}`) || '0', 10);
        respots[src] = parseInt(await env.TELEMETRY.get(`global:respots:${src}`) || '0', 10);
      }

      const stats = {
        totalUsers: users.length,
        activeLastWeek,
        totalSessions,
        totalHours: Math.round(totalSeconds / 3600),
        totalQsos,
        qsos,
        totalRespots,
        respots,
        versions: versionCounts,
        platforms: osCounts,
      };

      return new Response(JSON.stringify(stats, null, 2), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /api/timeseries — JSON data for dashboard charts
    if (request.method === 'GET' && url.pathname === '/api/timeseries') {
      try {
        // Fetch daily summaries (last 90 days)
        const daily = [];
        const summaryKeys = await listAllKeys(env, 'summary:');
        for (const key of summaryKeys) {
          const date = key.name.replace('summary:', '');
          // Skip monthly summary keys (summary-month:)
          if (date.length !== 10) continue;
          const val = await env.TELEMETRY.get(key.name, { type: 'json' });
          if (val) daily.push({ date, dau: val.dau || 0 });
        }
        daily.sort((a, b) => a.date.localeCompare(b.date));

        // Fetch monthly summaries
        const monthly = [];
        const monthKeys = await listAllKeys(env, 'summary-month:');
        for (const key of monthKeys) {
          const month = key.name.replace('summary-month:', '');
          const val = await env.TELEMETRY.get(key.name, { type: 'json' });
          if (val) monthly.push({ month, mau: val.mau || 0 });
        }
        monthly.sort((a, b) => a.month.localeCompare(b.month));

        // Current live stats
        const now = new Date();
        const today = fmtDate(now);
        const todayKeys = await listAllKeys(env, `day:${today}:`);
        const activeToday = todayKeys.length;

        // WAU — unique users across the last 7 days of day: keys
        const wauUsers = new Set(todayKeys.map(k => k.name.replace(`day:${today}:`, '')));
        for (let i = 1; i < 7; i++) {
          const d = new Date(now);
          d.setUTCDate(d.getUTCDate() - i);
          const dateStr = fmtDate(d);
          const keys = await listAllKeys(env, `day:${dateStr}:`);
          for (const k of keys) wauUsers.add(k.name.replace(`day:${dateStr}:`, ''));
        }
        const activeThisWeek = wauUsers.size;

        const userKeys = await listAllKeys(env, 'user:');
        const versionCounts = {};
        const osCounts = {};
        for (const key of userKeys) {
          const record = await env.TELEMETRY.get(key.name, { type: 'json' });
          if (record) {
            versionCounts[record.version] = (versionCounts[record.version] || 0) + 1;
            osCounts[record.os] = (osCounts[record.os] || 0) + 1;
          }
        }

        const totalQsos = parseInt(await env.TELEMETRY.get('global:qsos') || '0', 10);
        const totalRespots = parseInt(await env.TELEMETRY.get('global:respots') || '0', 10);

        const result = {
          daily,
          monthly,
          current: {
            totalUsers: userKeys.length,
            activeToday,
            activeThisWeek,
            versions: versionCounts,
            platforms: osCounts,
            totalQsos,
            totalRespots,
          },
        };

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch {
        return new Response('Server error', { status: 500, headers: corsHeaders });
      }
    }

    // GET /dashboard — self-contained HTML dashboard
    if (request.method === 'GET' && url.pathname === '/dashboard') {
      return new Response(dashboardHtml(), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },

  // ─── Cron: Daily rollup (runs at 05:00 UTC) ────────────────────────────────

  async scheduled(event, env, ctx) {
    const now = new Date();

    // Roll up yesterday's DAU
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = fmtDate(yesterday);

    const dayKeys = await listAllKeys(env, `day:${yesterdayStr}:`);
    const uniqueUsers = new Set(dayKeys.map(k => k.name.replace(`day:${yesterdayStr}:`, '')));
    const dau = uniqueUsers.size;

    // Collect version/platform breakdown from active users' records
    const versions = {};
    const platforms = {};
    for (const userId of uniqueUsers) {
      const record = await env.TELEMETRY.get(`user:${userId}`, { type: 'json' });
      if (record) {
        versions[record.version] = (versions[record.version] || 0) + 1;
        platforms[record.os] = (platforms[record.os] || 0) + 1;
      }
    }

    // Read aggregate counters for the summary
    const totalQsos = parseInt(await env.TELEMETRY.get('global:qsos') || '0', 10);
    const totalRespots = parseInt(await env.TELEMETRY.get('global:respots') || '0', 10);

    const dailySummary = { dau, versions, platforms, totalQsos, totalRespots };
    await env.TELEMETRY.put(`summary:${yesterdayStr}`, JSON.stringify(dailySummary), { expirationTtl: SUMMARY_TTL });

    // On the 1st of the month, compute MAU for the previous month
    if (now.getUTCDate() === 1) {
      const lastMonth = new Date(now);
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      const monthStr = fmtMonth(lastMonth);

      // List all day keys for that month and count unique users
      const monthDayKeys = await listAllKeys(env, `day:${monthStr}-`);
      const monthUsers = new Set(monthDayKeys.map(k => {
        // key format: day:YYYY-MM-DD:userId — extract userId after third colon-group
        const parts = k.name.split(':');
        return parts.slice(2).join(':'); // userId may theoretically contain colons (UUIDs don't, but be safe)
      }));
      const mau = monthUsers.size;

      // Collect version/platform from monthly active users
      const mVersions = {};
      const mPlatforms = {};
      for (const userId of monthUsers) {
        const record = await env.TELEMETRY.get(`user:${userId}`, { type: 'json' });
        if (record) {
          mVersions[record.version] = (mVersions[record.version] || 0) + 1;
          mPlatforms[record.os] = (mPlatforms[record.os] || 0) + 1;
        }
      }

      await env.TELEMETRY.put(`summary-month:${monthStr}`, JSON.stringify({ mau, versions: mVersions, platforms: mPlatforms }), { expirationTtl: SUMMARY_TTL });
    }
  },
};
