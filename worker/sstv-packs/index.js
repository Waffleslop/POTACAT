// potacat-sstv-packs — Cloudflare Worker
//
// Serves POTACAT's SSTV style packs (seasonal and event scenery for SSTV
// templates). Built like worker/dxpeditions: the HTTP handler only reads KV,
// so it never fails because of anything upstream. There is no cron: the
// content is published from the POTACAT repo by scripts/publish-sstv-packs.js,
// which signs the index and prints the KV uploads.
//
// Endpoints:
//   GET /feeds/sstv-packs.json          signed index { index, sig, keyId } (short cache, ETag)
//   GET /packs/<id>@<version>.json      one pack (immutable)
//   GET /packs/<id>@<version>/<file>    a font or licence file the pack names (immutable)
//   GET /healthz
//
// KV keys are the request paths without the leading slash. Packs are
// versioned in the path, so they can be cached forever; only the index moves.
// The desktop verifies the index signature and every hash itself, so this
// worker is a dumb, cacheable file server by design.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Max-Age': '86400',
};

const PACK_RE = /^packs\/[a-z0-9][a-z0-9-]*@\d+\.json$/;
const FILE_RE = /^packs\/[a-z0-9][a-z0-9-]*@\d+\/[A-Za-z0-9._-]+\.(woff2|ttf|otf|txt)$/;
const TYPES = { json: 'application/json; charset=utf-8', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain; charset=utf-8' };

async function etagOf(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return '"' + [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('') + '"';
}

const worker = {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
    const url = new URL(request.url);
    const key = url.pathname.replace(/^\/+/, '');

    if (key === 'healthz') {
      const idx = await env.SSTV_PACKS.get('feeds/sstv-packs.json');
      let packs = 0, generated = null;
      try { const w = JSON.parse(idx); const i = JSON.parse(w.index); packs = i.packs.length; generated = i.generated; } catch { /* */ }
      return new Response(JSON.stringify({ ok: !!idx, packs, generated }), {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const isIndex = key === 'feeds/sstv-packs.json';
    if (!isIndex && !PACK_RE.test(key) && !FILE_RE.test(key)) return new Response('Not Found', { status: 404, headers: CORS });

    const body = await env.SSTV_PACKS.get(key, { type: 'arrayBuffer' });
    if (!body) return new Response('Not Found', { status: 404, headers: CORS });

    const ext = key.split('.').pop();
    const headers = {
      ...CORS,
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      // Versioned paths never change; the index is re-read every few minutes
      // at the edge and revalidated by the app with If-None-Match.
      'Cache-Control': isIndex ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
    };
    const etag = await etagOf(body);
    headers.ETag = etag;
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : body, { headers });
  },
};

export default worker;
