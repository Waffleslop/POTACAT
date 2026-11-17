// The FlexRadio SmartLink client ID is the one secret in POTACAT's SmartLink
// code (FlexRadio, 2026-11-16). It must never be in the repository, and neither
// may a sign-in token. This greps the committed tree (lib, main.js, renderer,
// test, docs, .github, scripts, preload*.js, package.json) for:
//   - the real client ID, read from the developer key file when it exists
//     (D:\keyfiles\potacat-smartlink.env; skipped elsewhere, as in CI),
//   - anything shaped like a JWT,
//   - an Auth0 user id (auth0|...).
// Run: node test/smartlink-secret-leak-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Cfg = require('../lib/smartlink-config');

const root = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}

// The committed files under the paths that ship or are published.
const ROOTS = ['lib', 'main.js', 'renderer', 'test', 'docs', '.github', 'scripts', 'package.json', 'preload.js'];
let files = [];
try {
  files = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  // preload-*.js and anything new but not yet committed in these folders count too.
  const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', ...ROOTS], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  files = [...new Set([...files, ...untracked])];
} catch {
  console.log('  skip: not a git checkout');
}
const TEXT_EXT = /\.(js|cjs|mjs|json|html|css|md|txt|yml|yaml|ps1|sh|gyp|ts)$/i;
const texts = files.filter((f) => TEXT_EXT.test(f) && fs.existsSync(path.join(root, f)))
  .map((f) => ({ f, s: fs.readFileSync(path.join(root, f), 'utf8') }));

console.log(`SmartLink secrets: ${texts.length} committed text files checked`);
check(texts.length > 100 || files.length === 0, 'the tree was found');

// 1. The real client ID, when this machine has it.
let realId = null;
try { realId = Cfg._fromEnvText(fs.readFileSync(Cfg.DEV_ENV_FILE, 'utf8')); } catch { /* not here */ }
if (process.env.SMARTLINK_CLIENT_ID && Cfg.looksLikeClientId(process.env.SMARTLINK_CLIENT_ID)) realId = realId || process.env.SMARTLINK_CLIENT_ID;
if (realId && Cfg.looksLikeClientId(realId)) {
  const hits = texts.filter((t) => t.s.includes(realId)).map((t) => t.f);
  check(hits.length === 0, 'the client ID is in no committed file' + (hits.length ? ': ' + hits.join(', ') : ''));
} else {
  console.log('  skip: no client ID on this machine to look for (the CI case)');
}

// 2. JWT-shaped strings: three base64url parts, the first two starting eyJ ('{"').
//    A token someone pasted has the claims a real issuer writes (iss, aud, exp,
//    email). Hand-made test tokens ({"sub":"x"}, test/pota-sync-log-test.js)
//    carry none of them and are allowed.
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;
function realLooking(payloadB64) {
  try {
    const j = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return !!(j && (j.iss || j.aud || j.exp || j.email));
  } catch { return true; } // not decodable: treat as real
}
const jwtHits = texts.filter((t) => [...t.s.matchAll(JWT)].some((m) => realLooking(m[1]))).map((t) => t.f);
check(jwtHits.length === 0, 'no issued (iss/aud/exp/email) JWT in any committed file' + (jwtHits.length ? ': ' + jwtHits.join(', ') : ''));
check(realLooking(Buffer.from('{"iss":"https://frtest.auth0.com/","exp":1}').toString('base64url')) && !realLooking('eyJzdWIiOiJ4In0'), 'the JWT check tells an issued token from a hand-made test one');

// 3. Auth0 user ids.
const AUTH0 = /auth0\|[A-Za-z0-9]{8,}/;
const auHits = texts.filter((t) => AUTH0.test(t.s)).map((t) => t.f);
check(auHits.length === 0, 'no Auth0 user id in any committed file' + (auHits.length ? ': ' + auHits.join(', ') : ''));

// 4. The fixtures carry no serial, licence id, token or address of a real radio.
const fx = texts.filter((t) => t.f.startsWith('test/fixtures/smartlink/'));
check(fx.length >= 4, 'the SmartLink fixtures are checked');
for (const t of fx) {
  const serials = (t.s.match(/serial=(\S+)/g) || []).filter((s) => !/serial=0000-0000-0000-0000\b/.test(s) && !/serial=9999/.test(s));
  check(serials.length === 0, `${t.f}: only the zeroed serial`);
  check(!/token=(?!<)[^\s&]{8,}/.test(t.s) && !/radio_license_id=(?!<)\S/.test(t.s), `${t.f}: no token or licence id`);
  const ips = (t.s.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []).filter((ip) => !ip.startsWith('203.0.113.') && !/^1\.4\.0\.0$/.test(ip)); // V1.4.0.0 is the API version
  check(ips.length === 0, `${t.f}: only documentation addresses (203.0.113.x)` + (ips.length ? ': ' + ips.join(', ') : ''));
  check(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t.s), `${t.f}: no email address`);
}

// 5. The release workflow takes the ID from a secret and never prints it.
const wf = texts.find((t) => t.f === '.github/workflows/release.yml');
if (wf) {
  check(/secrets\.SMARTLINK_CLIENT_ID/.test(wf.s), 'release.yml reads the client ID from the SMARTLINK_CLIENT_ID secret');
  const sc = texts.find((t) => t.f === 'scripts/write-smartlink-resource.js');
  check(!!sc && /::add-mask::/.test(sc.s) && wf.s.includes('node scripts/write-smartlink-resource.js'), 'release.yml writes it through scripts/write-smartlink-resource.js, which masks it');
  check(!/echo\s+["']?\$\{?\{?\s*(secrets\.)?SMARTLINK_CLIENT_ID/.test(wf.s), 'release.yml never echoes it');
}

// 6. This test is in the list CI runs.
check(fs.readFileSync(path.join(root, 'scripts', 'run-tests.js'), 'utf8').includes("'test/smartlink-secret-leak-test.js'"), 'this test is in scripts/run-tests.js');

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'smartlink secret leak test failed');
