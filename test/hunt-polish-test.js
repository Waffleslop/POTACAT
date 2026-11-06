#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Review of the hunt filters (Casey: they should "just work"):
//  6. The status line said "answering K4POT next" for a whole QSO: it now
//     says "Hunt: working K4POT" when Hunt or a direct caller engages.
//  7. ECHOCAT Web, Hunt off: a second tick vanished on the next redraw.
//  8. A Guest Pass saw a Filters button whose changes the shack refuses.
//  9. The FT8 window never re-saved the list going from Custom to one target.
// 10. The Log window a review opened stayed open when the last contact was
//     declined, and its close timer could fire under someone typing.
// Run: node test/hunt-polish-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const R = (f) => readSrc(path.join(__dirname, '..', f));
const main = R('main.js');
const web = R('renderer/remote.js');
const pop = R('renderer/jtcat-popout.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('6: Hunt engaging a station says "working" on every surface; a direct caller too', () => {
  const sent = [];
  const ctx = {
    _jtcatHuntStatusLast: null,
    jtcatPopoutWin: { isDestroyed: () => false, webContents: { send: (ch, d) => sent.push(['win', ch, d]) } },
    remoteServer: { hasClient: () => true, sendToClient: (m) => sent.push(['ws', m.type, m]) },
  };
  vm.createContext(ctx);
  vm.runInContext(main.slice(main.indexOf('function jtcatHuntStatusWorking('), main.indexOf('function jtcatHuntStatusClear(')) + '\nthis.w = jtcatHuntStatusWorking;', ctx);
  ctx.w('K4POT');
  assert.deepStrictEqual(sent.map((s) => [s[0], s[1], s[2].text]), [['win', 'jtcat-hunt-status', 'Hunt: working K4POT'], ['ws', 'jtcat-hunt-status', 'Hunt: working K4POT']]);
  assert.ok(/jtcatSessionMark\(best\.call\);\s*jtcatHuntStatusWorking\(best\.call\);/.test(main), 'the Hunt pick');
  const direct = main.slice(main.indexOf('async function jtcatTryAnswerDirectCaller('), main.indexOf('async function jtcatTryAnswerDirectCaller(') + 4000);
  assert.ok(/jtcatHuntStatusWorking\(senderCall\);/.test(direct), 'a station calling us');
});

test('7: Hunt off, the web sheet shows the saved Custom list and saves every change', () => {
  assert.ok(/const ticked = \(\) => \(st\.huntMode === 'custom' \|\| !st\.huntMode \|\| st\.huntMode === 'off' \? st\.targets : \[st\.huntMode\]\);/.test(web));
  const h = web.slice(web.indexOf("targetsEl.addEventListener('change'"), web.indexOf("targetsEl.addEventListener('change'") + 600);
  assert.ok(/if \(!set\.length\) \{ e\.target\.checked = true; return; \}\s*send\(\{ targets: set \}\);/.test(h));
});

test('8: a Guest Pass on ECHOCAT Web gets no Filters button', () => {
  assert.ok(/if \(window\.__echoGuestPass\) \{ btn\.classList\.add\('hidden'\); setOpen\(false\); return; \}/.test(web));
});

test('9: the FT8 window saves the target list on every change, one target included', () => {
  const f = pop.slice(pop.indexOf('function onTargetBoxChange(e) {'), pop.indexOf('function onTargetBoxChange(e) {') + 1200);
  assert.ok(/huntTargets = set;\s*window\.api\.saveSettings\(\{ jtcatHuntTargets: set\.join\(','\) \}\);/.test(f));
  assert.ok(!/if \(set\.length > 1\) \{/.test(f));
});

test('10: declining the last reviewed contact closes the window; typing cancels a pending close', async () => {
  const closed = [];
  const win = { isDestroyed: () => false, close: () => closed.push(1) };
  const ctx = { setTimeout, clearTimeout, _logPopoutForReview: true, logPopoutWin: win, jtcatLogReviews: { current: null } };
  vm.createContext(ctx);
  const src = main.slice(main.indexOf('let _logReviewCloseTimer = null;'), main.indexOf('function jtcatCancelLogReview('));
  vm.runInContext(src.replace('1200)', '30)') + '\nthis.soon = logReviewCloseSoon; this.typed = () => { if (_logReviewCloseTimer) { clearTimeout(_logReviewCloseTimer); _logReviewCloseTimer = null; } };', ctx);
  ctx.soon(); await wait(60);
  assert.strictEqual(closed.length, 1, 'closes after the last contact');
  ctx.soon(); ctx.typed(); await wait(60);
  assert.strictEqual(closed.length, 1, 'a keystroke keeps it open');
  const cancel = main.slice(main.indexOf("ipcMain.on('log-review-cancel'"), main.indexOf("ipcMain.on('log-review-cancel'") + 300);
  assert.ok(/if \(jtcatLogReviews\.current\) jtcatShowLogReview\(\);\s*else logReviewCloseSoon\(\);/.test(cancel), 'decline uses it');
  assert.ok(/ipcMain\.on\('log-popout-typing', \(\) => \{\s*if \(_logReviewCloseTimer\) \{ clearTimeout\(_logReviewCloseTimer\); _logReviewCloseTimer = null; \}/.test(main));
  assert.ok(/noteTyping: \(\) => ipcRenderer\.send\('log-popout-typing'\)/.test(R('preload-log-popout.js')));
  assert.ok(/document\.addEventListener\('keydown', \(\) => \{[\s\S]{0,160}window\.api\.noteTyping\(\);/.test(R('renderer/log-popout.js')));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nHunt polish: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
