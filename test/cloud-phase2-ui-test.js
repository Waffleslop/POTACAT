#!/usr/bin/env node
'use strict';
// Desktop pieces of the Cloud API Phase 2 reply (potacat-cloudlog
// CLOUD_TO_DESKTOP_HANDOFF_2026-10-20_PUBLIC_API_PHASE2_REPLY.md):
//   §3 Embeddable Widgets consent toggle (GET/PUT /v1/embed-settings),
//   §4 key kinds on the keys card (secret / publishable / test, scopes incl.
//      logbook:admin for imports + webhooks, allowedOrigins for browser keys),
//   §6 "Import a log into Cloud…" = the Logbook's own ADIF import + a sync.
// Run: node test/cloud-phase2-ui-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Cloud Phase 2 desktop pieces');
const sync = R('lib/cloud-sync.js'), ipc = R('lib/cloud-ipc.js'), pre = R('preload.js');
const ui = R('renderer/cloud-ui.js'), html = R('renderer/index.html');

test('embed consent: GET/PUT /v1/embed-settings, loaded with the account view, applied on change, reverted on failure', () => {
  assert.ok(/async getEmbedSettings\(\) \{\n\s*await this\._ensureAuth\(\);\n\s*return this\._request\('GET', '\/v1\/embed-settings'\);/.test(sync));
  assert.ok(/async putEmbedSettings\(isPublic\) \{\n\s*await this\._ensureAuth\(\);\n\s*return this\._request\('PUT', '\/v1\/embed-settings', \{ public: !!isPublic \}\);/.test(sync));
  assert.ok(ipc.includes("ipcMain.handle('embed-settings-get'") && ipc.includes("ipcMain.handle('embed-settings-put'"));
  assert.ok(/embedSettingsGet: \(\) => ipcRenderer\.invoke\('embed-settings-get'\)/.test(pre) && /embedSettingsPut: \(isPublic\) => ipcRenderer\.invoke\('embed-settings-put', isPublic\)/.test(pre));
  assert.ok(/<input type="checkbox" id="cloud-embed-public" checked> Show my widgets publicly/.test(html), 'checked by default — the cloud column defaults TRUE');
  assert.ok(/renderBilling\(subscription\);\n\s*if \(apiKeysFieldset\)[^\n]*\n\s*loadEmbedPublic\(\);/.test(ui), 'loaded on showAccount');
  assert.ok(/embedPublic\.checked = !!\(r && r\.data && r\.data\.public\);/.test(ui));
  assert.ok(/if \(r && r\.error\) \{ embedPublic\.checked = !on;/.test(ui), 'a failed save reverts the box');
});

test('keys card: kinds map to the documented create body; browser keys need an exact https origin', () => {
  assert.ok(/<select id="cloud-api-keys-kind"/.test(html) && !/cloud-api-keys-readonly/.test(html), 'the Read-only box became a kind select');
  assert.ok(/standard:\s*\{ kind: 'secret',\s*environment: 'live', scopes: \['qsos:read', 'qsos:write'\] \}/.test(ui));
  assert.ok(/admin:\s*\{ kind: 'secret',\s*environment: 'live', scopes: \['qsos:read', 'qsos:write', 'logbook:admin'\] \}/.test(ui), 'imports + webhooks = logbook:admin');
  assert.ok(/publishable: \{ kind: 'publishable', environment: 'live', scopes: \['qsos:read', 'station:read'\] \}/.test(ui), 'publishable may hold only those two');
  assert.ok(/test:\s*\{ kind: 'secret',\s*environment: 'test'/.test(ui), 'test keys are secret-only');
  assert.ok(/\/\^https:\\\/\\\/\[\^\/\\s\]\+\$\/\.test\(origin\)/.test(ui) && /body\.allowedOrigins = \[origin\];/.test(ui), 'exact origin, no path');
  assert.ok(/if \(k\.environment === 'test'\) tags\.push\('test'\);/.test(ui) && /if \(k\.kind === 'publishable'\) tags\.push\('browser'\);/.test(ui) && /tags\.push\('imports \+ webhooks'\)/.test(ui), 'list tags');
  assert.ok(/login\.potacat\.com\/keys/.test(html), 'links the self-serve page');
});

test('"Import a log into Cloud…" runs the Logbook import, then Sync Now', () => {
  assert.ok(/<button type="button" id="cloud-import-adif" class="btn"/.test(html));
  const fn = ui.slice(ui.indexOf("const importAdifBtn = document.getElementById('cloud-import-adif')"), ui.indexOf('// ── API keys'));
  assert.ok(/await window\.api\.importAdif\(\)/.test(fn), 'the one ADIF import (sameness dedupe lives there)');
  assert.ok(/if \(result\.imported > 0 && window\.api\.cloudSyncNow\)[\s\S]*?await window\.api\.cloudSyncNow\(\)/.test(fn), 'sync after a non-empty import');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
