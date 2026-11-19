#!/usr/bin/env node
// Release builds only: write the FlexRadio SmartLink client ID into
// build/smartlink/smartlink.json, which electron-builder copies into the app's
// resources folder (package.json build.extraResources). lib/smartlink-config.js
// reads it there. The ID comes from the SMARTLINK_CLIENT_ID repository secret
// (.github/workflows/release.yml); it is never committed and never printed.
// With the secret unset this writes nothing, and that build says
// "SmartLink is not available in this build."
'use strict';

const fs = require('fs');
const path = require('path');
const { looksLikeClientId } = require('../lib/smartlink-config');

const dir = path.join(__dirname, '..', 'build', 'smartlink');
const file = path.join(dir, 'smartlink.json');
const id = (process.env.SMARTLINK_CLIENT_ID || '').trim();

fs.mkdirSync(dir, { recursive: true });
if (!id) {
  try { fs.unlinkSync(file); } catch { /* none */ }
  console.log('SmartLink: no SMARTLINK_CLIENT_ID secret; this build has no SmartLink.');
  process.exit(0);
}
// GitHub masks repository secrets already; masking again here keeps any
// derived output masked too. The workflow command itself is hidden by the runner.
if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write('::add-mask::' + id + '\n');
if (!looksLikeClientId(id)) {
  console.error('SmartLink: SMARTLINK_CLIENT_ID is set but does not look like a client ID; not written.');
  process.exit(1);
}
fs.writeFileSync(file, JSON.stringify({ clientId: id }) + '\n', { mode: 0o600 });
console.log('SmartLink: client ID written into the build (value not shown).');
