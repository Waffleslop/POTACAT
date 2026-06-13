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
// Club Station Mode removed 2026-06-02 — paired-device tokens + Guest
// Passes cover the same use cases (per-member auth + per-session
// privilege caps) without the CSV-of-credentials baggage.
const { IambicKeyer } = require('./keyer');
const protocol = require('./echocat-protocol');

// Pairing token TTL: mobile-app pairing tokens expire 5 minutes after
// the desktop generates them. The QR code only shows for as long as
// this window; the user has to regenerate if they take longer.
const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

// Sliding TTL applied to long-lived deviceTokens minted via the
// per-device pair flow. Each successful auth refreshes expiresAt to
// now + this. Devices marked trusted (operator-flagged) or accountLinked
// (Cloud-attested) get expiresAt:null at mint time and are skipped by
// the refresh — see docs/remote-desktop-plan.md. The 180-day window is
// long enough that an active user never sees a re-pair prompt; a phone
// that's been off for half a year prompts the owner to refresh.
const DEVICE_TOKEN_SLIDING_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// Operator-chosen TTL bounds for persistent share-links. Lower bound
// is a sanity guard (zero/negative TTLs would mint already-expired
// links). Upper bound is a deliberate security policy: sharing access
// must stay time-bounded. "Forever" requires pairing your own device
// and toggling "Trusted device" — see docs/remote-desktop-plan.md.
const MIN_PAIR_LINK_TTL_MS = 60 * 1000;
const MAX_PAIR_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// "YYYYMMDD" UTC stamp. Matches the iOS workedToday store's date
// key so today-membership comparisons line up across both ends.
function utcYyyymmdd(ms) {
  const d = new Date(ms);
  return (
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

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
    // Persistent share-link store (new in v1.9). Unlike _pairingTokens
    // (in-memory, 5-min TTL, intended for in-person QR scans), pair
    // links live on disk so the operator can email a recipient a link
    // and have it work after a desktop restart. Operator picks the
    // TTL (1h / 24h / 7d / 30d) at creation; redemption goes through
    // the same /api/pair endpoint that handles QR tokens. Hydrated by
    // main.js from settings.pendingPairLinks at startup; persisted on
    // 'pending-pair-links-changed'. See docs/remote-desktop-plan.md
    // > "Share-link (QR + URL + email)".
    this._pendingPairLinks = [];
    // Active rig model on the shack (e.g. "Flex 8600M", "FTDX10").
    // main.js calls setRigModel() whenever the user switches rigs in
    // settings. Surfaced over the wire in the server `hello` so POTACAT
    // desktop clients can show which rig each paired shack is wired to
    // in the Remote Radios panel — useful when the operator has two
    // shacks paired and needs to tell them apart.
    this._rigModel = '';
    this._pttSafetyTimer = null;
    this._pttSafetyTimeout = 180; // seconds
    this._pttActive = false;
    this._lastTuneTime = 0;
    this._lastFilterTime = 0;
    this._lastSpots = [];
    this._radioStatus = { freq: 0, mode: '', catConnected: false, txState: false };
    // Match-based freq suppression. After the client tunes, replace freq in
    // outgoing status payloads with the client's own target UNTIL the rig's
    // polled freq matches that target (within 25 Hz) — or a 3 s hard timeout
    // fires as a safety net. A fixed time window wasn't enough (W8IJW v1.7.2
    // re-report 2026-05-24): if the rig hadn't physically caught up by the
    // timer's end the next polled value still landed stale and snapped the
    // dial backwards. The rest of the status snapshot still flows live —
    // only freq is rewritten.
    this._postTuneFreqTarget = 0;    // Hz target (0 = not armed)
    this._postTuneFreqDeadline = 0;  // hard-timeout fallback
    this._sessionContacts = [];
    this._contactNr = 0;
    this._activatorState = null;
    this._workedParks = null;
    this._workedQsos = null;
    this._remoteSettings = {};
    this._jtcatUltracatState = null; // last ULTRACAT / Full Auto CQ state (replayed on connect)
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
    // POTACAT Cloud Tunnel exposure flag. True means this server is
    // currently reachable from the public internet via
    // <callsign>.potacat.com → cloudflared → us. In that state the
    // LAN-only auto-auth policy is unsafe (the FCC ULS callsign list
    // is public and the subdomain is enumerable), so we force every
    // new connection to present a paired-device token or a Guest
    // Pass code before it can drive the rig. Toggled by main.js via
    // setTunnelExposed() in response to cloud-tunnel.js state changes.
    this._tunnelExposed = false;
    // Alternate hostnames a paired phone can dial when the primary LAN
    // host stops responding. Source of truth lives in main.js (which
    // owns Tailscale + Cloud-Tunnel state); RemoteServer just stashes
    // the last-known values so they ride the auth-ok payload + every
    // /api/pair* response without main.js having to thread them
    // through each call site. Updated via setAltHosts().
    this._altHosts = { tsHost: '', cloudHost: '' };
    // In-flight tap-to-pair request (Part A). Holds the modal/popout
    // state for the single approve-or-deny window currently open, so
    // we can refuse concurrent requests with 503 pair_request_busy.
    this._pendingPairRequest = null;
    // Resolved tap-to-pair outcomes, keyed by requestId, kept ~2 min.
    // iOS retires idle sockets faster than a human clicks Approve, so
    // the held response is often dead by the time the operator acts —
    // the phone re-POSTs with the same requestId and collects the
    // outcome from here instead of opening a brand-new request.
    this._recentPairResults = new Map();
    // Owner-controlled gate. Defaults to allowed; main.js calls
    // setAllowPairRequests(false) when the operator turns the
    // Settings toggle off. Independent of the tunnel-exposed
    // refusal, which is always enforced.
    this._allowPairRequests = true;
  }

  /** Owner-controlled gate on /api/pair-request. */
  setAllowPairRequests(enabled) {
    this._allowPairRequests = !!enabled;
  }

  /**
   * Set the active rig model string advertised in `hello`. Called by
   * main.js whenever the user switches rigs. Empty string clears it
   * (no rig configured / headless / not yet connected).
   */
  setRigModel(model) {
    this._rigModel = String(model || '');
  }

  /**
   * Called by main.js when the operator clicks Approve in the
   * tap-to-pair popout. Mints a deviceToken, appends to
   * _pairedDevices, and resolves the held /api/pair-request HTTP
   * response with the PairResponse shape. Returns the new device
   * record for the audit log, or null if there's no matching
   * pending request (e.g. the user clicked Approve after the 60 s
   * timeout already fired).
   */
  approvePairRequest(requestId) {
    return this._resolvePairRequest(requestId, { approved: true });
  }

  /**
   * Called by main.js when the operator clicks Deny in the popout.
   * Resolves the held HTTP response with 403 pair_denied.
   */
  denyPairRequest(requestId) {
    return this._resolvePairRequest(requestId, { denied: true, reason: 'denied' });
  }

  _resolvePairRequest(requestId, decision) {
    const pending = this._pendingPairRequest;
    if (!pending || pending.requestId !== requestId || pending.resolved) return null;
    pending.resolved = true;
    if (pending.timer) clearTimeout(pending.timer);
    this._pendingPairRequest = null;
    const { res, deviceName, devicePlatform, addr } = pending;
    if (decision.approved) {
      const device = this.mintPairedDevice({ deviceName, devicePlatform });
      let fingerprint = '';
      try {
        if (this._tlsCertPem) {
          const x509 = new crypto.X509Certificate(this._tlsCertPem);
          fingerprint = x509.fingerprint256 || '';
        }
      } catch {}
      const payload = {
        deviceToken: device.token,
        deviceId: device.id,
        fingerprint,
        protocolVersion: protocol.PROTOCOL_VERSION,
        serverVersion: this._serverVersion || '',
        tsHost: this._altHosts.tsHost,
        cloudHost: this._altHosts.cloudHost,
      };
      // The held socket is often DEAD by now (iOS retires idle
      // connections faster than a human clicks Approve; flaky LAN
      // bridges drop the long-poll too — K6RBJ 2026-06-12). The write
      // below silently no-ops in that case, which used to ORPHAN the
      // freshly minted credentials. Keep the outcome retrievable for
      // 2 minutes: a same-requestId re-POST of /api/pair-request
      // collects it instead of opening a new request.
      this._storePairResult(requestId, 200, payload);
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch {} // client may have disconnected
      const fpPreview = fingerprint ? fingerprint.slice(0, 16) + '…' : '(no cert)';
      this.emit('log', `[Pair-Request] APPROVED ${deviceName} (${device.id}) from ${addr} fp=${fpPreview}`);
      this.emit('pair-request-resolved', { requestId, approved: true, deviceId: device.id });
      return device;
    } else {
      const reason = decision.reason || 'denied';
      const body = {
        error: 'pair_denied',
        message: reason === 'timeout'
          ? 'The owner didn\'t respond within 60 seconds. Try again or use the QR pairing flow.'
          : 'The owner denied the pair request.',
        reason,
      };
      this._storePairResult(requestId, 403, body);
      try {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      } catch {}
      this.emit('log', `[Pair-Request] DENIED ${deviceName} from ${addr} reason=${reason}`);
      this.emit('pair-request-resolved', { requestId, approved: false, reason });
      return null;
    }
  }

  _storePairResult(requestId, status, body) {
    // Sweep expired entries while we're here — the map only ever holds
    // a handful of rows (one per Approve/Deny in the last 2 minutes).
    const now = Date.now();
    for (const [id, r] of this._recentPairResults) {
      if (now > r.expiresAt) this._recentPairResults.delete(id);
    }
    this._recentPairResults.set(requestId, {
      status, body: JSON.stringify(body), expiresAt: now + 120_000,
    });
  }

  /** Consume (single-use) a recently resolved pair-request outcome. */
  _takeRecentPairResult(requestId) {
    const r = this._recentPairResults.get(requestId);
    if (!r) return null;
    this._recentPairResults.delete(requestId);
    if (Date.now() > r.expiresAt) return null;
    return r;
  }

  /**
   * Update the optional alternate hostnames advertised in auth-ok,
   * QR payloads, and /api/pair* responses. main.js calls this:
   *   - on startup once the Tailscale + Cloud-Tunnel state is known,
   *   - whenever cloud-tunnel emits 'change',
   *   - on the periodic tailscaleStatus() refresh.
   *
   * Idempotent: a call with the same shape doesn't broadcast. When
   * the values change AND a client is connected, pushes a typed
   * 'alt-hosts' message so already-connected phones pick up the new
   * fallback host without reconnecting.
   */
  setAltHosts({ tsHost, cloudHost } = {}) {
    const next = {
      tsHost: String(tsHost || ''),
      cloudHost: String(cloudHost || ''),
    };
    if (next.tsHost === this._altHosts.tsHost && next.cloudHost === this._altHosts.cloudHost) {
      return;
    }
    this._altHosts = next;
    if (this._client && this._client.readyState === WebSocket.OPEN && this._client._authenticated) {
      this._sendTo(this._client, { type: 'alt-hosts', tsHost: next.tsHost, cloudHost: next.cloudHost });
    }
  }

  getAltHosts() {
    return { tsHost: this._altHosts.tsHost, cloudHost: this._altHosts.cloudHost };
  }


  /**
   * Mark whether POTACAT Cloud Tunnel is currently publishing this
   * server on the public internet. When true, the LAN-only auto-auth
   * policy is disabled and every new WS connection must present either
   * a paired-device token (minted via /api/pair) or a valid Guest Pass
   * code before being treated as authenticated. The auth message
   * handler at the bottom of _handleMessage already accepts both
   * credentials — this flag only affects the gate in _handleConnection.
   *
   * Idempotent. Currently-connected clients are NOT kicked on a
   * false→true transition (they authenticated under the prior policy
   * and are presumed to be on the local LAN); restart the ECHOCAT
   * server to force a fleet-wide re-auth. A warning is logged so the
   * operator can see the policy change in the log pane.
   *
   * Called by main.js from the cloudTunnel 'change' event and from
   * the post-start sync after connectRemote().
   */
  setTunnelExposed(exposed) {
    const next = !!exposed;
    if (next === this._tunnelExposed) return;
    this._tunnelExposed = next;
    if (next) {
      this.emit('log', '[remote] Cloud Tunnel is now exposing this server publicly — new connections require paired-device or Guest Pass auth.');
      if (this._client && !this._client._pairedDevice) {
        this.emit('log', '[remote] WARN: a client is currently connected under the prior local-trust policy. It remains connected for this session; restart ECHOCAT to force re-auth.');
      }
    } else {
      this.emit('log', '[remote] Cloud Tunnel disabled — auth policy reverts to the configured requireToken setting.');
    }
  }

  start(port, token, opts = {}) {
    this._port = port || 7300;
    this._token = token;
    this._requireToken = opts.requireToken === true; // default false — match UI checkbox
    // Caller (main.js) reads the current cloud-tunnel state and passes
    // it in here so the flag is set BEFORE the listener accepts any
    // connections. Runtime toggles go through setTunnelExposed().
    this._tunnelExposed = opts.tunnelExposed === true;
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

    // EADDRINUSE retry loop. Common dev-mode case: a previous Electron
    // process didn't release the port before this one started (force-
    // kill, crash, fast restart, Windows TIME_WAIT). Rather than crash
    // the entire app via an uncaught EventEmitter 'error' throw, back
    // off and try again a few times. If we ultimately can't bind, log
    // it as a soft error and keep the rest of POTACAT running.
    let _attempts = 0;
    const _maxAttempts = 5;
    const _retryDelayMs = 800;
    const _tryListen = () => {
      _attempts++;
      this._httpServer.listen(this._port, '0.0.0.0', () => {
        this.running = true;
        const proto = this._https ? 'https' : 'http';
        this.emit('started', { port: this._port, https: this._https });
        const msg = `Server listening on ${proto}://0.0.0.0:${this._port}` +
          (_attempts > 1 ? ` (after ${_attempts} attempts)` : '');
        console.log(`[Echo CAT] ${msg}`);
        this.emit('log', msg);
      });
    };
    this._httpServer.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && _attempts < _maxAttempts) {
        const msg = `Port ${this._port} busy (attempt ${_attempts}/${_maxAttempts}); retrying in ${_retryDelayMs}ms…`;
        console.warn(`[Echo CAT] ${msg}`);
        this.emit('log', msg);
        // Remove the failed listener and rebuild the socket — Node's
        // http.Server doesn't reuse a server that errored on listen.
        setTimeout(() => {
          try { this._httpServer.close(); } catch {}
          _tryListen();
        }, _retryDelayMs);
        return;
      }
      // Final or non-EADDRINUSE error: log it, surface to main via
      // 'log' (which already wires to the CAT log pane), but do NOT
      // re-emit as 'error' — there's no listener on the main side and
      // EventEmitter would throw uncaughtException, killing POTACAT.
      const failMsg = err && err.code === 'EADDRINUSE'
        ? `ECHOCAT server could not bind to port ${this._port} after ${_maxAttempts} attempts. Another process is holding it — usually a stale POTACAT. Restart your computer or kill the orphan electron.exe and reopen POTACAT.`
        : `Server error: ${err && err.message ? err.message : err}`;
      console.error('[Echo CAT]', failMsg);
      this.emit('log', failMsg);
    });
    _tryListen();

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
        this._recordExpiredToken(tok, exp);
      }
    }
  }

  // Small ring of recently-expired tokens so /api/pair can distinguish
  // "unknown token" (typo, regenerated, wrong QR) from "your token
  // expired N seconds ago, mint a new one". Cap at 16 — the absolute
  // worst case is a flurry of expired-token attempts after a tester
  // walks away for 10 minutes, and we only need a couple. Bounded so
  // an attacker can't flood it.
  _recordExpiredToken(tok, expiredAt) {
    if (!this._recentlyExpired) this._recentlyExpired = [];
    this._recentlyExpired.push({ tok, expiredAt });
    while (this._recentlyExpired.length > 16) this._recentlyExpired.shift();
  }

  _knownPairingToken(tok) {
    if (!tok) return false;
    if (this._pairingTokens.has(tok)) return true;
    if (!this._recentlyExpired) return false;
    return this._recentlyExpired.some(e => e.tok === tok);
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
      // New in v1.9: trust tier fields. Pair-via-token defaults to guest
      // (sliding 180d expiry). The pair-link flow may pass opts.accountLinked
      // (Cloud-attested) or opts.trusted (pre-trusted by operator) to flag the
      // row as no-expiry at redemption time. See docs/remote-desktop-plan.md.
      expiresAt: opts.expiresAt === null ? null
        : (typeof opts.expiresAt === 'number' ? opts.expiresAt : Date.now() + DEVICE_TOKEN_SLIDING_TTL_MS),
      accountLinked: !!opts.accountLinked,
      trusted: !!opts.trusted,
    };
    this._pairedDevices.push(device);
    this.emit('paired-devices-changed', this.listPairedDevices());
    return device;
  }

  /**
   * Mint a paired-device record DIRECTLY without going through the
   * QR + pairing-token redemption flow. Used by the tap-to-pair
   * /api/pair-request endpoint after the user clicks Approve on the
   * desktop modal — at that point the operator has already
   * authorized the device via the in-person Approve click, so the
   * pairing-token gate is redundant.
   *
   * Same record shape as redeemPairingToken so paired devices look
   * identical regardless of which flow created them.
   */
  mintPairedDevice(opts = {}) {
    const device = {
      id: crypto.randomBytes(8).toString('hex'),
      name: String(opts.deviceName || 'Unknown device'),
      platform: String(opts.devicePlatform || ''),
      token: crypto.randomBytes(32).toString('hex'),
      addedAt: new Date().toISOString(),
      lastSeen: null,
      // Tap-to-pair via in-person Approve: default is guest tier with
      // sliding 180d expiry. The operator can promote to trusted via the
      // Settings → Remote Access toggle (see setDeviceTrusted). Callers
      // can override at mint time for the cloud-attested path.
      expiresAt: opts.expiresAt === null ? null
        : (typeof opts.expiresAt === 'number' ? opts.expiresAt : Date.now() + DEVICE_TOKEN_SLIDING_TTL_MS),
      accountLinked: !!opts.accountLinked,
      trusted: !!opts.trusted,
    };
    this._pairedDevices.push(device);
    this.emit('paired-devices-changed', this.listPairedDevices());
    return device;
  }

  /**
   * Hydrate the paired-devices list from caller-supplied storage.
   * Called by main.js at startup with `settings.pairedDevices || []`.
   *
   * Backfills the v1.9 trust-tier fields (expiresAt/accountLinked/trusted)
   * on rows that pre-date them. Grandfather rule: any device persisted
   * before these fields existed is treated as `trusted: true, expiresAt:
   * null` so we don't surprise existing users by mass-expiring their
   * phones on upgrade. New pairings get the sliding-expiry default at
   * mint time (see redeemPairingToken / mintPairedDevice).
   */
  setPairedDevices(devices) {
    const list = Array.isArray(devices) ? devices.slice() : [];
    for (const d of list) {
      if (d == null || typeof d !== 'object') continue;
      const hasExpiry = Object.prototype.hasOwnProperty.call(d, 'expiresAt');
      const hasAccount = Object.prototype.hasOwnProperty.call(d, 'accountLinked');
      const hasTrusted = Object.prototype.hasOwnProperty.call(d, 'trusted');
      if (!hasExpiry && !hasAccount && !hasTrusted) {
        d.expiresAt = null;
        d.accountLinked = false;
        d.trusted = true;
      } else {
        if (!hasExpiry) d.expiresAt = null;
        if (!hasAccount) d.accountLinked = false;
        if (!hasTrusted) d.trusted = false;
      }
    }
    this._pairedDevices = list;
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
      expiresAt: d.expiresAt == null ? null : d.expiresAt,
      accountLinked: !!d.accountLinked,
      trusted: !!d.trusted,
    }));
  }

  /**
   * Return paired devices including secret tokens. Caller (main.js) uses
   * this to persist to settings.json. Never sent over the wire.
   */
  exportPairedDevices() {
    return this._pairedDevices.slice();
  }

  // ─── Pending pair-link store (persistent share-link tokens) ────────
  //
  // Distinct from _pairingTokens (short-lived in-memory QR tokens).
  // These are user-created via the Share Access dialog, persist across
  // restarts, support 1h / 24h / 7d / 30d TTLs (operator-chosen at
  // creation), and are single-use. The /api/pair handler tries the
  // in-memory store first and falls back to here. See
  // docs/remote-desktop-plan.md for the design rationale.

  /**
   * Hydrate the pending-pair-links list from settings.json. Called by
   * main.js at startup. Drops any rows whose expiresAt is already in
   * the past, since those would have been rejected at redemption
   * anyway — keeping them around would just clutter the Revoke UI.
   */
  setPendingPairLinks(links) {
    const now = Date.now();
    const list = Array.isArray(links) ? links.slice() : [];
    this._pendingPairLinks = list.filter(l => l && typeof l === 'object'
      && typeof l.token === 'string' && l.token.length > 0
      && typeof l.expiresAt === 'number' && l.expiresAt > now);
  }

  /** Settings-persistence accessor; never sent over the wire. */
  exportPendingPairLinks() {
    return this._pendingPairLinks.slice();
  }

  /**
   * UI-safe list for the Share Access "pending links" panel. Includes
   * the full token because the operator may need to re-copy the URL
   * — these never leave the desktop renderer, only the share dialog.
   */
  listPendingPairLinks() {
    return this._pendingPairLinks.map(l => ({
      token: l.token,
      label: l.label || '',
      trust: l.trust || 'guest',
      createdAt: l.createdAt,
      expiresAt: l.expiresAt,
      used: !!l.used,
      usedAt: l.usedAt || null,
      usedByDeviceId: l.usedByDeviceId || null,
    }));
  }

  /**
   * Mint a persistent share-link token. Returns the row (caller will
   * embed `token` into the `potacat://pair?...` URL). Operator-supplied
   * ttlMs is clamped to MIN_PAIR_LINK_TTL_MS .. MAX_PAIR_LINK_TTL_MS
   * (1 minute .. 30 days) — the 30-day cap is intentional and tracks
   * the "guest sharing has a security boundary" rule in the design
   * doc. Owners who want no-expiry should pair their own device
   * normally and toggle "Trusted device" instead.
   */
  createPairLink(opts = {}) {
    const now = Date.now();
    let ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : (24 * 60 * 60 * 1000);
    if (ttlMs < MIN_PAIR_LINK_TTL_MS) ttlMs = MIN_PAIR_LINK_TTL_MS;
    if (ttlMs > MAX_PAIR_LINK_TTL_MS) ttlMs = MAX_PAIR_LINK_TTL_MS;
    const row = {
      token: crypto.randomBytes(32).toString('hex'),
      label: String(opts.label || '').slice(0, 80),
      // 'owned' (default) → the resulting paired-device row gets
      // trusted:true, expiresAt:null. The link itself still has a
      // TTL because the link is a transit credential, but the device
      // it pairs is the operator's own and shouldn't time out.
      // 'guest' → the resulting paired-device row gets the sliding
      // 180-day expiry (default for tap-to-pair). Operator can
      // revoke any time.
      trust: opts.trust === 'guest' ? 'guest' : 'owned',
      createdAt: now,
      expiresAt: now + ttlMs,
      used: false,
      usedAt: null,
      usedByDeviceId: null,
    };
    this._pendingPairLinks.push(row);
    this.emit('pending-pair-links-changed', this.listPendingPairLinks());
    return row;
  }

  /** Operator-initiated revoke from the Share Access UI. */
  revokePairLink(token) {
    const before = this._pendingPairLinks.length;
    this._pendingPairLinks = this._pendingPairLinks.filter(l => l.token !== token);
    const removed = before !== this._pendingPairLinks.length;
    if (removed) this.emit('pending-pair-links-changed', this.listPendingPairLinks());
    return removed;
  }

  /**
   * Internal: called by /api/pair when the in-memory pairing-token
   * store doesn't have the token. Looks up a persistent link, validates
   * it (not expired, not already used), and marks it consumed. Returns
   * the row on success, null otherwise.
   *
   * On consumption we keep the row in _pendingPairLinks but flip
   * `used:true` so the operator's Share Access UI can show "consumed
   * by Casey's iPad on 2026-06-04 at 14:23". The row is reaped on the
   * next setPendingPairLinks hydrate (expired rows drop), or the
   * operator can clear it explicitly via Revoke.
   */
  _consumePendingPairLink(token, opts = {}) {
    const row = this._pendingPairLinks.find(l => l.token === token);
    if (!row) return null;
    if (row.used) return null;
    if (Date.now() > row.expiresAt) return null;
    row.used = true;
    row.usedAt = Date.now();
    row.usedByDeviceId = opts.deviceId || null;
    this.emit('pending-pair-links-changed', this.listPendingPairLinks());
    return row;
  }

  /**
   * Forget a device by id. Returns true if the device was found.
   *
   * Also actively disconnects the device if it is the currently-connected
   * client: token validity is only checked at auth time, so without this
   * an already-authenticated socket would keep full CAT control until it
   * happened to reconnect (Casey's iPhone kept QSYing after Revoke,
   * 2026-06-12). Sends `revoked` then closes with 4004 AUTH_REVOKED —
   * same shape as _displaceCurrentClient, symmetric with
   * broadcastPassEnded for Guest Pass. Clients authenticated via the
   * legacy shared token or a Guest Pass have no _pairedDevice for this
   * id and are left alone.
   */
  revokeDevice(deviceId) {
    const before = this._pairedDevices.length;
    this._pairedDevices = this._pairedDevices.filter(d => d.id !== deviceId);
    const removed = before !== this._pairedDevices.length;
    if (removed) {
      const live = this._client;
      if (live && live._pairedDevice && live._pairedDevice.id === deviceId
          && live.readyState === WebSocket.OPEN) {
        try {
          this._sendTo(live, { type: 'revoked', reason: 'Access revoked by the desktop operator' });
        } catch {}
        if (live._heartbeat) {
          clearInterval(live._heartbeat);
          live._heartbeat = null;
        }
        try { live.close(protocol.CLOSE_CODES.AUTH_REVOKED, 'revoked'); } catch {}
        this._onClientDisconnected();
        this.emit('log', `Revoked device ${deviceId} — live session disconnected (4004)`);
      }
      this.emit('paired-devices-changed', this.listPairedDevices());
    }
    return removed;
  }

  /**
   * Flip the operator-trusted flag on a paired device. Trusted devices
   * are exempt from the sliding 180-day expiry (expiresAt is forced to
   * null), so the operator can mark their own hardware "never expire"
   * without needing a Cloud account. Untrusting reinstates the sliding
   * window starting now. See docs/remote-desktop-plan.md.
   *
   * Returns true if the device was found.
   */
  setDeviceTrusted(deviceId, trusted) {
    const dev = this._pairedDevices.find(d => d.id === deviceId);
    if (!dev) return false;
    const next = !!trusted;
    if (dev.trusted === next) return true;
    dev.trusted = next;
    if (next) {
      dev.expiresAt = null;
    } else if (!dev.accountLinked && dev.expiresAt == null) {
      dev.expiresAt = Date.now() + DEVICE_TOKEN_SLIDING_TTL_MS;
    }
    this.emit('paired-devices-changed', this.listPairedDevices());
    return true;
  }

  /**
   * Rename a paired device. Returns true if the device was found.
   * Emits paired-devices-changed so consumers (Settings summary card,
   * main.js persist hook) pick up the new label.
   */
  renameDevice(deviceId, newName) {
    const name = String(newName || '').trim().slice(0, 60);
    if (!name) return false;
    const dev = this._pairedDevices.find(d => d.id === deviceId);
    if (!dev) return false;
    if (dev.name === name) return true;
    dev.name = name;
    this.emit('paired-devices-changed', this.listPairedDevices());
    return true;
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
    // Idempotent: if a prior publish exists (re-bind after port
    // change, network event hot-reload, etc.) tear it down first
    // so we don't accumulate duplicate Bonjour instances.
    this._stopMdns();

    // Lazy-require so a missing dep doesn't break the rest of the server.
    let Bonjour;
    try { Bonjour = require('bonjour-service').default; }
    catch (err) {
      this.emit('log', `mDNS unavailable (bonjour-service not installed): ${err.message}`);
      return;
    }

    // Build the TXT once — same payload across every interface.
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

    // Publish on EVERY real LAN interface. The previous single
    // `new Bonjour().publish(...)` let multicast-dns pick one
    // interface via the OS's routing metric, which on a Windows
    // box with Hyper-V / WSL / Docker / Tailscale picked a virtual
    // one — the multicast packets went somewhere unreachable from
    // the phone and the iOS app's "FOUND ON YOUR NETWORK" card
    // stayed empty (Casey 2026-06-04). Reuses the existing
    // `getLocalIPs()` filter (which already does name + MAC OUI
    // virtual-adapter detection plus Windows route-table probing
    // via `_isVirtualAdapter` and `_getRoutedAddresses`) so the
    // mDNS filter doesn't drift from the cert SAN filter.
    //
    // Tailscale is deliberately excluded: mDNS-over-tailnet doesn't
    // reach the phone reliably (Tailscale runs its own DNS, not
    // mDNS) AND would shadow the real-LAN path even when both are
    // available. Phones falling through to the tailnet hostname is
    // handled by tsHost in the auth-ok / pair response payloads.
    const targets = RemoteServer.getLocalIPs().filter(x => !x.tailscale);
    if (targets.length === 0) {
      this.emit('log', 'mDNS publish skipped: no real IPv4 interfaces found');
      return;
    }

    this._bonjourInstances = [];
    for (const { name, address } of targets) {
      try {
        // bonjour-service forwards opts to multicast-dns. `interface`
        // steers multicast membership + setMulticastInterface; it ALSO
        // becomes the socket's bind address unless `bind` overrides it
        // (multicast-dns: socket.bind(port, opts.bind || opts.interface)).
        //
        // macOS: bind the WILDCARD, not the interface address. The OS's
        // own mDNSResponder owns 5353, and a specific-address bind can't
        // share it — the async "bind EADDRINUSE 192.168.x.y:5353" that
        // resulted crashed POTACAT at launch with no window and no dialog
        // (v1.8.6/v1.8.7 "won't open on Mac" reports; N3VD's Terminal
        // trace). Wildcard + reuseAddr coexists with mDNSResponder, and
        // `interface` still routes our announcements out this interface.
        const mdnsOpts = { interface: address };
        if (process.platform === 'darwin') mdnsOpts.bind = '0.0.0.0';
        // Async-error hardening, two layers (mDNS is best-effort — it must
        // never take the app down):
        //  1. bonjour-service's error callback — its DEFAULT is
        //     `(err) => { throw err; }`, i.e. an uncaught exception.
        //  2. the multicast-dns emitter's 'error' event — the initial
        //     auto-bind failure is emitted there directly and is NOT
        //     routed through the callback in (1).
        const onMdnsError = (err) => {
          this.emit('log', `mDNS error on ${name} (${address}): ${err && err.message || err} -- disabling mDNS on this interface`);
          try { inst.destroy(); } catch {}
          this._bonjourInstances = (this._bonjourInstances || []).filter(e => e.instance !== inst);
        };
        const inst = new Bonjour(mdnsOpts, onMdnsError);
        try { if (inst.server && inst.server.mdns) inst.server.mdns.on('error', onMdnsError); } catch {}
        const svc = inst.publish({
          name: `POTACAT on ${hostname}`,
          type: 'potacat',
          protocol: 'tcp',
          port: this._port,
          txt,
        });
        try { if (svc && typeof svc.on === 'function') svc.on('error', onMdnsError); } catch {}
        this._bonjourInstances.push({ instance: inst, service: svc, name, address });
        this.emit('log', `mDNS published on ${name} (${address}): _potacat._tcp port ${this._port} fp=${fingerprint.slice(0, 24)}...`);
      } catch (err) {
        this.emit('log', `mDNS publish failed on ${name} (${address}): ${err.message}`);
      }
    }
    // TODO: republish on interface hot-plug (user plugs Ethernet
    // after POTACAT is running, switches WiFi networks). Could
    // piggyback on the 10-min _refreshAltHosts tick in main.js by
    // diffing the current targets list against what's published.
  }

  _stopMdns() {
    try {
      if (this._bonjourInstances && this._bonjourInstances.length > 0) {
        for (const entry of this._bonjourInstances) {
          try { if (entry.service) entry.service.stop(() => {}); } catch {}
          try { if (entry.instance) entry.instance.destroy(); } catch {}
        }
        this._bonjourInstances = [];
      }
      // Legacy single-instance teardown — preserved for any code
      // path that still set the pre-multi-publish fields.
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

    // POTACAT Cloud Tunnel HTTP gate. When this server is being
    // published on the public internet via <callsign>.potacat.com,
    // every HTTP route except the explicit whitelist below is closed
    // behind a generic stub. Without this, an unauthenticated visitor
    // — or a scanner — could harvest the app version baked into the
    // renderer, the operator's callsign baked into the UI defaults,
    // the renderer JS source, and confirmation that the various API
    // endpoints exist on this hostname.
    //
    // Whitelist:
    //   - /health: low-info; the operator uses it for their own
    //     connectivity diagnostics.
    //   - /api/pair (POST): the mobile-app pairing redemption
    //     endpoint. Already token-protected (single-use 32-byte hex
    //     pairing token, 5-minute TTL, 4 KiB body cap, returns 401 on
    //     invalid/expired). Stubbing it broke pairing over the tunnel
    //     entirely — AB9AI reported 503 on /api/pair 2026-06-02 — so
    //     it has to flow through to the handler below. NOT a public
    //     route: an attacker without a valid pairingToken from the
    //     desktop's QR gets 401, same as before the gate existed.
    //
    // /api/ptt/* deliberately stays gated. It's an unauthenticated
    // local-trust shortcut for iOS Shortcuts / Stream Deck on the LAN
    // and must not be reachable over the tunnel.
    //
    // WS upgrades go through a separate handler attached to `_wss`
    // (see `this._wss.on('connection', ...)` in start()) and are
    // gated by the auth-mode flow in _handleConnection, so the
    // paired iPhone's WSS traffic is unaffected.
    // K3SBP 2026-06-02.
    //   - /api/pair-request (POST): tap-to-pair. Without this entry
    //     the catch-all below 503s the request before the handler
    //     ever runs (pair-request-tunnel-exposed-503-shadow). The
    //     handler enforces the real policy itself: typed 403 for
    //     non-private-LAN sources, LAN sources allowed (2026-06-05
    //     refinement). KE4EST hit the shadow 2026-06-12 with a zombie
    //     tunnel — cloudflared dead (DNS resolver down) but
    //     _tunnelExposed still true — so every LAN tap-to-pair
    //     bounced on the generic 503 and the Approve modal never
    //     appeared.
    const tunnelOpenPaths = (pathname === '/health')
      || (pathname === '/api/pair' && req.method === 'POST')
      || (pathname === '/api/pair-account' && req.method === 'POST')
      || (pathname === '/api/pair-request' && req.method === 'POST');
    // The stub is for PUBLIC visitors only (people who reached
    // <callsign>.potacat.com over the Cloud Tunnel). LAN and Tailscale
    // users must get the real ECHOCAT web UI even with the tunnel on —
    // that's the free, no-app, no-subscription path. Gating on
    // _tunnelExposed alone stubbed everyone (regression 2026-06-13);
    // now we only stub requests that actually came via the tunnel /
    // a public source. See _isTunnelOrPublicRequest.
    const fromTunnel = RemoteServer._isTunnelOrPublicRequest(
      req.headers, req.socket && req.socket.remoteAddress);
    if (this._tunnelExposed && fromTunnel && !tunnelOpenPaths) {
      res.writeHead(503, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      res.end(this._buildTunnelStubHtml());
      return;
    }

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
    // /api/pair-account — Cloud-attested pair redemption (v1.9 Path 1).
    //
    // Called by a signed-in laptop that has just obtained a pairToken
    // from POTACAT Cloud. Verifies the token by emitting a
    // 'verify-pair-token' event that main.js handles (because the
    // shack-side cloud bearer JWT lives in main.js's CloudSyncClient,
    // not in RemoteServer). On success, mints a deviceToken flagged
    // accountLinked:true, expiresAt:null and returns the standard
    // PairResponse shape. The same hosts/fingerprint are returned so
    // the laptop can stash them for reconnect.
    if (pathname === '/api/pair-account' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        const fromIp = req.socket?.remoteAddress || 'unknown';
        let payload;
        try { payload = JSON.parse(body); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          this.emit('log', `[Pair-Account] REJECTED from ${fromIp}: invalid JSON (${body.length}B)`);
          return;
        }
        const pairToken = String(payload.pairToken || '');
        const shackDeviceId = String(payload.shackDeviceId || '');
        if (!pairToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pairToken required' }));
          return;
        }
        // Hand off to main.js for cloud verification — main owns the
        // CloudSyncClient bearer token. We listen for the response
        // event and respond accordingly. The verification IS the
        // attestation: if main confirms it, we trust the token.
        let verifyResult;
        try {
          verifyResult = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('verify timeout')), 8000);
            const handler = (r) => {
              if (!r || r.pairToken !== pairToken) return;
              clearTimeout(t);
              this.off('verify-pair-token-result', handler);
              resolve(r);
            };
            this.on('verify-pair-token-result', handler);
            this.emit('verify-pair-token', { pairToken, shackDeviceId, fromIp });
          });
        } catch (err) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'verify failed: ' + (err.message || err) }));
          this.emit('log', `[Pair-Account] REJECTED from ${fromIp}: ${err.message || err}`);
          return;
        }
        if (!verifyResult.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: verifyResult.error || 'verify rejected' }));
          this.emit('log', `[Pair-Account] REJECTED from ${fromIp}: ${verifyResult.error}`);
          return;
        }
        // Mint a paired-device row with account-linked tier (no expiry).
        const device = this.mintPairedDevice({
          deviceName: payload.deviceName || 'POTACAT Desktop',
          devicePlatform: payload.devicePlatform || 'desktop',
          accountLinked: true,
          expiresAt: null,
        });
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
          tsHost: this._altHosts.tsHost,
          cloudHost: this._altHosts.cloudHost,
          accountLinked: true,
        }));
        this.emit('log', `[Pair-Account] OK ${device.name} (${device.id}) from ${fromIp} via cloud attestation`);
      });
      return;
    }

    if (pathname === '/api/pair' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        // 4 KiB cap — pairing payloads are tiny.
        if (body.length > 4096) { req.destroy(); }
      });
      req.on('end', () => {
        // Source IP for the log line. Useful when a tester says "I
        // tried to pair and nothing showed up" — at least we know if
        // the request reached us at all and from where.
        const fromIp = req.socket?.remoteAddress || 'unknown';
        let payload;
        try { payload = JSON.parse(body); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          this.emit('log', `[Pair] REJECTED from ${fromIp}: invalid JSON body (${body.length}B)`);
          return;
        }
        const pairingToken = String(payload.pairingToken || '');
        const tokenPreview = pairingToken ? pairingToken.slice(0, 8) + '…' : '(empty)';
        let device = this.redeemPairingToken(pairingToken, {
          deviceName: payload.deviceName,
          devicePlatform: payload.devicePlatform,
        });
        if (!device && pairingToken) {
          // Fall back to the persistent share-link store. These are the
          // emailed / messaged links generated via createPairLink(); they
          // share the /api/pair endpoint with the in-person QR flow so
          // mobile + desktop clients use one redemption code path. v1.9.
          const link = this._consumePendingPairLink(pairingToken);
          if (link) {
            // Propagate the link's trust tier into the minted device.
            // 'owned' links produce no-expiry trusted device rows (the
            // operator paired their own laptop); 'guest' links produce
            // the standard sliding-180d row (revoke any time). This is
            // the link the dialog's "Who's this for?" radio drives.
            const isOwned = link.trust === 'owned';
            device = this.mintPairedDevice({
              deviceName: payload.deviceName,
              devicePlatform: payload.devicePlatform,
              trusted: isOwned,
              expiresAt: isOwned ? null : undefined,
            });
            // Stamp the link with the device it minted so the Share
            // Access UI can show "consumed by Casey's iPad".
            link.usedByDeviceId = device.id;
            this.emit('pending-pair-links-changed', this.listPendingPairLinks());
            this.emit('log',
              `[Pair] OK via ${isOwned ? 'owned' : 'guest'} share link from ${fromIp}: ` +
              `${device.name} (${device.id}) token=${tokenPreview} label="${link.label || ''}"`);
          }
        }
        if (!device) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pairing token invalid or expired' }));
          // Distinguish "no token" / "wrong token" / "expired" so the
          // operator can tell whether the tester is typing the wrong
          // value vs. taking >5 min between QR display and entry.
          const tokenKnown = this._knownPairingToken(pairingToken);
          const reason = !pairingToken ? 'empty token'
            : !tokenKnown ? 'unknown token (typo, regenerated, expired, or consumed share link)'
            : 'token expired (>5 min since QR generation)';
          this.emit('log',
            `[Pair] REJECTED from ${fromIp}: ${reason}. token=${tokenPreview} ` +
            `platform=${payload.devicePlatform || '?'} name=${payload.deviceName || '?'}`);
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
          // Alternate hostnames so the phone can fall back when the
          // primary host stops resolving (LAN IP after they leave
          // home, etc.). Empty strings when not configured. Same
          // cert pin covers all three URLs since they all terminate
          // at this process.
          tsHost: this._altHosts.tsHost,
          cloudHost: this._altHosts.cloudHost,
        }));
        const fpPreview = fingerprint ? fingerprint.slice(0, 16) + '…' : '(no cert)';
        this.emit('log',
          `[Pair] OK ${device.name} (${device.id}) from ${fromIp} ` +
          `token=${tokenPreview} fp=${fpPreview}`);
      });
      return;
    }

    // Tap-to-pair: phone-initiated, owner-approved (Part A of
    // tap-to-pair + tsHost handoff). Mobile POSTs deviceName +
    // devicePlatform + requestId; desktop pops an Approve/Deny
    // modal. Held HTTP response resolves with the PairResponse
    // shape on Approve, 403 pair_denied on Deny / timeout, 503
    // pair_request_busy when another request is mid-flight.
    //
    // Tunnel-exposed mode refuses outright — modal-spam from a
    // stranger on the public internet is a denial-of-service /
    // social-engineering vector. Owner uses the QR + /api/pair
    // (already tunnel-whitelisted in v1.8.2) when remote.
    //
    // Returns 200 {deviceToken, deviceId, fingerprint, protocolVersion,
    // serverVersion, tsHost, cloudHost} on success, mirroring the
    // /api/pair shape so mobile's exchangePairingToken handler can
    // reuse the same decoder.
    if (pathname === '/api/pair-request' && req.method === 'POST') {
      const fromIp = req.socket?.remoteAddress || 'unknown';
      // Tunnel-exposed gate, refined 2026-06-12 (K3SBP): only block sources
      // that could have arrived THROUGH the tunnel. cloudflared proxies all
      // tunnel traffic to us from loopback, so a genuine RFC1918 source can
      // only be a same-LAN device — let the home tap-to-pair flow work even
      // while the station is publicly exposed. The 60s human Approve on the
      // desktop remains the trust gate. (Previously ANY tunnel exposure
      // blocked tap-to-pair outright, which silently broke pairing at home
      // for everyone who runs the tunnel 24/7.)
      if (this._tunnelExposed && !RemoteServer._isPrivateLanAddress(fromIp)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'pair_request_tunnel_blocked', message: 'Tap-to-pair only works from your home network. This station is exposed via POTACAT Cloud Tunnel — scan the pairing QR instead.' }));
        this.emit('log', `[Pair-Request] REJECTED from ${fromIp}: tunnel exposed and source is not a private LAN address`);
        return;
      }
      if (!this._allowPairRequests) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'pair_requests_disabled', message: 'The owner has disabled tap-to-pair on this station. Open the pairing QR on the desktop and scan it instead.' }));
        this.emit('log', `[Pair-Request] REJECTED from ${fromIp}: disabled by owner`);
        return;
      }
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 4096) { req.destroy(); }
      });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_json' }));
          this.emit('log', `[Pair-Request] REJECTED from ${fromIp}: invalid JSON body`);
          return;
        }
        const deviceName = String(payload.deviceName || '').slice(0, 60).trim() || 'Unknown device';
        const devicePlatform = String(payload.devicePlatform || '').slice(0, 20).trim();
        const requestId = String(payload.requestId || '').slice(0, 64).trim() ||
          crypto.randomBytes(8).toString('hex');
        // Retry handling, in two layers (the busy check used to run
        // before the body was even read, so a retry of the SAME
        // request could only ever see pair_request_busy):
        //  1. Already resolved → the phone's long-poll died before our
        //     Approve/Deny write landed (iOS idle-socket retirement,
        //     flaky bridges — K6RBJ). Hand the stored outcome straight
        //     back; without this the minted credentials were orphaned.
        const stored = this._takeRecentPairResult(requestId);
        if (stored) {
          res.writeHead(stored.status, { 'Content-Type': 'application/json' });
          res.end(stored.body);
          this.emit('log', `[Pair-Request] retry from ${fromIp} collected stored result for ${requestId.slice(0, 12)}… (HTTP ${stored.status})`);
          return;
        }
        //  2. Still pending → re-attach this fresh socket to the held
        //     request (popout stays up, 60s window unchanged) so the
        //     outcome has a live socket to land on.
        const pendingNow = this._pendingPairRequest;
        if (pendingNow && !pendingNow.resolved && pendingNow.requestId === requestId) {
          try { pendingNow.res.destroy(); } catch { /* old socket likely dead already */ }
          pendingNow.res = res;
          pendingNow.req = req;
          pendingNow.socketClosed = false;
          req.on('close', () => {
            if (this._pendingPairRequest === pendingNow && !pendingNow.resolved) {
              pendingNow.socketClosed = true;
              this.emit('log', `[Pair-Request] retry socket closed by client (popout stays open): ${pendingNow.deviceName}`);
            }
          });
          this.emit('log', `[Pair-Request] retry from ${fromIp} re-attached to pending ${requestId.slice(0, 12)}…`);
          return;
        }
        if (pendingNow) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pair_request_busy', message: 'Another pair request is already pending approval. Try again in a minute.' }));
          this.emit('log', `[Pair-Request] REJECTED from ${fromIp}: busy`);
          return;
        }
        // 60-second long-poll. Cleared by Approve/Deny calls below
        // or by the timeout fallback.
        const expiresAt = Date.now() + 60_000;
        const pending = {
          res, req, deviceName, devicePlatform, requestId, expiresAt, addr: fromIp,
          resolved: false,
        };
        this._pendingPairRequest = pending;
        // Idle timeout = auto-deny. Cleared by resolve().
        const timer = setTimeout(() => this._resolvePairRequest(requestId, { denied: true, reason: 'timeout' }), 60_000);
        pending.timer = timer;
        // Tell main.js to surface the Approve/Deny popout. main.js
        // listens for 'pair-request' and routes to the popout
        // BrowserWindow.
        this.emit('pair-request', { requestId, deviceName, devicePlatform, addr: fromIp, expiresAt });
        this.emit('log', `[Pair-Request] PENDING from ${fromIp}: ${deviceName} (${devicePlatform || 'unknown platform'})`);
        // Note: previously req.on('close') here cleared the 60-s
        // timer and emitted 'pair-request-cancelled', which closed
        // the popout within ~3-5 s of phone-socket teardown. iOS's
        // URLSession retires sockets aggressively (default
        // timeoutIntervalForRequest is short and the connection
        // pool drops idle requests faster than the operator can
        // click), so the popout vanished before the operator could
        // approve (Casey 2026-06-04).
        //
        // The popout + timer now live for the full 60 s regardless
        // of phone-socket state. If the operator approves after the
        // socket is dead, we still mint the device record (the
        // res.writeHead inside _resolvePairRequest is try/catch-
        // wrapped, so the write silently no-ops on a dead socket)
        // and the phone picks up the new credentials on its retry.
        // If the operator denies or the 60-s window lapses, same
        // path — try/catch on the response, the pending state
        // clears either way.
        //
        // Side effect: a concurrent pair request from a different
        // device while the original popout is alive gets
        // pair_request_busy until the operator acts on the first.
        // That's the intended concurrency model.
        req.on('close', () => {
          if (this._pendingPairRequest === pending && !pending.resolved) {
            pending.socketClosed = true;
            this.emit('log', `[Pair-Request] socket closed by client (popout stays open for operator): ${deviceName}`);
          }
        });
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
        // Rebuild on every request during development — ensures latest code.
        // Pass the per-request tunnel/public signal so the injected
        // __authMode matches what the WS layer will actually demand
        // (see _buildInlinedHtml + _handleConnection). LAN/Tailscale
        // requests (fromTunnel=false) auto-auth; tunnel/public requests
        // get the token screen.
        this._cachedInlinedHtml = this._buildInlinedHtml(fromTunnel);
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
  // Cloud Tunnel "service unavailable" stub. Served for every HTTP
  // route except /health when _tunnelExposed is true. Deliberately
  // contains no version, callsign, app-shell paths, GitHub link, or
  // anything else that would help an unauthenticated visitor (or
  // an indexing crawler) enumerate the install. Static — no template
  // inputs, no string concatenation, no risk of HTML injection.
  _buildTunnelStubHtml() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>POTACAT ECHOCAT</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font-family:'IBM Plex Mono','Menlo','Consolas',monospace;background:#0a0e1a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;padding:1.5rem;line-height:1.6;-webkit-font-smoothing:antialiased}
main{max-width:420px;text-align:center}
h1{font-family:'Fira Code','Menlo','Consolas',monospace;font-size:.9rem;letter-spacing:.15em;color:#34d399;font-weight:600;margin-bottom:1.25rem}
p{font-size:.85rem;color:#94a3b8;margin-bottom:.75rem}
.brand{margin-top:2.5rem;font-size:.7rem;color:#64748b;letter-spacing:.05em}
</style>
</head>
<body>
<main>
<h1>POTACAT</h1>
<p>This endpoint accepts connections from paired ECHOCAT and POTACAT devices only. On your shack computer, open Settings &rarr; ECHOCAT to pair a device or share a Guest Pass.</p>
<p class="brand">potacat.com</p>
</main>
</body>
</html>
`;
  }

  _buildInlinedHtml(fromTunnel = false) {
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

    // Inject auth mode so the connect screen can be pre-hidden. This
    // MUST agree with the WS `auth-mode` message computed in
    // _handleConnection — otherwise the renderer pre-hides the connect
    // screen for one mode while the wire demands the other, leaving a
    // dead main-UI shell with no spots/freq and no reachable token
    // entry (regression 2026-06-13: tunnel ON + no token → injected
    // 'none' but WS sent 'token'). Tunnel exposure only forces token
    // auth for connections that actually arrived via the tunnel / a
    // public source; LAN/Tailscale callers still auto-auth (the free
    // web path). See _isTunnelOrPublicRequest.
    const requiresAuth = this._requireToken || (this._tunnelExposed && fromTunnel);
    const authMode = requiresAuth ? 'token' : 'none';

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

    // Note: we no longer kick the existing client here at TCP-open
    // time. The new socket hasn't proven anything yet — could be a
    // port scan, a TLS failure, or an unauthenticated peer. Worse,
    // we'd have nothing useful to put in the kicked payload because
    // the hello hasn't arrived yet. Kick has been deferred to
    // _displaceCurrentClient() which fires from inside the auth-ok
    // path, where we know the new client is real and have full
    // platform/version info to send to the displaced device.
    // K3SBP 2026-05-30: this also fixes the iPhone-vs-iPad ping-pong
    // where each device was getting kicked the instant the other
    // opened a TCP socket, even before auth.

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
    ws._clientCapabilities = [];

    // Send our `hello` first. Legacy browser clients ignore unknown
    // message types so this is safe to send unconditionally.
    this._sendTo(ws, protocol.buildServerHello({
      serverVersion: this._serverVersion || '',
      capabilities: [], // reserved for future runtime feature negotiation
      rigModel: this._rigModel || '',
    }));

    // Tell the phone which auth mode to show. Cloud Tunnel exposure
    // forces token auth on the wire even if the operator has not
    // configured the legacy single-shared token, because the public
    // <callsign>.potacat.com hostname is enumerable and ham callsigns
    // are FCC-public — without this gate any DNS-savvy attacker could
    // hit the tunnel and auto-auth into a live rig. Paired-device
    // tokens (per-device, minted via /api/pair) and Guest Pass codes
    // are the accepted credentials in that mode; both are already
    // handled by the auth-message branch below. K3SBP 2026-06-02.
    // Tunnel exposure forces token auth only for connections that
    // actually arrived via the tunnel / a public source (cf-ray /
    // cf-connecting-ip or a public IPv4). A LAN/Tailscale caller is
    // never reachable by the DNS-savvy attacker the comment above
    // warns about, so it keeps the historical local-trust auto-auth —
    // this is the free, no-app web path. The HTTP layer already gates
    // the same way (the 503 stub + injected __authMode), so all three
    // now agree: HTTP stub, injected authMode, and WS authMode.
    const fromTunnel = RemoteServer._isTunnelOrPublicRequest(
      req.headers, req.socket && req.socket.remoteAddress);
    const requiresAuth = this._requireToken || (this._tunnelExposed && fromTunnel);
    const authMode = requiresAuth ? 'token' : 'none';
    this._sendTo(ws, { type: 'auth-mode', mode: authMode });

    // If no auth is required (LAN-only deployment, no token, no
    // public tunnel), auto-authenticate immediately. This
    // preserves the historical local-trust policy for operators who
    // run the server only on the LAN or via Tailscale.
    if (!requiresAuth) {
      ws._authenticated = true;
      this._displaceCurrentClient(ws, req);
      this._client = ws;
      this._sendTo(ws, { type: 'auth-ok', colorblindMode: !!this._colorblindMode, settings: this._remoteSettings, cwAvailable: this._cwEnabled, cwPaddleAvailable: this._cwPaddleAvailable, vfoLocked: !!this._vfoLocked, tsHost: this._altHosts.tsHost, cloudHost: this._altHosts.cloudHost, stationCallsign: (this._remoteSettings && this._remoteSettings.myCallsign ? String(this._remoteSettings.myCallsign).toUpperCase() : null) });
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
      // Always send the today-only summary, even when the full
      // worked-qsos push got capped. Powers the row-dim in ECHOCAT
      // web + iOS.
      this._sendWorkedToday(ws);
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

    // Auth timeout: any connection that did not auto-authenticate
    // above must present a valid credential within 10 seconds.
    // Previously this timer was armed only when requireToken was
    // true, which meant tunnel-exposed connections could sit open
    // forever consuming a slot. Now it fires whenever auto-auth
    // didn't happen, regardless of which secure mode is responsible.
    const authTimer = ws._authenticated ? null : setTimeout(() => {
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
      // Treat any inbound app-level message as liveness. K3SBP
      // 2026-05-30: iOS 26.5's URLSessionWebSocketTask appears to
      // not auto-respond to RFC 6455 PING control frames in some
      // configurations, so the WS-protocol pong listener below was
      // missing every heartbeat and the server was terminating
      // healthy clients at ~60s. The phone sends a JSON ping every
      // 2s; that's plenty of liveness signal without needing the
      // protocol-level handshake to work.
      ws._isAlive = true;
      ws._missedPings = 0;
      this._handleMessage(ws, msg, req);
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
      if (ws._passSession && !this.hasActivePassClient()) {
        // Last pass-authed client just dropped. main.js starts the
        // enforcement grace timer off this (cancelled if the guest
        // re-auths in time). The closing ws is already non-OPEN here,
        // so hasActivePassClient only sees OTHER live pass clients —
        // a same-guest reconnect that displaced this socket doesn't
        // trigger a false disconnect.
        this.emit('pass-client-disconnected', { code: ws._passSession.code });
      }
    });

    ws.on('error', (err) => {
      console.error('[Echo CAT] WebSocket error:', err.message);
      this.emit('log', `WS error: ${err.message}`);
    });
  }

  _handleMessage(ws, msg, req) {
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
      // Capability advertisement (Architecture B, v1.9). Stored on
      // the ws so the saveQsoRecord guard in main.js can check
      // whether to forward an auto-logged QSO (qso-attributed) or
      // surface log-error. Old clients that don't advertise end up
      // with an empty array — the hard-rule path kicks in for them.
      ws._clientCapabilities = Array.isArray(msg.capabilities) ? msg.capabilities.slice() : [];
      this.emit('log', `Client hello: protocol=${ws._protocolVersion} platform=${ws._clientPlatform} version=${ws._clientVersion} caps=${JSON.stringify(ws._clientCapabilities)}`);
      return;
    }

    // Auth
    if (msg.type === 'auth') {
      // Already authenticated (e.g. token not required) — but still
      // stamp the paired device's lastSeen if the client sent a
      // recognized token. The "no token required" mode auto-auths
      // every connection in _handleConnection before we ever see a
      // msg.token, so device identity for the Settings → Paired
      // Devices list has to land here on a best-effort basis. The
      // mobile client (EchocatClient) sends its device token on auth
      // mode='none' specifically for this. Casey 2026-06-02 hit
      // "never connected" on his iPhone for exactly this reason.
      if (ws._authenticated) {
        if (msg.token) {
          const matched = this._findDeviceByToken(msg.token);
          if (matched) {
            matched.lastSeen = new Date().toISOString();
            ws._pairedDevice = matched;
            this.emit('paired-devices-changed', this.listPairedDevices());
          }
        }
        return;
      }

      let authenticated = false;

      // Diagnostic: surface which credential the client presented so a failed
      // auth is debuggable from the log (e.g. a Guest Pass holder that sent a
      // stale device token instead of {passCode, sessionId}). K3SBP 2026-06-11.
      const _sid = msg.sessionId || msg.sessionToken;
      this.emit('log', `Auth attempt: hasToken=${!!msg.token} hasPassCode=${!!msg.passCode} hasSessionId=${!!_sid} mode=${msg.mode || '-'} passValidator=${!!this._passValidator}`);

      if (msg.token && this._token && msg.token.toUpperCase() === this._token.toUpperCase()) {
        // Token mode (legacy single shared token)
        authenticated = true;
      } else if (msg.token) {
        // Per-device token from a paired mobile app. Match against the
        // long-lived token minted during /api/pair.
        const device = this._findDeviceByToken(msg.token);
        if (device) {
          // v1.9: trust-tier expiry check. Guest devices have a sliding
          // 180-day expiresAt; trusted and account-linked devices have
          // expiresAt:null and never expire. Refuse with reason:'expired'
          // so the client can route to the re-pair UI instead of guessing
          // it was a bad token. Sliding refresh happens on the lastSeen
          // stamp below — only for non-trusted/non-accountLinked rows so
          // those stay pinned at null.
          if (device.expiresAt != null && Date.now() > device.expiresAt) {
            this._sendTo(ws, { type: 'auth-fail', reason: 'expired' });
            this.emit('log', `Auth refused: device ${device.id} (${device.name}) token expired ${new Date(device.expiresAt).toISOString()}`);
            return;
          }
          if (!device.trusted && !device.accountLinked) {
            device.expiresAt = Date.now() + DEVICE_TOKEN_SLIDING_TTL_MS;
          }
          authenticated = true;
        }
      } else if (msg.passCode && this._passValidator) {
        // Guest Pass auth (#46a): mobile got the code via cloud /redeem
        // and connects to our cloud_host tunnel using { mode: 'pass',
        // passCode, sessionId }. Validation + PassEnforcement load
        // happen asynchronously — fork to a helper that responds with
        // auth-ok or auth-fail when done.
        this._authenticatePass(ws, msg, req);
        return;
      }

      // Defensive lastSeen stamp for paired devices. This runs AFTER
      // the auth chain so any token-bearing successful auth — including
      // the legacy-token branch and any future auth paths — gets the
      // paired-device list updated. Previously the stamp lived inline
      // in the per-device branch only, which meant:
      //   - Legacy-token-shadow case (a desktop with `_token` configured
      //     happens to share its value with a paired device's token —
      //     possible if the operator copy-pasted between fields) won
      //     the legacy branch first and skipped the stamp, leaving the
      //     UI showing "never connected" for an actively-connected
      //     device.
      //   - Any paired-device entry created on a build that pre-dates
      //     the per-device branch stayed at lastSeen: null indefinitely
      //     even on successful subsequent auths.
      // Now both cases stamp lastSeen correctly. Backwards-compatible —
      // entries with token-only auth that don't match a paired device
      // (e.g. pure legacy single-token deployments) are no-op.
      if (authenticated && msg.token) {
        const matched = this._findDeviceByToken(msg.token);
        if (matched) {
          matched.lastSeen = new Date().toISOString();
          ws._pairedDevice = matched;
          this.emit('paired-devices-changed', this.listPairedDevices());
        }
      }

      if (authenticated) {
        ws._authenticated = true;
        this._displaceCurrentClient(ws, req);
        this._client = ws;
        const authOk = { type: 'auth-ok', colorblindMode: !!this._colorblindMode, settings: this._remoteSettings, cwAvailable: this._cwEnabled, cwPaddleAvailable: this._cwPaddleAvailable, vfoLocked: !!this._vfoLocked, tsHost: this._altHosts.tsHost, cloudHost: this._altHosts.cloudHost, stationCallsign: (this._remoteSettings && this._remoteSettings.myCallsign ? String(this._remoteSettings.myCallsign).toUpperCase() : null) };
        // Surface trust-tier fields so the client UI can show the right
        // badge in Remote Radios and drive the T-14d re-pair nudge.
        // Absent for legacy single-token auth (no paired-device row).
        if (ws._pairedDevice) {
          authOk.expiresAt = ws._pairedDevice.expiresAt == null ? null : ws._pairedDevice.expiresAt;
          authOk.accountLinked = !!ws._pairedDevice.accountLinked;
          authOk.trusted = !!ws._pairedDevice.trusted;
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
        this._sendWorkedToday(ws);
        // Send cached JTCAT state. Phone reconnecting after iOS app
        // suspend / lock should immediately see whatever the engine
        // was doing instead of waiting for the next live event.
        if (this._jtcatState) this._sendTo(ws, { type: 'jtcat-status', ...this._jtcatState });
        if (this._jtcatQsoState) this._sendTo(ws, { type: 'jtcat-qso-state', ...this._jtcatQsoState });
        if (this._jtcatUltracatState) this._sendTo(ws, { type: 'jtcat-ultracat-state', ...this._jtcatUltracatState });
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
        this.emit('client-connected', { address: ws._socket?.remoteAddress });
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
        // VFO lock
        if (this._vfoLocked) {
          this._sendTo(ws, { type: 'tune-blocked', reason: 'VFO Locked — Unlock VFO to change frequency' });
          break;
        }
        // Suppress freq snap-back: arm match-based suppression so subsequent
        // status broadcasts echo the client's tune target back until the rig
        // confirms it (or the safety timeout expires).
        this._postTuneFreqTarget = Math.round(freqKhz * 1000);
        this._postTuneFreqDeadline = now + 3000;
        this.emit('tune', {
          freqKhz,
          mode: msg.mode,
          bearing: msg.bearing,
        });
        break;
      }

      case 'ptt':
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

  // ── Guest Pass auth (#46a — Phase 2 protocol bridge) ────────────────
  // Mobile got the pass code via cloud /redeem (which validated owner
  // entitlement + opened a pass_sessions row). The phone then connects
  // to wss://<owner>.potacat.com with { mode: 'pass', passCode,
  // sessionId }. Here we re-validate the code against the public
  // GET /v1/passes/:code endpoint (defensive against last-second
  // revoke), trigger PassEnforcement.loadPass() via the injected
  // callback so CAT commands get gated, and authenticate the WS.

  setPassValidator(fn) { this._passValidator = fn; }
  setPassAuthCallback(fn) { this._onPassAuth = fn; }

  /** True when an OPEN, authenticated pass-mode client is attached
   *  (optionally filtered to one pass code). Lets main.js distinguish
   *  a live single-pass conflict (guest currently driving) from a
   *  stale enforcement session with nobody connected. */
  hasActivePassClient(code) {
    if (!this._wss) return false;
    for (const client of this._wss.clients) {
      if (!client._passSession || !client._authenticated) continue;
      if (client.readyState !== WebSocket.OPEN) continue;
      if (code && client._passSession.code !== code) continue;
      return true;
    }
    return false;
  }

  async _authenticatePass(ws, msg, req) {
    if (ws._authenticated) return;
    const addr = ws._socket?.remoteAddress || 'unknown';
    const passCodeMasked = (msg.passCode || '').slice(0, 4) + '****';
    this.emit('log', `Guest Pass auth attempt: code=${passCodeMasked} from=${addr}`);
    try {
      // Phase 3 (cloud mig 009) — the validator now requires the
      // 256-bit session_token returned by /redeem. Passing the raw
      // sessionId through; main.js's validator implementation does
      // the shape-check + the validate-session POST. A missing or
      // pre-009 (integer) sessionId is treated as invalid auth:
      // the validator returns null and we send auth-fail, which
      // prompts the guest's app to re-open the pass link and pick
      // up a fresh high-entropy token via /redeem.
      const profile = await this._passValidator(msg.passCode, msg.sessionId);
      if (!profile || !profile.code) {
        this.emit('log', `Guest Pass DENIED (code not found / expired / revoked / session mismatch): code=${passCodeMasked} from=${addr}`);
        this._sendTo(ws, { type: 'auth-fail', reason: 'Pass not found, expired, revoked, or session not recognized' });
        return;
      }
      if (this._onPassAuth) {
        try { await this._onPassAuth(profile.code, msg.sessionId); }
        catch (err) {
          this.emit('log', `Guest Pass DENIED (PassEnforcement.load failed): code=${profile.code} reason=${err.message || err}`);
          this._sendTo(ws, { type: 'auth-fail', reason: err.message || 'Pass load failed' });
          return;
        }
      }
      ws._passSession = {
        code: profile.code,
        sessionId: msg.sessionId || null,
        ownerCallsign: profile.owner_callsign,
        passProfile: profile,
      };
      ws._authenticated = true;
      this._displaceCurrentClient(ws, req);
      this._client = ws;
      this._sendTo(ws, {
        type: 'auth-ok',
        colorblindMode: !!this._colorblindMode,
        settings: this._remoteSettings,
        cwAvailable: this._cwEnabled,
        cwPaddleAvailable: this._cwPaddleAvailable,
        vfoLocked: !!this._vfoLocked,
        tsHost: this._altHosts.tsHost,
        cloudHost: this._altHosts.cloudHost,
        // Top-level stationCallsign carries the HOST'S call so the
        // guest's RemoteClient can pre-stamp it on forwarded QSOs
        // (Architecture B). Distinct from passSession.stationCallsign
        // below, which is what the pass-issuer typed into the form —
        // those happen to coincide in practice but the semantics
        // differ. The guest's ADIF STATION_CALLSIGN must be the host
        // station's call per §97.119.
        stationCallsign: (this._remoteSettings && this._remoteSettings.myCallsign ? String(this._remoteSettings.myCallsign).toUpperCase() : null),
        passSession: {
          code: profile.code,
          sessionId: msg.sessionId || null,
          ownerCallsign: profile.owner_callsign,
          privilegeClass: profile.privilege_class,
          maxPowerW: profile.max_power_w,
          allowedModes: profile.allowed_modes,
          expiresAt: profile.expires_at,
          stationCallsign: profile.station_callsign,
          operatorCallsign: profile.operator_callsign,
          controlOperatorCallsign: profile.control_operator_callsign,
        },
      });
      if (this._lastSpots.length > 0) this._sendTo(ws, { type: 'spots', data: this._lastSpots });
      this._sendTo(ws, { type: 'status', ...this._radioStatus });
      this.emit('log', `Guest Pass authenticated: code=${profile.code} owner=${profile.owner_callsign} guest-session=${msg.sessionId || 'n/a'} class=${profile.privilege_class} maxW=${profile.max_power_w} from=${addr}`);
      this.emit('client-connected', { address: ws._socket?.remoteAddress, pass: profile.code });
    } catch (err) {
      this.emit('log', `Guest Pass ERROR (validator threw): code=${passCodeMasked} from=${addr} err=${err.message || err}`);
      this._sendTo(ws, { type: 'auth-fail', reason: 'Pass validation failed: ' + (err.message || String(err)) });
    }
  }

  // Called by main.js when PassEnforcement emits 'ended' (expiry,
  // revoke, owner_override). Tells every pass-authed client the session
  // is over so the mobile UI can flip the banner + show PassEndedModal.
  // Connections are NOT force-closed here — mobile decides whether to
  // disconnect or remain on LAN/cloud as a free-tier client (if it has
  // its own pairing).
  broadcastPassEnded(reason) {
    let n = 0;
    for (const client of this._wss.clients) {
      if (client._passSession && client.readyState === WebSocket.OPEN) {
        this._sendTo(client, { type: 'pass-ended', reason, code: client._passSession.code });
        n++;
      }
    }
    if (n > 0) this.emit('log', `Broadcast pass-ended reason=${reason} clients=${n}`);
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

  /**
   * Politely displace the currently-connected client in favor of a
   * newly-authenticated one. Called from inside the auth-ok handler
   * (so we have the new client's hello info to send to the displaced
   * device). Sends `{type:'kicked', reason, byPlatform, byVersion,
   * byHost}` to the old client so it can show a meaningful "another
   * device took over" banner instead of mystery-error reconnecting.
   * K3SBP 2026-05-30.
   */
  _displaceCurrentClient(newWs, newReq) {
    if (!this._client || this._client.readyState !== WebSocket.OPEN) return;
    if (this._client === newWs) return;
    const byHost = (newReq && newReq.socket && newReq.socket.remoteAddress) || '';
    const payload = {
      type: 'kicked',
      reason: 'Another device took over this rig',
      byPlatform: newWs._clientPlatform || '',
      byVersion: newWs._clientVersion || '',
      byHost,
    };
    try { this._sendTo(this._client, payload); } catch {}
    if (this._client._heartbeat) {
      clearInterval(this._client._heartbeat);
      this._client._heartbeat = null;
    }
    try { this._client.close(); } catch {}
    this._onClientDisconnected();
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

  /**
   * Architecture B (v1.9): expose the active client's context so
   * main.js's saveQsoRecord can decide whether to forward an
   * auto-logged QSO (qso-attributed) or surface log-error per the
   * hard rule. Returns null when no authenticated client is
   * connected; otherwise an object with platform + capability + pass
   * session context.
   *
   * The platform string is what the client put in its hello (e.g.
   * 'ios', 'android', 'desktop-darwin', 'desktop-win32'). The
   * capabilities list comes from the same hello. _passSession is
   * set on a successful Guest Pass auth.
   */
  activeClientContext() {
    const c = this._client;
    if (!c || c.readyState !== WebSocket.OPEN || !c._authenticated) return null;
    return {
      platform: c._clientPlatform || '',
      version: c._clientVersion || '',
      capabilities: c._clientCapabilities ? c._clientCapabilities.slice() : [],
      passSession: c._passSession || null,
    };
  }

  /**
   * Architecture B (v1.9): the host couldn't deliver a forwarded
   * QSO to the client (no capability, sendToClient threw, WS
   * dropped). Surface the loss to the operator via a log-error
   * envelope so the client can render the verbose modal — the user
   * is expected to write the QSO down by hand. Casey's hard rule
   * (2026-06-05): never fall back to writing the guest's QSO into
   * the host's own ADIF. See brief-b-additions.md §3 for the
   * client-side modal spec.
   *
   * Returns true if the envelope was queued for send, false if no
   * client is connected (in which case the QSO is fully lost — the
   * operator never sees the modal and only the server log records
   * the drop).
   */
  sendLogError(qso, opts) {
    opts = opts || {};
    if (!this._client || this._client.readyState !== WebSocket.OPEN) {
      console.error('[architecture-b] cannot deliver log-error: client gone',
        { callsign: qso && qso.callsign, reason: opts.reason });
      return false;
    }
    try {
      this._sendTo(this._client, {
        type: 'log-error',
        qso: qso || {},
        reason: opts.reason || 'unknown',
        message: opts.message || '',
      });
      return true;
    } catch (err) {
      console.error('[architecture-b] sendLogError threw:', err);
      return false;
    }
  }

  broadcastRadioStatus(status) {
    this._radioStatus = { ...this._radioStatus, ...status };
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      const out = { type: 'status', ...this._radioStatus };
      // Match-based freq suppression: while armed, replace freq with the
      // client's target until the rig's polled freq confirms (≤25 Hz off)
      // or the safety deadline expires. The rest of the snapshot (mode,
      // smeter, swr, etc.) still flows live regardless.
      if (this._postTuneFreqTarget > 0) {
        const now = Date.now();
        const polled = this._radioStatus.freq;
        if (polled > 0 && Math.abs(polled - this._postTuneFreqTarget) <= 25) {
          // Rig caught up — release; pass the (matching) polled value through.
          this._postTuneFreqTarget = 0;
          this._postTuneFreqDeadline = 0;
        } else if (now >= this._postTuneFreqDeadline) {
          // Hard timeout — let reality through.
          this._postTuneFreqTarget = 0;
          this._postTuneFreqDeadline = 0;
        } else {
          out.freq = this._postTuneFreqTarget;
        }
      }
      this._sendTo(this._client, out);
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
      this._sendTo(this._client, { type: 'rigs', data: rigs, activeRigId });
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
    // Always also push a today-only summary. This one is bounded
    // (typically <500 QSOs/day → a few KB) so it never gets capped,
    // unlike the full worked-qsos payload which is skipped for active
    // loggers above 256 KB. This is what powers the "✓ worked today"
    // dim in ECHOCAT web + iOS spot rows when the full history can't
    // be delivered.
    this._workedTodayCache = null;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendWorkedToday(this._client);
    }
  }

  _buildWorkedTodaySummary() {
    if (this._workedTodayCache) return this._workedTodayCache;
    const today = utcYyyymmdd(Date.now());
    const out = [];
    const entries = this._workedQsos;
    if (entries) {
      // Two possible shapes: Map-like ({ call: [logs] }) or array of
      // log records. Handle both.
      const visit = (call, log) => {
        if (!log) return;
        const date = String(log.date || log.qsoDate || '').replace(/-/g, '');
        if (date !== today) return;
        out.push({
          call: String(call || log.callsign || '').toUpperCase(),
          ref: String(log.ref || log.sigInfo || log.potaRef || log.sotaRef || log.wwffRef || log.llotaRef || '').toUpperCase(),
          band: String(log.band || '').toUpperCase(),
          mode: String(log.mode || '').toUpperCase(),
          date,
        });
      };
      if (Array.isArray(entries)) {
        for (const e of entries) visit(e?.callsign, e);
      } else if (typeof entries === 'object') {
        for (const [call, logs] of Object.entries(entries)) {
          if (Array.isArray(logs)) for (const log of logs) visit(call, log);
        }
      }
    }
    this._workedTodayCache = out;
    return out;
  }

  _sendWorkedToday(ws) {
    const entries = this._buildWorkedTodaySummary();
    this._sendTo(ws, { type: 'worked-today', entries });
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
        this.emit('log', `Skipping worked-qsos auto-push — ${cached.bytes} bytes / ${callCount} calls exceeds ${MAX_BYTES}-byte cap. Phone will not see per-call QSO history.`);
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
    // Mirror the _sendTo diagnostic for this direct-send path. Without
    // this log line, a worked-qsos send sized between the 256 KB cap
    // and any future iOS limit wouldn't appear in the per-message log
    // and we'd miss it when triaging a 1009.
    const now = Date.now();
    if (!ws._connectedAtMs) ws._connectedAtMs = now;
    if (now - ws._connectedAtMs < 2000) {
      this.emit('log', `push msg=worked-qsos bytes=${cached.bytes}`);
    }
    if (cached.bytes > 8 * 1024 * 1024) {
      this.emit('log', `CRITICAL WS payload: msg=worked-qsos bytes=${cached.bytes} (>8MiB) — almost certainly the iOS 1009 trigger`);
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

  // ULTRACAT / Full Auto CQ state — cached so a (re)connecting client learns
  // the current unlock + run state without waiting for the next change.
  broadcastJtcatUltracatState(state) {
    this._jtcatUltracatState = state;
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-ultracat-state', ...state });
  }

  broadcastJtcatStatus(data) {
    this._jtcatState = data;
    // When the engine stops, drop the cached decode buffer so a phone
    // reconnecting later doesn't get stale decodes from a previous run
    // replayed as if fresh. (Field names are inconsistent across callers
    // — `running:false` from teardown, `state:'running'` from start —
    // so treat anything that isn't an explicit running signal as stopped.)
    const running = data && (data.running === true || data.state === 'running');
    if (!running) this._jtcatDecodeBuffer.length = 0;
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-status', ...data });
  }

  broadcastJtcatSpectrum(bins) {
    if (this.hasClient()) this._sendTo(this._client, { type: 'jtcat-spectrum', bins });
  }

  hasClient() {
    return !!(this._client && this._client.readyState === WebSocket.OPEN && this._client._authenticated);
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
    //
    // Routed via emit('log') so it lands in the user-visible CAT log (not
    // just stdout) — Walt's 2026-06-08 follow-up showed his copy/paste of
    // the CAT log had `WS close: code=1009` but no push lines because the
    // earlier `console.log` only surfaced in dev console. emit('log')
    // already prefixes "[Echo CAT] " at main.js:6360, so don't double-add.
    const now = Date.now();
    if (!ws._connectedAtMs) ws._connectedAtMs = now;
    if (now - ws._connectedAtMs < 2000) {
      this.emit('log', `push msg=${type} bytes=${bytes}`);
    }
    // Two-tier warning so the operator can tell "concerning" from "definitely
    // breaking iOS." 256 KB catches runaway settings (sstvTemplates with
    // imported large image, remoteCwMacros that ballooned, coalesced batches
    // that should be chunked). 8 MiB is the critical line — even with iOS
    // build 27's 32 MiB WS receive cap, a single message that close to the
    // ceiling is almost certainly the 1009 culprit (WS frame overhead +
    // base64 encoding can push the wire size another 35% past the JSON
    // length). Both warnings always fire regardless of timing window.
    if (bytes > 8 * 1024 * 1024) {
      this.emit('log', `CRITICAL WS payload: msg=${type} bytes=${bytes} (>8MiB) — almost certainly the iOS 1009 trigger; cap or chunk this message type`);
    } else if (bytes > 256 * 1024) {
      this.emit('log', `LARGE WS payload: msg=${type} bytes=${bytes} — likely 1009 trigger on iOS`);
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
  // Is this socket source address a genuine same-LAN peer (RFC1918)?
  // Used to scope the tap-to-pair tunnel gate: traffic arriving through
  // the Cloud Tunnel always reaches us from LOOPBACK (cloudflared's
  // local proxy), so an internet attacker can never present a private
  // LAN source address. Loopback is deliberately NOT private here for
  // that reason. CGNAT/Tailscale (100.64/10) is excluded too — mDNS
  // discovery doesn't cross the tailnet, so a tap-to-pair from there
  // is not a flow we recognize. K3SBP 2026-06-12.
  static _isPrivateLanAddress(addr) {
    let ip = String(addr || '');
    if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv6-mapped IPv4
    const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false; // IPv6 LAN sources are out of scope for now
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 10) return true;                    // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;      // 192.168/16
    return false;                                  // incl. 127/8, 100.64/10
  }

  /**
   * Did this HTTP request arrive over the Cloud Tunnel (i.e. from the
   * public internet), as opposed to a direct LAN / Tailscale / local
   * connection? Used to gate the public stub: the goal is that ANYONE
   * on the LAN or the tailnet gets the real ECHOCAT web UI, and only
   * public visitors hitting <callsign>.potacat.com get the stub.
   *
   * Primary signal: the Cloudflare edge stamps every proxied request
   * with Cf-Connecting-Ip / Cf-Ray and cloudflared forwards them — a
   * direct connection never carries these. (Before 2026-06-13 the gate
   * fired on `_tunnelExposed` alone, so enabling the Cloud Tunnel ALSO
   * stubbed the plain LAN/Tailscale web URL — the free path for users
   * who don't pay for the app or cloud. Regression report 2026-06-13.)
   *
   * Defense-in-depth: also treat a plainly-public IPv4 source as
   * tunnel/public (covers a manual port-forward the tunnel didn't
   * create). Loopback, RFC1918, Tailscale CGNAT (100.64/10) and
   * link-local sources, and anything non-IPv4 we can't classify, are
   * treated as direct — the web UI still requires the token for any
   * real action, so erring toward serving the shell is safe.
   */
  static _isTunnelOrPublicRequest(headers, remoteAddress) {
    if (headers && (headers['cf-ray'] || headers['cf-connecting-ip'])) return true;
    let ip = String(remoteAddress || '');
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false; // ::1, IPv6 LAN, or unknown — not a clear public source
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a === 127) return false;                        // loopback
    if (a === 10) return false;                         // 10/8
    if (a === 172 && b >= 16 && b <= 31) return false;  // 172.16/12
    if (a === 192 && b === 168) return false;           // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return false; // Tailscale CGNAT 100.64/10
    if (a === 169 && b === 254) return false;           // link-local
    return true;                                         // public IPv4 reaching us directly
  }

  // ranges). Tailscale stays — its 100.x is intentionally routable.
  static _isVirtualAdapter(name, mac) {
    const lname = (name || '').toLowerCase();
    // zerotier/hamachi/wireguard etc.: VPN overlay adapters look like
    // ordinary private IPv4 interfaces and CAN own a default route
    // (ZeroTier "allow default route override" — common in Icom RS-BA1
    // remote setups), so the routed-address backstop doesn't catch
    // them. K6RBJ's QR advertised his ZeroTier IP as "the LAN" and no
    // phone could ever reach it (2026-06-12). Windows names them
    // "ZeroTier One [nwid]" / "Hamachi"; Linux uses zt<hash>.
    if (/vethernet|hyper-?v|wsl|virtualbox|vbox|vmware|vmnet|parallels|docker|zerotier|^zt[a-z0-9]|hamachi|wireguard|wintun|openvpn|nordlynx|^tap|^tun\d/.test(lname)) {
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
