// The self-signed ECHOCAT certificate's serial is 8 random bytes, DER-encoded
// by derInt. DER requires the shortest form: no leading 0x00 unless the next
// byte has its high bit set. A serial starting 0x00 0x00-0x7f (about 1 in 512)
// made a certificate OpenSSL rejects ("asn1 encoding routines::illegal
// padding"), seen in CI in guest-pass-lease-end-test.
const assert = require('assert');
const crypto = require('crypto');
const { _derInt: derInt } = require('../lib/remote-server');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const hex = (b) => b.toString('hex');

console.log('DER INTEGER encoding (TLS serial)');
test('a leading zero byte before a low byte is dropped', () => {
  assert.strictEqual(hex(derInt(Buffer.from([0x00, 0x12, 0x34]))), '02021234');
});
test('several leading zeros are all dropped', () => {
  assert.strictEqual(hex(derInt(Buffer.from([0x00, 0x00, 0x00, 0x7f]))), '02017f');
});
test('a high first byte gets one 0x00 so it stays positive', () => {
  assert.strictEqual(hex(derInt(Buffer.from([0x80, 0x01]))), '0203008001');
});
test('zeros then a high byte keep exactly one 0x00', () => {
  assert.strictEqual(hex(derInt(Buffer.from([0x00, 0x00, 0x9a]))), '0202009a');
});
test('all zeros encodes as the integer 0', () => {
  assert.strictEqual(hex(derInt(Buffer.from([0x00, 0x00]))), '020100');
});
test('the v3 version field is unchanged', () => {
  assert.strictEqual(hex(derInt(Buffer.from([0x02]))), '020102');
});
test('1000 random 8-byte serials are all minimal DER', () => {
  for (let i = 0; i < 1000; i++) {
    const r = crypto.randomBytes(8);
    if (i < 300) r[0] = 0; // force the bad case often
    const d = derInt(r);
    const v = d.subarray(2);
    assert.strictEqual(d[1], v.length);
    if (v.length > 1) assert.ok(!(v[0] === 0x00 && !(v[1] & 0x80)), 'non-minimal: ' + hex(d));
    assert.ok(!(v[0] & 0x80), 'negative: ' + hex(d));
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
