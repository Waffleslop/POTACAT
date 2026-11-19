// The Flex's own transmit timeout (lib/flex-tx-timeout.js): filled in when the
// radio has none, never changed when it has one, left alone when Off; the
// SmartLink transmit backstop in lib/smartsdr.js; and the wiring in main.js.
// Why: D0 2026-11-17, an 8600M (v4.2.20) with interlock timeout=0 was still
// transmitting 45 s after its client went silent.
// Run: node test/flex-tx-timeout-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const T = require('../lib/flex-tx-timeout');
const { SmartSdrClient } = require('../lib/smartsdr');
const FT = require('../lib/flex-transport');
const { readSrc } = require('./_src');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('The setting');
  check(T.minutesFor({}) === 5 && T.minutesFor(null) === 5, 'default 5 minutes');
  check(T.minutesFor({ flexTxTimeoutMin: 0 }) === 0, 'Off is 0');
  check(T.minutesFor({ flexTxTimeoutMin: 10 }) === 10 && T.minutesFor({ flexTxTimeoutMin: '3' }) === 3, '3 and 10');
  check(T.minutesFor({ flexTxTimeoutMin: 7 }) === 5, 'an unknown value falls back to the default');
  check(JSON.stringify(T.OPTIONS.map((o) => o.label)) === '["Off","3 minutes","5 minutes","10 minutes"]', 'choices: Off / 3 / 5 / 10 minutes');

  console.log('The fill rule');
  const zero = T.decideFill({ radioTimeout: 0, minutes: 5, isGuiClient: true });
  check(zero.action === 'set' && zero.ms === 300000 && zero.command === 'interlock timeout=300000', 'timeout 0 -> interlock timeout=300000 (5 minutes)');
  check(T.decideFill({ radioTimeout: 0, minutes: 3, isGuiClient: true }).ms === 180000, '3 minutes -> 180000 ms');
  check(T.decideFill({ radioTimeout: 120000, minutes: 5, isGuiClient: true }).action === 'none', 'a non-zero value set elsewhere is never changed');
  check(T.decideFill({ radioTimeout: 0, minutes: 0, isGuiClient: true }).action === 'none', 'Off: the radio is left alone');
  check(T.decideFill({ radioTimeout: 0, minutes: 5, isGuiClient: false }).action === 'none', 'only as the GUI client');
  check(T.decideFill({ radioTimeout: null, minutes: 5, isGuiClient: true }).action === 'none', 'not before the radio reports it');
  check(T.radioTimeout({ timeout: '0' }) === 0 && T.radioTimeout({ state: 'READY' }) === null, 'radioTimeout reads the status');
  check(T.fillLogText(5) === '[Flex] the radio had no transmit timeout; set it to 5 minutes (Settings > My Rigs to change)', 'the log line');
  check(/SmartSDR and Maestro/.test(T.fillNoticeText(5)), 'the notice says it is a radio setting other clients see');


  console.log('The radio\'s reply and the readback (8600M 2026-11-18: logged "set", radio still read 0)');
  {
    const ok = T.replyLogText({ command: 'interlock timeout=300000', status: 0, line: 'R41|0|' });
    check(ok === '[Flex] the radio accepted "interlock timeout=300000" (reply R41|0|); waiting for its status to show the new timeout', 'an OK reply is logged with the raw R line');
    const bad = T.replyLogText({ command: 'interlock timeout=300000', status: 0x50000016, line: 'R41|50000016|Invalid parameter' });
    check(bad === '[Flex] the radio refused "interlock timeout=300000": error 0x50000016, Invalid parameter (reply R41|50000016|Invalid parameter). The transmit timeout is still off.', 'an error reply is said in plain words with its code: ' + bad);
    const none = T.replyLogText({ command: 'interlock timeout=300000', status: null, line: null });
    check(/no reply/.test(none) && /interlock timeout=300000/.test(none), 'no reply in time is said too');
    check(T.replyAccepted({ status: 0 }) === true && T.replyAccepted({ status: 0x50000016 }) === false && T.replyAccepted({ status: null }) === false, 'only status 0 is accepted');
    check(T.decideConfirm({ pending: true, radioTimeout: 300000 }).action === 'confirmed', 'a later non-zero timeout confirms the fill');
    check(T.decideConfirm({ pending: true, radioTimeout: 0, replied: true, accepted: true }).action === 'still-zero', 'accepted but still 0 is reported');
    check(T.decideConfirm({ pending: true, radioTimeout: 0, replied: false }).action === 'wait', 'a 0 before the reply is not a verdict');
    check(T.decideConfirm({ pending: false, radioTimeout: 300000 }).action === 'none', 'nothing pending: nothing to confirm');
    check(/still reports timeout=0/.test(T.stillZeroLogText({ command: 'interlock timeout=300000' })), 'the still-0 line');
  }

  console.log('Key-down commands');
  for (const c of ['xmit 1', 'transmit tune 1', 'atu start', 'cw key 1 time=0x0001 index=0', 'cw ptt 1 time=0x0001 index=1', 'cwx send "CQ"', 'transmit set mox=1']) check(T.isKeyDownCommand(c), 'key-down: ' + c);
  for (const c of ['xmit 0', 'transmit tune 0', 'atu bypass', 'cw key 0 time=0x1 index=2', 'cw ptt 0', 'transmit set rfpower=50', 'interlock timeout=300000', 'slice tune 0 14.074']) check(!T.isKeyDownCommand(c), 'not a key-down: ' + c);

  console.log('The SmartLink gate');
  check(T.smartLinkTxRefusal({ smartLink: false, interlockTimeout: 0, cmd: 'xmit 1' }) === null, 'LAN: never gated here');
  check(T.smartLinkTxRefusal({ smartLink: true, interlockTimeout: 0, cmd: 'transmit tune 1' }) === T.GATE_TEXT, 'timeout 0: refused');
  check(T.smartLinkTxRefusal({ smartLink: true, interlockTimeout: null, cmd: 'cw key 1' }) === T.GATE_TEXT, 'timeout not reported: refused');
  check(T.GATE_TEXT === "Transmit over SmartLink needs the radio's transmit timeout turned on, so a dropped connection cannot leave it transmitting. Turn on Radio transmit timeout in Settings > My Rigs.", 'the sentence');
  check(T.smartLinkTxRefusal({ smartLink: true, interlockTimeout: 300000, cmd: 'transmit tune 1' }) === null, 'timeout set: Tune goes');
  check(T.smartLinkTxRefusal({ smartLink: true, interlockTimeout: 300000, cmd: 'cw key 1' }) === null, 'timeout set: CW goes');
  check(T.smartLinkTxRefusal({ smartLink: true, interlockTimeout: 300000, cmd: 'xmit 1' }) === T.NO_TX_AUDIO_TEXT, 'timeout set: a key-down that needs transmit audio is still refused (not built over SmartLink)');

  console.log('The gate in lib/smartsdr.js: every command passes one chokepoint');
  {
    const written = [];
    const mk = (kind) => FT.injectedTransport({
      kind,
      udp: { kind: 'test', start: () => ({ seq: null, onPacket() {}, stop() {} }) },
      open(_h, attach) {
        const s = new EventEmitter();
        s.write = (d) => { written.push(d.trim()); return true; };
        s.end = () => {}; s.destroy = () => {};
        attach(s);
        s.emit('data', 'V1.4.0.0\nH4A30F977\nS4A30F977|interlock acc_txreq_enable=0 timeout=0\n');
        process.nextTick(() => s.emit('connect'));
        return s;
      },
    });
    const c = new SmartSdrClient();
    c.on('error', () => {});
    const refused = [];
    c.on('tx-refused', (r) => refused.push(r));
    c.setTransport(mk('smartlink'));
    c.connect('x');
    await sleep(20);
    check(c.interlockTimeout === 0, 'the client reads interlock timeout=0');
    written.length = 0;
    c.setTransmit(true); c.setTxTune(true); c.setAtu(true); c.cwKey(true); c.sendCwText('TEST');
    check(written.length === 0, 'with timeout 0 nothing that keys reaches the radio: ' + JSON.stringify(written));
    check(refused.length === 5 && refused.every((r) => r.reason === T.GATE_TEXT), 'each refusal is reported with the sentence');
    c.setTransmit(false); c.setTxTune(false);
    check(written.includes('xmit 0') || written.some((l) => /\|xmit 0$/.test(l)), 'releases always go out');
    c.setSliceAudioLevel(0, 0);
    check(!written.some((l) => /audio_level=0/.test(l)), 'audio_level=0 is never sent over SmartLink');
    c.setSliceAudioLevel(0, 50);
    check(written.some((l) => /audio_level=50/.test(l)), 'other levels are');
    c._handleLine('S4A30F977|interlock timeout=300000');
    written.length = 0;
    c.setTxTune(true);
    check(written.some((l) => /\|transmit tune 1$/.test(l)), 'once the radio reports a timeout, Tune keys');
    c.disconnect();

    // The same client over the LAN: nothing is gated (the fill rule protects it).
    const l = new SmartSdrClient();
    l.on('error', () => {});
    l.setTransport(mk('lan-test'));
    l.connect('x');
    await sleep(20);
    written.length = 0;
    l.setTransmit(true); l.setSliceAudioLevel(0, 0);
    check(written.some((w) => /\|xmit 1$/.test(w)) && written.some((w) => /audio_level=0$/.test(w)), 'LAN: commands go out unchanged');
    const n = l.setInterlockTimeout(300000);
    check(n != null && written.some((w) => /\|interlock timeout=300000$/.test(w)), 'setInterlockTimeout sends interlock timeout=<ms>');
    check(l.setInterlockTimeout(0) === null, 'setInterlockTimeout never sends 0');
    // The reply to the set is read and handed up, raw line and all.
    const replies = [];
    l.on('interlock-timeout-reply', (r) => replies.push(r));
    const seq2 = l.setInterlockTimeout(180000);
    l._handleLine(`R${seq2}|50000016|Invalid parameter`);
    check(replies.length === 1 && replies[0].status === 0x50000016 && replies[0].line === `R${seq2}|50000016|Invalid parameter` && replies[0].command === 'interlock timeout=180000', 'the R<seq>|<code>| reply to interlock timeout= is emitted: ' + JSON.stringify(replies));

    l.disconnect();
  }

  console.log('The wiring (main.js, renderer)');
  {
    const main = readSrc(path.join(__dirname, '..', 'main.js'));
    const i = main.indexOf('function flexTxTimeoutCheck(');
    check(i > 0, 'main.js has flexTxTimeoutCheck');
    const f = main.slice(i, main.indexOf('\n}\n', i));
    check(/FlexTxTimeout\.decideFill\(/.test(f) && /smartSdr\.guiReady/.test(f), 'it asks the pure rule, as the GUI client only');
    check(/smartSdr\.setInterlockTimeout\(/.test(f) && /FlexTxTimeout\.sendLogText\(/.test(f), 'it sends the timeout and logs what it sent');
    check(!/flexTxTimeoutNoticed/.test(f) && !/fillLogText/.test(f), 'sending is not success: no "set it" line and no notice flag at send time');
    const j = main.indexOf('function flexTxTimeoutConfirm(');
    check(j > 0, 'main.js has flexTxTimeoutConfirm');
    const g = main.slice(j, main.indexOf('\n}\n', j));
    check(/FlexTxTimeout\.decideConfirm\(/.test(g) && /flexTxTimeoutNoticed = true/.test(g) && /FlexTxTimeout\.fillLogText\(/.test(g), 'the notice flag and the "set it" line wait for a status that shows the new timeout');
    check(/smartSdr\.on\('interlock-timeout-reply'/.test(main) && /FlexTxTimeout\.replyLogText\(/.test(main), "the radio's reply is logged");
    check(/smartSdr\.on\('interlock', \(kv\) => \{ flexTxTimeoutConfirm\(kv\); flexTxTimeoutCheck\(/.test(main) && /flexTxTimeoutCheck\('gui-ready'\)/.test(main), 'checked on the interlock status and when the GUI seat is granted (LAN and SmartLink alike)');
    check(/smartSdr\.on\('tx-refused'/.test(main), 'a refused key-down is said where the press happened');
    const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
    check(/id="set-flex-tx-timeout"/.test(html) && /Radio transmit timeout/.test(html), 'the rig editor has Radio transmit timeout');
    const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
    check(/flexTxTimeoutMin/.test(app) && /FlexTxTimeout\.minutesFor\(/.test(app), 'the rig editor saves and loads flexTxTimeoutMin');
    check(/<script src="\.\.\/lib\/flex-tx-timeout\.js"><\/script>/.test(html), 'the renderer loads lib/flex-tx-timeout.js');
    check(/Sign in to FlexRadio to see your radios/.test(app), 'signed out, the SmartLink radio list says to sign in');
    const k = app.indexOf('function smartLinkFillRadios(');
    const h = app.slice(k, app.indexOf('\n}\n', k));
    check(/signedIn/.test(h) && h.indexOf('Sign in to FlexRadio to see your radios') < h.indexOf('No radios on this FlexRadio account'), 'and "No radios on this FlexRadio account" only when signed in');

  }

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, 'flex tx timeout tests failed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
