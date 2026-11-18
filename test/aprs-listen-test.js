#!/usr/bin/env node
'use strict';
// APRS phase 2: when "Listen on my radio" may start, and the one sentence the
// window shows when it may not (lib/aprs-listen.js). Plus the main.js wiring
// rules: receive only, one audio user at a time, the window closing stops it.
// Run: node test/aprs-listen-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/aprs-listen');
const PacketRigMode = require('../lib/packet-rig-mode');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const OK = { remote: false, catConnected: true, bands: null, freq: { hz: 144390000, mhz: '144.390' }, modemFound: true, ft8Decoding: false, winlinkHasModem: false };
const why = (o) => L.whyNot({ ...OK, ...o });

console.log('APRS listen rules');

test('a 2 m rig with CAT, a frequency and the modem may listen', () => {
  assert.strictEqual(why({}), null);
  assert.strictEqual(why({ bands: ['20m', '2m', '70cm'] }), null);
});

test('FT8 decoding: "FT8 is decoding. Stop it to listen to APRS."', () => {
  assert.strictEqual(why({ ft8Decoding: true }).sentence, 'FT8 is decoding. Stop it to listen to APRS.');
  assert.strictEqual(why({ ft8Decoding: true }).reason, 'ft8');
});

test('Winlink: "A Winlink session has the modem."', () => {
  assert.strictEqual(why({ winlinkHasModem: true }).sentence, 'A Winlink session has the modem.');
  assert.strictEqual(why({ winlinkHasModem: true }).reason, 'winlink');
});

test('no 2 m: "Your radio has no 2 m. APRS on 30 m is coming."', () => {
  assert.strictEqual(why({ bands: ['160m', '80m', '40m', '20m', '6m'] }).sentence, 'Your radio has no 2 m. APRS on 30 m is coming.');
  assert.strictEqual(why({ bands: [] }).reason, 'no-2m');
});

test('an unknown model (no band list) counts as unrestricted and is tried', () => {
  assert.strictEqual(why({ bands: null }), null);
});

test('the radio did not take the frequency: "The radio did not accept 144.390 MHz."', () => {
  assert.strictEqual(L.rejectedSentence({ hz: 144390000, mhz: '144.390' }), 'The radio did not accept 144.390 MHz.');
  assert.strictEqual(L.rejectedSentence({ hz: 144800000, mhz: '144.800' }), 'The radio did not accept 144.800 MHz.');
  assert.strictEqual(L.SENTENCES.rejected('145.175'), 'The radio did not accept 145.175 MHz.');
});

test('the other refusals each have one sentence', () => {
  assert.strictEqual(why({ catConnected: false }).sentence, 'Connect your radio to listen to APRS.');
  assert.strictEqual(why({ freq: null }).sentence, 'POTACAT has no APRS frequency for your grid square yet.');
  assert.strictEqual(why({ modemFound: false }).sentence, 'Dire Wolf is not available on this computer.');
  assert.strictEqual(why({ remote: true }).sentence, 'Listening runs on the computer the radio is connected to.');
});

test('every sentence is one sentence, plain, no emoji', () => {
  const all = Object.values(L.SENTENCES).map((s) => (typeof s === 'function' ? s('144.390') : s));
  for (const s of all) {
    assert.ok(/^[A-Z].*\.$/.test(s), s);
    assert.strictEqual((s.match(/\. /g) || []).length <= 1, true, s); // "FT8 is decoding. Stop it..." is the plan's own wording
    assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(s), s);
  }
});

test('order: a radio problem is named before a busy modem', () => {
  assert.strictEqual(why({ bands: ['20m'], ft8Decoding: true }).reason, 'no-2m');
  assert.strictEqual(why({ catConnected: false, winlinkHasModem: true }).reason, 'no-cat');
});

test('the frequency took when the readback is within 1 kHz', () => {
  assert.strictEqual(L.tuneAccepted(144390000, 144390000), true);
  assert.strictEqual(L.tuneAccepted(144390000, 144390500), true);
  assert.strictEqual(L.tuneAccepted(144390000, 14074000), false);
  assert.strictEqual(L.tuneAccepted(144390000, 0), false);
});

test('the mode comes from the packet rule: Icom FM-D, FT-857 PKT, plain FM elsewhere, by hand left alone', () => {
  const icom = PacketRigMode.resolvePacketRigMode({ choice: 'auto', family: 'icom', brand: 'Icom', protocol: 'civ' });
  assert.deepStrictEqual(L.listenModePlan(icom), { tuneMode: 'FM', dataMode: 'DIGFM' });
  const ft857 = PacketRigMode.resolvePacketRigMode({ choice: 'fmdata', family: 'serial', brand: 'Yaesu', protocol: 'yaesu-legacy' });
  assert.deepStrictEqual(L.listenModePlan(ft857), { tuneMode: 'FM', dataMode: 'PKTFM' });
  const kenwood = PacketRigMode.resolvePacketRigMode({ choice: 'auto', family: 'serial', brand: 'Kenwood', protocol: 'kenwood' });
  assert.deepStrictEqual(L.listenModePlan(kenwood), { tuneMode: 'FM', dataMode: null });
  const byHand = PacketRigMode.resolvePacketRigMode({ choice: 'fmdata', family: 'serial', brand: 'Kenwood', protocol: 'kenwood' });
  assert.deepStrictEqual(L.listenModePlan(byHand), { tuneMode: undefined, dataMode: null });
  assert.deepStrictEqual(L.listenModePlan(null), { tuneMode: 'FM', dataMode: null });
});

test('the setup line is lib/rig-setup-notes.js\'s own PKT RATE step, never written here', () => {
  const notes = require('../lib/rig-setup-notes').resolveSetupNotes({ model: 'FT-857', radioType: 'serialcat' });
  const line = L.setupLine(notes);
  assert.ok(/PKT RATE/.test(line), line);
  const step = notes.flatMap((n) => n.steps).find((s) => /PKT RATE/.test(s));
  assert.strictEqual(line, step);
  assert.strictEqual(L.setupLine(require('../lib/rig-setup-notes').resolveSetupNotes({ model: 'IC-9700', radioType: 'serialcat' })), '');
  assert.strictEqual(L.setupLine([]), '');
});

// ── main.js wiring (source-text guards; CRLF and LF both pass) ────────────
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (name) => {
  const i = main.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' not found');
  const open = main.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < main.length; k++) {
    if (main[k] === '{') depth++;
    else if (main[k] === '}' && --depth === 0) return main.slice(open, k + 1);
  }
  return '';
};

test('modemBridgeWanted() keeps the radio\'s sound card open while APRS listens', () => {
  assert.ok(/aprsListenWantsAudio\(\)/.test(fnBody('modemBridgeWanted')));
});

test('the APRS Dire Wolf config is the receive-only variant, never the Winlink builder', () => {
  const b = fnBody('aprsSpawnDirewolf');
  assert.ok(/buildDirewolfAprsRxConfig\(/.test(b));
  assert.ok(!/buildDirewolfConfig\(/.test(b));
  assert.ok(!/shimPort/.test(b));
});

test('APRS never keys: no PTT, no acquireRadio, no transmit in the APRS glue', () => {
  for (const name of ['aprsListenStart', 'aprsListenStop', 'aprsSpawnDirewolf', 'aprsListenTick', 'aprsListenYieldToWinlink']) {
    const b = fnBody(name);
    assert.ok(!/handleRemotePtt|acquireRadio|setPtt|\.key\(true\)|startModemBridge\(\{\s*playback:\s*true/.test(b), name);
  }
});

test('a Winlink gateway pick and a Winlink session take the modem from APRS first', () => {
  const pick = main.indexOf("winlinkDialHere('before the gateway pick')");
  const y1 = main.lastIndexOf('aprsListenYieldToWinlink(', pick);
  assert.ok(y1 > 0 && pick - y1 < 400, 'gateway pick');
  const sess = main.indexOf("winlinkDialHere('at Connect')");
  const y2 = main.lastIndexOf('aprsListenYieldToWinlink(', sess);
  assert.ok(y2 > 0 && sess - y2 < 2000, 'session start');
});

test('closing the APRS window stops listening; quit puts the radio back while CAT is open', () => {
  assert.ok(/aprsWin\.on\('closed', \(\) => \{[^}]*aprsListenStop\(/.test(main));
  const g = fnBody('gracefulCleanup');
  const stop = g.indexOf('aprsListenStop(');
  assert.ok(stop > 0, 'gracefulCleanup calls aprsListenStop');
  assert.ok(stop < g.indexOf('stopModemBridge('), 'before the audio and CAT links close');
});

test('the radio\'s first readback runs the return check (crash recovery)', () => {
  assert.ok(/aprsRadioReturnOnDial\(hz\)/.test(fnBody('sendCatFrequency')));
});

test('the return marker is a machine setting (GLOBAL_KEYS), not a profile one', () => {
  assert.ok(/^\s*'aprsListenReturn',/m.test(main));
});

test('the dev-only frame feed never runs in a packaged build', () => {
  assert.ok(/POTACAT_APRS_DEV_FRAMES/.test(main));
  assert.ok(/!app\.isPackaged && process\.env\.POTACAT_APRS_DEV_FRAMES/.test(main));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
