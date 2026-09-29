#!/usr/bin/env node
'use strict';
// Validate every SSTV style pack in data/sstv-packs/<id>/pack.json, and the
// files each one names (fonts and their licences). Exits 1 on any problem.
// CI runs this; so does scripts/sign-sstv-packs.js before it signs.
// Run: node scripts/validate-sstv-packs.js [dir]
const fs = require('fs');
const path = require('path');
const { validatePack } = require('../lib/sstv-pack-validate');

const MAX_FILE = { woff2: 200 * 1024, txt: 16 * 1024 };

function checkPackDir(dir) {
  const errors = [];
  const id = path.basename(dir);
  let raw, pack;
  try { raw = fs.readFileSync(path.join(dir, 'pack.json')); pack = JSON.parse(raw.toString('utf8')); }
  catch (e) { return [`${id}: pack.json unreadable (${e.message})`]; }
  const v = validatePack(pack, { bytes: raw.length });
  for (const e of v.errors) errors.push(`${id}: ${e}`);
  if (pack.id !== id) errors.push(`${id}: folder name and pack id "${pack.id}" differ`);
  for (const f of pack.fonts || []) {
    for (const name of [f.file, f.licenseFile].filter(Boolean)) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) { errors.push(`${id}: ${name} is named but missing`); continue; }
      const size = fs.statSync(p).size;
      const ext = name.split('.').pop();
      if (size > (MAX_FILE[ext] || 0)) errors.push(`${id}: ${name} is ${size} bytes (limit ${MAX_FILE[ext]})`);
    }
    if (!f.licenseFile) errors.push(`${id}: font ${f.family} ships without its licence file`);
  }
  const allowed = new Set(['pack.json', ...(pack.fonts || []).flatMap((f) => [f.file, f.licenseFile]).filter(Boolean)]);
  for (const name of fs.readdirSync(dir)) if (!allowed.has(name)) errors.push(`${id}: stray file ${name} (only pack.json and named fonts/licences ship)`);
  return errors;
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'sstv-packs'));
  const dirs = fs.readdirSync(root).map((n) => path.join(root, n)).filter((d) => fs.statSync(d).isDirectory());
  let bad = 0;
  for (const d of dirs) {
    const errs = checkPackDir(d);
    if (errs.length) { bad++; errs.forEach((e) => console.log('  FAIL ' + e)); }
    else console.log('  ok   ' + path.basename(d));
  }
  console.log(`\nSSTV packs: ${dirs.length - bad} valid, ${bad} invalid`);
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
module.exports = { checkPackDir };
