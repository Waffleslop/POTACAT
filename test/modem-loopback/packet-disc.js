#!/usr/bin/env node
'use strict';
// #300 with no radio: two Dire Wolfs over a raw audio relay, one playing this
// station (W1AAA) and one a gateway (W1BBB-10) that greets once, as a Winlink
// gateway does, and never again on the same link. A third AGW client on this
// station's Dire Wolf is POTACAT's own monitor (lib/direwolf-agw-monitor.js),
// and every frame it hears goes through lib/packet-link-close.js.
//
//   1. clean close: connect, greeting, then the disconnect Pat's clean close
//      sends ('d'). The watch must see the gateway's UA well inside
//      CLOSE_WAIT_MS, and the gateway must report the link gone.
//   2. dirty end: connect, greeting, then this station's Dire Wolf is killed
//      (what POTACAT did after a dirty disconnect). A new Dire Wolf calls
//      again: the gateway answers on the link it still holds, with no new
//      greeting, and the watch must call it held (stuck).
//
//   node test/modem-loopback/packet-disc.js        SKIP when assets/direwolf has no binary
//   LOOPBACK_REQUIRED=1 makes a missing binary a failure (CI).

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { rawEndpoint, crossConnect } = require('./relay');
const { binPath, Wolf } = require('./packet');
const Mon = require('../../lib/direwolf-agw-monitor');
const L = require('../../lib/packet-link-close');

const ROOT = path.join(__dirname, '..', '..');
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-packet-disc-'));
const ME = 'W1AAA', GW = 'W1BBB-10';
const GREETING = Buffer.from('[WL2K-5.0-B2FWIHJM$]\r;PQ: 12345678\rCMS via W1BBB >\r', 'latin1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dire Wolf refuses an AGW port above the registered range ("Invalid port
// number ... Using 8000"), so not an ephemeral port: one free in 20000-40000.
async function freePort() {
  for (;;) {
    const want = 20000 + Math.floor(Math.random() * 20000);
    const ok = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(want, '127.0.0.1', () => s.close(() => res(true))); });
    if (ok) return want;
  }
}

function monitor(port, watch, seen) {
  return Mon.createAgwMonitor({
    port,
    onFrame: (f, text) => { seen.push(text); watch.noteFrame(text, Date.now()); },
  });
}

async function waitFor(fn, ms, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
  return fn();
}

(async () => {
  if (!fs.existsSync(binPath(ROOT))) {
    const req = process.env.LOOPBACK_REQUIRED === '1';
    console.log(`packet disconnect loopback: ${req ? 'FAIL' : 'SKIP'} (no Dire Wolf at ${binPath(ROOT)})`);
    process.exit(req ? 1 : 0);
  }
  const results = [];
  const check = (ok, what) => { results.push({ ok: !!ok, what }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };
  const epA = await rawEndpoint(48000), epB = await rawEndpoint(48000);
  const relay = crossConnect(epA, epB);
  const agwA = await freePort(), agwB = await freePort();
  const B = new Wolf({ root: ROOT, name: 'gateway', call: GW, agwPort: agwB, audioPort: epB.port, dir: path.join(LOGS, 'B') });
  let A = new Wolf({ root: ROOT, name: 'station', call: ME, agwPort: agwA, audioPort: epA.port, dir: path.join(LOGS, 'A1') });
  // The gateway greets on the first connect of a link only.
  let greeted = 0;
  B.on('connected', () => { B.peer = ME; if (!greeted++) setTimeout(() => B.sendData(GREETING), 300); });
  let mon = null;
  try {
    await Promise.all([A.start(), B.start()]);
    await sleep(1500);

    // ── 1. the clean close ───────────────────────────────────────────────
    let watch = new L.PacketLinkWatch({ gateway: GW, mycall: ME });
    let seen = [];
    mon = monitor(agwA, watch, seen);
    await sleep(500);
    A.connect(GW);
    await A.once2('connected', 60000);
    await A.waitBytes(GREETING.length, 60000);
    check(watch.up && watch.greeting && !watch.stuck(Date.now()).stuck, 'clean: the link came up and the greeting was heard; not held');
    check(watch.needsClose({ patConnected: true }), 'clean: a link that is up needs closing');
    const t = Date.now();
    watch.beginClose(t);
    const goneP = B.once2('disconnected', L.CLOSE_WAIT_MS + 5000).then(() => true, () => false);
    A.disconnect(); // what Pat's clean close sends Dire Wolf
    const st = await waitFor(() => { const s = watch.closeState(Date.now()); return s.done ? s : null; }, L.CLOSE_WAIT_MS + 2000);
    check(st && st.by === 'UA' && st.ms < L.CLOSE_WAIT_MS, `clean: the gateway answered our DISC with ${st && st.by} after ${st && (st.ms / 1000).toFixed(1)} s`);
    const gone = await goneP;
    check(gone, 'clean: the gateway reports the link gone');
    mon.close(); mon = null;
    await sleep(1500);

    // ── 2. the dirty end, then a new call ────────────────────────────────
    greeted = 0;
    watch = new L.PacketLinkWatch({ gateway: GW, mycall: ME });
    seen = [];
    mon = monitor(agwA, watch, seen);
    await sleep(500);
    A.connect(GW);
    await A.once2('connected', 60000);
    // The greeting is not what this case is about: a link that is up is enough.
    await sleep(4000);
    console.log(`  dirty: the link is up (${watch.greeting ? 'greeting heard' : 'no greeting heard'}); the station's Dire Wolf is killed with it up`);
    mon.close(); mon = null;
    A.stop(); // killed with the link up: no DISC, as before this fix
    await sleep(3000);
    A = new Wolf({ root: ROOT, name: 'station', call: ME, agwPort: agwA, audioPort: epA.port, dir: path.join(LOGS, 'A2') });
    await A.start();
    await sleep(1500);
    watch = new L.PacketLinkWatch({ gateway: GW, mycall: ME, greetingWaitMs: 8000 });
    seen = [];
    mon = monitor(agwA, watch, seen);
    await sleep(500);
    A.connect(GW);
    const v = await waitFor(() => { const s = watch.stuck(Date.now()); return s.stuck ? s : null; }, 30000, 250);
    check(v && v.stuck, `dirty: the new call met the held link (${v ? v.why : 'not held'}; the gateway reported ${greeted} connects and greeted once)`);
    if (!(v && v.stuck)) console.log('  heard: ' + seen.slice(-12).join('\n         '));
    console.log(`  station AGW events: ${A.events.slice(-8).join(' | ')}`);
    console.log(`  gateway AGW events: ${B.events.slice(-8).join(' | ')}`);
  } catch (e) {
    check(false, `error: ${e.message}`);
    console.log(`  station AGW events: ${A.events.slice(-10).join(' | ')}`);
    console.log(`  gateway AGW events: ${B.events.slice(-10).join(' | ')}`);
  } finally {
    if (mon) mon.close();
    A.stop(); B.stop();
    relay.stop();
    await sleep(400);
    await Promise.all([epA.close(), epB.close()]);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\npacket disconnect loopback: ${passed} of ${results.length} passed. Logs: ${LOGS}`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
