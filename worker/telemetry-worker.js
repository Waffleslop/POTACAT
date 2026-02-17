/**
 * POTA CAT — Anonymous Telemetry Worker
 *
 * Cloudflare Worker + KV backend for opt-in usage statistics.
 *
 * What we collect:
 *   - Random anonymous ID (UUID, not tied to any callsign)
 *   - App version
 *   - Operating system (win32, darwin, linux)
 *   - Session duration (seconds)
 *
 * What we do NOT collect:
 *   - Callsigns, grid squares, IP addresses
 *   - Settings, frequencies, spots, or any radio data
 *   - No tracking, no fingerprinting, no third-party sharing
 *
 * Setup:
 *   1. Create a KV namespace: wrangler kv namespace create TELEMETRY
 *   2. Update wrangler.toml with the namespace ID
 *   3. Deploy: wrangler deploy
 *
 * KV Schema:
 *   key: "user:{telemetryId}"
 *   value: JSON { version, os, lastSeen, totalSessions, totalSeconds }
 *   TTL: 90 days (inactive users auto-expire)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for Electron app
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /ping — app sends telemetry on launch and close
    if (request.method === 'POST' && url.pathname === '/ping') {
      try {
        const body = await request.json();
        const { id, version, os, sessionSeconds } = body;

        // Validate
        if (!id || typeof id !== 'string' || id.length > 64) {
          return new Response('Bad request', { status: 400, headers: corsHeaders });
        }

        const key = `user:${id}`;
        const existing = await env.TELEMETRY.get(key, { type: 'json' });

        const record = existing || { version: '', os: '', lastSeen: '', totalSessions: 0, totalSeconds: 0 };
        record.version = version || record.version;
        record.os = os || record.os;
        record.lastSeen = new Date().toISOString();
        if (sessionSeconds && typeof sessionSeconds === 'number' && sessionSeconds > 0) {
          // Close ping — add duration only, don't double-count sessions
          record.totalSeconds += Math.min(sessionSeconds, 86400); // cap at 24h per session
        } else {
          // Launch ping — count the session
          record.totalSessions += 1;
        }

        // Store with 90-day TTL — inactive users auto-disappear
        await env.TELEMETRY.put(key, JSON.stringify(record), { expirationTtl: 7776000 });

        return new Response('ok', { status: 200, headers: corsHeaders });
      } catch {
        return new Response('Bad request', { status: 400, headers: corsHeaders });
      }
    }

    // GET /stats — developer dashboard (simple JSON)
    if (request.method === 'GET' && url.pathname === '/stats') {
      const list = await env.TELEMETRY.list({ prefix: 'user:' });
      const users = [];
      const versionCounts = {};
      const osCounts = {};
      let totalSeconds = 0;
      let totalSessions = 0;

      // Fetch all user records (KV list only returns keys, need to get values)
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

      // Count active in last 7 days
      const weekAgo = Date.now() - 7 * 86400000;
      const activeLastWeek = users.filter(u => new Date(u.lastSeen).getTime() > weekAgo).length;

      const stats = {
        totalUsers: users.length,
        activeLastWeek,
        totalSessions,
        totalHours: Math.round(totalSeconds / 3600),
        versions: versionCounts,
        platforms: osCounts,
      };

      return new Response(JSON.stringify(stats, null, 2), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
