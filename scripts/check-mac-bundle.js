#!/usr/bin/env node
'use strict';
// Release gate for the macOS bundle: files the app reads at run time must be
// IN the built .app. W0EGR's 1.13.0 Mac build had no scripts/launcher.js in
// app.asar and the Remote Launcher could not install. Fails the job when a
// required file is missing from both app.asar and Resources/.
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const REQUIRED = ['scripts/launcher.js'];
const apps = [];
for (const d of fs.readdirSync('dist')) {
  const p = path.join('dist', d, 'POTACAT.app', 'Contents', 'Resources');
  if (fs.existsSync(path.join(p, 'app.asar'))) apps.push(p);
}
if (!apps.length) { console.error('::error::no POTACAT.app found under dist/'); process.exit(1); }
let bad = 0;
for (const res of apps) {
  const listed = new Set(asar.listPackage(path.join(res, 'app.asar')).map((f) => f.split(path.sep).join('/').split('\\').join('/').replace(/^\//, '')));
  for (const f of REQUIRED) {
    const inAsar = listed.has(f);
    const onDisk = fs.existsSync(path.join(res, f));
    console.log(`${res}: ${f} — app.asar ${inAsar ? 'yes' : 'NO'}, Resources ${onDisk ? 'yes' : 'NO'}`);
    if (!inAsar && !onDisk) { console.error(`::error::${f} is missing from ${res}`); bad++; }
  }
}
process.exit(bad ? 1 : 0);
