#!/usr/bin/env node
'use strict';
// APRS A1: messages end to end against a local fake APRS-IS server (nothing
// reaches the real one), and as wired in main.js, the preload and the APRS
// window (source-text guards; CRLF and LF both pass).
// Run: node test/aprs-messages-wiring-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AprsIsClient } = require('../lib/aprs-is');
const { AprsIsFeed } = require('../lib/aprs-is-feed');
const { createMessenger } = require('../lib/aprs-messenger');
const { startFakeAprsIs } = require('./fixtures/fake-aprs-is-server');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return fn(); }
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return src.slice(i, src.indexOf('\n}\n', i));
};

(async () => {
  console.log('APRS messages: wiring');

  await test('end to end: a message goes up the verified uplink; a message to us comes in on the feed and is acked up the uplink', async () => {
    const srv = await startFakeAprsIs();
    const feed = new AprsIsFeed({ call: 'K3ABC', host: '127.0.0.1', port: srv.port, lat: 41.7, lon: -72.7, km: 150 });
    const up = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1' });
    const m = createMessenger({ myCall: 'K3ABC-10', myBase: 'K3ABC', canSend: () => up.verified, send: (l) => up.send(l) });
    feed.on('line', (l) => { m.receive(l); m.tick(); });
    feed.start(); up.connect();
    await until(() => up.verified && feed.state === 'connected');
    assert.ok(srv.logins.some((l) => l.readOnly && / g\/K3ABC\/K3ABC-\*$/.test(l.filter)), 'the feed asks for our messages');
    m.compose('W1AW', 'hello from POTACAT');
    m.tick();
    assert.ok(await until(() => srv.received.some((r) => r.call === 'K3ABC-10' && r.line === 'K3ABC-10>APZPCT,TCPIP*::W1AW     :hello from POTACAT{1')));
    srv.feed('W1AW>APRS,TCPIP*,qAC,T2FAKE::K3ABC-10 :ack1');
    srv.feed('W1AW>APRS,TCPIP*,qAC,T2FAKE::K3ABC    :got it, 73{88');
    assert.ok(await until(() => srv.received.some((r) => r.line === 'K3ABC-10>APZPCT,TCPIP*::W1AW     :ack88')), 'the ack goes up');
    const t = m.thread('W1AW');
    assert.strictEqual(t[0].state, 'delivered');
    assert.strictEqual(t[1].text, 'got it, 73');
    assert.strictEqual(m.unread(), 1);
    assert.strictEqual(srv.received.filter((r) => r.call === 'K3ABC').length, 0, 'the read-only feed never sends a packet');
    up.disconnect(); feed.stop();
    await srv.close();
  });

  await test('an unverified login sends nothing; the message waits, then says APRS-IS could not be reached', async () => {
    const srv = await startFakeAprsIs({ refuseVerify: true });
    const up = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1' });
    let t = 0;
    const m = createMessenger({ now: () => t, myCall: 'K3ABC-10', myBase: 'K3ABC', canSend: () => up.verified, send: (l) => up.send(l) });
    up.connect();
    await until(() => up.state === 'unverified');
    m.compose('W1AW', 'hello');
    m.tick(); t += 120000; m.tick();
    await wait(100);
    assert.strictEqual(srv.received.filter((r) => r.line[0] !== '#').length, 0);
    assert.strictEqual(m.thread('W1AW')[0].status, 'APRS-IS could not be reached, so it was not sent');
    up.disconnect();
    await srv.close();
  });

  const main = read('main.js');

  await test('main.js: every feed line goes to the messenger; the uplink is wanted only while a message or ack waits', () => {
    const start = fnBody(main, 'aprsStartFeed');
    assert.ok(/aprsMessagesFeedLine\(line\)/.test(start));
    const run = fnBody(main, 'aprsMessagesRun');
    assert.ok(/needsLink\(\)[\s\S]*aprsUplinkWant\('messages', true\)/.test(run));
    assert.ok(/aprsUplinkWant\('messages', false\)/.test(run), 'let go when nothing waits');
  });

  await test('main.js: messages go out as the uplink login (-10) through the verified uplink only, never a radio', () => {
    const block = main.slice(main.indexOf('// ── APRS A1: messages over the internet'), main.indexOf('// ── APRS phase 7'));
    assert.ok(block.length > 500);
    assert.ok(/AprsIgate\.uplinkLogin\(settings\.myCallsign\)/.test(block));
    assert.ok(/aprsUplink\.verified/.test(block) && /aprsUplink\.send\(line\)/.test(block));
    assert.ok(!/aprsRf|direwolf|Direwolf|ptt|PTT|setTransmit|keyRadio/.test(block), 'no radio in A1');
    assert.ok(/aprs-messages\.json/.test(block) && /profileDir\(/.test(block), 'kept per profile');
  });

  await test('main.js: the window asks, sends, views, stops; a test build sends nothing; quit saves', () => {
    for (const ch of ["'aprs-messages-get'", "'aprs-message-send'", "'aprs-messages-view'", "'aprs-message-stop'", "'aprs-messages-delete'"]) assert.ok(main.includes(ch), ch);
    assert.ok(/if \(!aprsIsServer\(\)\) return \{ ok: false/.test(fnBody(main, 'aprsMessageSend')));
    const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('before-quit'") + 1500);
    assert.ok(/aprsMessagesSaveNow\(\)/.test(quit));
  });

  await test('preload and window: the channels, the Messages view, the 67-character counter', () => {
    const pre = read('preload-aprs-popout.js');
    for (const k of ['messagesGet', 'messageSend', 'messagesView', 'messageStop', 'messagesDelete', 'onMessages']) assert.ok(pre.includes(k + ':'), k);
    const html = read('renderer/aprs-popout.html');
    assert.ok(/id="aprs-view-msgs"/.test(html) && /id="aprs-msgs-badge"/.test(html));
    assert.ok(/id="aprs-msgs-to"/.test(html) && /id="aprs-msgs-text"/.test(html) && /0 \/ 67/.test(html));
    assert.ok(html.indexOf('../lib/aprs-message.js') < html.indexOf('aprs-messages.js"'), 'the formats load before the view');
    const js = read('renderer/aprs-messages.js');
    assert.ok(/M\.counter\(/.test(js) && /M\.checkAddressee\(/.test(js));
    assert.ok(!/\balert\(|\bconfirm\(/.test(js), 'no pop-ups');
    const css = read('renderer/aprs-messages.css');
    assert.ok(!/#[0-9a-fA-F]{3,6}\b(?![^(]*\))/.test(css.replace(/var\([^)]*\)/g, '')), 'theme variables only');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
