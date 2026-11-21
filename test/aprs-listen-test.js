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

test('an HF-only rig listens on 30 m instead of being refused (phase 3)', () => {
  assert.strictEqual(why({ bands: ['160m', '80m', '40m', '30m', '20m', '6m'], band: '30m', freq: { hz: 10147600, mhz: '10.1476' } }), null);
});

test('a rig with neither 2 m nor 30 m: "Your radio has neither 2 m nor 30 m."', () => {
  assert.strictEqual(why({ bands: ['160m', '80m', '40m', '20m', '6m'] }).sentence, 'Your radio has neither 2 m nor 30 m.');
  assert.strictEqual(why({ bands: [] }).reason, 'no-band');
  assert.strictEqual(why({ bands: ['70cm', '23cm'] }).reason, 'no-band');
});

test('the old "APRS on 30 m is coming" sentence is gone from the code and the window', () => {
  for (const f of ['lib/aprs-listen.js', 'main.js', 'renderer/aprs-window.js', 'lib/aprs-window-state.js', 'renderer/aprs-popout.html']) {
    assert.ok(!/30 m is coming/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f);
  }
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
  assert.strictEqual(why({ bands: ['20m'], ft8Decoding: true }).reason, 'no-band');
  assert.strictEqual(why({ catConnected: false, winlinkHasModem: true }).reason, 'no-cat');
});

test('the frequency took when the readback is within 1 kHz', () => {
  assert.strictEqual(L.tuneAccepted(144390000, 144390000), true);
  assert.strictEqual(L.tuneAccepted(144390000, 144390500), true);
  assert.strictEqual(L.tuneAccepted(144390000, 14074000), false);
  assert.strictEqual(L.tuneAccepted(144390000, 0), false);
});

// #842: the 300 baud decoder holds about 100 Hz of offset, so 1 kHz on 30 m
// took a radio a few hundred hertz off as tuned, and it never decoded.
test('#842: on 30 m the readback must be within 50 Hz; 2 m keeps 1 kHz', () => {
  assert.strictEqual(L.tuneTolHz('30m'), 50);
  assert.strictEqual(L.tuneTolHz('2m'), 1000);
  assert.strictEqual(L.tuneAccepted(10147600, 10147600, '30m'), true);
  assert.strictEqual(L.tuneAccepted(10147600, 10147610, '30m'), true, '10 Hz steps');
  assert.strictEqual(L.tuneAccepted(10147600, 10147650, '30m'), true);
  assert.strictEqual(L.tuneAccepted(10147600, 10147900, '30m'), false, '300 Hz off: the decoder hears nothing');
  assert.strictEqual(L.tuneAccepted(10147600, 10147100, '30m'), false);
  assert.strictEqual(L.tuneAccepted(144390000, 144390500, '2m'), true);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.strictEqual((main.match(/AprsListen\.tuneAccepted\(hz, _currentFreqHz, aprsListen\.band\)/g) || []).length, 2, 'the start waits with the tolerance of the band');
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
  // Skip the parameter list first: a destructured parameter ({ resume = false })
  // has braces of its own and is not the body.
  let close = main.indexOf('(', i), pd = 0;
  for (; close < main.length; close++) {
    if (main[close] === '(') pd++;
    else if (main[close] === ')' && --pd === 0) break;
  }
  const open = main.indexOf('{', close);
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

// FLEX-8600M on 2026-11-18: Flex Direct up, "Connect your radio to listen to
// APRS." The start, the return and the mode-only steps ask the one route
// (lib/radio-tune-route.js), never `cat && cat.connected`.
test('listening starts when tuneRadio can reach the radio (Flex Direct, TCI, CAT), not only on CAT', () => {
  const b = fnBody('aprsListenStart');
  assert.ok(/catConnected:\s*RadioTuneRoute\.canTune\(|catConnected:\s*route\s*!==\s*''|catConnected:\s*!!route/.test(b), 'the gate is the shared route');
  assert.ok(!/catConnected:\s*!!\(cat && cat\.connected\)/.test(b), 'not cat.connected');
  assert.ok(/radioTuneRoute\(\)/.test(b));
});

test('the radio goes back on stop over the same route (Flex Direct included)', () => {
  const b = fnBody('aprsListenStop');
  assert.ok(!/was && cat && cat\.connected/.test(b), 'the return is not gated on cat.connected');
  assert.ok(/radioTuneRoute\(\)/.test(b) && /aprsReturn\.end\(/.test(b));
});

test('a mode sent on its own goes over CAT only, never the Flex shim', () => {
  const b = fnBody('aprsListenStart');
  assert.ok(/RadioTuneRoute\.modeOverCat\(route\)[^\n]*cat\.setModeOnly/.test(b), 'data mode step');
  const ret = main.slice(main.indexOf('const aprsReturn = AprsRadioReturn.createRadioReturn('), main.indexOf('function aprsLog('));
  assert.ok(/RadioTuneRoute\.modeOverCat\(radioTuneRoute\(\)\)/.test(ret), 'mode by name after the return');
  assert.ok(!/cat && cat\.connected && cat\.setModeOnly/.test(ret));
});

test('the place before listening is read for the route (the Flex slice, not the CAT shim)', () => {
  const b = fnBody('aprsListenStart');
  assert.ok(/RadioTuneRoute\.placeBefore\(\{\s*route/.test(b));
});

test('the window asks for the listen state once its listener is attached (the first push can arrive before it)', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload-aprs-popout.js'), 'utf8');
  assert.ok(/listenGet:\s*\(\)\s*=>\s*ipcRenderer\.send\('aprs-listen-get'\)/.test(pre));
  assert.ok(/ipcMain\.on\('aprs-listen-get',\s*\(\)\s*=>\s*\{?\s*aprsListenPush\(\)/.test(main));
});

// Casey 2026-11-19: "stop the modem audio process when APRS stops", unless
// Winlink or another user still needs it.
test('the modem audio lane stops with listening only when APRS started it and nobody else needs it', () => {
  const L = require('../lib/aprs-listen');
  assert.strictEqual(L.mayStopLane({ startedByAprs: true, isCurrent: true, othersNeed: false }), true);
  assert.strictEqual(L.mayStopLane({ startedByAprs: false, isCurrent: true, othersNeed: false }), false, 'a lane Winlink started');
  assert.strictEqual(L.mayStopLane({ startedByAprs: true, isCurrent: false, othersNeed: false }), false, 'rebuilt since by Winlink');
  assert.strictEqual(L.mayStopLane({ startedByAprs: true, isCurrent: true, othersNeed: true }), false, 'Winlink needs it');
  assert.strictEqual(L.mayStopLane({}), false);
});

test('main.js: stopping listening lets go of the lane APRS started (aprsReleaseLane)', () => {
  const ready = fnBody('aprsAudioReady');
  assert.ok(/aprsListen\.ownLane = winlinkAudio/.test(ready), 'the lane APRS started is remembered');
  const rel = fnBody('aprsReleaseLane');
  assert.ok(/AprsListen\.mayStopLane\(\{/.test(rel), 'asks lib/aprs-listen.js');
  assert.ok(/othersNeed: aprsLaneNeededByOthers\(\)/.test(rel));
  assert.ok(/stopWinlinkAudio\(\)/.test(rel), 'stops the lane');
  const others = fnBody('aprsLaneNeededByOthers');
  for (const w of ['winlinkSessionActive()', '_winlinkRetry', 'direwolfProc', 'ardopProc']) assert.ok(others.includes(w), w);
  // Pat's idle lane, replaced by APRS's, comes back as it was.
  assert.ok(/if \(giveBack && winlinkShim\) startWinlinkAudio\(\)/.test(rel), 'the Winlink idle lane is put back');
  const stop = fnBody('aprsListenStop');
  assert.ok(stop.indexOf('aprsStopModem()') < stop.indexOf('aprsReleaseLane()'), 'after Dire Wolf stops');
  // Winlink taking the modem is not a stop: its own session rebuilds the lane.
  assert.ok(!/aprsReleaseLane\(\)/.test(fnBody('aprsListenYieldToWinlink')));
});

test('the dev-only frame feed never runs in a packaged build', () => {
  assert.ok(/POTACAT_APRS_DEV_FRAMES/.test(main));
  assert.ok(/!app\.isPackaged && process\.env\.POTACAT_APRS_DEV_FRAMES/.test(main));
});

// ── Phase 3: the band chips and 30 m ──────────────────────────────────────
console.log('APRS 30 m (phase 3)');
const RigBands = require('../lib/rig-bands');
const PlainSsb = require('../lib/plain-ssb-for-digital');
const bandsOf = (model) => RigBands.bandsForRig({}, model, null);

test('band chips come from lib/rig-bands.js: 2 m, 30 m, or both', () => {
  assert.deepStrictEqual(L.bandChoices(bandsOf('IC-7300')), ['30m']);       // HF only
  assert.deepStrictEqual(L.bandChoices(bandsOf('IC-9700')), ['2m']);        // VHF/UHF only
  assert.deepStrictEqual(L.bandChoices(bandsOf('IC-705')), ['2m', '30m']);  // both
  assert.deepStrictEqual(L.bandChoices(bandsOf('FT-991/991A')), ['2m', '30m']);
  assert.deepStrictEqual(L.bandChoices(bandsOf('QDX')), ['30m']);
  assert.deepStrictEqual(L.bandChoices(null), ['2m', '30m']);             // an unknown model is not restricted
  assert.deepStrictEqual(L.bandChoices(['6m', '70cm']), []);
  // The operator's own band list in the rig editor wins.
  assert.deepStrictEqual(L.bandChoices(RigBands.bandsForRig({ bands: ['20m', '2m'] }, 'IC-7300', null)), ['2m']);
});

test('a rig with 2 m defaults to 2 m; an HF-only rig defaults to 30 m', () => {
  assert.strictEqual(L.chooseBand(bandsOf('IC-705')), '2m');
  assert.strictEqual(L.chooseBand(bandsOf('IC-9700')), '2m');
  assert.strictEqual(L.chooseBand(bandsOf('IC-7300')), '30m');
  assert.strictEqual(L.chooseBand(null), '2m');
  assert.strictEqual(L.chooseBand(['6m']), null);
});

test('a chip the operator picked holds while the rig has it, and falls back when it does not', () => {
  assert.strictEqual(L.chooseBand(bandsOf('IC-705'), '30m'), '30m');
  assert.strictEqual(L.chooseBand(bandsOf('IC-7300'), '2m'), '30m');
  assert.strictEqual(L.chooseBand(bandsOf('IC-9700'), '30m'), '2m');
  assert.strictEqual(L.chooseBand(bandsOf('IC-705'), 'nonsense'), '2m');
});

test('whyNot refuses a band the rig does not have', () => {
  assert.strictEqual(why({ bands: ['20m', '2m'], band: '30m' }).reason, 'no-band');
  assert.strictEqual(why({ bands: ['30m'], band: '2m' }).reason, 'no-band');
});

test('30 m tunes in DIGU, the mode JTCAT uses for FT8 (DATA-U where the rig has it), never FM', () => {
  const icom = PacketRigMode.resolvePacketRigMode({ choice: 'auto', family: 'icom', brand: 'Icom', protocol: 'civ' });
  const byHand = PacketRigMode.resolvePacketRigMode({ choice: 'fmdata', family: 'serial', brand: 'Kenwood', protocol: 'kenwood' });
  for (const pm of [icom, byHand, null]) assert.deepStrictEqual(L.listenModePlan(pm, '30m'), { tuneMode: 'DIGU', dataMode: null });
  // 2 m is unchanged by the band argument.
  assert.deepStrictEqual(L.listenModePlan(icom, '2m'), { tuneMode: 'FM', dataMode: 'DIGFM' });
  assert.deepStrictEqual(L.listenModePlan(icom), { tuneMode: 'FM', dataMode: 'DIGFM' });
});

test('30 m follows JTCAT\'s "DATA mode for FT8" setting: off means plain USB (lib/plain-ssb-for-digital.js)', () => {
  const mode = L.listenModePlan(null, '30m').tuneMode;
  assert.strictEqual(PlainSsb.plainSsbForDigital(mode, { useDataMode: true }), 'DIGU');
  assert.strictEqual(PlainSsb.plainSsbForDigital(mode, { useDataMode: false }), 'USB');
});

test('the window names the mode: FM on 2 m, USB on 30 m', () => {
  assert.strictEqual(L.modeLabel('2m'), 'FM');
  assert.strictEqual(L.modeLabel('30m'), 'USB');
});

test('the 30 m setup line is rig-setup-notes\' own sideband step, verbatim', () => {
  const N = require('../lib/rig-setup-notes');
  const steps = (model) => N.resolveSetupNotes({ model, radioType: 'serialcat' }).flatMap((n) => n.steps);
  const ft891 = L.setupLine(N.resolveSetupNotes({ model: 'FT-891', radioType: 'serialcat' }), '30m');
  assert.ok(/DATA BFO/.test(ft891), ft891);
  assert.ok(steps('FT-891').includes(ft891));
  const ft857 = L.setupLine(N.resolveSetupNotes({ model: 'FT-857', radioType: 'serialcat' }), '30m');
  assert.ok(/DIG MODE → USER-U/.test(ft857), ft857);
  assert.ok(steps('FT-857').includes(ft857));
  // 2 m on the same radio still shows the PKT RATE step.
  assert.ok(/PKT RATE/.test(L.setupLine(N.resolveSetupNotes({ model: 'FT-857', radioType: 'serialcat' }), '2m')));
  assert.strictEqual(L.setupLine(N.resolveSetupNotes({ model: 'IC-7300', radioType: 'serialcat' }), '30m'), '');
});

test('a digital filter that would cut a 30 m tone gets one plain sentence; filters are never changed', () => {
  assert.strictEqual(L.filterSentence('30m', 500), 'Your digital filter is 500 Hz wide. APRS on 30 m needs 1450 to 1950 Hz to pass.');
  assert.strictEqual(L.filterSentence('30m', 0), '');      // the radio's own filter: nothing known, nothing said
  assert.strictEqual(L.filterSentence('30m', 2400), '');
  assert.strictEqual(L.filterSentence('2m', 500), '');      // FM has a fixed bandwidth
});

// #839: a Flex DIGU filter of width w passes 100 to 100 + w Hz, so 1000 to
// 1800 Hz cut the 1800 Hz tone while only a filter under 1000 Hz was named.
test('#839: the warning follows the real passband edges, not a 1 kHz threshold', () => {
  assert.strictEqual(L.filterSentence('30m', 1000), 'Your digital filter is 1000 Hz wide. APRS on 30 m needs 1450 to 1950 Hz to pass.');
  assert.strictEqual(L.filterSentence('30m', 1500), 'Your digital filter is 1500 Hz wide. APRS on 30 m needs 1450 to 1950 Hz to pass.');
  assert.ok(L.filterSentence('30m', 1800) !== '', '100 to 1900 Hz still trims the upper sideband of the 1800 Hz tone');
  assert.strictEqual(L.filterSentence('30m', 1850), '');    // 100 to 1950 Hz passes both tones
  assert.strictEqual(L.filterSentence('30m', 3000), '');
});

test('#839: the radio\'s own filter edges decide when POTACAT has them', () => {
  assert.strictEqual(L.filterSentence('30m', 0, { lo: 100, hi: 2900 }), '');
  assert.strictEqual(L.filterSentence('30m', 3000, { lo: 1500, hi: 2700 }), 'Your receive filter passes 1500 to 2700 Hz. APRS on 30 m needs 1450 to 1950 Hz to pass.');
  assert.strictEqual(L.filterSentence('30m', 0, { lo: 200, hi: 1700 }), 'Your receive filter passes 200 to 1700 Hz. APRS on 30 m needs 1450 to 1950 Hz to pass.');
  assert.strictEqual(L.filterSentence('2m', 0, { lo: 200, hi: 1700 }), '');
  assert.strictEqual(L.HF_NEED_LO_HZ, 1450);
  assert.strictEqual(L.HF_NEED_HI_HZ, 1950);
});

test('the 30 m refusal names 10.1476 MHz', () => {
  assert.strictEqual(L.rejectedSentence({ hz: 10147600, mhz: '10.1476' }), 'The radio did not accept 10.1476 MHz.');
});

test('main.js: the band chip is wired, the frequency and the modem follow the band', () => {
  assert.ok(/ipcMain\.on\('aprs-listen-band'/.test(main));
  assert.ok(/AprsRfFrequency\.frequencyForBand\(/.test(fnBody('aprsListenFrequency')));
  assert.ok(/band:\s*aprsListen\.band/.test(fnBody('aprsSpawnDirewolf')));
  assert.ok(/AprsListen\.listenModePlan\(pm, aprsListen\.band\)/.test(fnBody('aprsListenStart')));
  assert.ok(/AprsListen\.chooseBand\(/.test(main));
  // A band change while listening never re-saves the APRS frequency as home: it goes through begin() again.
  assert.ok(!/aprsReturn\.(drop|end)\(/.test(fnBody('aprsListenSetBand')));
});

// Was "a chip per band", then (2026-11-19) a button per band; since 2026-11-20 one
// switch and a band select beside it, filled from the payload's bands (shown with two or more).
test('the window offers each band the rig has, from the payload (the band select beside the switch)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'aprs-popout.html'), 'utf8');
  assert.ok(/<select id="aprs-band-select"><\/select>/.test(html), 'an empty select: the options come from the payload');
  assert.ok(!/>Listen on 2 m</.test(html) && !/>2 m<\/(span|button)>/.test(html), 'no fixed 2 m button');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'aprs-window-state.js'), 'utf8');
  const glue = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'aprs-window.js'), 'utf8');
  assert.ok(/l\.bands/.test(lib) && /api\.listenBand\(/.test(glue));
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload-aprs-popout.js'), 'utf8');
  assert.ok(/listenBand:\s*\(b\)\s*=>\s*ipcRenderer\.send\('aprs-listen-band'/.test(pre));
});

// #841: a monitor that never opened, or closed later, left the window saying
// Listening while nothing Dire Wolf decoded could reach POTACAT.
test('#841: the modem starts again when its lane changed, it exited, or its monitor closed', () => {
  assert.strictEqual(L.modemRestartWhy({ laneChanged: false, procAlive: true, monitorLost: false }), '');
  assert.strictEqual(L.modemRestartWhy({ laneChanged: true, procAlive: true }), 'lane');
  assert.strictEqual(L.modemRestartWhy({ procAlive: false }), 'process');
  assert.strictEqual(L.modemRestartWhy({ procAlive: true, monitorLost: true }), 'monitor');
});

test('#841: main refuses a start whose AGW port never opened, and marks a monitor that closes on its own', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const spawnFn = main.slice(main.indexOf('async function aprsSpawnDirewolf('), main.indexOf('function aprsDevFeed('));
  assert.ok(/if \(!ready\) \{[\s\S]*?throw new Error\(/.test(spawnFn), 'no open port: the start fails with a reason');
  assert.ok(/onClose: \(code\) => \{[\s\S]*?aprsListen\.monitorLost = true/.test(spawnFn), 'a lost monitor is noted');
  assert.ok(!/onClose: \(\) => \{\}/.test(spawnFn), 'the monitor closing is no longer ignored');
  const stopFn = main.slice(main.indexOf('function aprsStopModem('), main.indexOf('function aprsLaneNeededByOthers('));
  assert.ok(/aprsListen\.monitorToken = null/.test(stopFn) && /aprsListen\.monitorLost = false/.test(stopFn), 'a monitor closed on purpose is not lost');
  const tick = main.slice(main.indexOf('function aprsListenTick('), main.indexOf('function aprsRadioReturnOnDial('));
  assert.ok(/AprsListen\.modemRestartWhy\(\{[^}]*monitorLost: !!aprsListen\.monitorLost/.test(tick), 'the tick restarts on a lost monitor');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
