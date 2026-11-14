#!/usr/bin/env node
'use strict';
// WSJT-X Mode you can't miss (#547): the heard rule and every word
// (lib/wsjtx-mode-notice.js), the WSJT-X client's lastHeardAt, the status
// fields and rig-reconnect-ack on the ECHOCAT wire, the Settings label and
// confirm, the chip/pill/panel/notice wiring, Station Setup, the bug report
// and ECHOCAT Web.
// Run: node test/wsjtx-mode-notice-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const W = require('../lib/wsjtx-mode-notice');
const G = require('../lib/cat-connect-gate');
const StationSetup = require('../lib/station-setup');
const { WsjtxClient, encodeHeartbeat } = require('../lib/wsjtx');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));
const html = readSrc(path.join(root, 'renderer', 'index.html'));
const css = readSrc(path.join(root, 'renderer', 'styles.css'));
const remoteJs = readSrc(path.join(root, 'renderer', 'remote.js'));
const remoteHtml = readSrc(path.join(root, 'renderer', 'remote.html'));
const remoteCss = readSrc(path.join(root, 'renderer', 'remote.css'));
const remoteServer = readSrc(path.join(root, 'lib', 'remote-server.js'));
const ssRenderer = readSrc(path.join(root, 'renderer', 'station-setup.js'));
const protocol = readSrc(path.join(root, 'docs', 'echocat-protocol.md'));

test('heard = a Heartbeat/Status within the last 60 s', () => {
  const now = 1_000_000;
  assert.strictEqual(W.HEARD_WINDOW_MS, 60000);
  assert.strictEqual(W.isHeard(now - 1000, now), true);
  assert.strictEqual(W.isHeard(now - 60000, now), true, '60 s is still heard');
  assert.strictEqual(W.isHeard(now - 60001, now), false);
  assert.strictEqual(W.isHeard(0, now), false, 'never heard');
  assert.strictEqual(W.isHeard(null, now), false);
  assert.strictEqual(W.isHeard(undefined, now), false);
  assert.strictEqual(W.isHeard(now + 5000, now), false, 'a clock step back is not heard');
});

test('the chip, the pill and the panel say it in the approved words', () => {
  assert.strictEqual(W.chip().label, 'WSJT-X Mode');
  assert.strictEqual(W.catPill().label, 'CAT: off');
  assert.strictEqual(W.catPill().title, 'WSJT-X Mode is on: WSJT-X has the radio');
  const quiet = W.panel({ heard: false, port: 2238 });
  assert.strictEqual(quiet.title, 'WSJT-X Mode is on');
  assert.strictEqual(quiet.line, "POTACAT leaves the radio to WSJT-X. While it's on, clicking a spot doesn't tune the radio and POTACAT's own FT8 doesn't transmit.");
  assert.strictEqual(quiet.state, 'WSJT-X not heard on port 2238');
  assert.strictEqual(quiet.hint, "If you're not using WSJT-X, turn this off and POTACAT connects to your radio.");
  assert.strictEqual(quiet.primary, 'off', 'Turn off is the main button when WSJT-X is silent');
  assert.strictEqual(quiet.turnOffLabel, 'Turn off WSJT-X Mode');
  assert.strictEqual(quiet.keepLabel, 'Keep it on');
  const live = W.panel({ heard: true, port: 2237 });
  assert.strictEqual(live.state, 'WSJT-X is talking to POTACAT');
  assert.strictEqual(live.hint, '');
  assert.strictEqual(live.primary, 'keep');
  assert.strictEqual(W.panel({}).state, 'WSJT-X not heard on port 2237', 'default port');
});

test('start notice: mode on and never heard; never after WSJT-X was heard or Keep it on', () => {
  const n = W.startNotice({ mode: true, heard: false });
  assert.strictEqual(n.title, "WSJT-X Mode is on, and WSJT-X isn't running");
  assert.strictEqual(n.line, "POTACAT isn't connected to your radio. Turn the mode off to use the radio from POTACAT.");
  assert.strictEqual(n.turnOffLabel, 'Turn off WSJT-X Mode');
  assert.strictEqual(n.keepLabel, 'Keep it on');
  assert.strictEqual(W.startNotice({ mode: false }), null);
  assert.strictEqual(W.startNotice({ mode: true, heard: true }), null);
  assert.strictEqual(W.startNotice({ mode: true, heard: false, everHeard: true }), null);
  assert.strictEqual(W.startNotice({ mode: true, kept: true }), null);
  assert.strictEqual(W.START_NOTICE_DELAY_MS, 30000);
});

test('bug report line, Station Setup line and ECHOCAT note', () => {
  assert.strictEqual(W.reportLine({ mode: false }), '');
  assert.ok(/^\*\*WSJT-X Mode:\*\* ON/.test(W.reportLine({ mode: true, heard: false, port: 2237 })));
  assert.ok(/NOT heard on UDP port 2237/.test(W.reportLine({ mode: true, heard: false, port: 2237 })));
  assert.ok(/WSJT-X heard on UDP port 2240/.test(W.reportLine({ mode: true, heard: true, port: 2240 })));
  assert.strictEqual(W.stationSetupNotice().text, 'WSJT-X Mode is on, so the radio checks are skipped.');
  assert.deepStrictEqual(W.stationSetupNotice().action, { id: 'wsjtx-mode-off', label: 'Turn off WSJT-X Mode' });
  assert.strictEqual(W.remoteNote(), "The shack is in WSJT-X Mode. WSJT-X has the radio, so tuning and transmitting from here are off. Turn it off at the shack: click CAT in POTACAT's top bar and untick WSJT-X Mode.");
});

test('the WSJT-X client stamps lastHeardAt on a Heartbeat, clears it on disconnect', () => {
  const c = new WsjtxClient();
  assert.strictEqual(c.lastHeardAt, 0);
  const before = Date.now();
  c._handleMessage(encodeHeartbeat('WSJT-X', 3), { address: '127.0.0.1', port: 50000 });
  assert.ok(c.lastHeardAt >= before && W.isHeard(c.lastHeardAt, Date.now()));
  c.disconnect();
  assert.strictEqual(c.lastHeardAt, 0);
  // Our own bridge's heartbeat (id POTACAT) is never WSJT-X.
  c._handleMessage(encodeHeartbeat('POTACAT', 3), { address: '127.0.0.1', port: 50000 });
  assert.strictEqual(c.lastHeardAt, 0);
  c.disconnect();
});

test('rig-reconnect-ack: no with the reason in WSJT-X Mode, otherwise yes', () => {
  assert.deepStrictEqual(G.rigReconnectAck({ enableWsjtx: true }), {
    type: 'rig-reconnect-ack', ok: false, code: 'wsjtx-mode',
    reason: 'WSJT-X Mode is on: WSJT-X has the radio. Untick WSJT-X Mode (click CAT in the top bar) for POTACAT to tune it',
  });
  assert.deepStrictEqual(G.rigReconnectAck({ enableWsjtx: false }), { type: 'rig-reconnect-ack', ok: true });
  assert.deepStrictEqual(G.rigReconnectAck(null), { type: 'rig-reconnect-ack', ok: true });
  const h = main.slice(main.indexOf("remoteServer.on('rig-reconnect'"), main.indexOf("remoteServer.on('refresh-events'"));
  assert.ok(/remoteServer\.sendToClient\(CatGate\.rigReconnectAck\(settings\)\);/.test(h), 'main answers with the shared ack');
  assert.ok(!/sendToClient\(\{ type: 'rig-reconnect-ack' \}\)/.test(h), 'the bare ack is gone');
  assert.ok(/if \(!settings\.enableWsjtx\) connectCatSafe\('phone rig-reconnect'\);/.test(h), 'nothing reconnects in WSJT-X Mode');
});

test('wire: status carries wsjtxMode and wsjtxHeard, pushed when either changes', () => {
  const fn = main.slice(main.indexOf('function broadcastRemoteRadioStatus('), main.indexOf('remoteServer.broadcastRadioStatus(status);') + 50);
  assert.ok(/status\.wsjtxMode = !!settings\.enableWsjtx;/.test(fn));
  assert.ok(/status\.wsjtxHeard = !!\(settings\.enableWsjtx && _wsjtxHeard\);/.test(fn));
  const conn = main.slice(main.indexOf('function connectWsjtx('), main.indexOf("wsjtx.on('error'"));
  assert.ok(/setInterval\(refreshWsjtxHeard, 5000\)/.test(conn), 'heard is re-checked while the mode is on');
  assert.ok((conn.match(/broadcastRemoteRadioStatus\(\)/g) || []).length >= 2, 'mode on and connection changes reach ECHOCAT');
  const disc = main.slice(main.indexOf('function disconnectWsjtx('), main.indexOf('function scheduleWsjtxHighlights('));
  assert.ok(/clearInterval\(_wsjtxHeardTimer\)/.test(disc) && /broadcastRemoteRadioStatus\(\)/.test(disc), 'mode off reaches ECHOCAT');
  const ref = main.slice(main.indexOf('function refreshWsjtxHeard('), main.indexOf('function connectWsjtx('));
  assert.ok(/WsjtxModeNotice\.isHeard\(wsjtx && wsjtx\.lastHeardAt, Date\.now\(\)\)/.test(ref));
  assert.ok(/if \(heard === _wsjtxHeard\) return;/.test(ref) && /broadcastRemoteRadioStatus\(\)/.test(ref), 'pushed only on a change');
  assert.ok(/win\.webContents\.send\('wsjtx-status', \{ \.\.\.s, heard: _wsjtxHeard \}\)/.test(main), 'the main window gets heard too');
  assert.ok(/\| `wsjtxMode` \| boolean \|/.test(protocol) && /\| `wsjtxHeard` \| boolean \|/.test(protocol), 'documented in the status table');
  assert.ok(/\| `rig-reconnect-ack` \| S→C \|.*code: "wsjtx-mode"/.test(protocol), 'rig-reconnect-ack documented');
});

test('Settings: labelled WSJT-X Mode, and turning it on asks the CAT menu confirm', () => {
  assert.ok(/<input type="checkbox" id="set-enable-wsjtx"> WSJT-X Mode<\/label>/.test(html));
  assert.ok(!/WSJT-X Integration/.test(html));
  const h = app.slice(app.indexOf("setEnableWsjtx.addEventListener('change'"), app.indexOf("setEnableWsjtx.addEventListener('change'") + 300);
  assert.ok(/if \(setEnableWsjtx\.checked && !confirmEnableWsjtx\(\)\) \{\n\s*setEnableWsjtx\.checked = false;/.test(h), 'Settings uses the same confirm');
  const cat = app.slice(app.indexOf("catPopoverWsjtx.addEventListener('change'"), app.indexOf("catPopoverWsjtx.addEventListener('change'") + 400);
  assert.ok(/if \(enabled && !confirmEnableWsjtx\(\)\)/.test(cat), 'the CAT menu confirm is unchanged');
  assert.ok(/await setWsjtxMode\(enabled\);/.test(cat), 'the box and the panel turn it off the same way');
  const set = app.slice(app.indexOf('async function setWsjtxMode('), app.indexOf('function turnOffWsjtxMode('));
  assert.ok(/saveSettings\(\{ enableWsjtx: enabled, wsjtxPort: port \}\)/.test(set) && !/confirm/.test(set), 'turning OFF needs no confirm');
});

test('status bar: the chip is first, amber from theme tokens; the pill is CAT: off, never green', () => {
  const bar = html.slice(html.indexOf('<div class="status-bar">'), html.indexOf('<span id="spot-count">'));
  const chipAt = bar.indexOf('id="wsjtx-status"');
  assert.ok(chipAt > 0 && chipAt < bar.indexOf('id="cat-status"'), 'first among the chips, before CAT');
  assert.ok(/id="wsjtx-status" class="status wsjtx-mode-chip hidden"[^>]*>WSJT-X Mode</.test(bar));
  assert.ok(!/class="status (connected|disconnected)'?\s*\+?.*wsjtx/.test(app.slice(app.indexOf('window.api.onWsjtxStatus('), app.indexOf('window.api.onWsjtxState('))), 'the chip no longer turns green/red');
  assert.ok(!app.includes("'Radio controlled by WSJT-X'"), 'the green "Radio controlled by WSJT-X" pill is gone');
  const cs = app.slice(app.indexOf('window.api.onCatStatus('), app.indexOf('// --- Update available listener ---'));
  assert.ok(/if \(wsjtxMode \|\| \(enableWsjtx && !connected\)\) \{[\s\S]*?catStatusEl\.className = 'status wsjtx-off';/.test(cs));
  assert.ok(/if \(enableWsjtx && typeof WsjtxModeNotice !== 'undefined'\) return WsjtxModeNotice\.catPill\(\)\.label;/.test(app));
  // Token-only colours in every new rule.
  const block = css.slice(css.indexOf('.status.wsjtx-mode-chip {'), css.indexOf('.ss-notice-text')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(block.length > 200);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block), 'no hard-coded colours: ' + (block.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/) || [''])[0]);
  assert.ok(/\.status\.wsjtx-mode-chip \{[^}]*var\(--warn-subtle\)[^}]*var\(--warn\)/.test(block));
  assert.ok(/\.status\.wsjtx-off \{[^}]*var\(--bg-tertiary\)[^}]*var\(--text-secondary\)/.test(block));
  assert.ok(!/cat-popover-wsjtx-warning/.test(css + html), 'the old hard-coded warning box is gone');
});

test('panel: the chip and the CAT pill open it; Turn off and Keep it on', () => {
  for (const id of ['cat-popover-wsjtx-panel', 'wsjtx-panel-title', 'wsjtx-panel-line', 'wsjtx-panel-state', 'wsjtx-panel-hint', 'wsjtx-panel-off', 'wsjtx-panel-keep']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.ok(html.indexOf('id="cat-popover-wsjtx-panel"') < html.indexOf('id="cat-popover-rigs"'), 'the panel heads the CAT menu');
  assert.ok(/wsjtxStatusEl\.addEventListener\('click', openCatPopoverFromWsjtxChip\);/.test(app));
  assert.ok(/W\.panel\(\{ heard: wsjtxHeard, port:/.test(app));
  assert.ok(/getElementById\('wsjtx-panel-off'\)\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); turnOffWsjtxMode\(\); \}\);/.test(app));
  assert.ok(/getElementById\('wsjtx-panel-keep'\)\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); closeCatPopover\(\); \}\);/.test(app));
  assert.ok(html.includes('<script src="../lib/wsjtx-mode-notice.js"></script>'));
  assert.ok(html.indexOf('../lib/wsjtx-mode-notice.js') < html.indexOf('<script src="app.js">'));
});

test('start notice: an in-app card after 30 s, Keep it on until next start', () => {
  assert.ok(/<div id="wsjtx-mode-card" class="station-setup-card wsjtx-mode-card hidden" role="alert">/.test(html));
  assert.ok(/W\.startNotice\(\{ mode: enableWsjtx, heard: wsjtxHeard, everHeard: wsjtxEverHeard, kept: wsjtxNoticeKept \}\)/.test(app));
  assert.ok(/WsjtxModeNotice\.START_NOTICE_DELAY_MS\) \|\| 30000\);/.test(app));
  assert.ok(/getElementById\('wsjtx-card-keep'\)\.addEventListener\('click', \(\) => \{\n\s*wsjtxNoticeKept = true;/.test(app));
  assert.ok(/if \(wsjtxHeard\) wsjtxEverHeard = true;/.test(app));
});

test('Station Setup: a top line with Turn off when the mode is on', () => {
  const ctx = { rig: { id: 'r1', model: 'IC-7300', active: true, inputDeviceId: 'x' }, live: { callsign: 'K1ABC', grid: 'FN20', catConnected: false, wsjtxMode: true } };
  const r = StationSetup.evaluateChecklist(ctx);
  assert.deepStrictEqual(r.notice, W.stationSetupNotice());
  const rc = r.steps.find((s) => s.id === 'radio-control');
  assert.strictEqual(rc.state, 'skipped');
  assert.deepStrictEqual(rc.actions, [{ id: 'wsjtx-mode-off', label: 'Turn off WSJT-X Mode' }]);
  assert.strictEqual(StationSetup.shouldPromptAtLaunch(r, {}), false, 'no launch nag on top of the WSJT-X notice');
  const off = StationSetup.evaluateChecklist({ ...ctx, live: { ...ctx.live, wsjtxMode: false } });
  assert.strictEqual(off.notice, null);
  assert.strictEqual(off.steps.find((s) => s.id === 'radio-control').state, 'needs');
  assert.ok(/wsjtxMode: isActive && !!settings\.enableWsjtx,/.test(main));
  assert.ok(html.includes('id="ss-notice"'));
  assert.ok(/case 'wsjtx-mode-off':[\s\S]{0,200}turnOffWsjtxMode\(\)/.test(ssRenderer));
});

test('bug report: the WSJT-X line leads the header and says whether WSJT-X was heard', () => {
  assert.ok(/window\.WsjtxModeNotice\.reportLine\(\{ mode: true, heard: wsjtxHeard, port: s\.wsjtxPort \}\)/.test(app));
  assert.ok(/'## POTACAT Bug Report',\n\s*'',\n\s*\.\.\.\(md\.wsjtxMode \? \[md\.wsjtxMode\] : \[\]\),\n\s*'\*\*Version:\*\* v' \+ md\.version,/.test(app));
  assert.ok(!app.includes('WSJT-X integration is ON'));
});

test('ECHOCAT Web: chip and explain-only note from the status fields', () => {
  assert.ok(remoteHtml.includes('<!-- wsjtx-mode-notice-js -->'));
  assert.ok(remoteServer.includes("['wsjtx-mode-notice-js', 'wsjtx-mode-notice.js']"), 'inlined by the server');
  assert.ok(/id="wsjtx-mode-chip" class="wsjtx-mode-chip hidden"[^>]*>WSJT-X Mode</.test(remoteHtml));
  assert.ok(remoteHtml.includes('<div id="wsjtx-mode-note" class="hidden" role="status"></div>'));
  assert.ok(/if \(s\.wsjtxMode !== undefined\) applyWsjtxMode\(!!s\.wsjtxMode, !!s\.wsjtxHeard\);/.test(remoteJs));
  assert.ok(/wsjtxModeNote\.textContent = W \? W\.remoteNote\(\) : '';/.test(remoteJs));
  assert.ok(!/saveSettings|enableWsjtx/.test(remoteJs.slice(remoteJs.indexOf('function applyWsjtxMode('), remoteJs.indexOf('function updateStatus('))), 'no remote turn-off');
  const block = remoteCss.slice(remoteCss.indexOf('/* WSJT-X Mode at the shack (#547)')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block), 'token colours only');
  assert.ok(/:root\[data-ds\] \{\n\s*--wsjtx-warn: var\(--ds-warn\);/.test(block), 'the design-system warning token in the six themes');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
