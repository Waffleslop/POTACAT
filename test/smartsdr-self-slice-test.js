// Flex Direct self-slice fallback (K3SBP 2026-10-17). The radio is supposed to
// restore the slice persisted against our client_id when `client gui` is
// acked. When it restores NONE, POTACAT used to log "Flex Direct active" and
// "RADIO LINK LOST" a second apart and refuse every tune, forever, with no
// reason given. Now it creates its own slice after a grace window, adopts it
// (never excludes it the way a slice made for another app is), re-creates one
// if its slice is removed mid-session, and reports a refusal instead of
// hammering the radio. No sockets: `_sock.write` is captured and the radio's
// replies and status lines are fed through `_handleLine`.
// Run: node test/smartsdr-self-slice-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SmartSdrClient } = require('../lib/smartsdr');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const HANDLE = '1234ABCD';
const CLIENT_ID = 'f88e0ab8-edc5-4f6c-8647-ec0118bc0385';

/** A client "connected" to a radio that answers nothing on its own. */
function fakeRadio({ supplier } = {}) {
  const c = new SmartSdrClient();
  const sent = [];
  c._sock = { write: (s) => sent.push(s.trim()) };
  c.connected = true;
  c._host = '192.168.1.50';
  c._selfSliceGraceMs = 30;
  c._selfSliceRetryMs = 0;
  c.setPersistentId(CLIENT_ID);
  if (supplier) c.setSliceSupplier(supplier);
  c._handleLine(`H${HANDLE}`);
  const events = [];
  for (const ev of ['gui-ready', 'slice-ready', 'slice-created', 'slice-create-failed', 'slice-lost']) {
    c.on(ev, (p) => events.push({ ev, ...p }));
  }
  // Register as the GUI client (what _promoteOrBind does with no external GUI).
  c._promoteOrBind();
  const guiSeq = seqOf(sent, 'client gui');
  c._handleLine(`R${guiSeq}|0|${CLIENT_ID}`);
  return { c, sent, events };
}

function seqOf(sent, prefix) {
  const line = [...sent].reverse().find((s) => s.includes(`|${prefix}`));
  if (!line) return null;
  return parseInt(line.match(/^C(\d+)\|/)[1], 10);
}
function createsSent(sent) { return sent.filter((s) => /\|slice create/.test(s)); }

(async () => {
  console.log('Radio restores no slice → POTACAT creates one on the supplied dial and adopts it');
  {
    const { c, sent, events } = fakeRadio({ supplier: () => ({ freqMHz: 7.074, mode: 'DIGU' }) });
    check(events.some((e) => e.ev === 'gui-ready'), 'client gui acked → gui-ready');
    check(c.canTune === false, 'no slice yet → canTune false (this is the state that used to last forever)');
    check(createsSent(sent).length === 0, 'nothing created inside the grace window');
    await sleep(60);
    const creates = createsSent(sent);
    check(creates.length === 1, 'one `slice create` after the grace window');
    check(/slice create freq=7\.074000 mode=DIGU$/.test(creates[0] || ''), `on the supplier's dial and mode (${creates[0]})`);
    // The radio announces the slice (tagged with OUR handle) before — or
    // instead of — a reply payload, exactly as an 8600 on v4 does.
    c._handleLine(`S${HANDLE}|slice 0 in_use=1 RF_frequency=7.074000 client_handle=0x${HANDLE} index_letter=A mode=DIGU dax=0`);
    check(c.ourSliceIndex === 0, 'the new slice is adopted as ours');
    check(c.canTune === true, 'canTune true once adopted');
    check(!c._excludedSlices.has(0), 'a self-created slice is never excluded (that is the JS8Call rule, not this one)');
    c._handleLine(`R${seqOf(sent, 'slice create')}|0|`);
    await sleep(10);
    const created = events.find((e) => e.ev === 'slice-created');
    check(created && created.index === 0 && created.freqMHz === 7.074 && created.mode === 'DIGU', 'slice-created reported with index, dial and mode');
    check(c._selfSliceTimer === null, 'grace timer cleared');
    check(c._createForSelf === false, 'forSelf flag reset after the create');
  }

  console.log('Radio restores a slice in time → nothing is created');
  {
    const { c, sent } = fakeRadio({ supplier: () => ({ freqMHz: 7.074, mode: 'DIGU' }) });
    c._handleLine(`S${HANDLE}|slice 0 in_use=1 RF_frequency=14.225000 client_handle=0x${HANDLE} index_letter=A mode=USB`);
    check(c.ourSliceIndex === 0 && c.canTune === true, 'restored slice adopted');
    check(c._selfSliceTimer === null, 'adoption cancels the grace timer');
    await sleep(60);
    check(createsSent(sent).length === 0, 'no `slice create` sent');
  }

  console.log('No supplier (or one that knows nothing) → the 20 m FT8 default');
  {
    const { c, sent } = fakeRadio({ supplier: () => null });
    await sleep(60);
    const creates = createsSent(sent);
    check(creates.length === 1 && /freq=14\.074000 mode=USB$/.test(creates[0]), `default dial (${creates[0]})`);
    const { c: c2, sent: sent2 } = fakeRadio({ supplier: () => { throw new Error('boom'); } });
    await sleep(60);
    check(createsSent(sent2).length === 1 && /freq=14\.074000 mode=USB$/.test(createsSent(sent2)[0]), 'a throwing supplier falls back to the default too');
    void c; void c2;
  }

  console.log('Our slice is removed mid-session → forgotten, reported, re-created');
  {
    const { c, sent, events } = fakeRadio({ supplier: () => ({ freqMHz: 21.074, mode: 'USB' }) });
    c._handleLine(`S${HANDLE}|slice 1 in_use=1 RF_frequency=21.074000 client_handle=0x${HANDLE} index_letter=B mode=USB`);
    check(c.ourSliceIndex === 1, 'following slice 1');
    c._handleLine(`S${HANDLE}|slice 1 in_use=0`);
    check(c.ourSliceIndex === null, 'removed slice is no longer ours (a dead index made every later command fail "not in use")');
    check(c.canTune === false, 'canTune false while there is no slice');
    check(events.some((e) => e.ev === 'slice-lost' && e.index === 1), 'slice-lost reported');
    await sleep(60);
    check(createsSent(sent).length === 1, 'a replacement is created after the grace window');
    // `removed` spelling too.
    c._handleLine(`S${HANDLE}|slice 2 in_use=1 RF_frequency=21.074000 client_handle=0x${HANDLE} index_letter=C mode=USB`);
    c._handleLine(`R${seqOf(sent, 'slice create')}|0|`);
    await sleep(10);
    check(c.ourSliceIndex === 2, 'the replacement is adopted');
    c._handleLine(`S${HANDLE}|slice 2 removed`);
    check(c.ourSliceIndex === null && events.filter((e) => e.ev === 'slice-lost').length === 2, '`removed` status forgets the slice as well');
  }

  console.log('Radio refuses the create → reported once, not hammered');
  {
    const { c, sent, events } = fakeRadio({ supplier: () => ({ freqMHz: 14.074, mode: 'USB' }) });
    c._selfSliceRetryMs = 30000;
    await sleep(60);
    const seq = seqOf(sent, 'slice create');
    check(seq != null, 'create attempted');
    c._handleLine(`R${seq}|50000028|Slice receiver limit reached`);
    await sleep(10);
    const fail = events.find((e) => e.ev === 'slice-create-failed');
    check(fail && /0x50000028/.test(fail.error), `refusal reported with the radio's status (${fail && fail.error})`);
    check(c.ourSliceIndex === null && c._createForSelf === false, 'nothing adopted, flag reset');
    c._armSelfSlice();
    await sleep(60);
    check(createsSent(sent).length === 1, 'a second attempt inside the retry window is not sent');
  }

  console.log('Teardown clears the grace timer');
  {
    const { c } = fakeRadio({ supplier: () => null });
    check(!!c._selfSliceTimer, 'timer armed after gui-ready');
    c.disconnect();
    check(c._selfSliceTimer === null, 'disconnect() clears it');
    const { c: c2, sent: sent2 } = fakeRadio({ supplier: () => null });
    c2.connected = false; // radio-side close
    c2._clearSelfSliceTimer();
    await sleep(60);
    check(createsSent(sent2).length === 0, 'no create after the socket is gone');
  }

  console.log('main.js wiring (source guards)');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check(src.includes('smartSdr.setSliceSupplier(flexSelfSliceWanted)'), 'main supplies the dial for a self-created slice');
    check(src.includes("smartSdr.on('slice-created'") && src.includes("smartSdr.on('slice-create-failed'") && src.includes("smartSdr.on('slice-lost'"), 'main logs create / refusal / loss');
    const guiReady = src.slice(src.indexOf("smartSdr.on('gui-ready'"), src.indexOf("smartSdr.on('gui-mode'"));
    check(!/sendCatStatus\(\{ connected: true \}\)/.test(guiReady), 'gui-ready no longer claims the link is up (registration cannot tune; the slice can)');
    const sliceReady = src.slice(src.indexOf("smartSdr.on('slice-ready'"), src.indexOf("smartSdr.on('slice-mute'"));
    const selfBranch = sliceReady.slice(0, sliceReady.indexOf('} else {'));
    check(/sendCatStatus\(\{ connected: true \}\)/.test(selfBranch), 'the self-host slice-ready branch lights the link pill');
    check(src.includes('rememberFlexSlice({ hz })') && src.includes('rememberFlexSlice({ mode: md })'), 'the self-hosted slice dial is remembered for the next launch');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, 'smartsdr self-slice tests failed');
})();
