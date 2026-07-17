// SDR list two-layer sync (desktop-ask sdr-list-full-sync): the full
// kiwiSdrList and the legacy 3-slot keys must stay in lockstep — slots are a
// view onto entries 0-2 — with mobile-matching overlay/compaction semantics
// (potacat-app src/utils/sdrList.ts) so the two ends can't drift, and
// sanitizeVfoProfiles-grade ingest hygiene so a client blob is never
// persisted verbatim. Run: node test/sdr-list-sync-test.js
'use strict';

const assert = require('assert');
const { sanitizeKiwiSdrList, reconcileSdrSettings } = require('../lib/sdr-list-sync');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const E = (label, host) => ({ label, host });
const FIVE = [E('A', 'a:8073'), E('B', 'b:8073'), E('C', 'c:8073'), E('D', 'd:8073'), E('E', 'e:8073')];

console.log('sanitizeKiwiSdrList:');
check(sanitizeKiwiSdrList(null).length === 0, 'non-array → []');
check(sanitizeKiwiSdrList([null, 'x', 42, []]).length === 0, 'garbage entries dropped');
check(sanitizeKiwiSdrList([E('ok', 'h:8073'), E('no-host', '  ')]).length === 1, 'blank-host entries dropped (dense invariant)');
{
  const r = sanitizeKiwiSdrList([{ label: 7, host: 'h:8073', extra: 1 }]);
  check(r[0].label === '7' && r[0].host === 'h:8073' && !('extra' in r[0]), 'coerces to strings, strips unknown fields');
}
check(sanitizeKiwiSdrList([E('x'.repeat(200), 'h:8073')])[0].label.length === 64, 'label clamped to 64');
check(sanitizeKiwiSdrList([E('a', 'h'.repeat(300))])[0].host.length === 128, 'host clamped to 128');
check(sanitizeKiwiSdrList(Array.from({ length: 250 }, (_, i) => E('n' + i, 'h' + i + ':8073'))).length === 100, 'list capped at 100');

console.log('reconcileSdrSettings — nothing SDR-related:');
check(reconcileSdrSettings({ scanDwell: 7 }, FIVE) === null, 'non-SDR partial → null (push behaves exactly as before)');
check(reconcileSdrSettings(null, FIVE) === null, 'null partial → null');
check(reconcileSdrSettings({ kiwiSdrList: 'bogus' }, FIVE) === null, 'non-array kiwiSdrList + no slots → null');

console.log('reconcileSdrSettings — phone edit (both layers):');
{
  // Acceptance: add 5 SDRs on the phone → all persisted, slots match 0-2.
  const partial = {
    kiwiSdrList: FIVE,
    kiwiSdrLabel1: 'A', kiwiSdrHost1: 'a:8073',
    kiwiSdrLabel2: 'B', kiwiSdrHost2: 'b:8073',
    kiwiSdrLabel3: 'C', kiwiSdrHost3: 'c:8073',
  };
  const r = reconcileSdrSettings(partial, []);
  check(r.list.length === 5, 'all 5 entries adopted');
  check(r.slotKeys.kiwiSdrHost2 === 'b:8073' && r.slotKeys.kiwiSdrLabel3 === 'C', 'derived slots match entries 0-2');
}
{
  // Phone deletes the top row: list of 4 + slots mirroring the new 0-2.
  const partial = {
    kiwiSdrList: FIVE.slice(1),
    kiwiSdrLabel1: 'B', kiwiSdrHost1: 'b:8073',
    kiwiSdrLabel2: 'C', kiwiSdrHost2: 'c:8073',
    kiwiSdrLabel3: 'D', kiwiSdrHost3: 'd:8073',
  };
  const r = reconcileSdrSettings(partial, FIVE);
  check(r.list.length === 4 && r.list[0].label === 'B', 'top-row delete adopted wholesale');
}

console.log('reconcileSdrSettings — slots-only edit (web client / Settings form):');
{
  // Acceptance: edit slot 2 → row 1 updates, entries 4+ untouched.
  const r = reconcileSdrSettings({ kiwiSdrLabel2: 'B2', kiwiSdrHost2: 'b2:8073' }, FIVE);
  check(r.list[1].label === 'B2' && r.list[1].host === 'b2:8073', 'slot 2 edit lands on entry 1');
  check(r.list.length === 5 && r.list[3].label === 'D' && r.list[4].label === 'E', 'entries 4-5 untouched');
  check(r.slotKeys.kiwiSdrLabel2 === 'B2', 'derived slot reflects the edit');
}
{
  // Clearing a slot's host removes the row and shifts later entries up
  // (mobile applyDesktopSlots compaction semantics).
  const r = reconcileSdrSettings({ kiwiSdrHost2: '' }, FIVE);
  check(r.list.length === 4 && r.list[1].label === 'C', 'cleared slot compacts, entries shift up');
  check(r.slotKeys.kiwiSdrLabel3 === 'D', 'derived slot 3 shows the shifted-up entry');
}
{
  // Slot edit with NO existing list creates one (desktop-only user).
  const r = reconcileSdrSettings({ kiwiSdrLabel1: 'X', kiwiSdrHost1: 'x:8073' }, undefined);
  check(r.list.length === 1 && r.list[0].host === 'x:8073', 'slots-only edit creates the list');
}
{
  // Absent slot keys keep current values — a partial touching only slot 1
  // must not blank slots 2-3 (window overlay, not replace).
  const r = reconcileSdrSettings({ kiwiSdrLabel1: 'A1', kiwiSdrHost1: 'a1:8073' }, FIVE);
  check(r.list[1].label === 'B' && r.list[2].label === 'C', 'untouched slots keep current entries');
}

console.log('reconcileSdrSettings — layer precedence + idempotence:');
{
  // Inconsistent layers: slot keys win for rows 0-2 (phone's receive rule).
  const partial = { kiwiSdrList: FIVE, kiwiSdrLabel1: 'OVR', kiwiSdrHost1: 'ovr:8073' };
  const r = reconcileSdrSettings(partial, []);
  check(r.list[0].host === 'ovr:8073' && r.list.length === 5, 'slot overlay wins over list rows 0-2');
}
{
  // The desktop Settings form re-sends unchanged slot keys on EVERY save —
  // reconciling must be a no-op then (5 entries stay 5).
  const partial = {
    kiwiSdrLabel1: 'A', kiwiSdrHost1: 'a:8073',
    kiwiSdrLabel2: 'B', kiwiSdrHost2: 'b:8073',
    kiwiSdrLabel3: 'C', kiwiSdrHost3: 'c:8073',
  };
  const r = reconcileSdrSettings(partial, FIVE);
  check(r.list.length === 5 && r.list.every((e, i) => e.label === FIVE[i].label), 'unchanged slot re-send is idempotent');
}
{
  // Sanitize applies through reconcile too — a hostile list blob is cleaned.
  const r = reconcileSdrSettings({ kiwiSdrList: [E('ok', 'h:8073'), null, E('bad', '')] }, []);
  check(r.list.length === 1, 'reconcile sanitizes the incoming list');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'sdr-list-sync tests failed');
