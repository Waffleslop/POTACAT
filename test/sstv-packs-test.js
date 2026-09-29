#!/usr/bin/env node
'use strict';
// SSTV style packs: the pure-data format, the signed feed, and the store that
// installs, claims and syncs them (lib/sstv-pack-validate.js, lib/sstv-packs.js).
// Run: node test/sstv-packs-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { validatePack, inSeason } = require('../lib/sstv-pack-validate');
const { SstvPackStore, verifyIndex, sha256 } = require('../lib/sstv-packs');
const P = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
const ROOT = path.join(__dirname, '..');
const HALLOWEEN_DIR = path.join(ROOT, 'data', 'sstv-packs', 'halloween');
const halloween = () => JSON.parse(fs.readFileSync(path.join(HALLOWEEN_DIR, 'pack.json'), 'utf8'));
const errsOf = (p) => validatePack(p).errors.join(' | ');

// A test signing key, and a signer that builds the feed the way the publish step does.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PUB = (() => { const d = publicKey.export({ type: 'spki', format: 'der' }); return d.subarray(d.length - 32).toString('base64'); })();
function signedFeed(entries) {
  const index = JSON.stringify({ schema: 1, generated: '2026-09-29T00:00:00Z', packs: entries });
  return { index, sig: crypto.sign(null, Buffer.from(index), privateKey).toString('base64'), keyId: 'test' };
}
function entryFor(pack, files) {
  const raw = Buffer.from(JSON.stringify(pack));
  return {
    raw,
    entry: { id: pack.id, name: pack.name, version: pack.version, season: pack.season, by: pack.by, minApp: pack.minApp, size: raw.length, sha256: sha256(raw), files: (files || []).map(([n, b]) => ({ name: n, size: b.length, sha256: sha256(b) })), preview: null },
  };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sstv-packs-')); }
function store(o) {
  const settings = o.settings || {};
  const s = new SstvPackStore({
    bundledDir: o.bundledDir || path.join(ROOT, 'data', 'sstv-packs'),
    userDir: o.userDir || tmpDir(),
    getSettings: () => settings,
    saveSettings: () => {},
    appVersion: o.appVersion || '9.9.9',
    fetch: o.fetch,
    feedUrl: 'https://packs.test/feeds/sstv-packs.json',
    publicKey: PUB,
    now: o.now,
  });
  return { s, settings };
}
// A fake network: url -> { status, body, etag }
function fakeNet(routes, seen) {
  return async (url, headers) => {
    if (seen) seen.push([url, headers]);
    const r = routes[url];
    if (!r) return { status: 404, etag: null, body: Buffer.alloc(0) };
    const res = typeof r === 'function' ? r(headers) : r;
    return { status: res.status || 200, etag: res.etag || null, body: Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body || '') };
  };
}

console.log('SSTV style packs');

// ---- the format -------------------------------------------------------------
test('the Halloween pack in the repo is valid', () => {
  const v = validatePack(halloween());
  assert.ok(v.ok, v.errors.join(' | '));
});

test('unknown keys are rejected at any depth (pure data only)', () => {
  const p = halloween(); p.onload = 'x';
  assert.ok(/unknown key "onload"/.test(errsOf(p)));
  const q = halloween(); q.backgrounds[0].draw[1].blob.script = 'x';
  assert.ok(/unknown key "script"/.test(errsOf(q)));
  const r = halloween(); r.backgrounds[0].draw.push({ eval: 'alert(1)' });
  assert.ok(/exactly one of/.test(errsOf(r)));
});

test('script-like strings and URLs are rejected', () => {
  for (const bad of ['<script>x</script>', 'javascript:alert(1)', 'url(http://x)', 'see https://evil.test']) {
    const p = halloween(); p.style = bad;
    assert.ok(/markup, a URL or a script/.test(errsOf(p)), bad);
  }
});

test('images: PNG data URLs only, 64 KB at most', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100)]);
  const p = halloween(); p.images = { moon: 'data:image/png;base64,' + png.toString('base64') };
  p.backgrounds[0].draw.push({ image: { name: 'moon', x: 0, y: 0, w: 64, h: 64 } });
  assert.ok(validatePack(p).ok, errsOf(p));
  const big = halloween(); big.images = { moon: 'data:image/png;base64,' + Buffer.concat([png, Buffer.alloc(70 * 1024)]).toString('base64') };
  assert.ok(/limit is 65536/.test(errsOf(big)));
  const svg = halloween(); svg.images = { moon: 'data:image/svg+xml;base64,PHN2Zz4=' };
  assert.ok(/data:image\/png/.test(errsOf(svg)));
});

test('headline wording can never touch {MYCALL} and friends', () => {
  const p = halloween(); p.text.replace['TNX QSO'] = '{MYCALL} BOO';
  assert.ok(/fill-ins/.test(errsOf(p)));
  const q = halloween(); q.text.replace['{MYCALL}'] = 'X';
  assert.ok(/not in headlines|fill-ins/.test(errsOf(q)));
  const r = halloween(); r.text.replace['NOT A HEADLINE'] = 'X';
  assert.ok(/not in headlines/.test(errsOf(r)));
});

test('palettes must letter in colours that stand off the sky', () => {
  const p = halloween(); p.palettes[0].glow = '#221a14';
  assert.ok(/contrast .* below 3:1/.test(errsOf(p)));
});

test('a pack over 512 KB is refused', () => {
  const p = halloween(); p.style = 'x'.repeat(100);
  const v = validatePack(p, { bytes: 600 * 1024 });
  assert.ok(!v.ok && /limit is 524288/.test(v.errors.join(' ')));
});

test('shapes named by ops must exist; fonts are headline-only OFL', () => {
  const p = halloween(); p.backgrounds[0].draw.push({ shape: 'ghost', at: [10, 10], size: 20 });
  assert.ok(/names no shape/.test(errsOf(p)));
  const q = halloween(); q.fonts[0].use = 'callsign';
  assert.ok(/never sets the callsign font/.test(errsOf(q)));
});

test('seasons, including one that wraps the new year', () => {
  const d = (s) => new Date(s + 'T12:00:00Z');
  assert.ok(inSeason({ from: '10-01', to: '11-02' }, d('2026-10-31')));
  assert.ok(!inSeason({ from: '10-01', to: '11-02' }, d('2026-11-03')));
  assert.ok(inSeason({ from: '12-20', to: '01-05' }, d('2026-12-25')));
  assert.ok(inSeason({ from: '12-20', to: '01-05' }, d('2027-01-03')));
  assert.ok(!inSeason({ from: '12-20', to: '01-05' }, d('2027-01-06')));
  assert.ok(inSeason(null, d('2026-06-01')), 'no season = always');
});

// ---- the signed feed --------------------------------------------------------
test('the index signature verifies, and a changed byte does not', () => {
  const { entry } = entryFor(halloween());
  const wire = signedFeed([entry]);
  assert.strictEqual(verifyIndex(wire, PUB).packs[0].id, 'halloween');
  const tampered = { ...wire, index: wire.index.replace('"version":2', '"version":3') };
  assert.throws(() => verifyIndex(tampered, PUB), /signature/);
  assert.throws(() => verifyIndex({ index: wire.index }, PUB), /not a signed index/);
});

test('the key in the app verifies what the repo\'s signer produces (when the key is here)', () => {
  const keyFile = path.join(os.homedir(), '.potacat', 'sstv-pack-signing-key.pem');
  if (!fs.existsSync(keyFile)) { console.log('    (skipped: no signing key on this machine)'); return; }
  const { buildFeed } = require('../scripts/sign-sstv-packs');
  const out = tmpDir();
  buildFeed({ srcDir: path.join(ROOT, 'data', 'sstv-packs'), outDir: out, privateKeyPem: fs.readFileSync(keyFile) });
  const wire = JSON.parse(fs.readFileSync(path.join(out, 'feeds', 'sstv-packs.json'), 'utf8'));
  assert.ok(verifyIndex(wire).packs.some((e) => e.id === 'halloween'), 'the built-in public key accepts it');
});

// ---- the store --------------------------------------------------------------
test('bundled packs are listed and drawable offline, with their font', () => {
  const { s } = store({ fetch: fakeNet({}) });
  const h = s.list().find((x) => x.id === 'halloween');
  assert.ok(h && h.bundled && h.installed && !h.available && !h.claimed);
  const g = s.get('halloween');
  assert.strictEqual(g.pack.id, 'halloween');
  assert.ok(g.fonts[0].bytes.length > 1000 && g.fonts[0].family === 'Rye');
});

test('feed merge: a pack only on the server is listed as available, and claiming installs it', async () => {
  const pack = halloween(); pack.id = 'winter'; pack.name = 'Winter lights'; pack.season = { from: '12-01', to: '01-06' }; pack.fonts = []; delete pack.text.headlineFont;
  const { raw, entry } = entryFor(pack);
  const net = fakeNet({
    'https://packs.test/feeds/sstv-packs.json': { body: JSON.stringify(signedFeed([entry])), etag: '"a"' },
    'https://packs.test/packs/winter@2.json': { body: raw },
  });
  const { s, settings } = store({ fetch: net });
  await s.refresh();
  const w = s.list().find((x) => x.id === 'winter');
  assert.ok(w && w.available && !w.installed);
  const r = await s.claim('winter');
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(settings.sstvPacksClaimed, ['winter']);
  assert.ok(s.list().find((x) => x.id === 'winter').installed);
  assert.strictEqual(s.get('winter').pack.name, 'Winter lights');
});

test('a pack that does not match the signed hash is refused and nothing is installed', async () => {
  const pack = halloween(); pack.id = 'spooky'; pack.fonts = []; delete pack.text.headlineFont;
  const { entry } = entryFor(pack);
  const evil = Buffer.from(JSON.stringify({ ...pack, name: 'Swapped' }));
  const userDir = tmpDir();
  const { s, settings } = store({ userDir, fetch: fakeNet({
    'https://packs.test/feeds/sstv-packs.json': { body: JSON.stringify(signedFeed([entry])) },
    'https://packs.test/packs/spooky@2.json': { body: evil },
  }) });
  await s.refresh();
  const r = await s.claim('spooky');
  assert.ok(!r.ok && /does not match/.test(r.error), JSON.stringify(r));
  assert.ok(!fs.existsSync(path.join(userDir, 'spooky')), 'nothing written');
  assert.ok(!(settings.sstvPacksClaimed || []).includes('spooky'));
});

test('a font file that does not match its hash is refused', async () => {
  const pack = halloween(); pack.id = 'fonty';
  const font = fs.readFileSync(path.join(HALLOWEEN_DIR, 'Rye-Regular.woff2'));
  const { raw, entry } = entryFor(pack, [['Rye-Regular.woff2', font]]);
  const { s } = store({ fetch: fakeNet({
    'https://packs.test/feeds/sstv-packs.json': { body: JSON.stringify(signedFeed([entry])) },
    'https://packs.test/packs/fonty@2.json': { body: raw },
    'https://packs.test/packs/fonty@2/Rye-Regular.woff2': { body: Buffer.concat([font, Buffer.from('x')]) },
  }) });
  await s.refresh();
  const r = await s.claim('fonty');
  assert.ok(!r.ok && /Rye-Regular.woff2 does not match/.test(r.error), JSON.stringify(r));
});

test('an unsigned or forged feed is ignored; the bundled packs still work', async () => {
  const { entry } = entryFor(halloween());
  const wire = signedFeed([entry]);
  const { s } = store({ fetch: fakeNet({ 'https://packs.test/feeds/sstv-packs.json': { body: JSON.stringify({ ...wire, sig: Buffer.alloc(64).toString('base64') }) } }) });
  assert.strictEqual(await s.refresh(), false);
  assert.ok(s.list().some((x) => x.id === 'halloween' && x.bundled));
});

test('If-None-Match: a 304 keeps the feed; a restart offline uses the cached copy', async () => {
  const pack = halloween(); pack.id = 'cached'; pack.fonts = []; delete pack.text.headlineFont;
  const { entry } = entryFor(pack);
  const seen = [];
  const userDir = tmpDir();
  let first = true;
  const net = fakeNet({ 'https://packs.test/feeds/sstv-packs.json': () => (first ? (first = false, { body: JSON.stringify(signedFeed([entry])), etag: '"v1"' }) : { status: 304 }) }, seen);
  const a = store({ userDir, fetch: net });
  await a.s.refresh();
  await a.s.refresh();
  assert.strictEqual(seen[1][1]['If-None-Match'], '"v1"');
  assert.ok(a.s.list().some((x) => x.id === 'cached'), 'still listed after the 304');
  const b = store({ userDir, fetch: async () => { throw new Error('offline'); } });
  await b.s.refresh();
  assert.ok(b.s.list().some((x) => x.id === 'cached' && x.available), 'cached feed used offline');
});

test('a pack needing a newer POTACAT is listed as incompatible and not installed', async () => {
  const pack = halloween(); pack.id = 'future'; pack.minApp = '9.0.0'; pack.fonts = []; delete pack.text.headlineFont;
  const { raw, entry } = entryFor(pack);
  const { s } = store({ appVersion: '1.10.27', fetch: fakeNet({
    'https://packs.test/feeds/sstv-packs.json': { body: JSON.stringify(signedFeed([entry])) },
    'https://packs.test/packs/future@2.json': { body: raw },
  }) });
  await s.refresh();
  assert.strictEqual(s.list().find((x) => x.id === 'future').compatible, false);
  const r = await s.claim('future');
  assert.ok(!r.ok && /needs POTACAT 9.0.0/.test(r.error));
});

test('claims: set active, unclaim clears active, and pairing merges as a union', async () => {
  const { s, settings } = store({ fetch: fakeNet({}) });
  settings.sstvPacksClaimed = ['winter'];
  assert.ok(s.setActive('halloween').ok);
  assert.deepStrictEqual(settings.sstvPacksClaimed.sort(), ['halloween', 'winter']);
  assert.strictEqual(settings.sstvActivePack, 'halloween');
  assert.strictEqual(await s.mergeClaims(['halloween', 'space', 'Bad Id']), true);
  assert.deepStrictEqual(settings.sstvPacksClaimed.sort(), ['halloween', 'space', 'winter'], 'union; invalid ids dropped');
  assert.strictEqual(await s.mergeClaims(['space']), false, 'nothing new, no change');
  s.unclaim('halloween');
  assert.strictEqual(settings.sstvActivePack, null);
  assert.ok(!s.setActive('nope').ok, 'cannot activate a pack that is not installed');
  const pl = s.claimsPayload();
  assert.deepStrictEqual(Object.keys(pl), ['claimed', 'active', 'lookShuffle']);
});

test('pairing: the claims message is registered both ways and guests are shut out', () => {
  const d = P.MESSAGES['sstv-pack-claims'];
  assert.ok(d && d.dir === P.Dir.BOTH && d.feature === 'sstv');
  const rs = fs.readFileSync(path.join(ROOT, 'lib', 'remote-server.js'), 'utf8').replace(/\r\n/g, '\n');
  const demux = rs.slice(rs.indexOf("case 'sstv-pack-claims':"), rs.indexOf("case 'sstv-pack-claims':") + 300);
  assert.ok(/if \(ws\._passSession\) break;/.test(demux), 'a guest\'s claims never merge');
  assert.ok(/sendSstvPackClaims\(payload\) \{\s*if \(!payload \|\| !this\._client \|\| this\._client\._passSession\) return;/.test(rs), 'and a guest is not sent the owner\'s');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/onRemoteServer\(\(rs\) => \{\s*\/\/ The app learns the desktop's claims at connect and sends its own\.\s*rs\.on\('client-connected'/.test(main), 'wired through onRemoteServer');
  for (const ch of ['sstv-packs-list', 'sstv-pack-get', 'sstv-pack-claim', 'sstv-pack-unclaim', 'sstv-pack-set-active']) {
    assert.ok(main.includes(`ipcMain.handle('${ch}'`), ch);
  }
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nSSTV style packs: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
