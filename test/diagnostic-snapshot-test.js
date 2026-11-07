// Desktop diagnostic-snapshot responder (Unified Bug Report).
// Canonical contract: status/brief-bug-report-{desktop,mobile}.md — the mobile
// app already ships a BugReportAssembler that consumes EXACTLY this sections
// shape, so these tests lock the desktop to the brief's wire schema.
//
// Layers:
//   - lib/diagnostic-snapshot.js  — pure section assembly + redaction
//   - lib/echocat-protocol.js     — request-diagnostic / diagnostic-snapshot (Dir.BOTH)
//   - lib/remote-server.js        — inbound handler: owner emits, guest refused
//
// Run: node test/diagnostic-snapshot-test.js

'use strict';

const {
  assembleSections, buildDiagnosticSnapshot,
  maskEmail, redactIpTo24, redactLogLines, REDACTED,
} = require('../lib/diagnostic-snapshot');
const protocol = require('../lib/echocat-protocol');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function eq(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const rawFull = {
  account: { signedIn: true, callsign: 'K3SBP', email: 'casey@cmox.co', subscriptionStatus: 'active', subscriptionSource: 'app_store', subscriptionExpiresAt: '2026-07-15' },
  connection: { role: 'host', pathTried: ['lan', 'cloud'], pathActive: 'cloud', remoteAddress: '192.168.1.50', latencyMs: 47, reconnectsLastHour: 1, passSession: false },
  pairedDevices: [{ id: '878b', name: 'iPhone 16 Pro', platform: 'ios', lastSeen: '2026-06-16T13:00:00Z' }],
  rig: { configured: true, profile: 'Flex 8600M', catTransport: 'TCP 192.168.1.50:4992', catStatus: 'connected', catLastPollAgeMs: 180, vfo: '14074.0 kHz DIGU', audioBridge: 'Flex Direct' },
  tailscale: { installed: true, connected: true, hostname: 'shack.taile1234.ts.net', peerCount: 3 },
  cloudTunnel: { enabled: true, status: 'live', cloudHost: 'k3sbp.potacat.com', lastHealthCheckAt: '2026-06-16T13:00:00Z' },
  logLines: ['[Echo CAT] hello', 'token eyJabc.def.ghi here', 'Authorization: Bearer sk_live_DEADBEEFtoken', 'blob ' + 'A'.repeat(40)],
};

// ───────────────────────────────────────────────────────────────────────────
console.log('=== assembleSections: brief shape (redact=false) ===');

{
  const s = assembleSections(rawFull, { redact: false });
  eq(Object.keys(s).sort(), ['account', 'cloudTunnel', 'connection', 'logLines', 'pairedDevices', 'rig', 'tailscale'], 'seven desktop sections');
  check(!('network' in s), 'no network section on desktop (mobile-only)');
  eq(s.account.callsign, 'K3SBP', 'account.callsign');
  eq(s.account.emailRedacted, 'casey@cmox.co', 'email raw when redact=false');
  eq(s.connection.pathActive, 'cloud', 'connection.pathActive');
  eq(s.pairedDevices[0].lastSeenAt, '2026-06-16T13:00:00Z', 'pairedDevices maps lastSeen -> lastSeenAt');
  eq(s.rig.profile, 'Flex 8600M', 'rig.profile');
  eq(s.rig.catStatus, 'connected', 'rig.catStatus');
  eq(s.tailscale.hostname, 'shack.taile1234.ts.net', 'tailscale.hostname');
  eq(s.cloudTunnel.cloudHost, 'k3sbp.potacat.com', 'cloudTunnel.cloudHost');
  check(Array.isArray(s.logLines) && s.logLines.length === 4, 'logLines is an array (string[])');
}

{
  // Empty raw → every section present with safe defaults (partial gather ships).
  const s = assembleSections({}, {});
  eq(s.account.signedIn, false, 'account defaults signedIn=false');
  eq(s.rig.catStatus, 'not_configured', 'rig defaults not_configured');
  eq(s.cloudTunnel.status, 'off', 'cloudTunnel defaults off');
  eq(s.logLines, [], 'logLines defaults to []');
}

{
  // One malformed section is isolated.
  const evil = {};
  Object.defineProperty(evil, 'configured', { enumerable: true, get() { throw new Error('boom'); } });
  const s = assembleSections({ rig: evil }, {});
  check(s.rig && typeof s.rig.error === 'string', 'throwing rig section -> per-section error');
  eq(s.account.signedIn, false, 'other sections still built after one fails');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== redaction (redact=true) ===');

{
  const s = assembleSections(rawFull, { redact: true });
  check(s.account.emailRedacted !== 'casey@cmox.co' && s.account.emailRedacted.includes('@'), 'email masked');
  eq(s.connection.remoteAddress, '192.168.1.0/24', 'remoteAddress redacted to /24');
  check(s.rig.catTransport.includes('192.168.1.0/24'), 'rig.catTransport IP redacted to /24');
  check(!s.rig.catTransport.includes('192.168.1.50'), 'raw rig IP gone');
  const joined = s.logLines.join('\n');
  check(!joined.includes('eyJabc.def.ghi'), 'JWT stripped from logLines');
  check(!/Bearer sk_live/.test(joined), 'Bearer token stripped from logLines');
  check(!joined.includes('A'.repeat(40)), '32+ char blob stripped from logLines');
  // Identity-bearing structural fields the report still needs:
  eq(s.account.callsign, 'K3SBP', 'callsign NOT redacted (report needs it)');
}

console.log('\n=== redaction helpers ===');
eq(redactIpTo24('192.168.1.50:4992'), '192.168.1.0/24:4992', 'redactIpTo24 host:port');
eq(redactIpTo24('127.0.0.1'), '127.0.0.1', 'loopback preserved');
check(maskEmail('casey@cmox.co').endsWith('.co'), 'maskEmail preserves TLD');
check(!maskEmail('casey@cmox.co').includes('casey'), 'maskEmail hides local part');
eq(redactLogLines(['x eyJaa.bb.cc y']), ['x <redacted-jwt> y'], 'redactLogLines JWT');
// Log lines carry the same addresses the summary fields mask, and these
// reports get emailed and pasted into Discord. Masking only the header was a
// half-measure (KQ4DX 2026-08-10: `remoteAddress` shown as 192.168.1.0/24 with
// `socket connect from 192.168.1.188` intact twenty lines below it).
eq(redactLogLines(['[Echo CAT] socket connect from 192.168.1.188']),
  ['[Echo CAT] socket connect from 192.168.1.0/24'], 'redactLogLines masks LAN IPs');
eq(redactLogLines(['[ws] dialing wss://192.168.1.150:7300 path=lan']),
  ['[ws] dialing wss://192.168.1.0/24:7300 path=lan'], 'redactLogLines masks IPs in URLs');
eq(redactLogLines(['listening on 127.0.0.1:7300']),
  ['listening on 127.0.0.1:7300'], 'redactLogLines leaves loopback alone');
eq(redactLogLines(['auth Bearer abc.def 10.0.0.5']), ['auth Bearer <redacted> 10.0.0.0/24'],
  'redactLogLines applies token rules AND IP masking together');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== buildDiagnosticSnapshot: envelope ===');

{
  const msg = buildDiagnosticSnapshot(
    { requestId: 'r1', source: 'desktop', appVersion: '1.8.13', platform: { os: 'win32', osVersion: '10.0', deviceModel: null }, timestamp: '2026-06-16T13:00:00.000Z' },
    rawFull, { redact: true });
  eq(msg.type, 'diagnostic-snapshot', 'message type');
  eq(msg.requestId, 'r1', 'requestId echoed');
  eq(msg.source, 'desktop', 'source desktop');
  eq(msg.platform, { os: 'win32', osVersion: '10.0', deviceModel: null }, 'platform is an object');
  eq(msg.timestamp, '2026-06-16T13:00:00.000Z', 'timestamp is ISO string');
  check(msg.sections && msg.sections.rig, 'sections embedded');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== protocol: wire schema (Dir.BOTH) ===');

check(protocol.isKnownType('request-diagnostic') && protocol.isKnownType('diagnostic-snapshot'), 'both types registered');
eq(protocol.describe('request-diagnostic').dir, protocol.Dir.BOTH, 'request-diagnostic is Dir.BOTH');
eq(protocol.describe('diagnostic-snapshot').dir, protocol.Dir.BOTH, 'diagnostic-snapshot is Dir.BOTH');
// Bidirectional → valid in BOTH directions (either side can request/respond).
check(protocol.validate({ type: 'request-diagnostic', requestId: 'x', redact: true }, protocol.Dir.C2S).ok, 'request-diagnostic valid c2s');
check(protocol.validate({ type: 'request-diagnostic', requestId: 'x' }, protocol.Dir.S2C).ok, 'request-diagnostic valid s2c (bidirectional)');
check(!protocol.validate({ type: 'request-diagnostic' }, protocol.Dir.C2S).ok, 'request-diagnostic without requestId rejected');
{
  const msg = { type: 'diagnostic-snapshot', requestId: 'x', source: 'desktop', appVersion: '1.8.13', platform: { os: 'win32', osVersion: '10', deviceModel: null }, timestamp: '2026-06-16T13:00:00Z', sections: { rig: { configured: false } } };
  const parsed = protocol.parse(protocol.encode(msg), protocol.Dir.S2C);
  check(parsed.ok, 'full snapshot encodes + parses (object platform, string timestamp)');
}
check(protocol.validate({ type: 'diagnostic-snapshot', requestId: 'x', source: 'desktop', error: 'not-authorized' }).ok, 'error-only snapshot validates');
{
  // platform must be an object now, not a string.
  const v = protocol.validate({ type: 'diagnostic-snapshot', requestId: 'x', platform: 'win32' });
  check(!v.ok && v.field === 'platform', 'string platform rejected (must be object)');
}
{
  const hello = protocol.buildServerHello({ capabilities: ['diagnostic-snapshot'] });
  check(hello.capabilities.includes('diagnostic-snapshot'), 'server hello carries diagnostic-snapshot capability');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== server handler: owner emits, guest refused ===');

function fakeWs() {
  const sent = [];
  return { _authenticated: true, readyState: 1, send: (w) => { try { sent.push(JSON.parse(w)); } catch {} }, _sent: sent };
}

{
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  const events = [];
  rs.on('request-diagnostic', (e) => events.push(e));
  rs._handleMessage(ws, { type: 'request-diagnostic', requestId: 'abc', redact: true }, {});
  eq(events.length, 1, 'owner request emits request-diagnostic');
  eq(events[0], { requestId: 'abc', redact: true }, 'event carries requestId + redact');
  eq(ws._sent.length, 0, 'owner path sends no immediate reply (main.js replies)');
}

{
  // Guest Pass session must NOT be able to pull host diagnostics (security
  // deviation from the brief, intentional — see handoff note). Refused with an
  // error snapshot so the requester never strands on its 5s timeout.
  const rs = new RemoteServer();
  const ws = fakeWs();
  ws._passSession = { code: 'GUEST1' };
  rs._client = ws;
  let emitted = 0;
  rs.on('request-diagnostic', () => { emitted++; });
  rs._handleMessage(ws, { type: 'request-diagnostic', requestId: 'g1' }, {});
  eq(emitted, 0, 'guest request does NOT emit');
  eq(ws._sent.length, 1, 'guest gets an immediate reply');
  eq(ws._sent[0].type, 'diagnostic-snapshot', 'guest reply is a diagnostic-snapshot');
  eq(ws._sent[0].error, 'not-authorized', 'guest reply carries not-authorized error');
  eq(ws._sent[0].requestId, 'g1', 'guest reply echoes requestId');
}

// ───────────────────────────────────────────────────────────────────────────
// The desktop half of the report used to hard-code reconnectsLastHour:0, so it
// contradicted its own log (KQ4DX 2026-08-10: "Reconnects last hour: 0" printed
// above three logged 1006 closes). A number that disagrees with the evidence
// beside it makes the reader distrust the whole page.
console.log('\n=== reconnect counter + push-log exclusions ===');

{
  const rs = new RemoteServer();
  eq(rs.reconnectsLastHour(), 0, 'fresh server reports no reconnects');
  rs._noteClientDisconnect();
  rs._noteClientDisconnect();
  eq(rs.reconnectsLastHour(), 2, 'authed drops are counted');
  // Older than the window — pruned on the next record, ignored by the reader.
  rs._recentClientDisconnects.unshift(Date.now() - 3700000);
  eq(rs.reconnectsLastHour(), 2, 'drops older than an hour do not count');
  rs._noteClientDisconnect();
  eq(rs._recentClientDisconnects.length, 3, 'recording prunes the expired entry');
}

{
  // High-rate streams must stay out of the connect-window push log: the bridge
  // TX meter alone pushes ~33/sec, and three iOS reconnects evicted every line
  // of real CAT history from the 600-line ring before the operator could report
  // anything. They can never be the 1009 offender that log window exists to find.
  const ex = RemoteServer.PUSH_LOG_EXCLUDED;
  check(ex.has('tx-meter'), 'tx-meter excluded from the push log');
  check(ex.has('smeter'), 'smeter excluded from the push log');
  check(ex.has('signal'), 'WebRTC signal excluded from the push log');
  check(!ex.has('auth-ok'), 'auth-ok still logged (a real 1009 suspect)');
  check(!ex.has('settings-update'), 'settings-update still logged (a real 1009 suspect)');
  check(!ex.has('all-qsos'), 'all-qsos still logged (a real 1009 suspect)');
}

{
  // The size warnings are deliberately OUTSIDE the exclusion — nothing large
  // may hide behind a stream type.
  const rs = new RemoteServer();
  const logs = [];
  rs.on('log', (m) => logs.push(m));
  const ws = fakeWs();
  ws._connectedAtMs = Date.now();
  rs._sendTo(ws, { type: 'tx-meter', value: 0.5 });
  eq(logs.filter((l) => l.startsWith('push msg=')).length, 0, 'tx-meter push is not logged');
  rs._sendTo(ws, { type: 'status', freq: 14074000 });
  eq(logs.filter((l) => l.startsWith('push msg=status')).length, 1, 'status push still logged');
  rs._sendTo(ws, { type: 'tx-meter', blob: 'x'.repeat(300 * 1024) });
  check(logs.some((l) => l.includes('LARGE WS payload') && l.includes('tx-meter')),
    'an oversized excluded type still raises the size warning');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== tailscale section: daemon state and the probe (GitHub #132) ===');

{
  // "Installed but not signed in" on a Mac that WAS signed in could not be
  // told apart from the real thing in a bug report: the section carried only
  // installed/connected/hostname. Now it names the daemon state and which
  // binary answered, with every candidate's answer — additive fields.
  const raw = {
    tailscale: {
      installed: true, connected: false, hostname: null, peerCount: null,
      backendState: 'NeedsLogin', state: 'needs-login',
      probe: {
        binary: '/opt/homebrew/bin/tailscale', error: '',
        candidates: [
          { path: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', backendState: null, error: 'Tailscale CLI is not available in the App Store build' },
          { path: '/opt/homebrew/bin/tailscale', backendState: 'NeedsLogin', error: '' },
          { path: '/Users/casey/bin/tailscale', backendState: null, error: 'not found' },
        ],
      },
    },
  };
  const s = assembleSections(raw, { redact: false });
  eq(s.tailscale.backendState, 'NeedsLogin', 'tailscale.backendState');
  eq(s.tailscale.state, 'needs-login', 'tailscale.state');
  eq(s.tailscale.binary, '/opt/homebrew/bin/tailscale', 'tailscale.binary = the one that answered');
  eq(s.tailscale.candidates.length, 3, 'every candidate is listed');
  eq(s.tailscale.candidates[0].error, 'Tailscale CLI is not available in the App Store build', 'a candidate error is kept');
  eq(s.tailscale.candidates[1].backendState, 'NeedsLogin', 'a candidate state is kept');
  eq(Object.keys(s.tailscale).sort(), ['backendState', 'binary', 'candidates', 'connected', 'hostname', 'installed', 'peerCount', 'probeError', 'state'], 'old fields still present');

  const r = assembleSections(raw, { redact: true });
  eq(r.tailscale.candidates[2].path, '/Users/<redacted>/bin/tailscale', 'redact masks a home directory in a candidate path');
  eq(r.tailscale.candidates[1].path, '/opt/homebrew/bin/tailscale', 'system paths are untouched');
  eq(assembleSections({ tailscale: { probe: { binary: 'C:\\Users\\casey\\tailscale.exe', candidates: [] } } }, { redact: true }).tailscale.binary,
    'C:\\Users\\<redacted>\\tailscale.exe', 'Windows home directories too');

  const empty = assembleSections({}, {}).tailscale;
  eq([empty.backendState, empty.state, empty.binary, empty.candidates, empty.probeError], [null, null, null, [], ''], 'defaults when main gathered nothing');
  eq(assembleSections({ tailscale: { installed: true, connected: true, hostname: 'x.ts.net' } }, {}).tailscale.candidates, [], 'an old-shape raw still ships');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
