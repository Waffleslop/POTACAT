// Simpler pairing (2026-11-25): the https pairing link with the parameters
// after "#", the older potacat:// form, the best browser address and the
// live state line (lib/pairing-screen.js).
// Run: node test/pairing-screen-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/pairing-screen');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

const params = {
  token: 'a'.repeat(64),
  name: 'SHACK-PC',
  host: 'wss://192.168.1.20:7300',
  fp: 'AB:CD:EF',
  spki: 'f'.repeat(64),
  cloudHost: 'k3sbp.potacat.com',
  tsHost: 'shack.tail1234.ts.net:7300',
  tsIp: '100.64.0.5:7300',
  tsCertPublic: '1',
};

console.log('pairing link');

test('https link on api.potacat.com/pair.html, parameters only after "#"', () => {
  const link = S.buildPairLink(params, { web: 'https://k3sbp.potacat.com' });
  const u = new URL(link);
  assert.strictEqual(u.origin, 'https://api.potacat.com');
  assert.strictEqual(u.pathname, '/pair.html');
  assert.strictEqual(u.search, '', 'nothing in the query string: it would reach the server logs');
  assert.ok(u.hash.startsWith('#token='));
  assert.ok(!link.split('#')[0].includes(params.token), 'the token is never before the "#"');
});

test('every key maps one to one onto potacat://pair', () => {
  const link = S.buildPairLink(params, { web: 'https://k3sbp.potacat.com' });
  const legacy = S.buildLegacyPairUri(params);
  assert.strictEqual(S.legacyFromLink(link), legacy, 'the page rebuilds exactly the potacat:// the desktop would write');
  const back = S.parsePairLink(legacy);
  assert.deepStrictEqual(back.params, params);
  const https = S.parsePairLink(link);
  assert.deepStrictEqual(https.params, params);
  assert.strictEqual(https.web, 'https://k3sbp.potacat.com');
  assert.ok(!legacy.includes('web='), 'the page-only key is never forwarded');
});

test('the fingerprint pin travels in the link', () => {
  const p = S.parsePairLink(S.buildPairLink(params));
  assert.strictEqual(p.params.fp, 'AB:CD:EF');
  assert.strictEqual(p.params.spki, params.spki);
});

test('the potacat:// form keeps today\'s shape', () => {
  const legacy = S.buildLegacyPairUri({ token: 't1', name: 'PC', host: 'wss://10.0.0.2:7300', fp: 'AA' });
  assert.strictEqual(legacy, 'potacat://pair?token=t1&name=PC&host=wss%3A%2F%2F10.0.0.2%3A7300&fp=AA');
});

test('refused: parameters in the query string, other hosts, other paths, http', () => {
  assert.strictEqual(S.parsePairLink('https://api.potacat.com/pair.html?token=abc').error, 'params-in-query');
  assert.strictEqual(S.parsePairLink('https://evil.example/pair.html#token=abc').error, 'not-a-pair-link');
  assert.strictEqual(S.parsePairLink('https://api.potacat.com/guest-pass.html#token=abc').error, 'not-a-pair-link');
  assert.strictEqual(S.parsePairLink('http://api.potacat.com/pair.html#token=abc').error, 'not-a-pair-link');
  assert.strictEqual(S.parsePairLink('https://api.potacat.com/pair.html#name=x').error, 'no-token');
  assert.strictEqual(S.parsePairLink('').error, 'empty');
  assert.strictEqual(S.legacyFromLink('https://api.potacat.com/pair.html?token=abc'), '');
});

test('unknown keys are dropped, not forwarded', () => {
  const p = S.parsePairLink('https://api.potacat.com/pair.html#token=t&evil=1&name=PC');
  assert.deepStrictEqual(p.params, { token: 't', name: 'PC' });
});

console.log('best browser address');

test('Cloud address wins when the tunnel is live', () => {
  const w = { cloudUrl: 'https://k3sbp.potacat.com', addresses: ['192.168.1.20'], port: 7300, tailscaleUrl: 'https://x.ts.net:7300' };
  assert.deepStrictEqual(S.bestWeb(w), { url: 'https://k3sbp.potacat.com', kind: 'cloud' });
});

test('else the home-network address, else Tailscale, else nothing', () => {
  assert.strictEqual(S.bestWebUrl({ addresses: ['192.168.1.20'], port: 7300 }), 'https://192.168.1.20:7300');
  assert.strictEqual(S.bestWebUrl({ addresses: [], port: 7300, tailscaleUrl: 'https://x.ts.net:7300' }), 'https://x.ts.net:7300');
  assert.strictEqual(S.bestWebUrl({ access: 'off', cloudUrl: 'https://k3sbp.potacat.com' }), '');
  assert.strictEqual(S.bestWebUrl(null), '');
  for (const k of ['cloud', 'lan', 'tailscale', '']) assert.ok(S.browserHint(k).length > 10);
});

console.log('live state');

test('waiting -> paired -> connected -> stays', () => {
  let s = S.initialState();
  assert.strictEqual(S.stateLine(s), 'Waiting for your phone.');
  s = S.nextState(s, { type: 'paired', name: 'Pixel 8', deviceId: 'd1' });
  assert.strictEqual(S.stateLine(s), 'Paired with Pixel 8. Waiting for it to connect.');
  s = S.nextState(s, { type: 'connected', deviceId: 'd1', name: 'Pixel 8' });
  assert.strictEqual(s.phase, 'connected');
  assert.strictEqual(S.stateLine(s), 'Connected: Pixel 8.');
  assert.strictEqual(S.nextState(s, { type: 'request', name: 'Other', code: '123456' }), s, 'a later request does not undo Connected');
});

test('another device connecting does not count', () => {
  let s = S.nextState(S.initialState(), { type: 'paired', name: 'Pixel 8', deviceId: 'd1' });
  const t = S.nextState(s, { type: 'connected', deviceId: 'd2', name: 'iPad' });
  assert.strictEqual(t, s);
  assert.strictEqual(S.nextState(S.initialState(), { type: 'connected', deviceId: 'd1' }).phase, 'waiting');
});

test('phone found shows the number and asks for the Approve click', () => {
  let s = S.nextState(S.initialState(), { type: 'request', name: 'iPhone', code: '042913' });
  assert.strictEqual(S.stateLine(s), 'iPhone wants to pair. Check that it shows 042 913, then click Approve.');
  const denied = S.nextState(s, { type: 'request-resolved', approved: false });
  assert.strictEqual(denied.phase, 'waiting');
  const ok = S.nextState(s, { type: 'request-resolved', approved: true, deviceId: 'd9' });
  assert.deepStrictEqual([ok.phase, ok.deviceId, ok.name], ['paired', 'd9', 'iPhone']);
});

test('the dialog and every pairing surface say ECHOCAT, not "Pair Mobile App"', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['renderer/index.html', 'renderer/pair-popout.html', 'renderer/pair-request-popout.html']) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/Pair Mobile App/.test(txt), f + ': "Pair Mobile App" retired');
    assert.ok(!/POTACAT mobile app/.test(txt), f + ': "the POTACAT mobile app" retired');
  }
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  const dlg = html.slice(html.indexOf('<dialog id="pair-device-dialog">'), html.indexOf('</dialog>', html.indexOf('<dialog id="pair-device-dialog">')));
  assert.ok(dlg.includes("Point your phone's camera here"));
  assert.ok(!/Regenerate/.test(dlg), 'no Regenerate button: the code renews itself');
  assert.ok(/<details class="pair-screen-trouble"/.test(dlg) && /Trouble pairing\?/.test(dlg));
  const trouble = dlg.slice(dlg.indexOf('<details class="pair-screen-trouble"'));
  for (const id of ['pair-manual-host', 'pair-manual-token', 'pair-manual-fp', 'pair-device-qr-copy-url', 'pair-link-list']) {
    assert.ok(trouble.includes('id="' + id + '"'), id + ' lives behind "Trouble pairing?"');
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
