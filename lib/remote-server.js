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
 * Generate a self-signed TLS certificate using pure Node.js crypto.
 * No openssl CLI dependency. Caches cert/key in certDir.
 * Includes all local IPv4 addresses in SAN for Tailscale/LAN access.
 */
function getOrCreateTlsCert(certDir) {
  const certPath = path.join(certDir, 'remote-cert.pem');
  const keyPath = path.join(certDir, 'remote-key.pem');

  // Return cached cert if it exists and is less than 1 year old
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const stat = fs.statSync(certPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 365 * 24 * 60 * 60 * 1000) {
        return {
          cert: fs.readFileSync(certPath, 'utf8'),
          key: fs.readFileSync(keyPath, 'utf8'),
        };
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

    // Collect all local IPv4 addresses for SAN
    const ipAddresses = ['127.0.0.1'];
    try {
      const interfaces = os.networkInterfaces();
      for (const addrs of Object.values(interfaces)) {
        for (const addr of addrs) {
          if (addr.family === 'IPv4' && !addr.internal) {
            ipAddresses.push(addr.address);
          }
        }
      }
    } catch {}

    // Build SAN extension: sequence of GeneralName [7] iPAddress
    const sanEntries = ipAddresses.map(ip => {
      const parts = ip.split('.').map(Number);
      const ipBuf = Buffer.from(parts);
      // iPAddress is context tag [7]
      return Buffer.concat([Buffer.from([0x87, 4]), ipBuf]);
    });
    const sanValue = derSeq(sanEntries);
    // SAN extension OID: 2.5.29.17
    const sanExt = derSeq([
      derOid('551d11'),
      derOctetString(sanValue),
    ]);

    // Basic Constraints: CA=FALSE
    const basicConstraints = derSeq([
      derOid('551d13'),
      Buffer.from([0x01, 0x01, 0xff]), // critical=true
      derOctetString(derSeq([])),
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

    const ipList = ipAddresses.join(', ');
    console.log(`[Echo CAT] Generated self-signed TLS certificate (SAN: ${ipList})`);
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
    this._directoryData = { nets: [], swl: [] };
    // JTCAT state
    this._jtcatState = null;
    this._jtcatQsoState = null;
    this._jtcatDecodeBuffer = [];
    this.running = false;
    // CW Keyer
    this._cwKeyer = null;
    this._cwKeyerOutput = null; // callback: ({ down, timestamp }) => void
    this._cwEnabled = false;
    this._cwWpm = 20;
    this._cwMode = 'iambicB';
    this._cwPaddleWatchdog = null; // safety: force paddle release if keyup lost over WS
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
    this._requireToken = opts.requireToken !== false; // default true
    this._pttSafetyTimeout = opts.pttSafetyTimeout || 180;
    this._https = false;

    // Resolve renderer directory (works in dev and packaged builds)
    this._basePath = opts.rendererPath || path.join(__dirname, '..', 'renderer');

    const handler = (req, res) => this._handleHttpRequest(req, res);

    // Try HTTPS first (required for getUserMedia on mobile browsers)
    const certDir = opts.certDir || path.join(__dirname, '..');
    const tlsCert = getOrCreateTlsCert(certDir);

    if (tlsCert) {
      this._httpServer = https.createServer({ cert: tlsCert.cert, key: tlsCert.key }, handler);
      this._https = true;
    } else {
      this._httpServer = http.createServer(handler);
    }

    this._wss = new WebSocket.Server({ server: this._httpServer });
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
      console.log(`[Echo CAT] Server listening on ${proto}://0.0.0.0:${this._port}`);
    });

    this._httpServer.on('error', (err) => {
      console.error('[Echo CAT] Server error:', err.message);
      this.emit('error', err);
    });

  }

  stop() {
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
      console.log(`[ECHOCAT API] PTT ${action} → ${this._pttActive ? 'TX' : 'RX'}`);
      return;
    }

    // Route / to remote.html — serve a single inlined HTML page
    // so self-signed TLS certs don't block CSS/JS subresource loads
    if (pathname === '/' || pathname === '/remote.html') {
      try {
        if (!this._cachedInlinedHtml) {
          this._cachedInlinedHtml = this._buildInlinedHtml();
        }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
        res.end(this._cachedInlinedHtml);
      } catch (err) {
        res.writeHead(500);
        res.end('Internal Server Error');
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

    // Replace the script tag with inlined JS
    html = html.replace(
      /<script src="remote\.js"><\/script>/,
      () => `<script>\n${js}\n</script>`
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
    }

    return html;
  }

  // --- WebSocket ---

  _handleConnection(ws, req) {
    const addr = req.socket.remoteAddress;
    console.log(`[Echo CAT] New connection from ${addr}`);

    // Kick existing client
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'kicked', reason: 'Another client connected' });
      if (this._client._heartbeat) { clearInterval(this._client._heartbeat); this._client._heartbeat = null; }
      try { this._client.close(); } catch {}
      this._onClientDisconnected();
    }

    ws._authenticated = false;

    // Tell the phone which auth mode to show
    const authMode = this._clubMode ? 'club' : (this._requireToken ? 'token' : 'none');
    this._sendTo(ws, { type: 'auth-mode', mode: authMode });

    // If token is not required (and not club mode), auto-authenticate immediately
    if (!this._requireToken && !this._clubMode) {
      ws._authenticated = true;
      this._client = ws;
      this._sendTo(ws, { type: 'auth-ok', colorblindMode: !!this._colorblindMode, settings: this._remoteSettings, cwAvailable: this._cwEnabled });
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
        this._sendTo(ws, { type: 'worked-qsos', entries: this._workedQsos });
      }
      if (this._directoryData.nets.length || this._directoryData.swl.length) {
        this._sendTo(ws, { type: 'directory', nets: this._directoryData.nets, swl: this._directoryData.swl });
      }
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
      this._handleMessage(ws, msg);
    });

    // Server-side heartbeat: detect zombie connections when phone tab is
    // closed without sending a proper WebSocket close frame.
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });
    ws._heartbeat = setInterval(() => {
      if (!ws._isAlive) {
        console.log('[Echo CAT] Client heartbeat timeout — closing');
        clearInterval(ws._heartbeat);
        ws._heartbeat = null;
        ws.terminate();
        return;
      }
      ws._isAlive = false;
      try { ws.ping(); } catch {}
    }, 15000);

    ws.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
      if (ws._heartbeat) { clearInterval(ws._heartbeat); ws._heartbeat = null; }
      if (ws === this._client) {
        this._onClientDisconnected();
      }
    });

    ws.on('error', (err) => {
      console.error('[Echo CAT] WebSocket error:', err.message);
    });
  }

  _handleMessage(ws, msg) {
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
        // Token mode
        authenticated = true;
      }

      if (authenticated) {
        ws._authenticated = true;
        this._client = ws;
        const authOk = { type: 'auth-ok', colorblindMode: !!this._colorblindMode, settings: this._remoteSettings, cwAvailable: this._cwEnabled };
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
          this._sendTo(ws, { type: 'worked-qsos', entries: this._workedQsos });
        }
        // Send cached JTCAT state
        if (this._jtcatState) this._sendTo(ws, { type: 'jtcat-status', ...this._jtcatState });
        if (this._jtcatQsoState) this._sendTo(ws, { type: 'jtcat-qso-state', ...this._jtcatQsoState });
        if (this._jtcatDecodeBuffer.length > 0) {
          this._sendTo(ws, { type: 'jtcat-decode-batch', entries: this._jtcatDecodeBuffer });
        }
        if (this._directoryData.nets.length || this._directoryData.swl.length) {
          this._sendTo(ws, { type: 'directory', nets: this._directoryData.nets, swl: this._directoryData.swl });
        }
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
        // Club mode: check license privilege
        if (this._clubMode && this._authenticatedMember) {
          const blocked = this._checkTunePrivilege(msg.freqKhz, msg.mode);
          if (blocked) {
            this._sendTo(ws, { type: 'tune-blocked', reason: blocked });
            if (this._auditLogger) {
              this._auditLogger.log(this._authenticatedMember.callsign, 'tune-blocked',
                `${msg.freqKhz} kHz ${msg.mode || ''}: ${blocked}`);
            }
            break;
          }
          if (this._auditLogger) {
            this._auditLogger.log(this._authenticatedMember.callsign, 'tune',
              `${msg.freqKhz} kHz ${msg.mode || ''}`);
          }
        }
        this.emit('tune', {
          freqKhz: msg.freqKhz,
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
        this.emit('log-qso', msg.data);
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

      // Unified rig-control dispatch (same actions as desktop IPC)
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
        if (msg.call) this.emit('jtcat-reply', { call: msg.call, grid: msg.grid || '', df: msg.df || 1500 });
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
      case 'jtcat-set-tx-freq':
        this.emit('jtcat-set-tx-freq', { hz: msg.hz || 1500 });
        break;
      case 'jtcat-set-tx-slot':
        this.emit('jtcat-set-tx-slot', { slot: msg.slot || 'auto' });
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

      case 'ping':
        this._sendTo(ws, { type: 'pong', ts: msg.ts });
        break;

      // --- CW Keyer messages ---
      case 'paddle':
        if (!this._cwEnabled || !this._cwKeyer) break;
        if (msg.contact === 'dit') {
          this._cwKeyer.paddleDit(!!msg.state);
        } else if (msg.contact === 'dah') {
          this._cwKeyer.paddleDah(!!msg.state);
        }
        // Watchdog: if no paddle message arrives for 2s, force both paddles released.
        // Catches lost keyup events over WebSocket that leave keyer running forever.
        if (this._cwPaddleWatchdog) clearTimeout(this._cwPaddleWatchdog);
        this._cwPaddleWatchdog = setTimeout(() => {
          this._cwPaddleWatchdog = null;
          if (this._cwKeyer) {
            this._cwKeyer.paddleDit(false);
            this._cwKeyer.paddleDah(false);
          }
        }, 2000);
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
        if (this._cwKeyer) this._cwKeyer.stop();
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

  sendWorkedParks(refs) {
    this._workedParks = refs;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'worked-parks', refs });
    }
  }

  sendWorkedQsos(entries) {
    this._workedQsos = entries;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'worked-qsos', entries });
    }
  }

  setRemoteSettings(obj) {
    this._remoteSettings = obj;
    this._cachedInlinedHtml = null;
    // Push updated settings live to connected ECHOCAT client
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'settings-update', settings: obj });
    }
  }

  broadcastDirectory(data) {
    this._directoryData = data;
    if (this._client && this._client.readyState === WebSocket.OPEN) {
      this._sendTo(this._client, { type: 'directory', nets: data.nets, swl: data.swl });
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

  _initCwKeyer() {
    this._destroyCwKeyer();
    this._cwKeyer = new IambicKeyer();
    this._cwKeyer.setWpm(this._cwWpm);
    this._cwKeyer.setMode(this._cwMode);

    this._cwKeyer.on('key', (evt) => {
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
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  static generateToken() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  static getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    // Try to get Tailscale MagicDNS hostname
    let tailscaleHostname = null;
    try {
      const { execSync } = require('child_process');
      const out = execSync('tailscale status --json', { timeout: 3000, encoding: 'utf-8' });
      const status = JSON.parse(out);
      if (status.Self && status.Self.DNSName) {
        tailscaleHostname = status.Self.DNSName.replace(/\.$/, ''); // strip trailing dot
      }
    } catch { /* Tailscale not installed or not running */ }

    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const isTailscale = addr.address.startsWith('100.');
          ips.push({
            name,
            address: addr.address,
            tailscale: isTailscale,
            tailscaleHostname: isTailscale ? tailscaleHostname : null,
          });
        }
      }
    }
    // Tailscale IPs first
    ips.sort((a, b) => (b.tailscale ? 1 : 0) - (a.tailscale ? 1 : 0));
    return ips;
  }
}

module.exports = { RemoteServer };
