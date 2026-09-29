#!/usr/bin/env node
'use strict';
// Sign the SSTV style-pack feed and print the wrangler commands that upload it
// to the potacat-sstv-packs worker's KV namespace. Uploads nothing itself:
// review the output, then run the commands (see worker/sstv-packs/README.md).
// Run: node scripts/publish-sstv-packs.js
const path = require('path');
const { main: sign } = require('./sign-sstv-packs');

const { outDir, files } = sign();
const rel = path.relative(path.join(__dirname, '..', 'worker', 'sstv-packs'), outDir).replace(/\\/g, '/');
console.log('\nFrom worker/sstv-packs, upload each file to KV (packs first, the index last,');
console.log('so no client ever sees an index naming a pack that is not there yet):\n');
const ordered = files.filter((f) => f !== 'feeds/sstv-packs.json').concat('feeds/sstv-packs.json');
for (const f of ordered) {
  console.log(`  npx wrangler kv key put --binding=SSTV_PACKS --remote "${f}" --path "${rel}/${f}"`);
}
