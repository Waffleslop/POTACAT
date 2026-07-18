// PSKReporter poll-outcome decision (2026-06-13). retrieve.pskreporter.info
// 502s constantly; a single transient gateway error used to blank the map
// for 5 minutes and raise an operator-facing error. decidePollOutcome now
// retries transient 5xx quickly + quietly, only failing for real after a
// run of them. This pins that policy.
// Run: node test/pskreporter-test.js

'use strict';

const { PskrClient } = require('../lib/pskreporter');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

const D = (code, retries) => PskrClient.decidePollOutcome(code, retries);

console.log('=== decidePollOutcome ===');

// Success resets everything.
check(D(200, 0).kind === 'ok', '200 → ok');
check(D(200, 3).kind === 'ok', '200 → ok even mid-retry-streak');

// 503 = rate limit: back off hard, but stay connected (service is up).
const rl = D(503, 0);
check(rl.kind === 'rate-limited', '503 → rate-limited');
check(rl.delay === 600000, '503 backs off 10 min');
check(rl.markDisconnected === false, '503 does NOT drop the connection');

// 502/500/504 = transient gateway: quick retry, stay connected.
for (const code of [500, 502, 504]) {
  const o = D(code, 0);
  check(o.kind === 'transient-retry', `${code} (1st) → transient-retry`);
  check(o.markDisconnected === false, `${code} keeps the map connected`);
}

// Escalating backoff: 30s, 60s, 120s, 240s, then capped.
check(D(502, 0).delay === 30000, '502 retry #1 delay = 30s');
check(D(502, 1).delay === 60000, '502 retry #2 delay = 60s');
check(D(502, 2).delay === 120000, '502 retry #3 delay = 120s');
check(D(502, 3).delay === 240000, '502 retry #4 delay = 240s (cap)');
check(D(502, 3).delay <= 300000, 'transient delay always stays under the 5-min poll');

// After MAX_TRANSIENT_RETRIES (4) consecutive transients → real failure.
const exhausted = D(502, 4);
check(exhausted.kind === 'fail', '502 after 4 retries → fail');
check(exhausted.markDisconnected === true, 'exhausted transient run drops the connection');
check(exhausted.delay === 300000, 'failure resumes the normal 5-min poll');

// Genuine client/other errors fail immediately (no transient grace).
const notFound = D(404, 0);
check(notFound.kind === 'fail', '404 → fail (not transient)');
check(notFound.markDisconnected === true, '404 drops the connection');
check(D(400, 0).kind === 'fail', '400 → fail');
check(D(403, 0).kind === 'fail', '403 → fail');

// ── _parseXml — slash-tolerant attribute matching + report count ──────────
// The old regex ([^/>]+) stopped at any '/' inside an attribute value, so a
// portable receiver callsign (EA8/DL1ABC) silently dropped that report.
// K3SBP 2026-07-18. _parseXml also returns the count so the poll log can say
// what came back instead of succeeding silently.
console.log('\n=== _parseXml ===');
{
  const c = new PskrClient();
  let spots = [];
  c.on('spot', (s) => spots.push(s));
  const xml =
    '<receptionReport receiverCallsign="K8ELS" receiverLocator="EM88TK" senderCallsign="K3SBP" senderLocator="FN20JB" frequency="7074235" flowStartSeconds="1784335695" mode="FT8" isSender="1" receiverDXCC="United States" receiverDXCCCode="K" sNR="-13" />' +
    '<receptionReport receiverCallsign="EA8/DL1ABC" receiverLocator="IL18" senderCallsign="K3SBP" frequency="7074231" flowStartSeconds="1784335695" mode="FT8" />' +
    '<receptionReport receiverCallsign="W1XP" receiverLocator="FN42fo" senderCallsign="K3SBP" frequency="7074231" flowStartSeconds="1784335695" mode="FT8" />';
  const count = c._parseXml(xml);
  check(count === 3, '_parseXml returns the parsed-report count (3)');
  check(spots.length === 3, 'all three reports emit spot events');
  check(spots.some((s) => s.spotter === 'EA8/DL1ABC'), 'slash in an attribute value no longer drops the report');
  check(spots[0].snr === -13 && spots[0].band === '40m', 'attributes parse (sNR, band from frequency)');
  check(c._parseXml('<html>gateway error page</html>') === 0, 'non-XML body parses as 0 reports, no throw');
}

// ── pollSoon — TX-aware early poll, rate-limit-safe ──────────────────────
// One-shot pull ~90s after TX starts so the map fills during the session
// (the 5-min cadence straddled K3SBP's entire 4-min run). Must skip when the
// regular poll is already near, and fire at most once per POLL_INTERVAL.
console.log('\n=== pollSoon ===');
{
  const c = new PskrClient();
  let scheduled = [];
  c._schedulePoll = (delay) => scheduled.push(delay); // stub — no timers
  c._active = true;

  c.nextPollAt = Date.now() + 60000; // regular poll lands in 1 min
  c.pollSoon(90000);
  check(scheduled.length === 0, 'skipped when the regular poll is already sooner/near');

  c.nextPollAt = Date.now() + 240000; // regular poll 4 min out
  c.pollSoon(90000);
  check(scheduled.length === 1 && scheduled[0] === 90000, 'fires when the regular poll is far out');

  c.pollSoon(90000);
  check(scheduled.length === 1, 'second call within POLL_INTERVAL is suppressed (rate-limit safety)');

  c._active = false;
  c._lastEarlyPollAt = 0;
  c.pollSoon(90000);
  check(scheduled.length === 1, 'inactive client never schedules');
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
