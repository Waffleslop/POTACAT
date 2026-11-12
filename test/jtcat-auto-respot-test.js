#!/usr/bin/env node
'use strict';
// JTCAT re-spots a hunted activator after a logged contact, opt-in only, with
// the same flags the Log QSO window's re-spot box sets (#351, DA2PK).
// Nothing here posts: the plan and the flags are pure (lib/jtcat-auto-respot.js),
// and the review path is checked through lib/log-review.js and source text.
// Run: node test/jtcat-auto-respot-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { planAutoRespot, applyAutoRespot, FRESH_SPOT_MS } = require('../lib/jtcat-auto-respot');
const { LogReviewQueue, prefillFor, mergeEdits } = require('../lib/log-review');
const { expandContact } = require('../lib/qso-expand');

const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const html = readSrc(path.join(root, 'renderer/jtcat-popout.html'));
const pop = readSrc(path.join(root, 'renderer/jtcat-popout.js'));
const logPop = readSrc(path.join(root, 'renderer/log-popout.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const NOW = Date.parse('2026-11-12T15:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString().slice(0, 19); // POTA shape, no Z
const ON = { jtcatAutoRespot: true };
const POTA = { sig: 'POTA', ref: 'DE-1197' };
const WWFF = { sig: 'WWFF', ref: 'DLFF-0123' };

function plan(settings, refs, extra) {
  return planAutoRespot({ settings, refs, spots: [], callsign: 'DK5UR', band: '20m', now: NOW, ...extra });
}
function record(refs) {
  return { callsign: 'DK5UR', band: '20m', mode: 'FT8', frequency: '14074', hunted: refs.map((r) => ({ ...r })) };
}
// The direct write: plan, then flags, as jtcatAutoLog does.
function direct(settings, refs, extra) {
  const q = record(refs);
  const p = plan(settings, refs, extra);
  applyAutoRespot(q, p, settings);
  return { q, p };
}

test('off by default: nothing is set, no spot goes out', () => {
  assert.strictEqual(plan({}, [POTA]), null);
  assert.strictEqual(plan({ jtcatAutoRespot: 'yes' }, [POTA]), null, 'only true turns it on');
  const { q } = direct({}, [POTA]);
  assert.strictEqual(q.respot, undefined);
  assert.strictEqual(q.wwffRespot, undefined);
});

test('on: POTA re-spot with the POTA template, the POTA ref first (only the first record carries the flags)', () => {
  const s = { ...ON, respotTemplate: '{rst} tnx {mycallsign}' };
  const { q } = direct(s, [WWFF, POTA]);
  assert.strictEqual(q.respot, true);
  assert.strictEqual(q.hunted[0].sig, 'POTA');
  assert.strictEqual(q.wwffRespot, true);
  assert.strictEqual(q.wwffReference, 'DLFF-0123');
  assert.strictEqual(q.respotComment, '{rst} tnx {mycallsign}');
  const recs = expandContact(q);
  assert.strictEqual(recs[0].sig, 'POTA');
  assert.ok(recs[0].respot && recs[0].wwffRespot, 'both flags on the first record');
  assert.ok(recs.slice(1).every((r) => !r.respot && !r.wwffRespot && !r.wwffRespotComment), 'never on a later record');
});

test('WWFF uses the WWFF template, else the POTA one', () => {
  const both = { ...ON, respotTemplate: 'P {rst}', wwffRespotTemplate: 'W {rst}' };
  let { q } = direct(both, [WWFF]);
  assert.strictEqual(q.respotComment, 'W {rst}', 'WWFF only: its own template');
  ({ q } = direct({ ...ON, respotTemplate: 'P {rst}' }, [WWFF]));
  assert.strictEqual(q.respotComment, 'P {rst}', 'no WWFF template: the POTA one');
  ({ q } = direct(both, [POTA, WWFF]));
  assert.deepStrictEqual([q.respotComment, q.wwffRespotComment], ['P {rst}', 'W {rst}'], 'both: each its own');
  assert.ok(/comments: qsoData\.wwffRespotComment \|\| qsoData\.respotComment \|\| ''/.test(main), 'saveQsoRecord posts WWFF with its own comment');
  assert.ok(/if \(qsoData\.wwffRespotComment\) qsoData\.wwffRespotComment = expand\(qsoData\.wwffRespotComment\);/.test(main), 'and expands its macros');
});

test('on, but a summit or other program only: nothing (no SOTA re-spot path here)', () => {
  assert.strictEqual(plan(ON, [{ sig: 'SOTA', ref: 'DM/NS-001' }]), null);
  const { q } = direct(ON, [{ sig: 'SOTA', ref: 'DM/NS-001' }]);
  assert.strictEqual(q.respot, undefined);
  assert.strictEqual(q.wwffRespot, undefined);
});

test('a manual log (no reports needed) never posts a public spot', () => {
  assert.strictEqual(plan(ON, [POTA], { manual: true }), null);
  const { q } = direct(ON, [POTA], { manual: true });
  assert.strictEqual(q.respot, undefined);
  assert.ok(/manual: !!\(opts && opts\.manual\)/.test(main), 'jtcatAutoLog passes opts.manual');
});

test('duplicate guard: a spot at that park on this band under 10 minutes old skips it', () => {
  const fresh = [{ source: 'pota', callsign: 'DK5UR', reference: 'DE-1197', frequency: '14074', spotTime: iso(4 * 60000) }];
  const p = plan(ON, [POTA], { spots: fresh });
  assert.deepStrictEqual([p.pota, p.skipped], [null, [{ sig: 'POTA', ref: 'DE-1197', ageMin: 4 }]]);
  const { q } = direct(ON, [POTA], { spots: fresh });
  assert.strictEqual(q.respot, undefined, 'no spot');
});

test('duplicate guard: an old spot, another band or another park still spots', () => {
  const old = [{ source: 'pota', callsign: 'DK5UR', reference: 'DE-1197', frequency: '14074', spotTime: iso(FRESH_SPOT_MS + 1000) }];
  assert.strictEqual(plan(ON, [POTA], { spots: old }).pota, 'DE-1197');
  const band = [{ source: 'pota', callsign: 'DK5UR', reference: 'DE-1197', frequency: '7074', spotTime: iso(60000) }];
  assert.strictEqual(plan(ON, [POTA], { spots: band }).pota, 'DE-1197');
  const park = [{ source: 'pota', callsign: 'DK5UR', reference: 'DE-0001', frequency: '14074', spotTime: iso(60000) }];
  assert.strictEqual(plan(ON, [POTA], { spots: park }).pota, 'DE-1197');
  const other = [{ source: 'pota', callsign: 'DL1ABC', reference: 'DE-1197', frequency: '14074', spotTime: iso(60000) }];
  assert.strictEqual(plan(ON, [POTA], { spots: other }).pota, 'DE-1197');
});

test('duplicate guard per program: a merged POTA+WWFF spot covers both; a POTA spot alone leaves WWFF', () => {
  const merged = [{ source: 'pota', callsign: 'DK5UR/P', reference: 'DE-1197', wwffReference: 'DLFF-0123', frequency: '14074', spotTime: iso(60000) }];
  const p = plan(ON, [POTA, WWFF], { spots: merged });
  assert.deepStrictEqual([p.pota, p.wwff, p.skipped.length], [null, null, 2]);
  const potaOnly = [{ source: 'pota', callsign: 'DK5UR', reference: 'DE-1197', frequency: '14074', spotTime: iso(60000) }];
  const p2 = plan(ON, [POTA, WWFF], { spots: potaOnly });
  assert.deepStrictEqual([p2.pota, p2.wwff], [null, 'DLFF-0123']);
  const { q } = direct(ON, [POTA, WWFF], { spots: potaOnly });
  assert.deepStrictEqual([q.respot, q.wwffRespot, q.respotComment], [undefined, true, '{rst} in {QTH} 73s {mycallsign} via POTACAT']);
  assert.ok(/\[JTCAT\] No re-spot: \$\{qsoData\.callsign\} @ \$\{s\.sig\} \$\{s\.ref\} already spotted/.test(main), 'one CAT log line when skipped');
});

// The Log QSO window under review: main holds the record, the form decides.
function review(settings, refs, form) {
  const q = new LogReviewQueue();
  const rec = record(refs);
  const p = plan(settings, refs);
  const item = q.add(rec, { relogKey: 'k', respotOn: !!(p && (p.pota || p.wwff)) });
  const pre = prefillFor(item, 0);
  const edits = {
    callsign: pre.callsign, frequency: String(pre.freqKhz), mode: pre.mode, band: rec.band,
    sig: pre.type.toUpperCase(), sigInfo: pre.reference, rstSent: '', rstRcvd: '',
    // What renderer/log-popout.js sends: respotFields only when the box is ticked.
    ...(form.ticked ? { respot: true, respotComment: 'tnx' } : {}),
  };
  return { pre, out: mergeEdits(item.record, edits) };
}

test('review, box unticked: no spot', () => {
  const { pre, out } = review(ON, [POTA], { ticked: false });
  assert.strictEqual(pre.respotOn, true, 'the box started ticked');
  assert.strictEqual(out.respot, undefined);
  assert.strictEqual(out.wwffRespot, undefined);
  // Even a record that somehow holds flags loses them when the form sends none.
  const held = mergeEdits({ ...record([POTA]), respot: true, wwffRespot: true, wwffReference: 'X', respotComment: 'c' }, { callsign: 'DK5UR' });
  assert.deepStrictEqual([held.respot, held.wwffRespot, held.wwffReference, held.respotComment], [undefined, undefined, undefined, undefined]);
});

test('review, box ticked: spot', () => {
  const { out } = review(ON, [POTA], { ticked: true });
  assert.deepStrictEqual([out.respot, out.respotComment], [true, 'tnx']);
});

test('review with the option off: the box starts unticked', () => {
  assert.strictEqual(review({}, [POTA], { ticked: false }).pre.respotOn, false);
});

test('wiring: flags only on the direct write, the review box pre-ticked from the plan, the switch in the window', () => {
  const body = main.slice(main.indexOf('async function jtcatAutoLog('), main.indexOf('function jtcatAutoRespotPlan('));
  const reviewAt = body.indexOf('jtcatLogReviews.add(qsoData');
  const applyAt = body.indexOf('JtcatAutoRespot.applyAutoRespot(qsoData, respotPlan, settings)');
  const writeAt = body.lastIndexOf('await jtcatWriteLog(qsoData, relogKeyStr);');
  assert.ok(reviewAt > 0 && applyAt > reviewAt && writeAt > applyAt, 'applied after the review branch, just before the write');
  assert.ok(/jtcatLogReviews\.add\(qsoData, \{ relogKey: relogKeyStr, respotOn \}\)/.test(body));
  assert.ok(/respotCheckEl\.checked = !!p\.respotOn;/.test(logPop), 'the Log window ticks the box from the prefill');
  assert.ok(/id="jp-auto-respot"/.test(html));
  assert.ok(/The spot is public, under your callsign\./.test(html));
  assert.ok(/window\.api\.saveSettings\(\{ jtcatAutoRespot: autoRespot \}\)/.test(pop));
  assert.ok(/autoRespot = s\.jtcatAutoRespot === true;/.test(pop));
});

test('devices: read at connect, set with jtcat-set-pref (Guest Pass refused in remote-server)', () => {
  const RemoteBridge = require('../lib/remote-bridge');
  assert.strictEqual(RemoteBridge.acceptPref('jtcatAutoRespot', true), true);
  assert.strictEqual(RemoteBridge.acceptPref('jtcatAutoRespot', 'true'), undefined);
  assert.ok(/jtcatAutoRespot: settings\.jtcatAutoRespot === true,/.test(main));
  assert.ok(/if \(key === 'jtcatAutoRespot'\) updateRemoteSettings\(\);/.test(main));
  assert.ok(/has\('jtcatAutoRespot'\)\) \{\s+updateRemoteSettings\(\);/.test(main), 'a desktop toggle reaches an open device');
});

console.log(`\nJTCAT auto re-spot: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
