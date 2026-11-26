#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Hunt answering a station that calls us directly honours the operator's
// "Call a station again after N days" (jtcatReworkDays) exactly as Hunt's CQ
// pick, Run and the double-click dupe warning do: jtcatWorkedInfo, one
// definition. Before the fix the direct-caller path tested "anywhere in the
// log, ever, any band or mode", so a station last worked days ago on a 1-day
// setting was never answered by Hunt while a manual reply went through with
// "already worked (aged-out)".
// Run: node test/jtcat-hunt-direct-caller-worked-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const WorkedBefore = require('../lib/worked-before');

const main = readSrc(path.join(__dirname, '..', 'main.js'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

function slice(from, to) {
  const a = main.indexOf(from);
  const b = main.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, 'slice ' + from);
  return main.slice(a, b);
}

const MY = 'W1ME';
const THEM = 'K9XYZ';
const today = WorkedBefore.utcDateStamp(new Date());
const daysAgo = (n) => WorkedBefore.cutoffStamp(today, n);

// The real jtcatReworkDaysSetting + jtcatWorkedInfo + jtcatTryAnswerDirectCaller,
// with the engine and QSO plumbing stubbed. Returns whether Hunt engaged THEM.
async function huntAnswers({ reworkDays, entries, spottedRefs }) {
  const marks = [];
  const ctx = {
    settings: { jtcatReworkDays: reworkDays },
    workedQsos: new Map(entries ? [[THEM, entries]] : []),
    WorkedBefore,
    jtcatSpottedActivator: () => (spottedRefs ? { refs: spottedRefs.map((ref) => ({ ref })) } : null),
    jtcatCurrentBandMode: () => ({ band: '20M', mode: 'FT8' }),
    _autoSeqEnabled: () => true,
    ft8Engine: { setRxFreq() {}, setTxFreq() {}, setTxMessage: async () => {}, setTxSlot() {}, tryImmediateTx() {}, _txEnabled: false },
    JtcatParser: require('../renderer/jtcat-parser'),
    HuntFilters: require('../lib/jtcat-hunt-filters'),
    jtcatIgnoreList: () => [],
    JtcatTxSlot: { workableUnderLock: () => true },
    jtcatTxSlotLock: () => null,
    jtcatFdContext: () => null,
    jtcatReplySlot() {},
    jtcatAutoCqOwner: 'popout',
    popoutJtcatQso: null,
    remoteJtcatQso: null,
    processPopoutJtcatQso() { ctx.popoutJtcatQso.phase = 'report'; ctx.popoutJtcatQso.call = THEM; ctx.popoutJtcatQso.txMsg = THEM + ' ' + MY + ' -10'; },
    processRemoteJtcatQso() {},
    jtcatHuntStatusWorking() {},
    jtcatSessionMark: (c) => marks.push(c),
    sendCatLog() {},
    broadcastAutoCqState() {},
  };
  vm.createContext(ctx);
  vm.runInContext(
    slice('function jtcatReworkDaysSetting(', '/** Should an automatic path refuse') +
    slice('async function jtcatTryAnswerDirectCaller(', '// One give-up executor') +
    '\nthis.answer = jtcatTryAnswerDirectCaller;', ctx);
  const results = [{ text: MY + ' ' + THEM + ' FN03', df: 1200, db: -8, slot: 'odd' }];
  const engaged = await ctx.answer(results, MY, 'FN42');
  if (engaged) assert.deepStrictEqual(marks, [THEM]);
  return engaged;
}

const qso = (date, band, mode, ref) => ({ date, band: band || '20M', mode: mode || 'FT8', ref: ref || '' });

(async () => {
  await test('1-day setting, last QSO 5 days ago on this band and mode: Hunt answers them', async () => {
    assert.strictEqual(await huntAnswers({ reworkDays: 1, entries: [qso(daysAgo(10)), qso(daysAgo(5))] }), true);
  });

  await test('1-day setting, a QSO today on this band and mode: still skipped', async () => {
    assert.strictEqual(await huntAnswers({ reworkDays: 1, entries: [qso(daysAgo(5)), qso(today)] }), false);
  });

  await test('7-day setting, last QSO 3 days ago: still skipped (inside the interval)', async () => {
    assert.strictEqual(await huntAnswers({ reworkDays: 7, entries: [qso(daysAgo(3))] }), false);
  });

  await test('setting 0 (never call again): a QSO years ago on this band and mode still skips', async () => {
    assert.strictEqual(await huntAnswers({ reworkDays: 0, entries: [qso('20200101')] }), false);
  });

  await test('never worked: answered, as before', async () => {
    assert.strictEqual(await huntAnswers({ reworkDays: 0, entries: null }), true);
  });

  await test('worked only on another band: answered (the policy is band and mode aware, as on Hunt\'s CQ pick)', async () => {
    assert.strictEqual(await huntAnswers({ reworkDays: 0, entries: [qso(today, '40M')] }), true);
  });

  await test('spotted activator worked today at the park they are spotted at: skipped; at another park: answered', async () => {
    assert.strictEqual(await huntAnswers({ reworkDays: 0, entries: [qso(today, '20M', 'FT8', 'US-0001')], spottedRefs: ['US-0001'] }), false);
    assert.strictEqual(await huntAnswers({ reworkDays: 0, entries: [qso(today, '20M', 'FT8', 'US-0001')], spottedRefs: ['US-0002'] }), true);
  });

  await test('the worked-before policy itself is unchanged', async () => {
    const d = (entries, reworkDays) => WorkedBefore.decideWorkedBefore(entries, { band: '20M', mode: 'FT8', reworkDays, todayUtc: today });
    assert.strictEqual(d([qso(daysAgo(5))], 0).reason, 'blocking');
    assert.strictEqual(d([qso(daysAgo(5))], 1).reason, 'aged-out');
    assert.strictEqual(d([qso(today)], 1).reason, 'recent');
    assert.strictEqual(d([qso(today, '40M')], 1).reason, 'other-band-mode');
  });

  await test('every automatic path reads the one definition: no bare workedQsos.has in Hunt\'s direct-caller filter', async () => {
    const direct = slice('async function jtcatTryAnswerDirectCaller(', '// One give-up executor');
    assert.ok(!/workedQsos\.has\(/.test(direct), 'bare all-time test is gone');
    assert.ok(/jtcatWorkedInfo\(parts\[1\], callerBm\.band, callerBm\.mode\)\.blocking/.test(direct));
    // Hunt's CQ pick and Run's callers already read it.
    assert.ok(/\|\| \(\(call\) => jtcatIsWorkedCall\(call, dupeBandMode\.band, dupeBandMode\.mode\)\);/.test(main));
    assert.ok(/if \(jtcatWorkedInfo\(call, band, mode\)\.blocking\) return 'already worked ' \+ where;/.test(main));
  });

  console.log(`\nHunt direct caller and the call-again interval: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
