// Settings > Cloud > Delete account (CLOUD_TO_DESKTOP 2026-11-26).
// A. lib/cloud-delete-account.js turns each Cloud answer into the sentence
//    the operator reads (200, 409 no_email_on_account, 401, 500, network).
// B. The link, the in-page confirm, the IPC and the client call are wired,
//    and the confirm never uses a browser dialog. No network.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const D = require('../lib/cloud-delete-account');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

// ── A. Response to sentence ─────────────────────────────────────────

test('200: names the masked address and the hour', () => {
  const r = D.deletionOutcome({ status: 200, body: { data: { emailSent: true, to: 'c***@example.com', expiresInHours: 1, page: D.DELETE_PAGE } } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'We sent a link to c***@example.com. Open it within an hour to finish.');
});

test('200 with a longer window says so', () => {
  const r = D.deletionOutcome({ status: 200, body: { data: { to: 'a***@b.org', expiresInHours: 2 } } });
  assert.strictEqual(r.text, 'We sent a link to a***@b.org. Open it within 2 hours to finish.');
});

test('409 no_email_on_account: the server message and hint', () => {
  const body = { error: 'no_email_on_account', message: 'This account has no email address to send the deletion link to.', hint: 'Write to support@example.com from the address you use, with your callsign.' };
  const r = D.deletionOutcome({ status: 409, body });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'no_email_on_account');
  assert.strictEqual(r.text, body.message + ' ' + body.hint);
});

test('409 in the nested envelope still reads', () => {
  const r = D.deletionOutcome({ status: 409, body: { error: { code: 'no_email_on_account', message: 'M.', hint: 'H.' } } });
  assert.strictEqual(r.text, 'M. H.');
});

test('401: signed out, nothing deleted', () => {
  const r = D.deletionOutcome({ status: 401, body: {} });
  assert.strictEqual(r.ok, false);
  assert.ok(/signed out/i.test(r.text));
  assert.ok(r.text.endsWith('Nothing was deleted.'));
});

test('500: server message kept, "Nothing was deleted." once', () => {
  const r = D.deletionOutcome({ status: 500, body: { error: 'server_error', message: 'Could not send the deletion link. Nothing was deleted.' } });
  assert.strictEqual(r.text, 'Could not send the deletion link. Nothing was deleted.');
  const bare = D.deletionOutcome({ status: 502, body: {} });
  assert.ok(bare.text.endsWith('Nothing was deleted.'));
});

test('network failure says so', () => {
  const r = D.deletionOutcome({ network: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.startsWith('No connection.'));
});

test('responseFromError reads CloudSyncClient errors', () => {
  const e409 = new Error('x'); e409.status = 409; e409.body = { error: 'no_email_on_account', message: 'M.', hint: 'H.' };
  assert.deepStrictEqual(D.responseFromError(e409), { status: 409, body: e409.body });
  assert.strictEqual(D.responseFromError(new Error('AUTH_EXPIRED')).status, 401);
  assert.strictEqual(D.responseFromError(new Error('Not authenticated')).status, 401);
  assert.strictEqual(D.responseFromError(new Error('Token refresh failed: bad')).status, 401);
  const e500 = D.responseFromError(new Error('POTACAT cloud error (HTTP 500): Could not send the deletion link. Nothing was deleted.'));
  assert.strictEqual(e500.status, 500);
  assert.strictEqual(D.deletionOutcome(e500).text, 'Could not send the deletion link. Nothing was deleted.');
  assert.strictEqual(D.responseFromError(new Error('POTACAT cloud is gateway error (HTTP 502). Please try again')).status, 502);
  assert.deepStrictEqual(D.responseFromError(new Error('getaddrinfo ENOTFOUND api.potacat.com')), { network: true });
  assert.deepStrictEqual(D.responseFromError(new Error('Request timeout')), { network: true });
});

test('copy makes no timing, refund or payment promises and has no emoji', () => {
  const samples = [
    D.CONFIRM_TEXT,
    D.deletionOutcome({ status: 200, body: { data: { to: 'x' } } }).text,
    D.deletionOutcome({ status: 401 }).text,
    D.deletionOutcome({ status: 500 }).text,
    D.deletionOutcome({ network: true }).text,
  ];
  for (const s of samples) {
    assert.ok(!/refund|credit|payment|subscription|days?\b|immediately/i.test(s), s);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s), s);
  }
});

// ── B. Wiring ───────────────────────────────────────────────────────

const html = read('renderer/index.html');
const ui = read('renderer/cloud-ui.js');
const preload = read('preload.js');
const ipc = read('lib/cloud-ipc.js');
const sync = read('lib/cloud-sync.js');

test('signed in: a quiet link and an in-page confirm inside the account section', () => {
  const start = html.indexOf('id="cloud-account-section"');
  const end = html.indexOf('</fieldset>', start);
  const section = html.slice(start, end);
  assert.ok(/<a href="#" id="cloud-delete-account-link"[^>]*>Delete account&hellip;<\/a>/.test(section));
  assert.ok(section.includes('id="cloud-delete-account-confirm" class="hidden"'));
  assert.ok(section.includes(D.CONFIRM_TEXT), 'confirm sentence matches lib/cloud-delete-account.js');
  assert.ok(section.includes('id="cloud-delete-account-send" class="btn btn-sm"'), 'not a primary button');
  assert.ok(!/cloud-delete-account[^"]*"[^>]*btn-primary/.test(section));
});

test('signed out: the link opens the web page through data-external', () => {
  const start = html.indexOf('id="cloud-login-section"');
  const end = html.indexOf('id="cloud-account-section"');
  const section = html.slice(start, end);
  assert.ok(/<a href="https:\/\/api\.potacat\.com\/delete-account" id="cloud-delete-account-web-link" data-external="1"[^>]*>Delete account&hellip;<\/a>/.test(section));
  assert.strictEqual(D.DELETE_PAGE, 'https://api.potacat.com/delete-account');
});

test('no new colours: only CSS tokens in the delete markup', () => {
  const chunk = html.slice(html.indexOf('<!-- Delete account (CLOUD_TO_DESKTOP'), html.indexOf('id="cloud-delete-account-status"') + 200);
  assert.ok(!/#[0-9a-fA-F]{3,6}\b|rgb\(/.test(chunk), 'no literal colours');
});

test('IPC wired end to end, through the existing cloud client', () => {
  assert.ok(preload.includes("cloudRequestAccountDeletion: () => ipcRenderer.invoke('cloud-request-account-deletion')"));
  assert.ok(ipc.includes("ipcMain.handle('cloud-request-account-deletion'"));
  assert.ok(ipc.includes('sync.requestAccountDeletion()'));
  assert.ok(ipc.includes("require('./cloud-delete-account')"));
  assert.ok(/async requestAccountDeletion\(\) \{\s*return this\._authedRequest\('POST', '\/v1\/account\/deletion-request', null\);/.test(sync));
  assert.ok(ui.includes('window.api.cloudRequestAccountDeletion()'));
});

test('the confirm is in-page: no window.confirm/alert in the delete handler', () => {
  const start = ui.indexOf('// ── Delete account (signed in)');
  const end = ui.indexOf('if (verifyBtn)', start);
  assert.ok(start > 0 && end > start);
  const block = ui.slice(start, end);
  assert.ok(!/\bconfirm\(|\balert\(/.test(block));
});

console.log(`cloud-delete-account-test: ${passed} passed`);
