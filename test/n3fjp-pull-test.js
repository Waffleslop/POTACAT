'use strict';
// Bringing in contacts logged in N3FJP on its own (W6ING 2026-10-25).
// N3FJP's API help page shows the LIST command but not its reply, so the
// parser is held to several plausible shapes and to dropping, never guessing.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const P = require('../lib/n3fjp-pull');
const { planImport } = require('../lib/qso-match');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
  };
  pending.push(run);
}

test('N3FJP column names (fld prefix) become ADIF', () => {
  const reply = '<CMD><LISTRESPONSE><RECORD><fldCall>w1aw</fldCall><fldDateStr>2026/10/25</fldDateStr>' +
    '<fldTimeOnStr>14:03:07</fldTimeOnStr><fldBand>20</fldBand><fldMode>SSB</fldMode><fldFrequency>14.2855</fldFrequency>' +
    '<fldRstS>59</fldRstS><fldRstR>57</fldRstR><fldName>Hiram</fldName><fldState>CT</fldState>' +
    '<fldCountryWorked>USA</fldCountryWorked><fldGridR>FN31</fldGridR><fldComments>nice</fldComments></RECORD></LISTRESPONSE></CMD>';
  const { records, dropped } = P.parseListReply(reply);
  assert.strictEqual(dropped, 0);
  assert.deepStrictEqual(records, [{
    CALL: 'W1AW', QSO_DATE: '20261025', TIME_ON: '140307', BAND: '20m', MODE: 'SSB', FREQ: '14.2855',
    RST_SENT: '59', RST_RCVD: '57', NAME: 'Hiram', STATE: 'CT', COUNTRY: 'USA', GRIDSQUARE: 'FN31', COMMENT: 'nice',
  }]);
});

test('plain tag names, no record wrapper: a new CALL starts the next record', () => {
  const reply = '<CMD><LIST><CALL>K3SBP</CALL><DATE>2026-10-24</DATE><TIMEON>2310</TIMEON><BAND>40</BAND><MODE>CW</MODE>' +
    '<CALL>N0CALL</CALL><DATE>20261024</DATE><TIMEON>231500</TIMEON><FREQUENCY>7.074</FREQUENCY><MODE>FT8</MODE></LIST></CMD>';
  const { records } = P.parseListReply(reply);
  assert.strictEqual(records.length, 2);
  assert.deepStrictEqual(records[0], { CALL: 'K3SBP', QSO_DATE: '20261024', TIME_ON: '231000', BAND: '40m', MODE: 'CW' });
  assert.strictEqual(records[1].BAND, '40m'); // from the frequency
  assert.strictEqual(records[1].FREQ, '7.074');
});

test('an ADIF reply works too', () => {
  const reply = '<call:5>W6ING<qso_date:8>20261025<time_on:4>1730<band:3>20m<mode:3>SSB<freq:6>14.250<eor>' +
    '<call:4>W1AW<qso_date:8>20261025<time_on:6>173500<band:3>20M<mode:2>CW<eor>';
  const { records } = P.parseListReply(reply);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].CALL, 'W6ING');
  assert.strictEqual(records[0].TIME_ON, '173000');
  assert.strictEqual(records[1].BAND, '20m');
});

test('unusable records are dropped and counted, never guessed', () => {
  const reply = '<fldCall>A1A</fldCall><fldDateStr>10/25/2026</fldDateStr><fldTimeOnStr>12:00</fldTimeOnStr><fldBand>20</fldBand>' +
    '<fldCall>B2B</fldCall><fldDateStr>2026/10/25</fldDateStr><fldBand>20</fldBand>' +
    '<fldCall>C3C</fldCall><fldDateStr>2026/10/25</fldDateStr><fldTimeOnStr>12:00</fldTimeOnStr>' +
    '<fldCall>D4D</fldCall><fldDateStr>2026/13/25</fldDateStr><fldTimeOnStr>12:00</fldTimeOnStr><fldBand>20</fldBand>';
  const { records, dropped } = P.parseListReply(reply);
  assert.strictEqual(records.length, 0);
  assert.strictEqual(dropped, 4); // US date order, no time, no band or freq, month 13
});

test('PH mode reads as SSB, entities are decoded', () => {
  const { records } = P.parseListReply('<fldCall>W1AW</fldCall><fldDateStr>2026/10/25</fldDateStr><fldTimeOnStr>0101</fldTimeOnStr>' +
    '<fldBand>20</fldBand><fldMode>PH</fldMode><fldComments>R &amp; R</fldComments>');
  assert.strictEqual(records[0].MODE, 'SSB');
  assert.strictEqual(records[0].COMMENT, 'R & R');
});

test('a contact POTACAT forwarded to N3FJP comes back as a duplicate, not a new QSO', () => {
  const ours = { CALL: 'W1AW', QSO_DATE: '20261025', TIME_ON: '140300', FREQ: '14.2855', BAND: '20m', MODE: 'SSB' };
  const { records } = P.parseListReply('<fldCall>W1AW</fldCall><fldDateStr>2026/10/25</fldDateStr><fldTimeOnStr>14:03:00</fldTimeOnStr>' +
    '<fldBand>20</fldBand><fldMode>USB</fldMode><fldFrequency>14.2855</fldFrequency>');
  const { fresh, skipped } = planImport([ours], records);
  assert.strictEqual(fresh.length, 0);
  assert.strictEqual(skipped, 1);
});

test('LIST commands: the whole log, then the latest N, each ending CR LF', () => {
  assert.strictEqual(P.listCommand(), '<CMD><LIST><INCLUDEALL></CMD>\r\n');
  assert.strictEqual(P.listCommand({ recent: 200 }), '<CMD><LIST><INCLUDEALL><VALUE>200</VALUE></CMD>\r\n');
});

test('requestList against a fake N3FJP: sends the command, reads a reply that arrives in pieces', async () => {
  let got = '';
  const server = net.createServer((sock) => {
    sock.on('data', (d) => {
      got += d.toString();
      if (got.includes('</CMD>\r\n') && !sock._answered) {
        sock._answered = true;
        sock.write('<CMD><LISTRESPONSE><fldCall>W1AW</fldCall>');
        setTimeout(() => sock.write('<fldDateStr>2026/10/25</fldDateStr><fldTimeOnStr>1403</fldTimeOnStr><fldBand>20</fldBand></LISTRESPONSE></CMD>'), 80);
        // N3FJP leaves the socket open; requestList must end on quiet.
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const reply = await P.requestList('127.0.0.1', port, P.listCommand({ recent: 5 }), { quietMs: 200, timeoutMs: 3000 });
  server.close();
  assert.ok(got.startsWith('<CMD><LIST><INCLUDEALL><VALUE>5</VALUE></CMD>\r\n'));
  assert.strictEqual(P.parseListReply(reply).records.length, 1);
});

test('requestList: N3FJP closed is an error, not a hang', async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  await assert.rejects(P.requestList('127.0.0.1', port, P.listCommand(), { timeoutMs: 2000 }), /N3FJP/);
});

test('the record N3FJP gets says USA, so its DXCC fills in (AE5JE)', () => {
  assert.strictEqual(P.n3fjpCountry('<CALL:5>W1ABC<COUNTRY:13>United States<MODE:3>FT8<EOR>'), '<CALL:5>W1ABC<COUNTRY:3>USA<MODE:3>FT8<EOR>');
  assert.strictEqual(P.n3fjpCountry('<COUNTRY:6>Canada<EOR>'), '<COUNTRY:6>Canada<EOR>');
  assert.strictEqual(P.n3fjpCountry('<COUNTRY:24>United States of America<EOR>'), '<COUNTRY:3>USA<EOR>');
  assert.strictEqual(P.n3fjpCountry(''), '');
});

test('main.js wiring: queue shared with the forward, pull gated on the setting', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes("return n3fjpQueue(() => sendN3fjpTcp(qsoData, host, port || 1100));"));
  assert.ok(/n3fjpQueue\(\(\) => N3fjpPull\.requestList\(/.test(main));
  assert.ok(/settings\.n3fjpPull && settings\.sendToLogbook && settings\.logbookType === 'n3fjp'/.test(main));
  assert.ok(/importQsoRecords\(records\)/.test(main));
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('id="set-n3fjp-pull"'));
});

(async () => {
  console.log('n3fjp-pull');
  for (const run of pending) await run();
  console.log(`\nn3fjp-pull: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
