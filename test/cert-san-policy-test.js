#!/usr/bin/env node
'use strict';
// Cert-pin Phase 1 + 2a (work item cert-pin-spki-migration).
// Pure policy cases + an INTEGRATION pass over the real getOrCreateTlsCert:
// the SPKI must survive a cert reissue (persisted keypair) and must change
// on a genuine key reset — silently keeping identity across a real key
// change is the failure mode this feature must never introduce.
// Run: node test/cert-san-policy-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { requiredSanSet, certCoverageGaps } = require('../lib/cert-san-policy');
const { getOrCreateTlsCert } = require('../lib/remote-server');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const REQ = requiredSanSet({
  advertisedIps: ['192.168.1.50'],
  hostname: 'px230',
  tailscaleHostname: 'px230.tail1234.ts.net',
});

test('required set = loopback + advertised IPs + hostname/.local + tailscale', () => {
  assert.ok(REQ.ips.has('127.0.0.1') && REQ.ips.has('192.168.1.50'));
  assert.ok(REQ.dns.has('px230') && REQ.dns.has('px230.local') && REQ.dns.has('px230.tail1234.ts.net'));
});

test('a Docker/VPN adapter IP absent from the SAN does NOT regenerate', () => {
  // The cert covers everything required; the machine ALSO has 172.17.0.1
  // (Docker) which the cert has never heard of. Old rule: regenerate, kill
  // every pairing. New rule: not our problem — nobody is told to dial it.
  const g = certCoverageGaps({
    sanIps: new Set(['127.0.0.1', '192.168.1.50']),
    sanDns: new Set(['px230', 'px230.local', 'px230.tail1234.ts.net']),
    required: REQ,
  });
  assert.strictEqual(g.regen, false, 'regenerated for an unadvertised interface');
});

test('TAILNET RENAME still regenerates (the case the old eagerness fixed)', () => {
  // Cert carries the OLD MagicDNS name; required carries the current one.
  const g = certCoverageGaps({
    sanIps: new Set(['127.0.0.1', '192.168.1.50']),
    sanDns: new Set(['px230', 'px230.local', 'px230.OLDNAME.ts.net']),
    required: REQ,
  });
  assert.strictEqual(g.regen, true);
  assert.deepStrictEqual(g.missingDns, ['px230.tail1234.ts.net']);
});

test('hostname change regenerates; a newly ADVERTISED IP regenerates', () => {
  const g1 = certCoverageGaps({
    sanIps: new Set(['127.0.0.1', '192.168.1.50']),
    sanDns: new Set(['oldname', 'oldname.local', 'px230.tail1234.ts.net']),
    required: REQ,
  });
  assert.strictEqual(g1.regen, true);
  const g2 = certCoverageGaps({
    sanIps: new Set(['127.0.0.1', '10.0.0.9']), // advertised IP changed (new DHCP lease)
    sanDns: new Set(['px230', 'px230.local', 'px230.tail1234.ts.net']),
    required: REQ,
  });
  assert.strictEqual(g2.regen, true);
});

test('no tailscale = no tailscale requirement (LAN-only stations)', () => {
  const req = requiredSanSet({ advertisedIps: [], hostname: 'shack', tailscaleHostname: null });
  assert.ok(!([...req.dns].some((d) => d.includes('ts.net'))));
});

// ── Integration: the SPKI survives reissue, and only reissue ───────────────

function spkiHashOf(certPem) {
  const x509 = new crypto.X509Certificate(certPem);
  return crypto.createHash('sha256')
    .update(x509.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}
function fingerprintOf(certPem) {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-cert-test-'));
try {
  test('fresh install mints cert + persisted key', () => {
    const t = getOrCreateTlsCert(dir, {});
    assert.ok(t && t.cert && t.key);
    assert.ok(fs.existsSync(path.join(dir, 'remote-cert.pem')));
    assert.ok(fs.existsSync(path.join(dir, 'remote-key.pem')));
  });

  test('REISSUE keeps the SPKI, changes the fingerprint (Phase 2a core)', () => {
    const before = fs.readFileSync(path.join(dir, 'remote-cert.pem'), 'utf8');
    // Force a genuine reissue: delete only the cert, keep the key.
    fs.unlinkSync(path.join(dir, 'remote-cert.pem'));
    const t = getOrCreateTlsCert(dir, {});
    assert.notStrictEqual(fingerprintOf(t.cert), fingerprintOf(before), 'reissue must change the cert hash');
    assert.strictEqual(spkiHashOf(t.cert), spkiHashOf(before), 'reissue must NOT change the SPKI — the whole point');
  });

  test('REGRESSION GUARD: a real key reset changes the SPKI', () => {
    const before = fs.readFileSync(path.join(dir, 'remote-cert.pem'), 'utf8');
    fs.unlinkSync(path.join(dir, 'remote-cert.pem'));
    fs.unlinkSync(path.join(dir, 'remote-key.pem'));
    const t = getOrCreateTlsCert(dir, {});
    assert.notStrictEqual(spkiHashOf(t.cert), spkiHashOf(before),
      'a genuine identity change MUST change the SPKI — phones must refuse it');
  });

  test('requiredSan opt keeps a covering cert cached across a fake extra interface', () => {
    // The cert on disk covers required; pass a required set it satisfies and
    // confirm the same PEM comes back untouched (no silent reissue).
    const before = fs.readFileSync(path.join(dir, 'remote-cert.pem'), 'utf8');
    const x509 = new crypto.X509Certificate(before);
    const req = { ips: new Set(['127.0.0.1']), dns: new Set() };
    const t = getOrCreateTlsCert(dir, { requiredSan: req });
    assert.strictEqual(fingerprintOf(t.cert), fingerprintOf(before), 'covering cert must be reused as-is');
    assert.ok(x509.subjectAltName.includes('127.0.0.1'));
  });
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\nCert SAN policy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
