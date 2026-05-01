#!/usr/bin/env node
'use strict';
// One-off station probe. Tries a candidate list of public KiwiSDR / WebSDR.org
// receivers and reports which are live. Direct hostnames only — the
// proxy.kiwisdr.com tunnel hosts return HTTP 307 to a *.proxy2.kiwisdr.com
// host which the `ws` library can't follow, so we skip them in the directory
// (users can still type those URLs manually if they want).

const http = require('http');

const C = [
  // Verified working in the v1.5.13 dev session
  ['Twente',     'websdr.ewi.utwente.nl', 8901, 'WebSDR.org'],
  ['KFS Kansas', 'websdr1.kfsdr.com',     8901, 'WebSDR.org'],
  ['NA5B',       'na5b.com',              8902, 'WebSDR.org'],
  ['Bucks PA',   'bucks.hopto.org',       8073, 'KiwiSDR'],

  // Direct-host KiwiSDR candidates (no proxy.kiwisdr.com redirects)
  ['K3FEF',      'k3fef.com',             8073, 'KiwiSDR'],
  ['WA2ZKD',     'sdr.wa2zkd.net',        8073, 'KiwiSDR'],
  ['KPH Coast',  'kphsdr.com',            8073, 'KiwiSDR'],
  ['W6DRZ',      'sdr.w6drz.us',          8073, 'KiwiSDR'],
  ['WD8RIF',     'wd8rif.com',            8073, 'KiwiSDR'],
  ['VE3HLS',     've3hls.dyndns.org',     8073, 'KiwiSDR'],
  ['Calgary',    'calgary.kiwisdr.com',   8073, 'KiwiSDR'],
  ['HB9RYZ',     'hb9ryz.dyndns.org',     8073, 'KiwiSDR'],
  ['KFS West',   'kfs.kiwisdr.com',       8073, 'KiwiSDR'],
  ['VE3SUN',     've3sun.com',            8073, 'KiwiSDR'],
  ['KMaui',      'maui-kiwisdr.com',      8073, 'KiwiSDR'],
  ['SM5BSZ',     'kiwi.kkn.net',          8073, 'KiwiSDR'],
  ['9V1QQ',      'kiwisdr.9v1qq.com',     8073, 'KiwiSDR'],

  // WebSDR.org candidates
  ['Twente-2',   'websdr.ewi.utwente.nl', 8901, 'WebSDR.org'],
  ['SUWS',       'websdr.suws.org.uk',    8901, 'WebSDR.org'],
  ['JFW',        'web888.lasalle.edu',    8901, 'WebSDR.org'],
  ['HKARC',      'websdr.hkarc.net',      8901, 'WebSDR.org'],
  ['IK1JNS',     'websdr.ik1jns.it',      8901, 'WebSDR.org'],
  ['DF0HHB',     'websdr.df0hhb.de',      8901, 'WebSDR.org'],
  ['F4ENG',      'websdr.f4eng.fr',       8901, 'WebSDR.org'],
];

function probe(name, host, port, type) {
  return new Promise((resolve) => {
    const path = type === 'KiwiSDR' ? '/status' : '/';
    const chunks = [];
    let len = 0;
    const req = http.get(
      { host, port, path, timeout: 5000, headers: { 'User-Agent': 'POTACAT/1.0' } },
      (res) => {
        // Reject redirects — they imply a different actual host that we
        // can't reach via WebSocket without follow-redirect support.
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          resolve({ name, host, port, type, ok: false, err: 'redirect' });
          return;
        }
        res.on('data', (d) => { chunks.push(d); len += d.length; if (len > 8000) { res.destroy(); } });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8', 0, Math.min(len, 8000));
          const looksRight = type === 'KiwiSDR'
            ? /name=|sw_version|users=|status=|gps_fixes=/.test(body)
            : /WebSDR|websdr|websdr-base|bandinfo/i.test(body);
          resolve({ name, host, port, type, ok: res.statusCode === 200 && looksRight, status: res.statusCode, len });
        });
        res.on('error', () => resolve({ name, host, port, type, ok: false, err: 'res error' }));
      }
    );
    req.on('error', (e) => resolve({ name, host, port, type, ok: false, err: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ name, host, port, type, ok: false, err: 'timeout' }); });
  });
}

(async () => {
  const live = [], dead = [];
  for (const c of C) {
    const r = await probe(...c);
    process.stdout.write(r.ok ? '+' : '-');
    (r.ok ? live : dead).push(r);
  }
  console.log();
  console.log('\nLIVE:');
  for (const r of live) console.log(`  ✓ ${r.name.padEnd(14)} ${r.host}:${r.port} (${r.type})`);
  console.log('\nDEAD:');
  for (const r of dead) console.log(`  ✗ ${r.name.padEnd(14)} ${r.host}:${r.port} — ${r.err || 'http ' + r.status}`);
  console.log(`\n${live.length} live / ${C.length} total`);
})();
