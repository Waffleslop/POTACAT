// ECHOCAT server — HTTPS + WebSocket for phone-based remote radio control
// Serves mobile web UI, relays spots/tune/PTT commands, and WebRTC signaling
// Uses self-signed TLS certificate so getUserMedia() works on mobile browsers
// (navigator.mediaDevices requires a secure context: https or localhost)
const http = require('http');
const https = require('https');
const tls = require('tls');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
// execSync no longer needed — TLS certs generated with pure Node.js crypto
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { loadClubUsers, verifyMemberPassword, getMemberRigAccess, getScheduledNow } = require('./club-users');
const { IambicKeyer } = require('./keyer');
const protocol = require('./echocat-protocol');

// --- License privilege ranges (duplicated from renderer/app.js) ---
const PRIVILEGE_RANGES = {
  us_extra: [
    [1800, 2000, 'all'], [3500, 3600, 'cw_digi'], [3600, 4000, 'phone'],
    [7000, 7125, 'cw_digi'], [7125, 7300, 'phone'], [10100, 10150, 'all'],
    [14000, 14150, 'cw_digi'], [14150, 14350, 'phone'], [18068, 18168, 'all'],
    [21000, 21200, 'cw_digi'], [21200, 21450, 'phone'], [24890, 24990, 'all'],
    [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'], [50000, 54000, 'all'],
    [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  us_advanced: [
    [1800, 2000, 'all'], [3525, 3600, 'cw_digi'], [3700, 4000, 'phone'],
    [7025, 7125, 'cw_digi'], [7125, 7300, 'phone'], [10100, 10150, 'all'],
    [14025, 14150, 'cw_digi'], [14175, 14350, 'phone'], [18068, 18168, 'all'],
    [21025, 21200, 'cw_digi'], [21225, 21450, 'phone'], [24890, 24990, 'all'],
    [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'], [50000, 54000, 'all'],
    [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  us_general: [
    [1800, 2000, 'all'], [3525, 3600, 'cw_digi'], [3800, 4000, 'phone'],
    [7025, 7125, 'cw_digi'], [7175, 7300, 'phone'], [10100, 10150, 'all'],
    [14025, 14150, 'cw_digi'], [14225, 14350, 'phone'], [18068, 18168, 'all'],
    [21025, 21200, 'cw_digi'], [21275, 21450, 'phone'], [24890, 24990, 'all'],
    [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'], [50000, 54000, 'all'],
    [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  us_technician: [
    [3525, 3600, 'cw_digi'], [7025, 7125, 'cw_digi'], [21025, 21200, 'cw_digi'],
    [28000, 28300, 'cw_digi'], [28300, 28500, 'phone'], [50000, 54000, 'all'],
    [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  ca_basic: [
    [50000, 54000, 'all'], [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  ca_honours: [
    [1800, 2000, 'all'], [3500, 4000, 'all'], [7000, 7300, 'all'],
    [10100, 10150, 'all'], [14000, 14350, 'all'], [18068, 18168, 'all'],
    [21000, 21450, 'all'], [24890, 24990, 'all'], [28000, 29700, 'all'],
    [50000, 54000, 'all'], [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
};
// Pairing token TTL: mobile-app pairing tokens expire 5 minutes after
// the desktop generates them. The QR code only shows for as long as
// this window; the user has to regenerate if they take longer.
const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

const CW_DIGI_MODES = new Set(['CW', 'FT8', 'FT4', 'FT2', 'RTTY', 'DIGI', 'JS8', 'PSK31', 'PSK']);
const PHONE_MODES = new Set(['SSB', 'USB', 'LSB', 'FM', 'AM']);

// --- ASN.1 DER helpers for self-signed cert generation (no openssl needed) ---
function derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function derSeq(bufs) {
  const body = Buffer.concat(bufs);
  return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
}

function derSet(bufs) {
  const body = Buffer.concat(bufs);
  return Buffer.concat([Buffer.from([0x31]), derLen(body.length), body]);
}

function derOid(oidHex) {
  const bytes = Buffer.from(oidHex, 'hex');
  return Buffer.concat([Buffer.from([0x06, bytes.length]), bytes]);
}

function derUtf8(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([Buffer.from([0x0c]), derLen(buf.length), buf]);
}

function derBitString(buf) {
  return Buffer.concat([Buffer.from([0x03]), derLen(buf.length + 1), Buffer.from([0x00]), buf]);
}

function derInt(buf) {
  // Ensure positive by prepending 0x00 if high bit set
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return Buffer.concat([Buffer.from([0x02]), derLen(buf.length), buf]);
}

function derExplicit(tag, content) {
  return Buffer.concat([Buffer.from([0xa0 | tag]), derLen(content.length), content]);
}

function derOctetString(buf) {
  return Buffer.concat([Buffer.from([0x04]), derLen(buf.length), buf]);
}

function derGeneralizedTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  const buf = Buffer.from(s, 'ascii');
  return Buffer.concat([Buffer.from([0x18]), derLen(buf.length), buf]);
}

/**
 * Collect every name + IP the cert should cover so the iOS client's
 * SAN check passes regardless of whether it connected by IP or by
 * Tailscale MagicDNS hostname. Probes Tailscale once per call.
 */
function gatherCertSanTargets() {
  const ipAddresses = new Set(['127.0.0.1']);
  const dnsNames = new Set();
  try {
    const interfaces = os.networkInterfaces();
    for (const addrs of Object.values(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          ipAddresses.add(addr.address);
        }
      }
    }
  } catch {}
  try {
    const hostname = os.hostname();
    if (hostname) {
      dnsNames.add(hostname);
      // .local hostname for mDNS discovery — common on macOS / iOS
      if (!/\.local$/i.test(hostname)) dnsNames.add(`${hostname}.local`);
    }
  } catch {}
  // Tailscale MagicDNS hostname: phone connecting via Tailnet uses
  // this name, and iOS validates it against SAN before letting the
  // app's URLSession delegate near the connection. K3SBP 2026-05-05:
  // "network request failed" was iOS rejecting the hostname/SAN
  // mismatch before any app code ran.
  const ts = tailscaleStatus();
  if (ts && ts.hostname) dnsNames.add(ts.hostname);
  return { ipAddresses: Array.from(ipAddresses), dnsNames: Array.from(dnsNames) };
}

/**
 * Generate a self-signed TLS certificate using pure Node.js crypto.
 * No openssl CLI dependency. Caches cert/key in certDir.
 * Includes all local IPv4 addresses + system hostname + Tailscale
 * MagicDNS hostname in SAN. Regenerates if the cached cert's SAN
 * doesn't already cover all current names/IPs (interfaces or
 * Tailscale identity changed since last run).
 */
/**
 * Locate the Tailscale CLI binary. On macOS the standard install
 * doesn't symlink `tailscale` into PATH unless the user runs
 * "Install Tailscale CLI" from the menu-bar app — most don't, and
 * Electron's inherited PATH doesn't pick up things like Homebrew
 * on Apple Silicon either. Probe known locations and cache the
 * result for the process lifetime. Returns null if not found.
 */
let _cachedTailscaleBinary = undefined; // distinct from null = "tried, not found"
function findTailscaleBinary() {
  if (_cachedTailscaleBinary !== undefined) return _cachedTailscaleBinary;
  const { execFileSync } = require('child_process');
  const candidates = [];
  // PATH lookup first — fast on Linux/Windows where the installer
  // sets it up correctly, and on macOS for users who DID symlink.
  candidates.push('tailscale');
  if (process.platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/bin/tailscale',           // Homebrew Apple Silicon
      '/usr/local/bin/tailscale',              // Homebrew Intel + macOS "Install CLI" target
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale', // App bundle direct
    );
  } else if (process.platform === 'linux') {
    candidates.push('/usr/bin/tailscale', '/usr/local/bin/tailscale');
  } else if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\Tailscale\\tailscale.exe');
  }
  for (const cand of candidates) {
    try {
      execFileSync(cand, ['version'], { timeout: 3000, stdio: 'pipe' });
      _cachedTailscaleBinary = cand;
      return cand;
    } catch {}
  }
  _cachedTailscaleBinary = null;
  return null;
}

/**
 * Probe Tailscale for status. Distinguishes between the failure
 * modes so the UI can suggest the right next step:
 *   - returns null:                Tailscale not installed / CLI missing
 *   - {installed:true,loggedIn:false}:  installed but not signed in
 *   - {installed:true,loggedIn:true,magicDNS:false}:  signed in,
 *     MagicDNS off (admin must enable)
 *   - {installed:true,loggedIn:true,magicDNS:true,hostname:"…"}:
 *     fully ready
 */
function tailscaleStatus() {
  const bin = findTailscaleBinary();
  if (!bin) return null;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(bin, ['status', '--json'], { timeout: 3000, encoding: 'utf-8' });
    const status = JSON.parse(out);
    const backendState = status.BackendState || '';
    // BackendState 'NeedsLogin' / 'NoState' / 'Stopped' all mean
    // "not actively connected to a tailnet" from our perspective.
    const loggedIn = backendState === 'Running';
    if (!loggedIn) {
      return { installed: true, loggedIn: false, backendState };
    }
    // MagicDNS: explicit signal in CurrentTailnet, fall back to
    // "Self.DNSName looks like a real tailnet hostname".
    let magicDNS = false;
    if (status.CurrentTailnet && typeof status.CurrentTailnet.MagicDNSEnabled === 'boolean') {
      magicDNS = status.CurrentTailnet.MagicDNSEnabled;
    } else if (status.Self && status.Self.DNSName) {
      magicDNS = /\.[a-z0-9-]+\.ts\.net\.?$/i.test(status.Self.DNSName);
    }
    const hostname = status.Self && status.Self.DNSName
      ? status.Self.DNSName.replace(/\.$/, '')
      : null;
    return { installed: true, loggedIn: true, magicDNS, hostname, backendState };
  } catch {
    return null;
  }
}

/**
 * Issue (or refresh) a Tailscale-managed Let's Encrypt cert for the
 * given hostname. Writes <certDir>/tailscale-cert.pem and .key.
 * Returns true on success. Throws on failure with a useful message
 * — the IPC layer will surface that to the UI so users know whether
 * to enable HTTPS in their admin console.
 */
function issueTailscaleCert(certDir, hostname) {
  const bin = findTailscaleBinary();
  if (!bin) {
    throw new Error('Tailscale CLI not found. Install Tailscale and (on macOS) run "Install Tailscale CLI" from the menu-bar app.');
  }
  const certPath = path.join(certDir, 'tailscale-cert.pem');
  const keyPath = path.join(certDir, 'tailscale-cert.key');
  const { execFileSync } = require('child_process');
  try {
    execFileSync(
      bin,
      ['cert', `-cert-file=${certPath}`, `-key-file=${keyPath}`, hostname],
      { timeout: 60000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    const stderr = (err.stderr || '').toString();
    // Bubble up a clean message to the caller / UI.
    if (/HTTPS.*not enabled/i.test(stderr) || /not.*enabled.*HTTPS/i.test(stderr)) {
      throw new Error('HTTPS Certificates are not enabled in your Tailscale admin console.');
    }
    throw new Error(`tailscale cert failed: ${stderr.trim() || err.message}`);
  }
  return { certPath, keyPath };
}

/**
 * Find an existing Tailscale-issued cert in certDir. Returns null if
 * absent, expired, or close to expiry (< 14 days).
 */
function loadCachedTailscaleCert(certDir) {
  const certPath = path.join(certDir, 'tailscale-cert.pem');
  const keyPath = path.join(certDir, 'tailscale-cert.key');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
  try {
    const certPem = fs.readFileSync(certPath, 'utf8');
    const keyPem = fs.readFileSync(keyPath, 'utf8');
    const x509 = new crypto.X509Certificate(certPem);
    const validTo = new Date(x509.validTo);
    const daysLeft = (validTo - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft <= 0) return null;
    return { cert: certPem, key: keyPem, validTo, daysLeft, certPath, keyPath };
  } catch {
    return null;
  }
}

function getOrCreateTlsCert(certDir, opts = {}) {
  // Caller-provided cert path takes priority. This is the manual
  // path: user supplied an explicit cert/key in settings.
  if (opts.userCertPath && opts.userKeyPath) {
    try {
      const cert = fs.readFileSync(opts.userCertPath, 'utf8');
      const key = fs.readFileSync(opts.userKeyPath, 'utf8');
      console.log(`[Echo CAT] Using user-provided TLS cert from ${opts.userCertPath}`);
      return { cert, key, userProvided: true };
    } catch (err) {
      console.warn(`[Echo CAT] Failed to read user-provided TLS cert (${err.message}) — falling back.`);
    }
  }

  // Tailscale-issued cert (publicly-trusted Let's Encrypt). iOS
  // accepts this natively without any pinning, sidestepping the ATS
  // self-signed rejection. The cert is cached in certDir; the UI's
  // "Set up secure connection via Tailscale" button populates it.
  let cached = loadCachedTailscaleCert(certDir);
  if (cached) {
    // Auto-renew within the LE renewal window (< 14 days left). Done
    // synchronously here so the freshly-renewed cert is what we hand
    // to the HTTPS server — no race, no second restart needed. Cheap:
    // when Tailscale already has a valid LE cert in its ACME cache,
    // `tailscale cert` just rewrites the files in ~100ms. If the
    // renewal call fails (Tailscale logged out, HTTPS toggle disabled
    // since last issue, network blip), we keep using the cached cert
    // until it actually expires — better to serve a soon-to-expire
    // cert than to drop to self-signed.
    if (cached.daysLeft < 14) {
      const ts = tailscaleStatus();
      if (ts) {
        try {
          console.log(`[Echo CAT] Tailscale cert has ${Math.floor(cached.daysLeft)} days left — auto-renewing.`);
          issueTailscaleCert(certDir, ts.hostname);
          const fresh = loadCachedTailscaleCert(certDir);
          if (fresh) cached = fresh;
        } catch (err) {
          console.warn(`[Echo CAT] Auto-renew failed (${err.message}) — using existing cert.`);
        }
      }
    }
    console.log(`[Echo CAT] Using cached Tailscale cert (expires ${cached.validTo.toISOString().slice(0,10)}, ${Math.floor(cached.daysLeft)} days left)`);
    return { cert: cached.cert, key: cached.key, tailscaleIssued: true };
  }

  const certPath = path.join(certDir, 'remote-cert.pem');
  const keyPath = path.join(certDir, 'remote-key.pem');
  const { ipAddresses, dnsNames } = gatherCertSanTargets();

  // Cached cert is acceptable iff it exists, is < 1 year old, AND
  // its SAN already covers every current IP and DNS name. If a new
  // interface came up (Tailscale brought online after first launch)
  // or the machine's hostname changed, the cert won't cover the new
  // identity and iOS will hostname-mismatch reject. Regenerate.
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const stat = fs.statSync(certPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 365 * 24 * 60 * 60 * 1000) {
        const certPem = fs.readFileSync(certPath, 'utf8');
        const keyPem = fs.readFileSync(keyPath, 'utf8');
        let sanIps = new Set();
        let sanDns = new Set();
        try {
          const x509 = new crypto.X509Certificate(certPem);
          const san = x509.subjectAltName || '';
          // Format: "IP Address:127.0.0.1, DNS:host.local, ..."
          for (const piece of san.split(',')) {
            const t = piece.trim();
            const ipM = t.match(/^IP Address:([\d.]+)$/);
            if (ipM) sanIps.add(ipM[1]);
            const dnsM = t.match(/^DNS:(.+)$/);
            if (dnsM) sanDns.add(dnsM[1]);
          }
        } catch {}
        const missingIps = ipAddresses.filter(ip => !sanIps.has(ip));
        const missingDns = dnsNames.filter(d => !sanDns.has(d));
        if (missingIps.length === 0 && missingDns.length === 0) {
          return { cert: certPem, key: keyPem };
        }
        console.log(`[Echo CAT] Cached TLS cert missing SAN entries (ips=${missingIps.join(',')||'-'} dns=${missingDns.join(',')||'-'}) — regenerating.`);
      }
    } catch {}
  }

  try {
    // Generate RSA 2048 key pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Build X.509 v3 self-signed certificate in DER
    const serialNumber = derInt(crypto.randomBytes(8));

    // SHA-256 with RSA OID
    const sha256WithRsa = derSeq([derOid('2a864886f70d01010b'), Buffer.from([0x05, 0x00])]);

    // Issuer/Subject: CN=ECHOCAT, O=POTACAT
    const cn = derSeq([derOid('550403'), derUtf8('ECHOCAT')]);
    const org = derSeq([derOid('55040a'), derUtf8('POTACAT')]);
    const issuer = derSeq([derSet([cn]), derSet([org])]);

    // Validity: now to +1 year
    const notBefore = new Date();
    const notAfter = new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000);
    const validity = derSeq([derGeneralizedTime(notBefore), derGeneralizedTime(notAfter)]);

    // SAN entries: every IPv4 + every hostname iOS might use to
    // reach this server. Reuses the gathered list from above so the
    // cache-coverage check and the freshly-generated cert can never
    // disagree about what's covered.
    const sanEntries = [
      ...ipAddresses.map(ip => {
        const parts = ip.split('.').map(Number);
        // GeneralName [7] iPAddress, 4 bytes
        return Buffer.concat([Buffer.from([0x87, 4]), Buffer.from(parts)]);
      }),
      ...dnsNames.map(name => {
        const buf = Buffer.from(name, 'ascii');
        // GeneralName [2] dNSName, primitive context-specific
        return Buffer.concat([Buffer.from([0x82, buf.length]), buf]);
      }),
    ];
    const sanValue = derSeq(sanEntries);
    // SAN extension OID: 2.5.29.17
    const sanExt = derSeq([
      derOid('551d11'),
      derOctetString(sanValue),
    ]);

    // Basic Constraints: CA=TRUE — required for iOS Certificate Trust Settings
    const basicConstraints = derSeq([
      derOid('551d13'),
      Buffer.from([0x01, 0x01, 0xff]), // critical=true
      derOctetString(derSeq([Buffer.from([0x01, 0x01, 0xff])])), // cA=TRUE
    ]);

    // Key Usage: digitalSignature (bit 0) — required by iOS/Safari
    // Bit string: 0x05 = 5 unused bits, 0x80 = digitalSignature (bit 0 set)
    const keyUsage = derSeq([
      derOid('551d0f'),
      Buffer.from([0x01, 0x01, 0xff]), // critical=true
      derOctetString(Buffer.concat([Buffer.from([0x03, 0x02, 0x05, 0x80])])),
    ]);

    // Extended Key Usage: serverAuth (1.3.6.1.5.5.7.3.1) — required by iOS
    const ekuServerAuth = derOid('2b06010505070301');
    const extKeyUsage = derSeq([
      derOid('551d25'),
      derOctetString(derSeq([ekuServerAuth])),
    ]);

    const extensions = derExplicit(3, derSeq([basicConstraints, keyUsage, extKeyUsage, sanExt]));

    // TBS (to-be-signed) certificate
    const version = derExplicit(0, derInt(Buffer.from([0x02]))); // v3
    const tbsCert = derSeq([
      version,
      serialNumber,
      sha256WithRsa,
      issuer,
      validity,
      issuer, // subject = issuer (self-signed)
      publicKey, // already DER-encoded SubjectPublicKeyInfo
      extensions,
    ]);

    // Sign TBS with private key
    const signer = crypto.createSign('SHA256');
    signer.update(tbsCert);
    const signature = signer.sign(privateKey);

    // Build final certificate
    const cert = derSeq([
      tbsCert,
      sha256WithRsa,
      derBitString(signature),
    ]);

    // PEM encode
    const certPem = '-----BEGIN CERTIFICATE-----\n' +
      cert.toString('base64').match(/.{1,64}/g).join('\n') +
      '\n-----END CERTIFICATE-----\n';

    // Save to disk
    fs.writeFileSync(certPath, certPem);
    fs.writeFileSync(keyPath, privateKey);

    const sanSummary = [
      ...ipAddresses.map(ip => `IP:${ip}`),
      ...dnsNames.map(d => `DNS:${d}`),
    ].join(', ');
    console.log(`[Echo CAT] Generated self-signed TLS certificate (SAN: ${sanSummary})`);
    return { cert: certPem, key: privateKey };
  } catch (err) {
    console.warn('[Echo CAT] Could not generate TLS cert:', err.message);
    console.warn('[Echo CAT] Falling back to plain HTTP — audio will NOT work on mobile');
    return null;
  }
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// Only serve these files to the phone
const ALLOWED_FILES = new Set([
  'remote.html', 'remote.js', 'remote.css',
]);

class RemoteServer extends EventEmitter {
  constructor() {
    super();
    this._httpServer = null;
    this._wss = null;
    this._client = null;       // single authenticated WebSocket
    this._port = 7300;
    this._token = null;
    // Server version string sent in `hello`. Caller (main.js) populates
    // this from package.json before calling start(); leaving it empty
    // does not break the handshake — the field is optional.
    this._serverVersion = '';
    // Mobile-app pairing state. `_pairingTokens` is the in-memory store
    // of one-time tokens minted via createPairingToken(); each expires
    // PAIRING_TOKEN_TTL_MS after creation. `_pairedDevices` is the
    // long-lived list of devices that have completed pairing — caller
    // (main.js) hydrates from settings.json on start and saves back
    // when the `paired-devices-changed` event fires.
    this._pairingTokens = new Map();
    this._pairedDevices = [];
    this._pttSafetyTimer = null;
    this._pttSafetyTimeout = 180; // seconds
    this._pttActive = false;
    this._lastTuneTime = 0;
    this._lastFilterTime = 0;
    this._lastSpots = [];
    this._radioStatus = { freq: 0, mode: '', catConnected: false, txState: false };
    this._sessionContacts = [];
    this._contactNr = 0;
    this._activatorState = null;
    this._workedParks = null;
    this._workedQsos = null;
    this._remoteSettings = {};
    this._colorblindMode = false;
    // VFO lock — blocks tune requests from ECHOCAT clients; kept in sync with
    // main.js's _vfoLocked via setVfoLocked() + 'vfo-set-lock' emit.
    this._vfoLocked = false;
    this._directoryData = { nets: [], swl: [] };
    this._donorCallsigns = [];
    // JTCAT state
    this._jtcatState = null;
    this._jtcatQsoState = null;
    this._jtcatTxStatus = null;
    this._jtcatDecodeBuffer = [];
    this.running = false;
    // CW Keyer
    this._cwKeyer = null;
    this._cwKeyerOutput = null; // callback: ({ down, timestamp }) => void
    this._cwEnabled = false;
    this._cwWpm = 20;
    this._cwMode = 'iambicB';
    this._cwPaddleWatchdog = null; // safety: force paddle release if keyup lost over WS
    this._cwPaddleAvailable = true; // false when DTR keying is unavailable AND no fallback (Linux cdc_acm + no pyserial)
    this._cwPaddleUnavailableReason = null;
    this._basePath = null;     // resolved path to renderer/ directory
    this._cachedInlinedHtml = null;
    // Club Station Mode
    this._clubMode = false;
    this._clubCsvPath = null;
    this._clubRigs = [];       // settings.rigs for rig access filtering
    this._auditLogger = null;
    this._authenticatedMember = null; // current club member
    this._activeRigId = null;
  }

  /**
   * Configure club station mode.
   * @param {boolean} enabled
   * @param {string} csvPath — path to club_users.csv
   * @param {object} auditLogger — from createAuditLogger()
   * @param {object[]} rigs — settings.rigs array
   */
  setClubMode(enabled, csvPath, auditLogger, rigs, activeRigId) {
    this._clubMode = !!enabled;
    this._clubCsvPath = csvPath || null;
    this._auditLogger = auditLogger || null;
    this._clubRigs = rigs || [];
    this._activeRigId = activeRigId || null;
    this._cachedInlinedHtml = null; // force rebuild with club mode flag
  }

  start(port, token, opts = {}) {
    this._port = port || 7300;
    this._token = token;
    this._requireToken = opts.requireToken === true; // default false — match UI checkbox
    this._pttSafetyTimeout = opts.pttSafetyTimeout || 180;
    this._https = false;

    // Resolve renderer directory (works in dev and packaged builds)
    this._basePath = opts.rendererPath || path.join(__dirname, '..', 'renderer');

    const handler = (req, res) => this._handleHttpRequest(req, res);

    // Try HTTPS first (required for getUserMedia on mobile browsers)
    const certDir = opts.certDir || path.join(__dirname, '..');
    const tlsCert = getOrCreateTlsCert(certDir, {
      userCertPath: opts.userCertPath,
      userKeyPath: opts.userKeyPath,
    });

    if (tlsCert) {
      this._httpServer = https.createServer({ cert: tlsCert.cert, key: tlsCert.key }, handler);
      this._https = true;
      // Stash for the pairing endpoint and the mDNS TXT record so we
      // don't have to re-read it from disk on every fingerprint query.
      this._tlsCertPem = tlsCert.cert;
    } else {
      this._httpServer = http.createServer(handler);
      this._tlsCertPem = null;
    }

    // perMessageDeflate compresses individual frames on the wire. Walt
    // KK4DF v1.5.19: iOS RN client closes with code=1009 ("Message Too
    // Big") and bufferedAmount=0 within ~70 ms of connect even though
    // worked-qsos is skipped — meaning some other message in the initial
    // burst exceeds the phone's limit. auth-ok with the full settings
    // object (sstvTemplates, customCatButtons, remoteCwMacros) is the
    // prime suspect on accounts with rich settings. Enabling deflate
    // typically halves big-JSON wire size and can drop a borderline
    // message back under the iOS WebSocket threshold. The serverNoContext
    // -Takeover + clientNoContextTakeover defaults keep per-connection
    // memory small, which matters on RPi-class hosts.
    this._wss = new WebSocket.Server({
      server: this._httpServer,
      perMessageDeflate: {
        zlibDeflateOptions: { level: 6 },
        threshold: 1024,          // don't bother compressing tiny frames
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
      },
    });
    this._wss.on('connection', (ws, req) => {
      this._handleConnection(ws, req);
    });

    // Track open sockets so we can destroy them on stop()
    this._sockets = new Set();
    this._httpServer.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
    });
    this._httpServer.on('secureConnection', (socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
    });

    this._httpServer.listen(this._port, '0.0.0.0', () => {
      this.running = true;
      const proto = this._https ? 'https' : 'http';
      this.emit('started', { port: this._port, https: this._https });
      const msg = `Server listening on ${proto}://0.0.0.0:${this._port}`;
      console.log(`[Echo CAT] ${msg}`);
      this.emit('log', msg);
    });

    this._httpServer.on('error', (err) => {
      console.error('[Echo CAT] Server error:', err.message);
      this.emit('log', `Server error: ${err.message}`);
      this.emit('error', err);
    });

    // mDNS / Bonjour advertisement so the mobile app can browse for
    // POTACAT desktops on the LAN without the user typing IP:port.
    // TXT record carries the version + cert fingerprint so the app
    // can show "POTACAT 1.5.13 — pin fingerprint AA:BB:..." before the
    // user accepts the pairing.
    this._startMdns(tlsCert);
  }

  // --- Mobile-app pairing ---

  /**
   * Mint a one-time pairing token. The token is what gets embedded in
   * the QR code shown on the desktop. Phone scans → POSTs to /api/pair
   * with the token → desktop verifies + mints a long-lived device token.
   *
   * Tokens auto-expire after PAIRING_TOKEN_TTL_MS. They are NOT
   * persisted to disk — if the desktop restarts, the user must
   * regenerate.
   */
  createPairingToken(opts = {}) {
    this._sweepExpiredPairingTokens();
    const token = crypto.randomBytes(32).toString('hex');
    // Per-token expiry. Default is the short PAIRING_TOKEN_TTL_MS
    // (5 min) for in-person QR scans. Friend-share callers pass a
    // longer ttlMs (typically 1 hour) so the recipient has time to
    // see the message and pair from elsewhere.
    const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : PAIRING_TOKEN_TTL_MS;
    const now = Date.now();
    const entry = {
      token,
      createdAt: now,
      expiresAt: now + ttlMs,
      deviceLabel: String(opts.deviceLabel || ''),
    };
    this._pairingTokens.set(token, entry);
    return token;
  }

  _sweepExpiredPairingTokens() {
    const now = Date.now();
    for (const [tok, entry] of this._pairingTokens) {
      const exp = entry.expiresAt || (entry.createdAt + PAIRING_TOKEN_TTL_MS);
      if (now > exp) {
        this._pairingTokens.delete(tok);
      }
    }
  }

  /**
   * Redeem a pairing token, mint a long-lived device token, and add
   * the device to `_pairedDevices`. Returns the device record (with
   * its `token` so the phone can store it) on success, or null if the
   * pairing token is unknown or expired.
   *
   * Caller is expected to listen for the `paired-devices-changed`
   * event and persist the list to settings.json.
   */
  redeemPairingToken(pairingToken, opts = {}) {
    this._sweepExpiredPairingTokens();
    const entry = this._pairingTokens.get(pairingToken);
    if (!entry) return null;
    // Single-use: delete on redemption.
    this._pairingTokens.delete(pairingToken);
    const device = {
      id: crypto.randomBytes(8).toString('hex'),
      name: String(opts.deviceName || entry.deviceLabel || 'Unknown device'),
      platform: String(opts.devicePlatform || ''),
      token: crypto.randomBytes(32).toString('hex'),
      addedAt: new Date().toISOString(),
      lastSeen: null,
    };
    this._pairedDevices.push(device);
    this.emit('paired-devices-changed', this.listPairedDevices());
    return device;
  }

  /**
   * Hydrate the paired-devices list from caller-supplied storage.
   * Called by main.js at startup with `settings.pairedDevices || []`.
   */
  setPairedDevices(devices) {
    this._pairedDevices = Array.isArray(devices) ? devices.slice() : [];
  }

  /**
   * Return paired devices without their secret tokens — safe to send
   * to the renderer for display.
   */
  listPairedDevices() {
    return this._pairedDevices.map(d => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      addedAt: d.addedAt,
      lastSeen: d.lastSeen,
    }));
  }

  /**
   * Return paired devices including secret tokens. Caller (main.js) uses
   * this to persist to settings.json. Never sent over the wire.
   */
  exportPairedDevices() {
    return this._pairedDevices.slice();
  }

  /**
   * Forget a device by id. Returns true if the device was found.
   */
  revokeDevice(deviceId) {
    const before = this._pairedDevices.length;
    this._pairedDevices = this._pairedDevices.filter(d => d.id !== deviceId);
    const removed = before !== this._pairedDevices.length;
    if (removed) this.emit('paired-devices-changed', this.listPairedDevices());
    return removed;
  }

  /**
   * Look up a long-lived device by its token. Used by the auth path.
   */
  _findDeviceByToken(token) {
    if (!token) return null;
    return this._pairedDevices.find(d => d.token === token) || null;
  }

  // --- mDNS ---

  _startMdns(tlsCert) {
    // Lazy-require so a missing dep doesn't break the rest of the server.
    let Bonjour;
    try { Bonjour = require('bonjour-service').default; }
    catch (err) {
      this.emit('log', `mDNS unavailable (bonjour-service not installed): ${err.message}`);
      return;
    }
    try {
      this._bonjour = new Bonjour();
      let fingerprint = '';
      try {
        if (tlsCert && tlsCert.cert) {
          const x509 = new crypto.X509Certificate(tlsCert.cert);
          fingerprint = x509.fingerprint256 || '';
        }
      } catch {}
      const hostname = (() => { try { return os.hostname(); } catch { return 'POTACAT'; } })();
      const txt = {
        version: this._serverVersion || '',
        name: hostname,
        // mDNS TXT entries cap at ~255 bytes per key; the SHA-256 hex
        // fingerprint with colons is 95 bytes, well under the limit.
        fingerprint,
        proto: 'echocat',
      };
      this._bonjourService = this._bonjour.publish({
        name: `POTACAT on ${hostname}`,
        type: 'potacat',
        protocol: 'tcp',
        port: this._port,
        txt,
      });
      this.emit('log', `mDNS published: _potacat._tcp on port ${this._port} (host=${hostname}, fp=${fingerprint.slice(0, 24)}...)`);
    } catch (err) {
      this.emit('log', `mDNS publish failed: ${err.message}`);
    }
  }

  _stopMdns() {
    try {
      if (this._bonjourService) {
        this._bonjourService.stop(() => {});
        this._bonjourService = null;
      }
      if (this._bonjour) {
        this._bonjour.destroy();
        this._bonjour = null;
      }
    } catch (err) {
      // Failure to tear down mDNS shouldn't block server shutdown.
      this.emit('log', `mDNS shutdown error: ${err.message}`);
    }
  }

  stop() {
    this._stopMdns();
    this._destroyCwKeyer();
    if (this._pttActive) {
      this._pttActive = false;
      this.emit('ptt', { state: false });
    }
    if (this._pttSafetyTimer) {
      clearTimeout(this._pttSafetyTimer);
      this._pttSafetyTimer = null;
    }
    if (this._client) {
      if (this._client._heartbeat) { clearInterval(this._client._heartbeat); this._client._heartbeat = null; }
      try { this._client.close(); } catch {}
      this._client = null;
    }
    if (this._wss) {
      this._wss.close();
      this._wss = null;
    }
    if (this._httpServer) {
      this._httpServer.close();
      // Destroy all open TCP sockets so the process can exit.
      // httpServer.close() only stops accepting new connections —
      // existing keep-alive / WebSocket sockets hold the event loop open.
      if (this._sockets) {
        for (const socket of this._sockets) {
          socket.destroy();
        }
        this._sockets.clear();
      }
      this._httpServer = null;
    }
    this.running = false;
    console.log('[Echo CAT] Server stopped');
    this.emit('log', 'Server stopped');
  }

  // --- HTTP ---

  _handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = url.pathname;

    // --- HTTP PTT API ---
    // Simple REST endpoint for external PTT triggers (iOS Shortcuts, Stream Deck, etc.)
    // Usage: GET /api/ptt/on, GET /api/ptt/off, GET /api/ptt/toggle
    // Optional token: ?token=xxx (required if requireToken is enabled)
    if (pathname.startsWith('/api/ptt/')) {
      const action = pathname.split('/')[3]; // on, off, toggle
      // Token auth: check if required
      if (this._requireToken && this._token) {
        const qToken = url.searchParams.get('token');
        if (qToken !== this._token) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'Invalid or missing token. Use ?token=YOUR_TOKEN' }));
          return;
        }
      }
      if (action === 'on') {
        this._handlePtt(true);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ptt: true }));
      } else if (action === 'off') {
        this._handlePtt(false);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ptt: false }));
      } else if (action === 'toggle') {
        const newState = !this._pttActive;
        this._handlePtt(newState);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ptt: newState }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Use /api/ptt/on, /api/ptt/off, or /api/ptt/toggle' }));
      }
      console.log(`[ECHOCAT API] PTT ${action} -> ${this._pttActive ? 'TX' : 'RX'}`);
      return;
    }

    // --- Mobile-app pairing endpoint ---
    // POST /api/pair  body: {pairingToken, deviceName, devicePlatform}
    // Returns 200 {deviceToken, deviceId, fingerprint, protocolVersion} or 401.
    if (pathname === '/api/pair' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        // 4 KiB cap — pairing payloads are tiny.
        if (body.length > 4096) { req.destroy(); }
      });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        const pairingToken = String(payload.pairingToken || '');
        const device = this.redeemPairingToken(pairingToken, {
          deviceName: payload.deviceName,
          devicePlatform: payload.devicePlatform,
        });
        if (!device) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pairing token invalid or expired' }));
          return;
        }
        // Compute fingerprint for the response (the app will pin it).
        let fingerprint = '';
        try {
          if (this._tlsCertPem) {
            const x509 = new crypto.X509Certificate(this._tlsCertPem);
            fingerprint = x509.fingerprint256 || '';
          }
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          deviceToken: device.token,
          deviceId: device.id,
          fingerprint,
          protocolVersion: protocol.PROTOCOL_VERSION,
          serverVersion: this._serverVersion || '',
        }));
        this.emit('log', `Paired new device: ${device.name} (${device.id})`);
      });
      return;
    }

    // Cheap health endpoint — lets the user verify the server is reachable
    // even when the main page errors out. Returns plain text "ok" plus the
    // server version so a phone hitting this can prove the network/cert
    // path works regardless of whether the SPA renders.
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('ok');
      return;
    }

    // Route / to remote.html — serve a single inlined HTML page
    // so self-signed TLS certs don't block CSS/JS subresource loads
    if (pathname === '/' || pathname === '/remote.html') {
      try {
        // Rebuild on every request during development — ensures latest code
        this._cachedInlinedHtml = this._buildInlinedHtml();
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'ETag': Date.now().toString(),
        });
        res.end(this._cachedInlinedHtml);
      } catch (err) {
        // Surface the actual reason in both the verbose log and the body.
        // Until v1.5.7 this caught block silently swallowed everything,
        // which is why "Page does not load. Nothing in Verbose log."
        // came in with no clue about the underlying cause (KK4DF, KM4CFT).
        const msg = `Failed to serve / : ${err && err.message ? err.message : err}`;
        console.error('[Echo CAT]', msg);
        this.emit('log', msg);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('ECHOCAT 500 — ' + (err && err.message ? err.message : 'unknown error') +
                '\nCheck the desktop Verbose log for details.');
      }
      return;
    }

    // Serve individual files as fallback (e.g. if referenced directly)
    const filename = pathname.slice(1);
    if (!ALLOWED_FILES.has(filename)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const filePath = path.join(this._basePath, filename);
    const ext = path.extname(filename);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      res.end(data);
    } catch (err) {
      this.emit('log', `Failed to serve ${filename}: ${err.message}`);
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  /**
   * Build a single self-contained HTML page with CSS and JS inlined.
   * This avoids subresource loading issues with self-signed TLS certs
   * (browsers accept the cert warning for the page but may silently
   * block CSS/JS fetches over the same untrusted connection).
   * Also reduces round trips over slow Tailscale/VPN links.
   */
  _buildInlinedHtml() {
    const htmlPath = path.join(this._basePath, 'remote.html');
    const cssPath = path.join(this._basePath, 'remote.css');
    const jsPath = path.join(this._basePath, 'remote.js');

    let html = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');

    // Replace the stylesheet link with inlined CSS
    // Use arrow function replacements to avoid $-substitution in content
    // (e.g. '$' in Morse code table would be interpreted as $' = "text after match")
    html = html.replace(
      /<link rel="stylesheet" href="remote\.css">/,
      () => `<style>\n${css}\n</style>`
    );

    // Inject auth mode so connect screen can be pre-hidden
    const authMode = this._clubMode ? 'club' : (this._requireToken ? 'token' : 'none');

    // Note: connect screen visibility handled by JS via __authMode and auth-ok

    // Replace the script tag with inlined JS + auth mode
    html = html.replace(
      /<script src="remote\.js"><\/script>/,
      () => `<script>window.__authMode="${authMode}";\n${js}\n</script>`
    );

    // Inline Leaflet CSS + JS for activation map
    const leafletCssPath = path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist', 'leaflet.css');
    const leafletJsPath = path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist', 'leaflet.js');
    try {
      if (fs.existsSync(leafletCssPath)) {
        const leafletCss = fs.readFileSync(leafletCssPath, 'utf8');
        html = html.replace('<!-- leaflet-css -->', () => `<style>\n${leafletCss}\n</style>`);
      }
      if (fs.existsSync(leafletJsPath)) {
        const leafletJs = fs.readFileSync(leafletJsPath, 'utf8');
        html = html.replace('<!-- leaflet-js -->', () => `<script>\n${leafletJs}\n</script>`);
      }
    } catch (err) {
      console.error('[Echo CAT] Failed to inline Leaflet:', err.message);
      this.emit('log', `Failed to inline Leaflet: ${err.message}`);
    }

    return html;
  }

  // --- WebSocket ---

  _handleConnection(ws, req) {
    const addr = req.socket.remoteAddress;
    console.log(`[Echo CAT] New connection from ${addr}`);
    this.emit('log', `New connection from ${addr}`);

    // Kick existing client
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'kicked', reason: 'Another client connected' });
      if (this._client._heartbeat) { clearInterval(this._client._heartbeat); this._client._heartbeat = null; }
      try { this._client.close(); } catch {}
      this._onClientDisconnected();
    }

    ws._authenticated = false;
    // Anchor for the per-message inline size logger in _sendTo() — set
    // here at handler entry so even the server-hello send is included
    // in the diagnostic window.
    ws._connectedAtMs = Date.now();
    // Protocol version of the connected peer. v0 = legacy browser ECHOCAT
    // (does not send a `hello`). Bumped to whatever the peer advertises
    // as soon as we receive their `hello` frame. See lib/echocat-protocol.js.
    ws._protocolVersion = 0;
    ws._clientPlatform = '';
    ws._clientVersion = '';

    // Send our `hello` first. Legacy browser clients ignore unknown
    // message types so this is safe to send unconditionally.
    this._sendTo(ws, protocol.buildServerHello({
      serverVersion: this._serverVersion || '',
      capabilities: [], // reserved for future runtime feature negotiation
    }));

    // Tell the phone which auth mode to show
    const authMode = this._clubMode ? 'club' : (this._requireToken ? 'token' : 'none');
    this._sendTo(ws, { type: 'auth-mode', mode: authMode });

    // If token is not required (and not club mode), auto-authenticate immediately
    if (!this._requireToken && !this._clubMode) {
      ws._authenticated = true;
      this._client = ws;
      this._sendTo(ws, { type: 'auth-ok', colorblindMode: !!this._colorblindMode, settings: this._remoteSettings, cwAvailable: this._cwEnabled, cwPaddleAvailable: this._cwPaddleAvailable, vfoLocked: !!this._vfoLocked });
      if (this._lastSpots.length > 0) {
        this._sendTo(ws, { type: 'spots', data: this._lastSpots });
      }
      this._sendTo(ws, { type: 'status', ...this._radioStatus });
      if (this._activatorState) {
        this._sendTo(ws, { type: 'activator-state', ...this._activatorState });
      }
      if (this._sessionContacts.length > 0) {
        this._sendTo(ws, { type: 'session-contacts', contacts: this._sessionContacts });
      }
      if (this._workedParks) {
        this._sendTo(ws, { type: 'worked-parks', refs: this._workedParks });
      }
      if (this._workedQsos) {
        this._sendWorkedQsosCapped(ws);
      }
      if (this._directoryData.nets.length || this._directoryData.swl.length) {
        this._sendTo(ws, { type: 'directory', nets: this._directoryData.nets, swl: this._directoryData.swl });
      }
      if (this._donorCallsigns.length > 0) {
        this._sendTo(ws, { type: 'donor-callsigns', callsigns: this._donorCallsigns });
      }
      this._logInitialPayloadSizes();
      this.emit('client-connected', { address: addr });
      console.log('[Echo CAT] Client auto-authenticated (no token required)');
    }

    // Auth timeout: must authenticate within 10 seconds
    const authTimer = !this._requireToken ? null : setTimeout(() => {
      if (!ws._authenticated) {
        this._sendTo(ws, { type: 'auth-fail', reason: 'Timeout' });
        ws.close();
      }
    }, 10000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      // Debug kiwi messages
      if (msg.type && msg.type.startsWith('kiwi')) {
      }
      this._handleMessage(ws, msg);
    });

    // Server-side heartbeat: detect zombie connections when phone tab is
    // closed without sending a proper WebSocket close frame.
    //
    // Tolerate up to 3 consecutive missed pings (~45s) instead of the
    // previous 1-miss / ~30s. iOS routinely suspends apps for 30+
    // seconds in the background, and the phone's foreground-reconnect
    // (mobile Build #4) brings the WebSocket back fast on unlock —
    // but we'd been killing the connection before the unlock landed,
    // forcing a heavyweight reconnect-and-rehydrate every time.
    ws._isAlive = true;
    ws._missedPings = 0;
    ws.on('pong', () => { ws._isAlive = true; ws._missedPings = 0; });
    ws._heartbeat = setInterval(() => {
      if (!ws._isAlive) {
        ws._missedPings++;
        if (ws._missedPings >= 3) {
          console.log(`[Echo CAT] Client heartbeat timeout — ${ws._missedPings} missed pings, closing`);
          clearInterval(ws._heartbeat);
          ws._heartbeat = null;
          ws.terminate();
          return;
        }
      }
      ws._isAlive = false;
      try { ws.ping(); } catch {}
    }, 15000);

    ws.on('close', (code, reasonBuf) => {
      if (authTimer) clearTimeout(authTimer);
      if (ws._heartbeat) { clearInterval(ws._heartbeat); ws._heartbeat = null; }
      // Diagnostic logging for the iOS reconnect-loop case. Close codes:
      //   1000 normal, 1001 going-away (app backgrounded), 1006 abnormal
      //   (no close frame — socket died), 1008 policy violation, 1009
      //   message too big, 1011 internal error.
      const reason = reasonBuf ? reasonBuf.toString('utf8').slice(0, 200) : '';
      const buffered = (typeof ws.bufferedAmount === 'number') ? ws.bufferedAmount : -1;
      this.emit('log', `WS close: code=${code} reason="${reason}" bufferedAmount=${buffered} authed=${!!ws._authenticated}`);
      if (ws === this._client) {
        this._onClientDisconnected();
      }
    });

    ws.on('error', (err) => {
      console.error('[Echo CAT] WebSocket error:', err.message);
      this.emit('log', `WS error: ${err.message}`);
    });
  }

  _handleMessage(ws, msg) {
    // v1 hello — record the peer's protocol version + platform. Legacy
    // (v0) browser ECHOCAT skips this entirely and goes straight to auth,
    // which is fine: ws._protocolVersion stays at 0 and the rest of the
    // server treats it like always.
    if (msg && msg.type === 'hello') {
      const v = protocol.validate(msg, protocol.Dir.C2S);
      if (!v.ok) {
        try { ws.close(protocol.CLOSE_CODES.HANDSHAKE_INVALID, 'invalid hello'); } catch {}
        return;
      }
      const compat = protocol.checkCompatibility(msg.protocolVersion);
      if (!compat.compatible) {
        this.emit('log', `Refusing v${msg.protocolVersion} client: ${compat.reason}`);
        try { ws.close(protocol.CLOSE_CODES.PROTOCOL_VERSION_UNSUPPORTED, compat.reason); } catch {}
        return;
      }
      ws._protocolVersion = msg.protocolVersion;
      ws._clientPlatform = String(msg.clientPlatform || '');
      ws._clientVersion = String(msg.clientVersion || '');
      this.emit('log', `Client hello: protocol=${ws._protocolVersion} platform=${ws._clientPlatform} version=${ws._clientVersion}`);
      return;
    }

    // Auth
    if (msg.type === 'auth') {
      // Already authenticated (e.g. token not required) — ignore
      if (ws._authenticated) return;

      let authenticated = false;
      let member = null;

      if (this._clubMode && msg.callsign) {
        // Club mode: callsign + password auth
        // Re-read CSV on every auth attempt for hot-reload
        const { members, errors } = loadClubUsers(this._clubCsvPath);
        if (errors.length > 0) {
          console.warn('[Echo CAT] Club CSV errors:', errors.join('; '));
        }
        const callUpper = msg.callsign.toUpperCase();
        member = members.find(m => m.callsign === callUpper);
        if (member && verifyMemberPassword(member, msg.password || '')) {
          authenticated = true;
          this._authenticatedMember = member;
          const addr = ws._socket?.remoteAddress || 'unknown';
          if (this._auditLogger) this._auditLogger.log(member.callsign, 'login', `Connected from ${addr}`);
          console.log(`[Echo CAT] Club member authenticated: ${member.callsign} (${member.role})`);
        } else {
          const addr = ws._socket?.remoteAddress || 'unknown';
          const failCall = msg.callsign.toUpperCase();
          if (this._auditLogger) this._auditLogger.log(failCall, 'login-fail', `From ${addr}`);
          this._sendTo(ws, { type: 'auth-fail', reason: 'Invalid callsign or password' });
          return;
        }
      } else if (!this._clubMode && msg.token && this._token && msg.token.toUpperCase() === this._token.toUpperCase()) {
        // Token mode (legacy single shared token)
        authenticated = true;
      } else if (!this._clubMode && msg.token) {
        // Per-device token from a paired mobile app. Match against the
        // long-lived token minted during /api/pair. Touches lastSeen for
        // the desktop UI's device list.
        const device = this._findDeviceByToken(msg.token);
        if (device) {
          authenticated = true;
          device.lastSeen = new Date().toISOString();
          ws._pairedDevice = device;
          this.emit('paired-devices-changed', this.listPairedDevices());
        }
      }

      if (authenticated) {
        ws._authenticated = true;
        this._client = ws;
        const authOk = { type: 'auth-ok', colorblindMode: !!this._colorblindMode, settings: this._remoteSettings, cwAvailable: this._cwEnabled, cwPaddleAvailable: this._cwPaddleAvailable, vfoLocked: !!this._vfoLocked };
        if (member) {
          authOk.member = {
            callsign: member.callsign,
            firstname: member.firstname,
            lastname: member.lastname,
            role: member.role,
            licenseClass: member.licenseClass,
          };
          // Schedule advisory: check if someone else is scheduled for the active rig
          if (this._clubCsvPath) {
            try {
              const { members: allMembers } = loadClubUsers(this._clubCsvPath);
              // Find active rig name
              const activeRig = this._clubRigs.find(r => r.id === this._activeRigId);
              if (activeRig) {
                const scheduled = getScheduledNow(allMembers, activeRig.name);
                if (scheduled && scheduled.callsign !== member.callsign) {
                  const startStr = String(scheduled.slot.startH).padStart(2,'0') + ':' + String(scheduled.slot.startM).padStart(2,'0');
                  const endStr = String(scheduled.slot.endH).padStart(2,'0') + ':' + String(scheduled.slot.endM).padStart(2,'0');
                  authOk.scheduleAdvisory = {
                    scheduledCallsign: scheduled.callsign,
                    scheduledName: scheduled.firstname,
                    radio: activeRig.name,
                    time: startStr + '\u2013' + endStr,
                  };
                }
              }
            } catch {}
          }
        }
        this._sendTo(ws, authOk);
        // Send cached state
        if (this._lastSpots.length > 0) {
          this._sendTo(ws, { type: 'spots', data: this._lastSpots });
        }
        this._sendTo(ws, { type: 'status', ...this._radioStatus });
        if (this._activatorState) {
          this._sendTo(ws, { type: 'activator-state', ...this._activatorState });
        }
        if (this._sessionContacts.length > 0) {
          this._sendTo(ws, { type: 'session-contacts', contacts: this._sessionContacts });
        }
        if (this._workedParks) {
          this._sendTo(ws, { type: 'worked-parks', refs: this._workedParks });
        }
        if (this._workedQsos) {
          this._sendWorkedQsosCapped(ws);
        }
        // Send cached JTCAT state. Phone reconnecting after iOS app
        // suspend / lock should immediately see whatever the engine
        // was doing instead of waiting for the next live event.
        if (this._jtcatState) this._sendTo(ws, { type: 'jtcat-status', ...this._jtcatState });
        if (this._jtcatQsoState) this._sendTo(ws, { type: 'jtcat-qso-state', ...this._jtcatQsoState });
        if (this._jtcatTxStatus) this._sendTo(ws, { type: 'jtcat-tx-status', ...this._jtcatTxStatus });
        if (this._jtcatDecodeBuffer.length > 0) {
          this._sendTo(ws, { type: 'jtcat-decode-batch', entries: this._jtcatDecodeBuffer });
        }
        if (this._directoryData.nets.length || this._directoryData.swl.length) {
          this._sendTo(ws, { type: 'directory', nets: this._directoryData.nets, swl: this._directoryData.swl });
        }
        if (this._donorCallsigns.length > 0) {
          this._sendTo(ws, { type: 'donor-callsigns', callsigns: this._donorCallsigns });
        }
        this._logInitialPayloadSizes();
        this.emit('client-connected', { address: ws._socket?.remoteAddress, member });
        console.log('[Echo CAT] Client authenticated');
      } else {
        this._sendTo(ws, { type: 'auth-fail', reason: 'Invalid token' });
      }
      return;
    }

    // All other messages require auth
    if (!ws._authenticated || ws !== this._client) return;

    switch (msg.type) {
      case 'tune': {
        const now = Date.now();
        if (now - this._lastTuneTime < 500) break; // rate limit
        this._lastTuneTime = now;
        // Coerce freqKhz to a number at the protocol boundary. The iOS
        // app sends it as a JSON string, and downstream consumers expect
        // a Number — kiwiSdr.tune() calls freqKhz.toFixed(3) and crashed
        // the main process with "freqKhz.toFixed is not a function"
        // (K3SBP 2026-05-14). Reject malformed values outright rather
        // than passing NaN down the chain.
        const freqKhz = Number(msg.freqKhz);
        if (!isFinite(freqKhz) || freqKhz <= 0) break;
        // VFO lock (applies to everyone, including club members)
        if (this._vfoLocked) {
          this._sendTo(ws, { type: 'tune-blocked', reason: 'VFO Locked — Unlock VFO to change frequency' });
          if (this._clubMode && this._authenticatedMember && this._auditLogger) {
            this._auditLogger.log(this._authenticatedMember.callsign, 'tune-blocked',
              `${freqKhz} kHz ${msg.mode || ''}: vfo-locked`);
          }
          break;
        }
        // Club mode: check license privilege
        if (this._clubMode && this._authenticatedMember) {
          const blocked = this._checkTunePrivilege(freqKhz, msg.mode);
          if (blocked) {
            this._sendTo(ws, { type: 'tune-blocked', reason: blocked });
            if (this._auditLogger) {
              this._auditLogger.log(this._authenticatedMember.callsign, 'tune-blocked',
                `${freqKhz} kHz ${msg.mode || ''}: ${blocked}`);
            }
            break;
          }
          if (this._auditLogger) {
            this._auditLogger.log(this._authenticatedMember.callsign, 'tune',
              `${freqKhz} kHz ${msg.mode || ''}`);
          }
        }
        this.emit('tune', {
          freqKhz,
          mode: msg.mode,
          bearing: msg.bearing,
        });
        break;
      }

      case 'ptt':
        if (this._clubMode && this._authenticatedMember && this._auditLogger) {
          this._auditLogger.log(this._authenticatedMember.callsign,
            msg.state ? 'ptt-on' : 'ptt-off', '');
        }
        this._handlePtt(!!msg.state);
        break;

      case 'estop':
        // Emergency stop — no rate limiting
        this._handlePtt(false);
        break;

      case 'vfo-set-lock':
        // Hand off to main.js; main.js owns the authoritative state and will
        // call setVfoLocked() which echoes back to this client plus any other
        // connected windows (desktop VFO popout, other ECHOCAT clients).
        this.emit('vfo-set-lock', !!msg.locked);
        if (this._clubMode && this._authenticatedMember && this._auditLogger) {
          this._auditLogger.log(this._authenticatedMember.callsign,
            msg.locked ? 'vfo-lock' : 'vfo-unlock', '');
        }
        break;

      case 'signal':
        // WebRTC signaling relay
        this.emit('signal-from-client', msg.data);
        break;

      case 'set-sources':
        this.emit('set-sources', msg.sources);
        break;

      case 'set-echo-filters':
        this.emit('set-echo-filters', msg.filters);
        break;

      case 'log-qso':
        // Browser ECHOCAT wraps the payload in {type, data}; the iOS
        // native app sends it flat at the top level. Accept both
        // shapes — the top-level handler in main.js validates the
        // resulting object regardless. Mallory KD5ZZU 2026-05-06: a
        // QSO logged from the iOS app vanished because msg.data was
        // undefined (iOS shape), the handler bailed with "Missing
        // callsign", and the iOS UI cheerfully showed haptic success
        // because LogQuickSheet doesn't wait for log-result.
        this.emit('log-qso', msg.data || msg);
        break;

      case 'set-activator-park':
        this.emit('set-activator-park', {
          parkRef: msg.parkRef || '',
          activationType: msg.activationType || 'pota',
          activationName: msg.activationName || '',
          sig: msg.sig || '',
        });
        break;

      case 'search-parks':
        if (msg.query) {
          this.emit('search-parks', { query: msg.query });
        }
        break;

      case 'get-past-activations':
        this.emit('get-past-activations');
        break;

      case 'get-activation-map-data':
        this.emit('get-activation-map-data', {
          parkRef: msg.parkRef || '',
          date: msg.date || '',
          contacts: msg.contacts || [],
        });
        break;

      case 'switch-rig':
        if (msg.rigId) {
          // Club mode: verify member has rig access
          if (this._clubMode && this._authenticatedMember) {
            const allowedRigs = getMemberRigAccess(this._authenticatedMember, this._clubRigs);
            if (!allowedRigs.some(r => r.id === msg.rigId)) {
              this._sendTo(ws, { type: 'rig-blocked', reason: 'You do not have access to this radio' });
              if (this._auditLogger) {
                this._auditLogger.log(this._authenticatedMember.callsign, 'switch-rig-blocked', msg.rigId);
              }
              break;
            }
            if (this._auditLogger) {
              this._auditLogger.log(this._authenticatedMember.callsign, 'switch-rig', msg.rigId);
            }
          }
          this.emit('switch-rig', { rigId: msg.rigId });
        }
        break;

      case 'set-filter': {
        const now = Date.now();
        if (now - this._lastFilterTime < 500) break;
        this._lastFilterTime = now;
        this.emit('set-filter', { width: msg.width });
        break;
      }

      case 'filter-step': {
        const now = Date.now();
        if (now - this._lastFilterTime < 500) break;
        this._lastFilterTime = now;
        this.emit('filter-step', { direction: msg.direction });
        break;
      }

      case 'set-nb':
        this.emit('set-nb', { on: !!msg.on });
        break;

      case 'set-atu':
        this.emit('set-atu', { on: !!msg.on });
        break;

      case 'set-vfo':
        this.emit('set-vfo', { vfo: msg.vfo === 'B' ? 'B' : 'A' });
        break;

      case 'swap-vfo':
        this.emit('swap-vfo');
        break;

      case 'set-rfgain':
        this.emit('set-rfgain', { value: msg.value });
        break;

      case 'set-txpower':
        this.emit('set-txpower', { value: msg.value });
        break;

      case 'get-audio-devices':
        this.emit('get-audio-devices');
        break;

      case 'set-audio-device':
        this.emit('set-audio-device', { kind: msg.kind, deviceId: msg.deviceId });
        break;

      case 'qrz-lookup':
        this.emit('qrz-lookup', { callsign: msg.callsign });
        break;

      // TX EQ + compressor — mobile read/write. `tx-eq-get` asks for the
      // current desktop state (replied via broadcastTxEqState below);
      // `tx-eq-set` mirrors the desktop's tx-eq-set IPC and goes through
      // the same main-process handler so settings persistence + bridge
      // + VFO popout broadcast all happen in one path.
      case 'tx-eq-get':
        this.emit('tx-eq-get');
        break;
      case 'tx-eq-set':
        this.emit('tx-eq-set', {
          enabled: !!msg.enabled,
          preset: msg.preset || 'ragchew',
          customParams: (msg.customParams && typeof msg.customParams === 'object') ? msg.customParams : undefined,
        });
        break;

      // Unified rig-control dispatch (same actions as desktop IPC)
      case 'tgxl-select-antenna':
        this.emit('tgxl-select-antenna', { port: msg.port || 1 });
        break;
      case 'rig-control': {
        const action = msg.data && msg.data.action;
        if (!action) break;
        this.emit('rig-control', msg.data);
        break;
      }

      case 'set-refresh-interval':
        this.emit('set-refresh-interval', { value: msg.value });
        break;

      case 'set-mode':
        if (msg.mode) this.emit('set-mode', { mode: msg.mode });
        break;

      case 'toggle-rotor':
        this.emit('toggle-rotor', { enabled: !!msg.enabled });
        break;

      case 'set-scan-dwell':
        this.emit('set-scan-dwell', { value: msg.value });
        break;

      case 'set-max-age':
        this.emit('set-max-age', { value: msg.value });
        break;

      case 'set-dist-unit':
        this.emit('set-dist-unit', { value: msg.value });
        break;

      case 'set-cw-xit':
        this.emit('set-cw-xit', { value: msg.value });
        break;

      case 'set-cw-filter':
        this.emit('set-cw-filter', { value: msg.value });
        break;

      case 'set-ssb-filter':
        this.emit('set-ssb-filter', { value: msg.value });
        break;

      case 'set-digital-filter':
        this.emit('set-digital-filter', { value: msg.value });
        break;

      case 'vfo-profiles-update':
        this.emit('vfo-profiles-update', { profiles: Array.isArray(msg.profiles) ? msg.profiles : [] });
        break;

      case 'apply-vfo-profile':
        this.emit('apply-vfo-profile', { profile: msg.profile || {} });
        break;

      case 'set-enable-split':
        this.emit('set-enable-split', { value: !!msg.value });
        break;

      case 'set-enable-atu':
        this.emit('set-enable-atu', { value: !!msg.value });
        break;

      case 'set-tune-click':
        this.emit('set-tune-click', { value: !!msg.value });
        break;

      case 'lookup-call':
        if (msg.callsign) this.emit('lookup-call', { callsign: msg.callsign });
        break;

      case 'scan-step':
        this.emit('scan-step', msg);
        break;

      case 'get-all-qsos':
        this.emit('get-all-qsos');
        break;

      case 'update-qso':
        if (msg.idx !== undefined && msg.fields) {
          this.emit('update-qso', { idx: msg.idx, fields: msg.fields });
        }
        break;

      case 'delete-qso':
        if (msg.idx !== undefined) {
          this.emit('delete-qso', { idx: msg.idx });
        }
        break;

      // --- JTCAT (FT8/FT4) ---
      case 'jtcat-start':
        this.emit('jtcat-start', { mode: msg.mode || 'FT8' });
        break;
      case 'jtcat-stop':
        this.emit('jtcat-stop');
        break;
      case 'jtcat-call-cq':
        this.emit('jtcat-call-cq');
        break;
      case 'jtcat-reply':
        if (msg.call) this.emit('jtcat-reply', { call: msg.call, grid: msg.grid || '', df: msg.df || 1500, sliceId: msg.sliceId || '' });
        break;
      case 'jtcat-enable-tx':
        this.emit('jtcat-enable-tx', { enabled: !!msg.enabled });
        break;
      case 'jtcat-halt-tx':
        this.emit('jtcat-halt-tx');
        break;
      case 'jtcat-auto-cq-mode':
        this.emit('jtcat-auto-cq-mode', { mode: msg.mode || 'off' });
        break;
      case 'jtcat-set-mode':
        this.emit('jtcat-set-mode', { mode: msg.mode || 'FT8' });
        break;
      case 'set-freedv':
        this.emit('set-freedv', { enabled: !!msg.enabled });
        break;
      // FreeDV
      case 'freedv-start':
        this.emit('freedv-start', { mode: msg.mode || '700E' });
        break;
      case 'freedv-stop':
        this.emit('freedv-stop');
        break;
      case 'freedv-set-mode':
        this.emit('freedv-set-mode', { mode: msg.mode || '700E' });
        break;
      case 'freedv-set-tx':
        this.emit('freedv-set-tx', { enabled: !!msg.enabled });
        break;
      case 'freedv-set-squelch':
        this.emit('freedv-set-squelch', { enabled: msg.enabled, threshold: msg.threshold });
        break;
      case 'jtcat-set-tx-freq':
        this.emit('jtcat-set-tx-freq', { hz: msg.hz || 1500 });
        break;
      case 'jtcat-set-tx-slot':
        this.emit('jtcat-set-tx-slot', { slot: msg.slot || 'auto' });
        break;
      case 'jtcat-rx-gain':
        this.emit('jtcat-rx-gain', { value: msg.value });
        break;
      case 'jtcat-tx-gain':
        this.emit('jtcat-tx-gain', { value: msg.value });
        break;
      case 'jtcat-cancel-qso':
        this.emit('jtcat-cancel-qso');
        break;
      case 'jtcat-skip-phase':
        this.emit('jtcat-skip-phase');
        break;
      case 'jtcat-log-qso':
        this.emit('jtcat-log-qso');
        break;
      case 'jtcat-set-band':
        this.emit('jtcat-set-band', { band: msg.band, freqKhz: msg.freqKhz });
        break;
      case 'jtcat-waterfall':
        this.emit('jtcat-waterfall', { visible: !!msg.visible });
        break;
      case 'jtcat-tune-toggle':
        this.emit('jtcat-tune-toggle');
        break;
      case 'jtcat-set-auto-seq':
        this.emit('jtcat-set-auto-seq', { enabled: !!msg.enabled });
        break;

      case 'jtcat-start-multi-remote':
        this.emit('jtcat-start-multi-remote', { slices: msg.slices || [] });
        break;

      case 'voice-macro-sync':
        this.emit('voice-macro-sync', { idx: msg.idx, label: msg.label, audio: msg.audio });
        break;
      case 'voice-macro-delete':
        this.emit('voice-macro-delete', { idx: msg.idx });
        break;
      case 'voice-macro-play':
        // Phone-tapped macro slot — main.js routes through the local
        // voice-macro-ptt audio chain (PTT on, play clip, PTT off).
        this.emit('voice-macro-play', { idx: msg.idx });
        break;
      case 'jtcat-set-hold-tx-freq':
        this.emit('jtcat-set-hold-tx-freq', { enabled: !!msg.enabled });
        break;

      // Phone pushes its CW macros to the desktop so they survive
      // localStorage wipes on the phone (Safari ITP, browser cache
      // clears). Desktop saves to settings.remoteCwMacros and re-pushes
      // to all connected clients on the next auth-ok handshake.
      case 'save-cw-macros':
        if (Array.isArray(msg.macros)) {
          this.emit('save-cw-macros', { macros: msg.macros });
        }
        break;

      // Phone persists ECHOCAT prefs (welcome banner dismissed, future
      // tabs-hidden state, etc.) to the desktop so they survive a
      // localStorage wipe on the phone.
      case 'save-echo-pref':
        if (msg.key) this.emit('save-echo-pref', { key: msg.key, value: msg.value });
        break;

      // --- SSTV messages ---
      case 'sstv-open':
        this.emit('sstv-open');
        break;
      case 'sstv-photo':
        // Phone captured photo for SSTV TX: { image: base64, mode: 'martin1'|... }
        this.emit('sstv-photo', { image: msg.image, mode: msg.mode || 'martin1' });
        break;
      case 'sstv-stop':
        this.emit('sstv-stop');
        break;
      case 'sstv-halt-tx':
        // Phone requested an immediate TX abort — release PTT, kill audio.
        this.emit('sstv-halt-tx');
        break;
      case 'sstv-set-auto-enabled':
        // Phone tapped the AUTO-SSTV banner to disable the idle-trigger.
        this.emit('sstv-set-auto-enabled', { enabled: !!msg.enabled });
        break;
      case 'restart-audio':
        // Phone-triggered audio reset. Same effect as Settings → ECHOCAT
        // → "Restart audio" on the desktop: tear down + rebuild the
        // WebRTC audio bridge + JTCAT capture so a Windows RDP shuffle
        // (or any stale audio handle) is recovered without touching the
        // shack PC physically. K3SBP 2026-05-08.
        this.emit('restart-audio');
        break;
      case 'sstv-get-gallery':
        // Phone requests recent decoded images: { limit, offset }
        this.emit('sstv-get-gallery', { limit: msg.limit || 10, offset: msg.offset || 0, requestId: msg.requestId });
        break;
      case 'sstv-get-compose':
        // Phone asks desktop for its current compose (bg + text layers)
        this.emit('sstv-get-compose');
        break;

      case 'ping':
        this._sendTo(ws, { type: 'pong', ts: msg.ts });
        break;

      // --- CW Keyer messages ---
      case 'paddle':
        if (!this._cwEnabled || !this._cwKeyer) break;
        // Drop paddle events on the floor when the desktop has determined
        // paddle keying can't reach the radio (e.g. Linux cdc_acm rejected
        // TIOCMSET and pyserial fallback couldn't be spawned). Phone-side
        // is gated too, but a stale `cwPaddleAvailable=true` could slip in
        // if the WS message races with the desktop notification — belt
        // and suspenders.
        if (!this._cwPaddleAvailable) break;
        if (msg.contact === 'dit') {
          this._cwKeyer.paddleDit(!!msg.state);
        } else if (msg.contact === 'dah') {
          this._cwKeyer.paddleDah(!!msg.state);
        }
        // Watchdog: if no paddle message arrives for 1.5 s, assume the browser
        // lost a keyup event (common on Android Bluetooth MIDI / sustained
        // key-holds where the OS keydown fires once and no keyup comes) and
        // hard-stop the keyer. Originally this also force-sent a key-up to
        // the radio unconditionally — but that hit the CW key line again
        // even when the keyer had already cleanly idled, resetting the
        // rig's BK-IN timer and adding ~1.5 s of perceived break-in delay
        // (KM4CFT 2026-04-23). Now we only force the key-up when there is
        // actually evidence the radio is keyed (last emitted key event was
        // 'down').
        if (this._cwPaddleWatchdog) clearTimeout(this._cwPaddleWatchdog);
        this._cwPaddleWatchdog = setTimeout(() => {
          this._cwPaddleWatchdog = null;
          if (this._cwKeyer) {
            this._cwKeyer.paddleDit(false);
            this._cwKeyer.paddleDah(false);
            this._cwKeyer.stop();
          }
          // Only fire a redundant key-up at the radio if we actually emitted
          // a key-down without a matching key-up. stop() above will emit one
          // if state was non-IDLE, so this only kicks in when stop()'s
          // internal check missed something.
          if (this._cwKeyerOutput && this._lastCwKeyDown) {
            this._cwKeyerOutput({ down: false, timestamp: Date.now() });
            this._lastCwKeyDown = false;
          }
          // Let the phone update its sidetone / key indicator too.
          if (this._client && this._client.readyState === WebSocket.OPEN) {
            this._sendTo(this._client, { type: 'cw-state', keying: false });
          }
        }, 1500);
        break;

      case 'cw-config': {
        const wpm = Math.max(5, Math.min(50, msg.wpm || 20));
        const mode = ['iambicA', 'iambicB', 'straight'].includes(msg.mode) ? msg.mode : 'iambicB';
        this._cwWpm = wpm;
        this._cwMode = mode;
        if (this._cwKeyer) {
          this._cwKeyer.setWpm(wpm);
          this._cwKeyer.setMode(mode);
        }
        this._sendTo(ws, { type: 'cw-config-ack', wpm, mode });
        this.emit('cw-config', { wpm, mode });
        break;
      }

      case 'cw-stop':
        // Stops the iambic paddle keyer locally (server-side audio sidetone
        // / DTR keyer). Also emit 'cw-cancel-text' so main.js can abort any
        // in-flight macro / freeform CW text sitting in the rig's KY buffer,
        // pyserial helper, DTR timer queue, or SmartSDR cwx queue — AA6C
        // 2026-05-05 asked for a cancel button on the CW pane after
        // mis-clicking a long macro and having to wait it out.
        if (this._cwKeyer) this._cwKeyer.stop();
        this.emit('cw-cancel-text');
        break;

      case 'cw-text':
        // Send CW text macro/freeform — emitted to main.js for routing to radio
        if (msg.text && typeof msg.text === 'string') {
          this.emit('cw-text', { text: msg.text });
        }
        break;

      case 'cw-enable':
        // Phone requests to toggle remote CW on/off
        this.emit('cw-enable-request', { enabled: !!msg.enabled });
        break;

      case 'save-custom-cat-buttons':
        if (msg.buttons && Array.isArray(msg.buttons)) {
          this.emit('save-custom-cat-buttons', msg.buttons);
        }
        break;

      // ── Cloud Sync (ECHOCAT) ─────────────────────────────────────
      case 'cloud-login':
        this.emit('cloud-login', msg, (result) => this._sendTo(ws, { type: 'cloud-login-result', ...result }));
        break;
      case 'cloud-register':
        this.emit('cloud-register', msg, (result) => this._sendTo(ws, { type: 'cloud-register-result', ...result }));
        break;
      case 'cloud-logout':
        this.emit('cloud-logout', (result) => this._sendTo(ws, { type: 'cloud-logout-result', ...result }));
        break;
      case 'cloud-get-status':
        this.emit('cloud-get-status', (result) => this._sendTo(ws, { type: 'cloud-status', ...result }));
        break;
      case 'cloud-sync-now':
        this.emit('cloud-sync-now', (result) => this._sendTo(ws, { type: 'cloud-sync-result', ...result }));
        break;
      case 'cloud-bulk-upload':
        this.emit('cloud-bulk-upload', (result) => this._sendTo(ws, { type: 'cloud-upload-result', ...result }));
        break;
      case 'cloud-verify-subscription':
        this.emit('cloud-verify-subscription', (result) => this._sendTo(ws, { type: 'cloud-verify-result', ...result }));
        break;
      case 'cloud-save-bmac-email':
        this.emit('cloud-save-bmac-email', msg.bmacEmail, (result) => this._sendTo(ws, { type: 'cloud-bmac-result', ...result }));
        break;
      case 'kiwi-connect':
        console.log('[Echo CAT] kiwi-connect received:', JSON.stringify(msg).substring(0, 200));
        this.emit('kiwi-connect', msg);
        break;
      case 'kiwi-disconnect':
        this.emit('kiwi-disconnect');
        break;
      case 'kiwi-tune':
        // QSY the SDR receiver mid-session. Mobile sends freqKhz as a
        // string (matches the rig `tune` schema). Mode optional — falls
        // back to current mode on the desktop side.
        this.emit('kiwi-tune', { freqKhz: msg.freqKhz, mode: msg.mode });
        break;
      case 'save-settings':
        if (msg.settings) this.emit('save-settings', msg.settings);
        break;
    }
  }

  _handlePtt(state) {
    if (this._pttSafetyTimer) {
      clearTimeout(this._pttSafetyTimer);
      this._pttSafetyTimer = null;
    }

    if (state) {
      // Start safety timer
      this._pttSafetyTimer = setTimeout(() => {
        console.log('[Echo CAT] PTT safety timeout — forcing RX');
        this._pttActive = false;
        this.emit('ptt', { state: false });
        // Notify phone
        if (this._client && this._client.readyState === WebSocket.OPEN) {
          this._sendTo(this._client, {
            type: 'ptt-timeout',
            message: 'PTT safety timeout reached — auto-RX',
          });
        }
      }, this._pttSafetyTimeout * 1000);
    }

    this._pttActive = state;
    this.emit('ptt', { state });
  }

  _onClientDisconnected() {
    // Force CW key up if keyer was active (safety)
    if (this._cwPaddleWatchdog) { clearTimeout(this._cwPaddleWatchdog); this._cwPaddleWatchdog = null; }
    if (this._cwKeyer) {
      this._cwKeyer.stop();
    }
    // Always force key-up through the output callback — keyer.stop() only emits
    // key-up if it wasn't already idle, but the radio may still be in TX
    if (this._cwKeyerOutput) {
      this._cwKeyerOutput({ down: false, timestamp: Date.now() });
    }
    // Force RX if PTT was active
    if (this._pttActive) {
      this._pttActive = false;
      if (this._pttSafetyTimer) {
        clearTimeout(this._pttSafetyTimer);
        this._pttSafetyTimer = null;
      }
      this.emit('ptt', { state: false });
      console.log('[Echo CAT] Client disconnected while TX — forcing RX');
    }
    // Club mode: log disconnect
    if (this._clubMode && this._authenticatedMember && this._auditLogger) {
      this._auditLogger.log(this._authenticatedMember.callsign, 'logout', '');
    }
    this._authenticatedMember = null;
    this._client = null;
    this.emit('client-disconnected');
    console.log('[Echo CAT] Client disconnected');
  }

  // Force PTT release from external source (e.g. CAT disconnected during TX)
  forcePttRelease() {
    if (this._pttSafetyTimer) {
      clearTimeout(this._pttSafetyTimer);
      this._pttSafetyTimer = null;
    }
    this._pttActive = false;
    // Notify phone to update its PTT UI state
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, {
        type: 'ptt-force-rx',
        message: 'Radio connection lost — PTT released',
      });
    }
  }

  // --- Broadcasting ---

  /** Push the current VFO profile list to the connected phone. */
  sendVfoProfiles(profiles) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'vfo-profiles', profiles: Array.isArray(profiles) ? profiles : [] });
    }
  }

  broadcastSpots(spots) {
    this._lastSpots = spots;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'spots', data: spots });
    }
  }

  sendToClient(msg) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, msg);
    }
  }

  broadcastRadioStatus(status) {
    this._radioStatus = { ...this._radioStatus, ...status };
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'status', ...this._radioStatus });
    }
  }

  sendSourcesToClient(sources) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'sources', data: sources });
    }
  }

  sendFiltersToClient(filters) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'echo-filters', data: filters });
    }
  }

  sendRigsToClient(rigs, activeRigId) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      let filteredRigs = rigs;
      // Club mode: filter rigs by member access
      if (this._clubMode && this._authenticatedMember) {
        filteredRigs = getMemberRigAccess(this._authenticatedMember, this._clubRigs);
      }
      this._sendTo(this._client, { type: 'rigs', data: filteredRigs, activeRigId });
    }
  }

  sendLogResult(result) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'log-ok', ...result });
    }
  }

  broadcastActivatorState(state) {
    this._activatorState = state;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'activator-state', ...state });
    }
  }

  setColorblindMode(enabled) {
    this._colorblindMode = !!enabled;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'colorblind-mode', enabled: this._colorblindMode });
    }
  }

  setVfoLocked(locked) {
    this._vfoLocked = !!locked;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'vfo-lock-state', locked: this._vfoLocked });
    }
  }

  sendWorkedParks(refs) {
    this._workedParks = refs;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'worked-parks', refs });
    }
  }

  sendWorkedQsos(entries) {
    this._workedQsos = entries;
    this._workedQsosCache = null; // entries reference changed → re-serialize
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      // Reset the per-WS dedupe so a live update (e.g. just-logged QSO)
      // makes it to the phone.
      this._client._workedQsosSent = false;
      this._sendWorkedQsosCapped(this._client);
    }
  }

  // Auto-pushed worked-qsos can be huge for active loggers — K0OTC's
  // ~19k-callsign ADIF serialized to multiple MB and hit the iOS
  // WebSocket frame ceiling, causing a connect/disconnect loop right
  // after auth. Skip the auto-push when serialization exceeds 1 MB;
  // small logs are unaffected. Phones that need the full per-call
  // history can request it via a dedicated message later.
  _sendWorkedQsosCapped(ws) {
    if (!this._workedQsos) return;
    // Both the auth-ok path and the main.js client-connected handler call
    // this on the same connection, which means we stringify a multi-MB map
    // twice for a single reconnect. Cache the result per-connection — the
    // worked-qsos data doesn't change mid-session — and reuse it.
    let cached = this._workedQsosCache;
    const sameRef = cached && cached.source === this._workedQsos;
    if (!sameRef) {
      // 256 KB. 1 MB was empirically still too large for iOS RN
      // WebSocket — Scott WG9I's ~5000-QSO / 1100-park log fit under
      // the previous 1 MB cap and still produced a 1009 close right
      // after auth on iOS. Tightening until we ship chunked transport.
      const MAX_BYTES = 256_000;
      const payload = { type: 'worked-qsos', entries: this._workedQsos };
      let json;
      try { json = JSON.stringify(payload); } catch { return; }
      const callCount = (this._workedQsos.length != null)
        ? this._workedQsos.length
        : (typeof this._workedQsos === 'object' ? Object.keys(this._workedQsos).length : '?');
      cached = {
        source: this._workedQsos,
        json,
        oversized: json.length > MAX_BYTES,
        bytes: json.length,
        callCount,
        cap: MAX_BYTES,
      };
      this._workedQsosCache = cached;
      if (cached.oversized) {
        console.log(`[Echo CAT] Skipping worked-qsos auto-push — ${cached.bytes} bytes / ${callCount} calls exceeds ${MAX_BYTES}-byte cap. Phone will not see per-call QSO history.`);
      }
    }
    // Dedupe within a single connection: only send (or skip-notify) once
    // per WS instance. Without this, the auth-ok path AND the
    // client-connected handler both fire, sending the same payload twice
    // back-to-back on every reconnect — wasteful and a likely contributor
    // to the iOS reconnect loop on big logs.
    if (ws._workedQsosSent) return;
    ws._workedQsosSent = true;
    if (cached.oversized) {
      this._sendTo(ws, { type: 'worked-qsos-skipped', reason: 'size', bytes: cached.bytes, cap: cached.cap });
      return;
    }
    try { ws.send(cached.json); } catch {} // already serialized — reuse it
  }

  // One-shot diagnostic: log the byte size of every initial-state
  // payload we just blasted at a freshly-authed client. Lets us catch
  // whichever message is provoking iOS WS code=1009 without making
  // testers reproduce + send logs every time the offender changes.
  _logInitialPayloadSizes() {
    const sizes = [];
    const measure = (label, obj) => {
      if (obj == null) return;
      try { sizes.push(`${label}=${Buffer.byteLength(JSON.stringify(obj))}`); } catch {}
    };
    // auth-ok carries the entire settings object on every connect/reconnect.
    // Walt KK4DF on v1.5.19 was hitting iOS WS 1009 within 70ms of connect
    // even with worked-qsos skipped — auth-ok with rich settings (sstv
    // templates, customCatButtons, remoteCwMacros) is the leading suspect
    // for accounts with heavy customization. Measure both the full auth-ok
    // and just the settings sub-object so the offender is unambiguous.
    measure('auth-ok', {
      type: 'auth-ok',
      colorblindMode: !!this._colorblindMode,
      settings: this._remoteSettings,
      cwAvailable: this._cwEnabled,
      cwPaddleAvailable: this._cwPaddleAvailable,
      vfoLocked: !!this._vfoLocked,
    });
    if (this._remoteSettings) measure('  └ settings', this._remoteSettings);
    if (this._lastSpots && this._lastSpots.length) measure('spots', { type: 'spots', data: this._lastSpots });
    measure('status', { type: 'status', ...this._radioStatus });
    if (this._activatorState) measure('activator-state', this._activatorState);
    if (this._sessionContacts && this._sessionContacts.length) measure('session-contacts', { contacts: this._sessionContacts });
    if (this._workedParks) measure('worked-parks', { refs: this._workedParks });
    // worked-qsos: reuse the cache built by _sendWorkedQsosCapped so
    // we don't re-stringify multiple MB just to log a size.
    if (this._workedQsosCache && this._workedQsosCache.bytes != null) {
      sizes.push(`worked-qsos=${this._workedQsosCache.bytes}${this._workedQsosCache.oversized ? '(skipped)' : ''}`);
    }
    if (this._jtcatDecodeBuffer && this._jtcatDecodeBuffer.length) measure('jtcat-decode-batch', { entries: this._jtcatDecodeBuffer });
    if (this._directoryData && (this._directoryData.nets.length || this._directoryData.swl.length)) measure('directory', this._directoryData);
    if (this._donorCallsigns && this._donorCallsigns.length) measure('donor-callsigns', { callsigns: this._donorCallsigns });
    console.log(`[Echo CAT] Initial payload sizes: ${sizes.join(' ')}`);
  }

  setRemoteSettings(obj) {
    this._remoteSettings = obj;
    this._cachedInlinedHtml = null;
    // Push updated settings live to connected ECHOCAT client
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'settings-update', settings: obj });
    }
  }

  // TX EQ + compressor state — pushed to mobile any time desktop's
  // settings.txEqEnabled / settings.txEqPreset changes (Settings dialog,
  // VFO popout dropdown, or mobile itself echoing back). Mobile keeps
  // its own EQ UI in sync from this message; no polling required.
  broadcastTxEqState(payload) {
    if (!payload) return;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, {
        type: 'tx-eq-state',
        enabled: !!payload.enabled,
        preset: payload.preset || 'ragchew',
        // null if user has never touched Custom — mobile UI shows
        // sliders at zeroes in that case and persists on first edit.
        customParams: payload.customParams || null,
      });
    }
  }

  broadcastDirectory(data) {
    this._directoryData = data;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, {
        type: 'directory',
        nets: data.nets,
        swl: data.swl,
        // Per docs/desktop-handoffs/sync-user-defined-nets.md: mobile
        // shipped the consumer first (NetEntry.isUser flag + (name,
        // freq) dedupe), so as long as we send userNets in this
        // payload, the phone's Dir tab shows the user's My Net
        // Reminders with a "MY" badge automatically.
        userNets: data.userNets || [],
      });
    }
  }

  broadcastDonorCallsigns(callsigns) {
    this._donorCallsigns = callsigns;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'donor-callsigns', callsigns });
    }
  }

  broadcastClusterState(connected) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'cluster-state', connected });
    }
  }

  sendSessionContacts() {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'session-contacts', contacts: this._sessionContacts });
    }
  }

  addSessionContact(contact) {
    this._contactNr++;
    const c = { nr: this._contactNr, ...contact };
    this._sessionContacts.push(c);
    return c;
  }

  getSessionContacts() {
    return this._sessionContacts;
  }

  resetSessionContacts() {
    this._sessionContacts = [];
    this._contactNr = 0;
  }

  sendParkResults(results) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'park-results', results });
    }
  }

  sendPastActivations(activations) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'past-activations', data: activations });
    }
  }

  sendCallLookup(data) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'call-lookup', ...data });
    }
  }

  sendActivationMapData(data) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'activation-map-data', data });
    }
  }

  sendAllQsos(qsos) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'all-qsos', data: qsos });
    }
  }

  sendQsoUpdated(result) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'qso-updated', ...result });
    }
  }

  sendQsoDeleted(result) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'qso-deleted', ...result });
    }
  }

  relaySignalToClient(data) {
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'signal', data });
    }
  }

  // --- JTCAT Broadcasting ---

  broadcastJtcatDecode(data) {
    this._jtcatDecodeBuffer.push(data);
    if (this._jtcatDecodeBuffer.length > 10) this._jtcatDecodeBuffer.shift();
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-decode', ...data });
  }

  broadcastJtcatCycle(data) {
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-cycle', ...data });
  }

  broadcastJtcatTxStatus(data) {
    // Cache for reconnect replay — phone falling asleep mid-FT8 used
    // to come back with no idea whether the engine was TXing or RXing
    // until the next cycle boundary up to 15s later. (iOS handoff #1.)
    this._jtcatTxStatus = data;
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-tx-status', ...data });
  }

  broadcastJtcatQsoState(qso) {
    this._jtcatQsoState = qso;
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-qso-state', ...qso });
  }

  broadcastJtcatAutoCqState(state) {
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-auto-cq-state', ...state });
  }

  broadcastJtcatStatus(data) {
    this._jtcatState = data;
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-status', ...data });
  }

  broadcastJtcatSpectrum(bins) {
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-spectrum', bins });
  }

  hasClient() {
    return !!(this._client && this._client.readyState === WebSocket.OPEN && this._client._authenticated);
  }

  /** Get the currently authenticated club member (or null). */
  getAuthenticatedMember() {
    return this._authenticatedMember;
  }

  // --- SSTV broadcasts ---

  broadcastSstvRxImage(data) {
    if (!this.hasClient()) return;
    // Convert imageData to base64 PNG for phone display
    this._sendTo(this._client, {
      type: 'sstv-rx-image',
      image: data.base64 || data.dataUrl || '',
      mode: data.mode,
      width: data.width,
      height: data.height,
      timestamp: Date.now(),
    });
  }

  broadcastSstvTxStatus(data) {
    if (this.hasClient()) this._sendTo(this._client, { type: 'sstv-tx-status', ...data });
  }

  broadcastSstvProgress(data) {
    if (this.hasClient()) this._sendTo(this._client, { type: 'sstv-rx-progress', ...data });
  }

  broadcastSstvWfBins(bins) {
    if (this.hasClient()) this._sendTo(this._client, { type: 'sstv-wf-bins', bins });
  }

  sendSstvGallery(images, requestId, total) {
    if (this.hasClient()) this._sendTo(this._client, { type: 'sstv-gallery', images, requestId, total });
  }

  // Live compose sync: desktop pushes its current background + text layers so
  // the phone's compose view mirrors what the user built on the desktop.
  broadcastSstvComposeState(state) {
    if (this.hasClient()) this._sendTo(this._client, { type: 'sstv-compose-state', ...state });
  }

  // --- CW Keyer ---

  /**
   * Register the callback that receives raw key events from the iambic keyer.
   * This is the abstraction point for different radio CW implementations.
   * @param {function} callback - receives { down: boolean, timestamp: number }
   */
  setCwKeyerOutput(callback) {
    this._cwKeyerOutput = callback || null;
  }

  /**
   * Enable or disable remote CW keying.
   * When enabled, creates an IambicKeyer and wires it to the output callback.
   */
  setCwEnabled(enabled) {
    this._cwEnabled = !!enabled;
    if (enabled) {
      this._initCwKeyer();
    } else {
      this._destroyCwKeyer();
    }
    // Notify connected phone
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'cw-available', enabled: this._cwEnabled });
    }
  }

  /**
   * Tell the phone whether paddle keying actually reaches the radio.
   * Macros and text-send go through different code paths (CI-V 0x17,
   * hamlib send_morse) and stay enabled even when this is false — only
   * the iambic-keyer paddle path is gated by this flag.
   *
   * Used to suppress phone-side local sidetone when desktop has detected
   * that DTR keying isn't working (e.g. Linux cdc_acm rejected TIOCMSET
   * and pyserial fallback couldn't be spawned). Without this, the user
   * hears phantom sidetone with no radio output and assumes POTACAT is
   * broken — confusing per KM4CFT 2026-04-29.
   */
  setCwPaddleAvailable(available, reason) {
    this._cwPaddleAvailable = !!available;
    this._cwPaddleUnavailableReason = reason || null;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, {
        type: 'cw-paddle-available',
        available: this._cwPaddleAvailable,
        reason: this._cwPaddleUnavailableReason,
      });
    }
  }

  _initCwKeyer() {
    this._destroyCwKeyer();
    this._cwKeyer = new IambicKeyer();
    this._cwKeyer.setWpm(this._cwWpm);
    this._cwKeyer.setMode(this._cwMode);

    this._cwKeyer.on('key', (evt) => {
      // Track last key direction so the watchdog can avoid sending a
      // redundant key-up to the radio when it's already in RX. The previous
      // unconditional force key-up was hitting the rig's CW key line a
      // second time and resetting the BK-IN timer (~+1.5 s extra delay
      // perceived as a 4 s break-in by KM4CFT).
      this._lastCwKeyDown = !!evt.down;
      // Forward to radio via output callback
      if (this._cwKeyerOutput) {
        this._cwKeyerOutput(evt);
      }
      // Send cw-state back to phone for sidetone indicator
      if (this._client && this._client.readyState === WebSocket.OPEN) {
        this._sendTo(this._client, { type: 'cw-state', keying: evt.down });
      }
    });
  }

  _destroyCwKeyer() {
    if (this._cwPaddleWatchdog) { clearTimeout(this._cwPaddleWatchdog); this._cwPaddleWatchdog = null; }
    if (this._cwKeyer) {
      this._cwKeyer.stop();
      this._cwKeyer.removeAllListeners();
      this._cwKeyer = null;
    }
  }

  // --- License privilege check (mirrors renderer/app.js isOutOfPrivilege) ---

  _checkTunePrivilege(freqKhz, mode) {
    if (!this._authenticatedMember || !this._authenticatedMember.licenseClass) return null;
    const cls = this._authenticatedMember.licenseClass;
    if (!cls || cls === 'none') return null;
    const ranges = PRIVILEGE_RANGES[cls];
    if (!ranges) return null;
    if (!mode) return null;
    const modeUpper = mode.toUpperCase();
    for (const [lower, upper, allowed] of ranges) {
      if (freqKhz >= lower && freqKhz <= upper) {
        if (allowed === 'all') return null;
        if (allowed === 'cw_digi' && CW_DIGI_MODES.has(modeUpper)) return null;
        if (allowed === 'phone' && PHONE_MODES.has(modeUpper)) return null;
      }
    }
    const licenseName = cls.replace('us_', '').replace('ca_', '');
    return `${freqKhz} kHz ${mode} is outside ${licenseName} privileges`;
  }

  // --- Helpers ---

  _sendTo(ws, obj) {
    let wire;
    try { wire = JSON.stringify(obj); }
    catch { return; }
    const bytes = wire.length;
    const type = (obj && obj.type) || 'unknown';

    // Per-message diagnostic for the initial-state push window. Walt KK4DF
    // 2026-05-14: client closes with code=1009 mid-burst, the after-the-
    // fact _logInitialPayloadSizes() summary either fires after the close
    // handler races ahead or runs but doesn't surface the offender (e.g.
    // pre-v1.5.20 builds didn't include auth-ok in the summary). Logging
    // each send inline gives us the offender unambiguously — the last
    // `push msg=...` line before `WS close: code=1009` is the message
    // that tripped the iOS receive cap. Limit to the first 2s post-
    // connect so steady-state traffic (spot batches, status pushes, jtcat
    // decode batches) doesn't flood the verbose log.
    const now = Date.now();
    if (!ws._connectedAtMs) ws._connectedAtMs = now;
    if (now - ws._connectedAtMs < 2000) {
      console.log(`[Echo CAT] push msg=${type} bytes=${bytes}`);
    }
    // Always warn on individual payloads over 256 KB regardless of timing
    // — well over any single legitimate state message and a likely 1009
    // trigger even on iOS RN builds with the 32 MiB cap raised. Catches
    // runaway settings (sstvTemplates with imported large image,
    // remoteCwMacros that ballooned, etc.) and coalesced batches that
    // should be chunked.
    if (bytes > 256 * 1024) {
      console.warn(`[Echo CAT] LARGE WS payload: msg=${type} bytes=${bytes} — likely 1009 trigger on iOS`);
    }

    try { ws.send(wire); }
    catch {}
  }

  static generateToken() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  // Filter out interfaces that exist only on this host and can't be
  // reached by another device on the network. K3SBP 2026-05-05 had
  // Hyper-V's Default Switch (192.168.126.x) and a WSL2 vEthernet
  // (172.28.48.x) appearing in the ECHOCAT IP list — neither is a
  // routable target for a phone. Match by interface name first, then
  // by MAC OUI as a backup (virtual NICs use vendor-assigned OUI
  // ranges). Tailscale stays — its 100.x is intentionally routable.
  static _isVirtualAdapter(name, mac) {
    const lname = (name || '').toLowerCase();
    if (/vethernet|hyper-?v|wsl|virtualbox|vbox|vmware|vmnet|parallels|docker|^tap|^tun\d/.test(lname)) {
      return true;
    }
    if (mac) {
      const oui = mac.toLowerCase().replace(/[:-]/g, '').slice(0, 6);
      // 00155d = Microsoft Hyper-V, 005056/000c29 = VMware,
      // 080027 = VirtualBox, 001c42 = Parallels
      if (['00155d', '005056', '000c29', '080027', '001c42'].includes(oui)) {
        return true;
      }
    }
    return false;
  }

  // On Windows, list IPv4 addresses that own a default route. An
  // interface without a default route can't reach anything off this
  // host (Hyper-V Default Switch, USB tethering devices that haven't
  // been plugged in, ad-hoc adapters), so it's not a valid pair
  // target. Returns null on non-Windows or when the probe fails;
  // callers fall back to name/MAC filtering.
  //
  // Uses `route print -4 0.0.0.0` because it's ~80x faster than the
  // PowerShell Get-NetIPConfiguration equivalent (50ms vs 4s on a
  // typical machine — PS startup dominates). Output format:
  //   Network Destination   Netmask   Gateway   Interface   Metric
  //         0.0.0.0       0.0.0.0   192.168.1.1  192.168.1.42   25
  // We pull the 4th column (Interface, the local IP that owns the
  // route).
  //
  // Cached for 30s to keep cost off the hot path.
  static _getRoutedAddresses() {
    if (process.platform !== 'win32') return null;
    if (RemoteServer._gwCache && (Date.now() - RemoteServer._gwCacheTime) < 30000) {
      return RemoteServer._gwCache;
    }
    try {
      const { execSync } = require('child_process');
      const out = execSync('route print -4 0.0.0.0', { timeout: 3000, encoding: 'utf-8' });
      const ips = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\d+\.\d+\.\d+\.\d+)/);
        if (m) ips.add(m[1]);
      }
      RemoteServer._gwCache = ips;
      RemoteServer._gwCacheTime = Date.now();
      return ips;
    } catch {
      RemoteServer._gwCache = null;
      return null;
    }
  }

  static getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    // Try to get Tailscale MagicDNS hostname via the shared probe
    // (handles macOS PATH quirks / app-bundle binary location).
    const ts = tailscaleStatus();
    const tailscaleHostname = ts ? ts.hostname : null;

    const routedIPs = RemoteServer._getRoutedAddresses();

    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        const isTailscale = addr.address.startsWith('100.');
        // Don't filter Tailscale even though it has no default route —
        // it's the whole point of being there.
        if (!isTailscale) {
          if (RemoteServer._isVirtualAdapter(name, addr.mac)) continue;
          // On Windows, drop addresses that don't own a default route.
          // Catches phantom NICs that name/MAC heuristics miss (K3SBP
          // 2026-05-05: "Ethernet 6" was a USB NCM Host Device with
          // 192.168.126.11, no gateway, unreachable).
          if (routedIPs && !routedIPs.has(addr.address)) continue;
        }
        ips.push({
          name,
          address: addr.address,
          tailscale: isTailscale,
          tailscaleHostname: isTailscale ? tailscaleHostname : null,
        });
      }
    }
    // Tailscale IPs first
    ips.sort((a, b) => (b.tailscale ? 1 : 0) - (a.tailscale ? 1 : 0));
    return ips;
  }
}

module.exports = {
  RemoteServer,
  tailscaleStatus,
  issueTailscaleCert,
  loadCachedTailscaleCert,
};
