#!/usr/bin/env node
'use strict';
// APRS window, 2026-11-19 (Casey: "I should just be able to do a 1-click
// transmit. Also I should be able to see my SWR, S-meter and also change my
// tx signal power"; and "shouldn't I be able to change my callsign addendum
// (K3SBP-10)?"). The radio beacon is one click, its button reads band,
// frequency and power before the click, a refused gate still disables it, a
// second click during a beacon does nothing; the window shows the meters and
// sets TX power through set-tx-power with the radio's read-back; "My APRS
// SSID" picks the radio beacon's SSID, the default unchanged.
// The window's script runs here against a small stand-in DOM.
// Run: node test/aprs-rf-one-click-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const exists = (f) => fs.existsSync(path.join(root, f));
const fnBody = (src, name) => {
  let i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) i = src.indexOf('\nasync function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return src.slice(i, src.indexOf('\n}\n', i));
};

console.log('APRS radio beacon: one click, meters, TX power, My APRS SSID');

// ── a stand-in DOM, enough for the APRS window's bar scripts ─────────────────
function makeDom(ids) {
  const els = {};
  function el(id, tag) {
    const cls = new Set();
    const e = {
      id, tagName: (tag || 'span').toUpperCase(), textContent: '', title: '', disabled: false, hidden: false, value: '',
      min: '', max: '', step: '', innerHTML: '', className: '', dataset: {}, style: {}, children: [], options: [], attrs: {}, listeners: {},
      classList: {
        add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
        toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); },
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { this.children.push(c); if (c.tagName === 'OPTION') this.options.push(c); return c; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      fire(t, ev) { for (const fn of this.listeners[t] || []) fn(ev || { target: this }); },
      blur() {},
    };
    Object.defineProperty(e, 'innerHTML', { get() { return ''; }, set() { e.children = []; e.options = []; } });
    const tc = { v: '' };
    Object.defineProperty(e, 'textContent', { get() { return tc.v || e.children.map((c) => c.textContent).join(' '); }, set(v) { tc.v = String(v); if (v === '') e.children = []; } });
    return e;
  }
  for (const id of ids) els[id] = el(id, /select$|-ssid$/.test(id) ? 'select' : /range$/.test(id) ? 'input' : /-now$/.test(id) ? 'button' : 'span');
  const document = {
    hidden: false, activeElement: null,
    documentElement: { getAttribute: () => '' },
    getElementById: (id) => els[id] || null,
    createElement: (tag) => el('', tag),
    addEventListener() {},
  };
  return { els, document };
}

function loadBar({ now = 1000 } = {}) {
  const ids = ['aprs-rf-now', 'aprs-rf-detail', 'aprs-rf-status', 'aprs-rf-dot', 'aprs-rf-text', 'aprs-rf-meters', 'aprs-rf-last',
    'aprs-rf-power', 'aprs-rf-power-range', 'aprs-rf-power-select', 'aprs-rf-power-val'];
  const { els, document } = makeDom(ids);
  const calls = { rfSend: 0, rfGet: 0, rig: [] };
  const on = {};
  const timers = [];
  const clock = { t: now };
  const api = {
    rfGet: () => { calls.rfGet++; }, rfSend: () => { calls.rfSend++; },
    onRf: (cb) => { on.rf = cb; },
    rigControl: (d) => { calls.rig.push(d); return Promise.resolve({ ok: true }); },
    rigPowerGet: () => {}, onRigPower: (cb) => { on.power = cb; },
    onCatSmeter: (cb) => { on.smeter = cb; }, onCatSwr: (cb) => { on.swr = cb; },
    onCatSwrRatio: (cb) => { on.swrRatio = cb; }, onCatFwdPower: (cb) => { on.fwd = cb; },
  };
  const DateStub = { now: () => clock.t };
  const ctx = {
    document, console, Date: DateStub, Math, Number, String, parseFloat, parseInt, isFinite, JSON, Object, Array, Infinity,
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock.t + ms }); return timers.length; }, clearTimeout: () => {},
    setInterval: () => 0,
  };
  ctx.window = ctx; ctx.self = ctx;
  ctx.window.api = api;
  vm.createContext(ctx);
  vm.runInContext(read('lib/rig-power-view.js'), ctx);
  vm.runInContext(read('lib/aprs-rf-meters.js'), ctx);
  vm.runInContext(read('renderer/aprs-rf-beacon-bar.js'), ctx);
  const runTimers = () => { const due = timers.splice(0); for (const t of due) t.fn(); };
  return { els, calls, on, clock, runTimers };
}

const READY = {
  allowed: true, reason: '', why: '', band: '30m', bandLabel: '30 m', mode: 'USB', mhz: '10.1476', powerW: 5,
  preview: { button: 'Beacon now on 30 m, 10.1476 MHz at 5 W', detail: 'USB, as K3SBP, path WIDE1-1, about 1.6 s on the air. One click transmits one packet.' },
  sending: false, phase: 'idle', keyed: false, meters: { smeter: true, swr: true, alc: false, power: true }, lastPeak: null,
  sentence: '', lastAt: 0, lastPacket: '', lastBand: '',
};

// ── one click ────────────────────────────────────────────────────────────────
test('the button reads band, frequency and power before the click, and the line under it mode, call, path and air time', () => {
  const R = require('../lib/aprs-rf-beacon');
  const p = R.rfPreview({ bandLabel: '30 m', mhz: '10.1476', mode: 'USB', powerW: 5, path: ['WIDE1-1'], airMs: 1600, source: 'K3SBP' });
  assert.strictEqual(p.button, 'Beacon now on 30 m, 10.1476 MHz at 5 W');
  assert.ok(/USB/.test(p.detail) && /as K3SBP/.test(p.detail) && /path WIDE1-1/.test(p.detail) && /about 1\.6 s on the air/.test(p.detail), p.detail);
  const unknown = R.rfPreview({ bandLabel: '2 m', mhz: '144.390', mode: 'FM', powerW: 0, path: ['WIDE1-1', 'WIDE2-1'], airMs: 900, source: 'K3SBP-9' });
  assert.strictEqual(unknown.button, 'Beacon now on 2 m, 144.390 MHz');
  assert.ok(/power set on the radio/.test(unknown.detail) && /WIDE1-1,WIDE2-1/.test(unknown.detail));
  const narrow = R.rfPreview({ bandLabel: '30 m', mhz: '10.1476', mode: 'USB', powerW: 10, path: ['WIDE1-1'], airMs: 1600, source: 'K3SBP', txNarrow: { lo: 1400, hi: 2000 } });
  assert.ok(/narrowed to 1400-2000 Hz/.test(narrow.detail));

  const b = loadBar();
  b.on.rf(READY);
  const btn = b.els['aprs-rf-now'];
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.textContent, 'Beacon now on 30 m, 10.1476 MHz at 5 W');
  assert.ok(/path WIDE1-1/.test(b.els['aprs-rf-detail'].textContent));
});

test('one click sends: rfSend at once, no confirmation step anywhere', () => {
  const b = loadBar();
  b.on.rf(READY);
  b.els['aprs-rf-now'].fire('click');
  assert.strictEqual(b.calls.rfSend, 1, 'one click, one send');
  const all = read('renderer/aprs-popout.html') + read('renderer/aprs-rf-beacon-bar.js') + read('preload-aprs-popout.js');
  assert.ok(!/aprs-rf-confirm|aprs-rf-cancel|rfAsk|rfCancel|aprs-rf-ask/.test(all), 'no confirm line, Cancel or ask step in the window');
  const main = read('main.js');
  assert.ok(!/aprs-rf-ask|aprs-rf-cancel|aprsRfAsk|aprsRfCancel|APRS_RF_CONFIRM_MS|aprsRfUi\.confirm/.test(main), 'no confirm step in main');
  assert.ok(/ipcMain\.on\('aprs-rf-send', \(\) => \{ aprsRfSend\(\)/.test(main));
});

test('a second click while a beacon is going out does nothing (window and main)', () => {
  const b = loadBar();
  b.on.rf(READY);
  const btn = b.els['aprs-rf-now'];
  btn.fire('click');
  assert.strictEqual(btn.disabled, true, 'disabled at once');
  btn.fire('click');
  b.on.rf(READY); // a push from before the click arrives: still held
  btn.fire('click');
  assert.strictEqual(b.calls.rfSend, 1);
  b.clock.t += 5000;
  b.on.rf({ ...READY, sending: true, phase: 'waiting' });
  assert.strictEqual(btn.disabled, true, 'main says a beacon is going out');
  btn.fire('click');
  b.on.rf({ ...READY, phase: 'keyed', keyed: true });
  btn.fire('click');
  assert.strictEqual(b.calls.rfSend, 1, 'never a second send');
  b.on.rf(READY);
  assert.strictEqual(btn.disabled, false, 'ready again after the beacon');
  // main: the click handler returns at once while one is in flight
  const send = fnBody(read('main.js'), 'aprsRfSend');
  assert.ok(/if \(_aprsRfSending \|\| aprsRfInFlight\(\)\) return;/.test(send), send);
  assert.ok(send.indexOf('_aprsRfSending = true') < send.indexOf('aprsRfTransmit()') && /finally \{ _aprsRfSending = false;/.test(send));
});

test('a refused gate still disables the button, with its sentence', () => {
  const b = loadBar();
  const why = 'Turn on Listen on my radio first. The beacon goes out on the frequency it listens on.';
  b.on.rf({ ...READY, allowed: false, reason: 'listen', why });
  const btn = b.els['aprs-rf-now'];
  assert.strictEqual(btn.disabled, true);
  assert.strictEqual(btn.textContent, 'Beacon now (radio)');
  assert.strictEqual(btn.title, why);
  assert.strictEqual(b.els['aprs-rf-text'].textContent, 'Radio beacon: ' + why);
  btn.fire('click');
  assert.strictEqual(b.calls.rfSend, 0);
  // main judges the gate again at the click, before the runner
  const t = fnBody(read('main.js'), 'aprsRfTransmit');
  assert.ok(t.indexOf('AprsRfGate.readiness(aprsRfGateState())') > 0 && t.indexOf('AprsRfGate.readiness(aprsRfGateState())') < t.indexOf('aprsRfRunner()'));
  assert.ok(t.indexOf('if (APRS_DEV_FRAMES)') < t.indexOf('aprsRfRunner()'), 'a dev build never transmits');
});

// ── meters ───────────────────────────────────────────────────────────────────
test('meters: the S-meter while listening, SWR and RF out while the beacon transmits, peaks after', () => {
  const b = loadBar();
  b.on.rf(READY);
  b.on.smeter(100);
  const txt = () => b.els['aprs-rf-meters'].children.map((c) => c.children.map((x) => x.textContent).join(' ')).join(' | ');
  assert.ok(/S-meter S8/.test(txt()), txt());
  assert.ok(/SWR shows while transmitting/.test(txt()), txt());
  b.on.rf({ ...READY, phase: 'keyed', keyed: true });
  b.on.swr(30); // wire 30 = 1.5
  b.on.fwd(5);
  assert.ok(/SWR 1\.5/.test(txt()) && /RF out 5 W/.test(txt()), txt());
  b.on.swrRatio(1.3); // the radio's true ratio wins
  assert.ok(/SWR 1\.3/.test(txt()), txt());
  b.on.rf({ ...READY, lastPeak: { swr: 1.3, fwdW: 5.1 } });
  assert.strictEqual(b.els['aprs-rf-last'].textContent, 'Peak on the last radio beacon: SWR 1.3, RF out 5.1 W.');
});

test('meters: a radio with no SWR says so and never shows a made-up value', () => {
  const M = require('../lib/aprs-rf-meters');
  const v = M.meterView({ txing: true, swr: 0, fwdW: 4, available: { smeter: true, swr: false, power: true } });
  assert.strictEqual(v.items.find((i) => i.key === 'swr').text, 'No SWR from this radio');
  const rx = M.meterView({ txing: false, smeter: 120, available: { smeter: true, swr: false } });
  assert.strictEqual(rx.items.find((i) => i.key === 'swr').text, 'No SWR from this radio');
  assert.strictEqual(rx.items.find((i) => i.key === 'smeter').text, 'S9');
  const last = M.meterView({ txing: false, available: { swr: false }, last: { swr: 0, fwdW: 5 } });
  assert.strictEqual(last.last, 'Peak on the last radio beacon: no SWR from this radio, RF out 5 W.');
  const b = loadBar();
  b.on.rf({ ...READY, keyed: true, phase: 'keyed', meters: { smeter: true, swr: false, power: true } });
  assert.ok(/No SWR from this radio/.test(b.els['aprs-rf-meters'].textContent), b.els['aprs-rf-meters'].textContent);
  // the scale is the VFO and JTCAT windows': S9 at 120, S9+60 at 255; SWR 1 + v/60
  assert.strictEqual(M.sLabel(255), 'S9+60');
  assert.strictEqual(M.swrFromWire(60), 2);
  assert.strictEqual(M.swrClass(1.4), 'ok'); assert.strictEqual(M.swrClass(2.5), 'warn'); assert.strictEqual(M.swrClass(3.5), 'high');
});

test('the peaks: only between the beacon\'s key-down and its end; the true ratio wins over the wire value', () => {
  const M = require('../lib/aprs-rf-meters');
  const p = M.createPeak();
  p.note('swr', 3); p.note('fwd', 50);
  p.start();
  p.note('swr', 1.5); p.note('swr-ratio', 1.2); p.note('fwd', 4.96); p.note('fwd', 2);
  assert.deepStrictEqual(p.end(), { swr: 1.2, fwdW: 5 });
  p.note('fwd', 80);
  assert.strictEqual(p.active(), false);
  const main = read('main.js');
  assert.ok(/_aprsRfKeyed = true;\n  _aprsRfPeak\.start\(\);/.test(fnBody(main, 'aprsRfKey')));
  assert.ok(/aprsRfUi\.lastPeak = _aprsRfPeak\.end\(\)/.test(fnBody(main, 'aprsRfTransmit')));
});

test('main feeds the window the meters every window gets', () => {
  const main = read('main.js');
  assert.ok(/aprsWinMeter\('cat-smeter', val\)/.test(fnBody(main, 'sendCatSmeter')));
  assert.ok(/aprsWinMeter\('cat-swr', val\)/.test(fnBody(main, 'sendCatSwr')));
  assert.ok(/aprsWinMeter\('cat-fwd-power', v\)/.test(fnBody(main, 'sendCatFwdPower')));
  assert.ok((main.match(/aprsWinMeter\('cat-swr-ratio', /g) || []).length >= 3, 'Flex, TCI and remote SWR ratio');
  assert.ok(/meters: vfoMetersAvailable\(\)/.test(fnBody(main, 'aprsRfPayload')), 'the VFO window\'s rule for which meters the radio has');
  const pre = read('preload-aprs-popout.js');
  for (const ch of ['cat-smeter', 'cat-swr', 'cat-swr-ratio', 'cat-fwd-power']) assert.ok(pre.indexOf("'" + ch + "'") > 0, ch);
});

// ── TX power ─────────────────────────────────────────────────────────────────
test('the power control sends set-tx-power through rig-control and shows the radio\'s read-back', () => {
  const b = loadBar();
  const payload = { watts: 5, powerUnit: 'W', settable: true, capable: true, known: true, minPower: 5, maxPower: 100, powerStep: 1, powerDecimals: 0, powerChoices: null };
  b.on.power(payload);
  const box = b.els['aprs-rf-power'], range = b.els['aprs-rf-power-range'], val = b.els['aprs-rf-power-val'];
  assert.strictEqual(box.classList.contains('hidden'), false);
  assert.strictEqual(String(range.min), '5'); assert.strictEqual(String(range.max), '100');
  assert.strictEqual(val.textContent, 'radio reads 5W');
  range.value = '20';
  range.fire('input');
  assert.strictEqual(val.textContent, 'setting 20W');
  b.runTimers();
  assert.strictEqual(JSON.stringify(b.calls.rig), JSON.stringify([{ action: 'set-tx-power', value: 20 }]));
  b.clock.t += 1000;
  b.on.power({ ...payload, watts: 20 });
  assert.strictEqual(val.textContent, 'radio reads 20W', 'the read-back, not the slider');
  b.on.power({ ...payload, capable: false });
  assert.strictEqual(box.classList.contains('hidden'), true, 'no txpower capability: no control, as elsewhere');
  const main = read('main.js');
  const push = fnBody(main, 'pushAprsRigPower');
  assert.ok(/jtcatPopoutRigPowerPayload\(\)/.test(push) && /'aprs-rig-power'/.test(push), 'the JTCAT / Winlink payload: the rig caps\' min/max');
  assert.ok(/pushAprsRigPower\(\);/.test(main), 'pushed with every rig state');
  assert.ok(/rigControl: \(d\) => ipcRenderer\.invoke\('rig-control', d\)/.test(read('preload-aprs-popout.js')));
});

test('the beacon itself still never changes power', () => {
  const main = read('main.js');
  const a = main.indexOf('// ── APRS phase 7: ONE manual beacon over the radio');
  const block = main.slice(a, main.indexOf('\nfunction killArdop() {', a));
  assert.ok(!/setPower|setRfPower|rfpower|set-power|applyRigControl|rigControl/i.test(block));
  assert.ok(!/set-tx-power/.test(read('lib/aprs-rf-beacon.js')));
});

test('the power note is short and factual', () => {
  const html = read('renderer/aprs-popout.html');
  const m = /id="aprs-rf-power-note">([^<]*)</.exec(html);
  assert.ok(m, 'the note is there');
  assert.ok(/5 W is fine to start/.test(m[1]) && /2 m commonly runs 5 to 50 W/.test(m[1]) && /30 m/.test(m[1]) && /depending on conditions/.test(m[1]));
});

// ── My APRS SSID ─────────────────────────────────────────────────────────────
test('My APRS SSID: 0 to 15 with the APRS SSID recommendations\' meanings', () => {
  const B = require('../lib/aprs-beacon');
  assert.deepStrictEqual(B.SSID_CHOICES.map((c) => c.ssid), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const label = (n) => B.SSID_CHOICES[n].label;
  assert.ok(/primary|home/.test(label(0)));
  assert.ok(/handheld/.test(label(7)));
  assert.ok(/primary mobile/.test(label(9)));
  assert.ok(/special activity/.test(label(6)));
  assert.ok(/internet|iGate/.test(label(10)));
  assert.ok(/weather station/.test(label(13)));
  assert.ok(/balloon/.test(label(11)));
});

test('My APRS SSID: the default keeps the radio beacon as before; a pick sets it; the Settings call is never touched', () => {
  const B = require('../lib/aprs-beacon');
  const R = require('../lib/aprs-rf-beacon');
  const pkt = (o) => R.buildRfBeacon({ settingsCall: 'K3SBP', band: '2m', lat: 40.5, lon: -75.05, symbol: 'car', comment: 'x', approx: true, ...(o || {}) });
  assert.strictEqual(B.beaconSettings({}).rfSsid, null, 'nothing picked');
  assert.strictEqual(pkt().source, 'K3SBP', 'default: no SSID, as before');
  assert.strictEqual(pkt({ settingsCall: 'K3SBP-7' }).source, 'K3SBP-7', 'default: the Settings call\'s own SSID, as before');
  assert.strictEqual(pkt({ ssid: 9 }).source, 'K3SBP-9');
  assert.ok(/^K3SBP-9>APZPCT,WIDE1-1,WIDE2-1:/.test(pkt({ ssid: 9 }).packet));
  assert.strictEqual(pkt({ settingsCall: 'K3SBP-7', ssid: 0 }).source, 'K3SBP', '0 = no SSID, never -0');
  assert.deepStrictEqual(B.settingsPatch({ rfSsid: 9 }), { aprsRfSsid: 9 });
  assert.deepStrictEqual(B.settingsPatch({ rfSsid: null }), { aprsRfSsid: null });
  assert.deepStrictEqual(B.settingsPatch({ rfSsid: 16 }), {}, 'out of range: dropped');
  assert.deepStrictEqual(B.settingsPatch({ rfSsid: 'x' }), {});
  assert.ok(!('myCallsign' in B.settingsPatch({ rfSsid: 9, myCallsign: 'X' })));
  assert.strictEqual(B.beaconSettings({ aprsRfSsid: 6 }).rfSsid, 6);
});

test('the internet beacon and the iGate stay on the login -10 (APRS-IS documents FROMCALL = login)', () => {
  const B = require('../lib/aprs-beacon');
  const b = B.buildBeacon({ settingsCall: 'K3SBP', lat: 40.5, lon: -75.05, symbol: 'house', comment: 'x', approx: true });
  assert.ok(/^K3SBP-10>APZPCT,TCPIP\*:/.test(b.packet));
  assert.strictEqual(require('../lib/aprs-igate').uplinkLogin('K3SBP-9').call, 'K3SBP-10');
});

test('main uses the pick for the packet and for Dire Wolf\'s MYCALL, and the window shows the calls', () => {
  const main = read('main.js');
  assert.ok(/ssid: st\.rfSsid/.test(fnBody(main, 'aprsRfPlan')));
  assert.ok(/ssid: AprsBeacon\.beaconSettings\(settings\)\.rfSsid/.test(fnBody(main, 'aprsRfStartModem')));
  assert.ok(/rfCall: login\.ok \? AprsRfBeacon\.rfSource\(settings\.myCallsign, login\.base, /.test(fnBody(main, 'aprsBeaconState')));
  const html = read('renderer/aprs-popout.html');
  assert.ok(/id="aprs-rf-ssid"/.test(html) && /id="aprs-beacon-as"/.test(html));
  const i = html.indexOf('id="aprs-rf-now"'), j = html.indexOf('id="aprs-beacon-as"');
  assert.ok(j > i && j - i < 400, 'the calls sit next to the beacon buttons');
  const bar = read('renderer/aprs-beacon-bar.js');
  assert.ok(/'Internet beacon as ' \+ s\.call/.test(bar) && /radio beacon as ' \+ s\.rfCall/.test(bar));
  assert.ok(/beaconSet\(\{ rfSsid: /.test(bar));
});

test('the new test is in scripts/run-tests.js', () => {
  assert.ok(read('scripts/run-tests.js').indexOf("'test/aprs-rf-one-click-test.js'") >= 0);
  assert.ok(exists('lib/aprs-rf-meters.js'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
