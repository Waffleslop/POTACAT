#!/usr/bin/env node
'use strict';
// Reviewing a JTCAT contact before it is written (lib/log-review.js), when a
// QSO began (lib/jtcat-qso-clock.js) and the fields the record gained.
// Run: node test/log-review-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LogReviewQueue, prefillFor, mergeEdits } = require('../lib/log-review');
const { JtcatQsoClock, IDLE_MS } = require('../lib/jtcat-qso-clock');
const { expandContact } = require('../lib/qso-expand');
const { buildAdifFields } = require('../lib/adif-writer');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const held = () => ({
  callsign: 'K1ABC', frequency: '7047.5', mode: 'FT4', band: '40m',
  qsoDate: '20261102', timeOn: '195912', qsoDateOff: '20261102', timeOff: '200101',
  rstSent: '-12', rstRcvd: '+03', gridsquare: 'FN42', gridHeard: true, comment: 'JTCAT FT4',
  hunted: [{ sig: 'POTA', ref: 'US-1234' }, { sig: 'POTA', ref: 'US-5678' }, { sig: 'WWFF', ref: 'KFF-1' }],
  contestId: 'ARRL-FIELD-DAY', srxString: '2A EMA',
});
// What the form sends back when nothing was touched.
const untouched = (r) => {
  const p = prefillFor({ id: 1, record: r }, 0);
  return {
    callsign: p.callsign, frequency: String(p.freqKhz), mode: p.mode, band: r.band,
    qsoDate: p.qsoDate, timeOn: p.timeOn.slice(0, 4), rstSent: p.rstSent, rstRcvd: p.rstRcvd,
    sig: p.reference ? p.type.toUpperCase() : '', sigInfo: p.reference, comment: p.notes,
  };
};

test('Save with nothing changed writes the held record, every field of it', () => {
  const r = held();
  assert.deepStrictEqual(mergeEdits(r, untouched(r)), { ...r });
});

test('the form shows the first program with a chip and every ref of it', () => {
  const p = prefillFor({ id: 7, record: held() }, 2);
  assert.deepStrictEqual([p.review, p.waiting, p.force, p.type, p.reference], [7, 2, true, 'pota', 'US-1234,US-5678']);
  assert.strictEqual(p.freqKhz, 7047.5);
  const gma = { ...held(), hunted: [{ sig: 'GMA', ref: 'W1/AB-001' }] };
  assert.strictEqual(prefillFor({ id: 1, record: gma }, 0).type, 'dx', 'no chip for GMA');
  const m = mergeEdits(gma, untouched(gma));
  assert.deepStrictEqual(m.hunted, gma.hunted, 'a park the form cannot show survives Save');
});

test('a typed park replaces what was spotted; a typed park with none spotted is used', () => {
  const r = held();
  const m = mergeEdits(r, { ...untouched(r), sig: 'POTA', sigInfo: 'US-9999', potaRef: 'US-9999' });
  assert.ok(!m.hunted);
  assert.deepStrictEqual([m.sig, m.sigInfo, m.potaRef], ['POTA', 'US-9999', 'US-9999']);
  const none = { ...held() }; delete none.hunted;
  const n = mergeEdits(none, { ...untouched(none), sig: 'POTA', sigInfo: 'US-1', potaRef: 'US-1' });
  assert.deepStrictEqual([n.sig, n.sigInfo], ['POTA', 'US-1'], 'the park JTCAT could not know');
});

test('a corrected call drops what belonged to the old one', () => {
  const r = held();
  const m = mergeEdits(r, { ...untouched(r), callsign: 'K1ABD', sig: '', sigInfo: '' });
  assert.deepStrictEqual([m.callsign, m.gridsquare, m.gridHeard, m.hunted], ['K1ABD', '', false, undefined]);
  assert.strictEqual(m.srxString, '2A EMA', 'the exchange stays');
});

test('seconds and the measured end stay unless the start was corrected', () => {
  const r = held();
  const same = mergeEdits(r, untouched(r));
  assert.deepStrictEqual([same.timeOn, same.timeOff], ['195912', '200101']);
  const moved = mergeEdits(r, { ...untouched(r), timeOn: '1950' });
  assert.deepStrictEqual([moved.timeOn, moved.timeOff, moved.qsoDateOff], ['1950', undefined, undefined]);
});

test('a frequency edit moves the band with it; an unchanged one keeps its precision', () => {
  const r = held();
  assert.strictEqual(mergeEdits(r, { ...untouched(r), frequency: '7047.50' }).frequency, '7047.5');
  const m = mergeEdits(r, { ...untouched(r), frequency: '14074', band: '20m' });
  assert.deepStrictEqual([m.frequency, m.band], ['14074', '20m']);
});

test('the queue: order, a failed save back at the front, held calls count as worked', () => {
  const q = new LogReviewQueue();
  const a = q.add({ callsign: 'K1A', band: '20m', mode: 'FT8' }, { relogKey: 'a' });
  const b = q.add({ callsign: 'K1B', band: '20m', mode: 'FT8' });
  assert.deepStrictEqual([q.current.id, q.waiting, q.size], [a.id, 1, 2]);
  assert.ok(q.holds('k1a', '20M', 'ft8'));
  assert.ok(!q.holds('K1A', '40m', 'FT8'), 'another band is a new contact');
  const t = q.take(a.id);
  assert.strictEqual(q.current.id, b.id);
  q.putBack(t);
  assert.strictEqual(q.current.id, a.id);
  assert.strictEqual(q.take(999), null);
  assert.strictEqual(q.drain().length, 2);
  assert.strictEqual(q.size, 0);
});

test('the QSO clock: first note wins, survives a new object, an idle attempt starts afresh', () => {
  const c = new JtcatQsoClock();
  c.note('k1abc', 1000);
  c.note('K1ABC', 61000);
  assert.strictEqual(c.take('<K1ABC>', 120000), 1000);
  assert.strictEqual(c.take('K1ABC', 130000), 130000, 'taken: gone');
  c.note('K1ABC', 0);
  c.note('K1ABC', IDLE_MS + 1);
  assert.strictEqual(c.take('K1ABC', IDLE_MS + 2), IDLE_MS + 1);
  assert.strictEqual(c.take('N0CALL', 5), 5, 'never noted: now');
});

test('records carry TIME_OFF, QTH, CQZ, ITUZ and CONT', () => {
  const recs = expandContact({ callsign: 'K1ABC', mode: 'FT8', frequency: '14074', qsoDate: '20261102', timeOn: '195912', qsoDateOff: '20261102', timeOff: '200101' }, {
    callInfo: () => ({ name: 'Ann', state: 'MA', qth: 'Boston', cqz: '5', ituz: '8' }),
    entityFor: () => ({ name: 'United States', away: false, cont: 'NA', cqz: 4, ituz: 7 }),
  });
  const f = buildAdifFields(recs[0]);
  assert.deepStrictEqual([f.TIME_ON, f.TIME_OFF, f.QSO_DATE_OFF, f.QTH, f.CQZ, f.ITUZ, f.CONT], ['195912', '200101', '20261102', 'Boston', '5', '8', 'NA']);
});

test('zones and city: an away or slash call never takes QRZ; a park contact has no home city', () => {
  const qrz = () => ({ name: 'Ann', qth: 'Boston', cqz: '5', ituz: '8' });
  const away = expandContact({ callsign: '6W/IK2HKT', mode: 'FT8' }, {
    callInfo: qrz, entityFor: () => ({ name: 'Senegal', away: true, cont: 'AF', cqz: 35, ituz: 46 }),
  })[0];
  assert.deepStrictEqual([away.qth, away.cqz, away.ituz, away.cont], ['', '35', '46', 'AF']);
  const slash = expandContact({ callsign: 'K1ABC/4', mode: 'FT8' }, {
    callInfo: qrz, entityFor: () => ({ name: 'United States', away: false, cont: 'NA', cqz: 5, ituz: 8 }),
  })[0];
  assert.strictEqual(slash.cqz, '5');
  const park = expandContact({ callsign: 'K1ABC', mode: 'FT8', sig: 'POTA', sigInfo: 'US-1' }, {
    callInfo: qrz, entityFor: () => ({ name: 'United States', away: false, cont: 'NA', cqz: 5, ituz: 8 }),
  })[0];
  assert.strictEqual(park.qth, '');
  const none = expandContact({ callsign: 'K1ABC', mode: 'FT8' })[0];
  assert.deepStrictEqual([none.cqz, none.ituz, none.cont, none.qth], ['', '', '', ''], 'no data, no field');
  assert.ok(!('CQZ' in buildAdifFields(none)));
});

test('wiring: only the window prompts, a phone never does, and a held call counts as worked', () => {
  const main = R('main.js');
  assert.ok(main.includes('opts && opts.fromWindow && settings.jtcatLogPrompt === true'));
  const onDone = main.slice(main.indexOf('function remoteJtcatOnDone'), main.indexOf('function processRemoteJtcatQso'));
  assert.ok(!onDone.includes('fromWindow'), 'a phone-run QSO logs by itself');
  const remote = main.slice(main.indexOf("remoteServer.on('jtcat-log-qso'"), main.indexOf("remoteServer.on('signal-from-client'"));
  assert.ok(!remote.includes('fromWindow'));
  assert.ok(/jtcatLogReviews\.holds\(c, band, mode\)/.test(main));
  assert.ok(!Object.keys(require('../lib/remote-bridge').JTCAT_PREFS).includes('jtcatLogPrompt'), 'never sent to a shack, where nobody may be sitting');
  assert.ok(/app\.on\('before-quit', \(e\) => \{\s+if \(jtcatLogReviews\.size\)/.test(main), 'quitting writes what is waiting');
  const html = R('renderer/jtcat-popout.html');
  assert.ok(html.includes('id="jp-log-prompt"'));
  assert.ok(R('renderer/log-popout.html').includes('<option value="FT2">FT2</option>'));
  assert.ok(R('renderer/log-popout.html').includes('id="lp-review" hidden'));
  assert.ok(!/freqInput\.value = String\(Math\.round\(p\.freqKhz\)\);\s+if \(p\.mode\) \{\s+const m = modeFamily\(p\.mode\);\s+if \(\[\.\.\.modeSelect\.options\]\.some\(\(o\) => o\.value === m\)\) modeSelect\.value = m;\s+\}\s+\/\/ What this prefill/.test(R('renderer/log-popout.js')), 'a prefill keeps 7047.5');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
