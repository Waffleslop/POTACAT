#!/usr/bin/env node
'use strict';
// Settings > Cloud > "API keys" — the desktop card for the POTACAT Cloud
// public API (potacat-cloudlog CLOUD_TO_DESKTOP_HANDOFF_2026-10-20_PUBLIC_API_REPLY.md §1).
// Guards: the three JWT routes are called with the documented shapes, the
// token is shown once, server codes map to one sentence each, the fieldset
// follows the account view, and the label matches the docs on
// api.potacat.com ("Settings → Cloud → API keys").
// Run: node test/cloud-api-keys-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Cloud API keys card');
const sync = R('lib/cloud-sync.js'), ipc = R('lib/cloud-ipc.js'), pre = R('preload.js');
const ui = R('renderer/cloud-ui.js'), html = R('renderer/index.html');

test('cloud client: the three routes, JWT-authenticated like every other call', () => {
  assert.ok(/async listApiKeys\(\) \{\n\s*await this\._ensureAuth\(\);\n\s*return this\._request\('GET', '\/v1\/api-keys'\);/.test(sync));
  assert.ok(/async createApiKey\(body\) \{\n\s*await this\._ensureAuth\(\);\n\s*return this\._request\('POST', '\/v1\/api-keys', body\);/.test(sync));
  assert.ok(/async revokeApiKey\(id\) \{\n\s*await this\._ensureAuth\(\);\n\s*return this\._request\('DELETE', '\/v1\/api-keys\/' \+ encodeURIComponent\(id\)\);/.test(sync));
});

test('IPC: handlers return the API envelope error code, message and HTTP status', () => {
  for (const ch of ['api-keys-list', 'api-keys-create', 'api-keys-revoke']) assert.ok(ipc.includes(`ipcMain.handle('${ch}'`), ch);
  assert.ok(/error: \(e && e\.code\) \|\| err\.code \|\| err\.message \|\| 'error',\n\s*message: \(e && e\.message\) \|\| err\.message \|\| '',\n\s*status: err\.status \|\| 0,/.test(ipc), 'envelope mapping');
  assert.ok(/apiKeysList: \(\) => ipcRenderer\.invoke\('api-keys-list'\)/.test(pre) && /apiKeysCreate: \(body\) => ipcRenderer\.invoke\('api-keys-create', body\)/.test(pre) && /apiKeysRevoke: \(id\) => ipcRenderer\.invoke\('api-keys-revoke', id\)/.test(pre), 'preload');
});

test('card: label matches the docs, follows the account view, token shown once', () => {
  assert.ok(/<legend>API keys<\/legend>/.test(html), 'legend "API keys" (docs say Settings → Cloud → API keys)');
  assert.ok(/id="cloud-api-keys-fieldset" class="source-toggles hidden"/.test(html), 'hidden until signed in');
  assert.ok(/if \(apiKeysFieldset\) apiKeysFieldset\.classList\.add\('hidden'\);/.test(ui), 'hidden on showLogin');
  assert.ok(/if \(apiKeysFieldset\) \{ apiKeysFieldset\.classList\.remove\('hidden'\); loadApiKeys\(\); \}/.test(ui), 'shown + loaded on showAccount');
  assert.ok(/apiKeysToken\.textContent = key\.token \|\| ''/.test(ui) && /POTACAT Cloud will not show it again/.test(html), 'token once, with the warning');
  assert.ok(/\['qsos:read'\] : \['qsos:read', 'qsos:write'\]/.test(ui), 'read-only box → qsos:read only');
});

test('card: one sentence per server code', () => {
  assert.ok(/r\.status === 404\) return 'The API is not available on POTACAT Cloud yet\.'/.test(ui), '404 before the cloud deploys');
  assert.ok(/r\.error === 'callsign_required'\) return 'Set your callsign first/.test(ui), '422 callsign_required');
  assert.ok(/r\.error === 'too_many_keys'\) return 'At most 20 active keys/.test(ui), '422 too_many_keys');
  assert.ok(/'revoked ' \+ fmtWhen\(k\.revokedAt\)/.test(ui) && /if \(revoked\) tr\.style\.color = 'var\(--text-tertiary\)';/.test(ui), 'revoked keys listed greyed');
});

test('card: fixed columns; the Key cell shows only the 8 characters that tell keys apart', () => {
  // Every key shares pc_live_; the full prefix ran into "Last used" in the narrow pane (Casey 2026-10-20).
  assert.ok(/table-layout:fixed;/.test(ui) && /<colgroup><col style="width:38%"><col style="width:22%"><col style="width:28%"><col style="width:12%"><\/colgroup>/.test(ui));
  assert.ok(/const tail = prefix\.replace\(\/\^pc_\[a-z\]\+_\/, ''\);/.test(ui) && /code\.textContent = '…' \+ tail; code\.title = prefix \+ '…';/.test(ui), 'tail shown, full prefix on hover');
  assert.ok(/white-space:nowrap;/.test(ui) && /overflow-wrap:anywhere;/.test(ui), 'key never wraps; name and last-used may');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
