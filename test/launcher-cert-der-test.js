// The Remote Launcher's own self-signed certificate had the same DER serial
// bug as ECHOCAT's (#260): about 1 in 512 was invalid ("illegal padding"),
// seen in CI in launcher-cloud-test. Worse, the launcher reused its saved
// certificate for a year without checking it.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-der-'));
process.env.POTACAT_LAUNCHER_DIR = dir;
const L = require('../scripts/launcher');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const hex = (b) => b.toString('hex');

console.log('launcher certificate (DER serial)');
test('derInt drops leading zeros and keeps one 0x00 for a high byte', () => {
  assert.strictEqual(hex(L._derInt(Buffer.from([0x00, 0x12, 0x34]))), '02021234');
  assert.strictEqual(hex(L._derInt(Buffer.from([0x00, 0x00, 0x9a]))), '0202009a');
  assert.strictEqual(hex(L._derInt(Buffer.from([0x80, 0x01]))), '0203008001');
  assert.strictEqual(hex(L._derInt(Buffer.from([0x02]))), '020102');
});
test('a certificate generated with a 0x00 0x12 serial parses', () => {
  const real = crypto.randomBytes;
  crypto.randomBytes = (n, ...a) => { const b = real(n, ...a); if (n === 8 && !a.length) { b[0] = 0x00; b[1] = 0x12; } return b; };
  try {
    for (const f of ['launcher-cert.pem', 'launcher-key.pem']) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    const { cert } = L.generateTlsCert();
    new crypto.X509Certificate(cert);
  } finally { crypto.randomBytes = real; }
});
test('a saved certificate that does not parse is regenerated, not reused', () => {
  fs.writeFileSync(path.join(dir, 'launcher-cert.pem'), '-----BEGIN CERTIFICATE-----\nMIIBAA==\n-----END CERTIFICATE-----\n');
  fs.writeFileSync(path.join(dir, 'launcher-key.pem'), 'not a key');
  const { cert } = L.generateTlsCert();
  new crypto.X509Certificate(cert);
  assert.ok(!/MIIBAA==/.test(cert));
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
