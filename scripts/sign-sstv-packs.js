#!/usr/bin/env node
'use strict';
// Build and sign the SSTV style-pack feed from data/sstv-packs/.
//
// Writes dist/sstv-packs/:
//   feeds/sstv-packs.json              { index: "<JSON string>", sig, keyId }
//   packs/<id>@<version>.json          the exact pack.json bytes
//   packs/<id>@<version>/<file>        fonts and licences the pack names
//
// The index is { schema: 1, generated, packs: [{ id, name, version, season,
// by, minApp, size, sha256, files: [{ name, size, sha256 }], preview: null }] }.
// The signature is ed25519 over the exact UTF-8 bytes of the index string, so
// the client verifies before parsing a single field (lib/sstv-packs.js).
//
// The private key is read from POTACAT_PACK_KEY or
// ~/.potacat/sstv-pack-signing-key.pem. It never lives in the repo.
// Run: node scripts/sign-sstv-packs.js [--out dir]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { checkPackDir } = require('./validate-sstv-packs');
const { verifyIndex, KEY_ID } = require('../lib/sstv-packs');
const { packFileNames } = require('../lib/sstv-pack-validate');

function keyPath() {
  return process.env.POTACAT_PACK_KEY || path.join(os.homedir(), '.potacat', 'sstv-pack-signing-key.pem');
}

function buildFeed({ srcDir, outDir, privateKeyPem, now, verifyKey }) {
  const dirs = fs.readdirSync(srcDir).map((n) => path.join(srcDir, n)).filter((d) => fs.statSync(d).isDirectory());
  const problems = dirs.flatMap(checkPackDir);
  if (problems.length) throw new Error('packs failed validation:\n  ' + problems.join('\n  '));
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const entries = [];
  const writes = [];
  for (const d of dirs) {
    const raw = fs.readFileSync(path.join(d, 'pack.json'));
    const pack = JSON.parse(raw.toString('utf8'));
    const files = [];
    for (const name of packFileNames(pack)) {
      const body = fs.readFileSync(path.join(d, name));
      files.push({ name, size: body.length, sha256: sha(body) });
      writes.push([`packs/${pack.id}@${pack.version}/${name}`, body]);
    }
    entries.push({
      id: pack.id, name: pack.name, version: pack.version, season: pack.season, by: pack.by, minApp: pack.minApp,
      size: raw.length, sha256: sha(raw), files, preview: null,
    });
    writes.push([`packs/${pack.id}@${pack.version}.json`, raw]);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const index = JSON.stringify({ schema: 1, generated: new Date(now || Date.now()).toISOString(), packs: entries });
  const sig = crypto.sign(null, Buffer.from(index, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  const wire = { index, sig, keyId: KEY_ID };
  verifyIndex(wire, verifyKey); // refuse to publish anything the app would reject (tests pass their own key)
  writes.push(['feeds/sstv-packs.json', Buffer.from(JSON.stringify(wire))]);
  for (const [rel, body] of writes) {
    const p = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return { entries, files: writes.map(([rel]) => rel) };
}

function main() {
  const i = process.argv.indexOf('--out');
  const outDir = path.resolve(i > 0 ? process.argv[i + 1] : path.join(__dirname, '..', 'dist', 'sstv-packs'));
  const srcDir = path.join(__dirname, '..', 'data', 'sstv-packs');
  let pem;
  try { pem = fs.readFileSync(keyPath()); }
  catch { console.error(`No signing key at ${keyPath()} (set POTACAT_PACK_KEY).`); process.exit(1); }
  fs.rmSync(outDir, { recursive: true, force: true });
  const { entries, files } = buildFeed({ srcDir, outDir, privateKeyPem: pem });
  for (const e of entries) console.log(`  signed ${e.id} v${e.version} (${e.size} bytes, ${e.files.length} file(s))`);
  console.log(`\n${files.length} file(s) written to ${outDir}`);
  return { outDir, files };
}

if (require.main === module) main();
module.exports = { buildFeed, keyPath, main };
