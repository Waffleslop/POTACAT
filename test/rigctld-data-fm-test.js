// GitHub #259 (NA4DQ, IC-7100 on rigctld, 1200-baud packet on 2 m): since
// 1.14.0 a DATA key-down waits for the radio to report DATA. FM's data form
// is DIGFM, and the rigctld codec had no token for it, so resolveMode gave
// null, no mode command went out, the radio stayed FM, and every packet over
// ended "released before the radio reported the DATA mode — not keyed".
const assert = require('assert');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const PttModeSwap = require('../lib/ptt-mode-swap');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const codec = () => new RigctldCodec({ brand: 'Icom', model: 'IC-7100' }, () => {});

console.log('rigctld: the data form of every voice mode has a token (#259)');
for (const voice of ['USB', 'LSB', 'FM', 'AM']) {
  const data = PttModeSwap.dataFormOf(voice);
  test(`${voice} -> ${data} resolves to a rigctld token`, () => {
    const t = codec().resolveMode(data, 145630000);
    assert.ok(t, `${data} resolved to ${t}`);
    assert.ok(PttModeSwap.isDataModeName(t), `${t} reads back as a DATA mode`);
  });
}
test('DIGFM is Hamlib PKTFM, DIGAM is PKTAM', () => {
  assert.strictEqual(codec().resolveMode('DIGFM', 145630000), 'PKTFM');
  assert.strictEqual(codec().resolveMode('DIGAM', 7200000), 'PKTAM');
});
test('PKTFM / PKTAM pass through by their own names', () => {
  assert.strictEqual(codec().resolveMode('PKTFM', 145630000), 'PKTFM');
  assert.strictEqual(codec().resolveMode('PKTAM', 7200000), 'PKTAM');
});
test('the existing tokens are unchanged', () => {
  const c = codec();
  assert.strictEqual(c.resolveMode('DIGU', 14095600), 'PKTUSB');
  assert.strictEqual(c.resolveMode('DIGL', 7000000), 'PKTLSB');
  assert.strictEqual(c.resolveMode('FM', 145630000), 'FM');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
