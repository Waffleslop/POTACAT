#!/usr/bin/env node
'use strict';
// What the ECHOCAT app needs from the desktop to draw SSTV packs and templates
// (potacat-meta sstv-packs-mobile-readiness-desktop, 2026-09-29): hello
// capabilities to gate on, a TTF beside every WOFF2 (React Native / Skia cannot
// load WOFF2), and a lib/sstv-templates.js it can vendor — pure data in,
// no dynamic code, no ctx.filter (Skia has shadows but no CSS filter strings).
// Run: node test/sstv-mobile-readiness-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { validatePack, FONT_FILE_LIMITS, packFileNames } = require('../lib/sstv-pack-validate');
const { SstvPackStore, sha256 } = require('../lib/sstv-packs');

const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HALLOWEEN_DIR = path.join(ROOT, 'data', 'sstv-packs', 'halloween');
const halloween = () => JSON.parse(fs.readFileSync(path.join(HALLOWEEN_DIR, 'pack.json'), 'utf8'));
const errsOf = (p) => validatePack(p).errors.join(' | ');

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PUB = (() => { const d = publicKey.export({ type: 'spki', format: 'der' }); return d.subarray(d.length - 32).toString('base64'); })();
function signedFeed(entries) {
  const index = JSON.stringify({ schema: 1, generated: '2026-09-29T00:00:00Z', packs: entries });
  return { index, sig: crypto.sign(null, Buffer.from(index), privateKey).toString('base64'), keyId: 'test' };
}
function entryFor(pack, files) {
  const raw = Buffer.from(JSON.stringify(pack));
  return { raw, entry: { id: pack.id, name: pack.name, version: pack.version, season: pack.season, by: pack.by, minApp: pack.minApp, size: raw.length, sha256: sha256(raw), files: files.map(([n, b]) => ({ name: n, size: b.length, sha256: sha256(b) })), preview: null } };
}
function netFor(routes) {
  return async (url) => {
    const r = routes[url];
    if (!r) return { status: 404, etag: null, body: Buffer.alloc(0) };
    return { status: 200, etag: null, body: Buffer.isBuffer(r) ? r : Buffer.from(r) };
  };
}
function storeWith(fetch) {
  const settings = {};
  const s = new SstvPackStore({
    bundledDir: path.join(ROOT, 'data', 'sstv-packs'), userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sstv-ready-')),
    getSettings: () => settings, saveSettings: () => {}, appVersion: '9.9.9', fetch,
    feedUrl: 'https://packs.test/feeds/sstv-packs.json', publicKey: PUB,
  });
  return s;
}

console.log('SSTV mobile readiness');

test('the hello advertises sstv-packs, sstv-fskid and sstv-guest-check', () => {
  const src = R('lib/remote-server.js');
  const caps = /capabilities: \[([\s\S]*?)\],/.exec(src)[1];
  for (const c of ['sstv-packs', 'sstv-fskid', 'sstv-guest-check']) assert.ok(caps.includes(`'${c}'`), c);
  // …and each names something that really exists behind it.
  assert.ok(/case 'sstv-pack-claims':/.test(src) && /type: 'sstv-pack-claims'/.test(src), 'pack claims both ways');
  const main = R('main.js');
  assert.ok(/type: 'sstv-rx-fskid'/.test(main) && /fskCall: meta\.fskCall/.test(R('lib/sstv-gallery.js')), 'FSK ID reaches clients and gallery records');
  assert.ok(/interceptCatCommand\(\{ type: 'sstv_tx'/.test(main) && /broadcastSstvTxStatus\(\{ state: 'rx', error: res\.userVisible \}\)/.test(main), 'guest picture checked, refusal as sstv-tx-status');
});

test('schema 2 requires a TTF beside every WOFF2; schema 1 stays WOFF2-only and valid', () => {
  assert.ok(validatePack(halloween()).ok, errsOf(halloween()));
  const noTtf = halloween(); delete noTtf.fonts[0].ttf;
  assert.ok(/ttf/.test(errsOf(noTtf)), 'schema 2 without a TTF');
  const old = halloween(); old.schema = 1; delete old.fonts[0].ttf;
  assert.ok(validatePack(old).ok, 'an older WOFF2-only pack: ' + errsOf(old));
  const oldWithTtf = halloween(); oldWithTtf.schema = 1;
  assert.ok(!validatePack(oldWithTtf).ok, 'schema 1 never names a TTF');
  const woff = halloween(); woff.fonts[0].ttf = 'Rye-Regular.woff2';
  assert.ok(/ttf/.test(errsOf(woff)), 'the ttf field must be .ttf or .otf');
  const otf = halloween(); otf.fonts[0].ttf = 'Rye-Regular.otf';
  assert.ok(validatePack(otf).ok);
  assert.ok(!validatePack(Object.assign(halloween(), { schema: 3 })).ok);
});

test('the Halloween pack ships Rye-Regular.ttf (a real TrueType file, under the cap)', () => {
  const p = halloween();
  assert.strictEqual(p.fonts[0].ttf, 'Rye-Regular.ttf');
  const ttf = fs.readFileSync(path.join(HALLOWEEN_DIR, 'Rye-Regular.ttf'));
  assert.strictEqual(ttf.readUInt32BE(0), 0x00010000, 'sfnt version 1.0');
  assert.ok(ttf.length <= FONT_FILE_LIMITS.ttf);
  assert.deepStrictEqual(packFileNames(p), ['Rye-Regular.woff2', 'Rye-Regular.ttf', 'OFL.txt']);
});

test('the signer lists the TTF in the index with its own size and sha256', () => {
  const { buildFeed } = require('../scripts/sign-sstv-packs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sstv-ready-feed-'));
  buildFeed({ srcDir: path.join(ROOT, 'data', 'sstv-packs'), outDir: out, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), verifyKey: PUB });
  const wire = JSON.parse(fs.readFileSync(path.join(out, 'feeds', 'sstv-packs.json'), 'utf8'));
  const e = JSON.parse(wire.index).packs.find((x) => x.id === 'halloween');
  const f = e.files.find((x) => x.name === 'Rye-Regular.ttf');
  const bytes = fs.readFileSync(path.join(HALLOWEEN_DIR, 'Rye-Regular.ttf'));
  assert.ok(f && f.size === bytes.length && f.sha256 === sha256(bytes));
  assert.ok(fs.existsSync(path.join(out, 'packs', `halloween@${e.version}`, 'Rye-Regular.ttf')), 'uploaded beside the WOFF2');
});

test('the store installs a pack with its TTF, and refuses a TTF that does not match its hash', async () => {
  const pack = halloween(); pack.id = 'ttfy';
  const woff = fs.readFileSync(path.join(HALLOWEEN_DIR, 'Rye-Regular.woff2'));
  const ttf = fs.readFileSync(path.join(HALLOWEEN_DIR, 'Rye-Regular.ttf'));
  const ofl = fs.readFileSync(path.join(HALLOWEEN_DIR, 'OFL.txt'));
  const { raw, entry } = entryFor(pack, [['Rye-Regular.woff2', woff], ['Rye-Regular.ttf', ttf], ['OFL.txt', ofl]]);
  const base = `https://packs.test/packs/ttfy@${pack.version}`;
  const routes = {
    'https://packs.test/feeds/sstv-packs.json': JSON.stringify(signedFeed([entry])),
    [`${base}.json`]: raw, [`${base}/Rye-Regular.woff2`]: woff, [`${base}/Rye-Regular.ttf`]: ttf, [`${base}/OFL.txt`]: ofl,
  };
  const good = storeWith(netFor(routes));
  await good.refresh();
  const r = await good.claim('ttfy');
  assert.ok(r.ok, r.error);
  assert.strictEqual(good.get('ttfy').fonts[0].file, 'Rye-Regular.woff2', 'the desktop still draws from the WOFF2');
  const bad = storeWith(netFor(Object.assign({}, routes, { [`${base}/Rye-Regular.ttf`]: Buffer.concat([ttf, Buffer.from('x')]) })));
  await bad.refresh();
  const r2 = await bad.claim('ttfy');
  assert.ok(!r2.ok && /Rye-Regular\.ttf does not match/.test(r2.error), JSON.stringify(r2));
});

test('lib/sstv-templates.js is vendorable: no dynamic code, no ctx.filter', () => {
  const src = R('lib/sstv-templates.js');
  assert.ok(!/\beval\s*\(|new Function|Function\s*\(|import\s*\(|require\s*\(/.test(src.replace(/\/\/.*$/gm, '')), 'pack data is interpreted, never executed');
  assert.ok(!/\.filter\s*=/.test(src), 'soft edges use shadows, not ctx.filter');
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
  }
  console.log(`\nSSTV mobile readiness: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
