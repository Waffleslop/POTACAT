// #250: an unverified licence class never refuses a transmission or a tune.
// The ATU wizard and Guest Pass called isOutOfPrivilege directly, so before
// this an unverified class (e.g. a future UK class) would have refused there
// even though txPrivilegeRefusal doesn't.
const assert = require('assert');
const P = require('../lib/privileges');
const { pointAllowed } = require('../lib/atu-wizard');
const { PassEnforcement } = require('../lib/pass-enforcement');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// A fake class in the shared module instance both libs use: 10 m only.
const FAKE = 'xx_gate_fake';
const ranges = [[28000, 29700, 'all']];
P.CLASSES[FAKE] = { label: 'XX Fake', country: 'XX', ranges, verified: false, source: 'test fixture' };
P.PRIVILEGE_MAP[FAKE] = ranges;
P.CLASS_LABELS[FAKE] = 'XX Fake';

function guest(cls) {
  const pe = new PassEnforcement({ revalidateMs: 0, log: () => {} });
  pe._state = 'active';
  pe._pass = { code: 'T', guest_callsign: 'KF0WWL', privilege_class: cls, privilege_class_short: 'x', max_power_w: 100, allowed_modes: [] };
  pe._expiresAtMs = Date.now() + 3600_000;
  pe._rigPowerReadable = () => true;
  return pe;
}

console.log('unverified classes never refuse (#250)');
test('premise: the spot filter does treat 20 m as outside the fake class', () => {
  assert.strictEqual(P.isOutOfPrivilege(14074, 'FT8', FAKE), true);
});
test('ATU wizard: an unverified class does not refuse a point (treated like no class)', () => {
  assert.notStrictEqual(pointAllowed(14074, 'DIGITAL', FAKE, 5).reason, 'outside your privileges');
  assert.deepStrictEqual(pointAllowed(14074, 'DIGITAL', FAKE, 5), pointAllowed(14074, 'DIGITAL', 'none', 5));
});
test('ATU wizard: a verified class still refuses (Technician, 20 m phone)', () => {
  assert.strictEqual(pointAllowed(14250, 'SSB', 'us_technician', 5).ok, false);
});
test('Guest Pass: an unverified class does not refuse a key-down on 20 m', () => {
  const r = guest(FAKE).interceptCatCommand({ type: 'tx_enable', freqHz: 14074000, mode: 'DATA', currentWatts: 20, powerAgeMs: 0 });
  assert.notStrictEqual(r.reason, 'out_of_band', JSON.stringify(r));
});
test('Guest Pass: an unverified class does not refuse SSTV on 20 m', () => {
  const r = guest(FAKE).interceptCatCommand({ type: 'sstv_tx', freqHz: 14230000, mode: 'USB' });
  assert.notStrictEqual(r.reason, 'out_of_band', JSON.stringify(r));
});
test('Guest Pass: a verified class still refuses (Technician, USB on 14.250)', () => {
  const r = guest('us_technician').interceptCatCommand({ type: 'tx_enable', freqHz: 14250000, mode: 'USB' });
  assert.strictEqual(r.reason, 'out_of_band');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
