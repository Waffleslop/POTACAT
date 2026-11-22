#!/usr/bin/env node
'use strict';
// The radio's GPS over the SmartSDR API connection (lib/smartsdr.js): one
// `sub gps all` per connection, on the connection POTACAT already holds, a
// 'gps' event from the status lines, and never a set command because of it.
// A fake socket stands in for the radio; nothing goes on the network but the
// meter UDP port the client always opens on localhost.
// Run: node test/smartsdr-gps-test.js
const assert = require('assert');
const net = require('net');
const { EventEmitter } = require('events');

const written = [];
class FakeSocket extends EventEmitter {
  setNoDelay() {}
  connect() { setImmediate(() => this.emit('connect')); return this; }
  write(s) { written.push(String(s)); return true; }
  destroy() {}
  end() {}
}
// stdout/stderr on a pipe are net.Sockets made on first use: make them before the swap.
void process.stdout; void process.stderr;
const RealSocket = net.Socket;
net.Socket = FakeSocket;
const { SmartSdrClient } = require('../lib/smartsdr');

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log('  ok  ' + label); } else { fail++; console.log('  FAIL ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmds = () => written.map((w) => w.replace(/^C\d+\|/, '').trim());

(async () => {
  const c = new SmartSdrClient();
  const events = [];
  c.on('gps', (s) => events.push(s));
  c.connect('192.0.2.10');
  await sleep(50);

  const subs = cmds().filter((x) => x === 'sub gps all');
  check(subs.length === 1, 'sub gps all is sent once on connect');
  check(cmds().includes('info'), 'info is asked once (gps=Not Present means no GPS)');

  const before = written.length;
  c._handleLine('S4A2B1C3D|gps lat=0#lon=0#grid=#altitude=0 m#tracked=0#visible=12#speed=0 kts#freq_error=0 ppb#status=Warming Up#time=04:49:39Z#track=0.0');
  c._handleLine('S4A2B1C3D|gps gnss_powered_ant=false');
  check(events.length === 2, "a 'gps' event per change");
  const s = events[events.length - 1];
  check(s.installed === true && s.fix === false && s.status === 'Warming Up' && s.visible === 12 && s.antennaPowered === false, 'the event carries the merged state');
  check(c.gpsState().status === 'Warming Up', 'gpsState() returns the latest');
  c._handleLine('S4A2B1C3D|gps lat=0#lon=0#grid=#altitude=0 m#tracked=0#visible=12#speed=0 kts#freq_error=0 ppb#status=Warming Up#time=04:49:39Z#track=0.0');
  check(events.length === 2, 'the same state again is no new event');
  c._handleLine('S4A2B1C3D|gps lat=38.8895#lon=-77.0353#grid=FM18lv#tracked=9#status=Fine Lock#time=05:10:02Z');
  check(events.length === 3 && events[2].fix === true && events[2].grid === 'FM18lv', 'a fix arrives as an event');
  check(written.length === before, 'gps lines send nothing to the radio');

  // The info reply: a radio with no GPS.
  const infoSeq = [...c._awaiting.keys()][0];
  if (infoSeq !== undefined) c._handleLine(`R${infoSeq}|0|model="FLEX-6400",gps="Not Present"`);
  await sleep(10);
  check(c.gpsState().installed === false, 'info gps=Not Present: not installed');

  // Nothing GPS-related is ever a set or an install.
  const gpsCmds = cmds().filter((x) => /gps/i.test(x));
  check(gpsCmds.every((x) => x === 'sub gps all'), 'the only gps command is the subscription: ' + JSON.stringify(gpsCmds));
  check(!cmds().some((x) => /^radio gps|gps (set|install|uninstall)/i.test(x)), 'never radio gps install/uninstall or a gps set');

  // A new connection subscribes again, once, and starts from nothing.
  c.disconnect();
  written.length = 0;
  c.connect('192.0.2.10');
  await sleep(50);
  check(cmds().filter((x) => x === 'sub gps all').length === 1, 'a reconnect subscribes once again');
  check(c.gpsState().installed === false && c.gpsState().status === '', 'a reconnect forgets the old GPS state');

  c.disconnect();
  net.Socket = RealSocket;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
