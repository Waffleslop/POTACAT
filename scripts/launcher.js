#!/usr/bin/env node
// POTACAT Remote Launcher — standalone HTTPS server for starting/stopping POTACAT remotely.
// Runs as a Windows startup task (Startup folder VBS).
// Zero npm dependencies — uses only Node.js built-ins.
//
// Auth: uses your callsign from POTACAT settings as the passphrase (case-insensitive).
//       Or set launcherPassphrase in settings.json to override.
//
// Usage:  node scripts/launcher.js [--port PORT] [--no-tls]
// Config: %APPDATA%/potacat/launcher-config.json (port, https)
// Auth:   %APPDATA%/potacat/settings.json (myCallsign or launcherPassphrase)

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');

// --- Config ---
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function getConfigDir() {
  if (IS_WIN) return path.join(process.env.APPDATA || '', 'potacat');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'potacat');
  return path.join(os.homedir(), '.config', 'potacat');
}

const CONFIG_DIR = getConfigDir();
const CONFIG_PATH = path.join(CONFIG_DIR, 'launcher-config.json');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const DEFAULT_PORT = 7301;
const ECHOCAT_PORT = 7300;
const PROCESS_NAME = IS_WIN ? 'POTACAT.exe' : 'POTACAT';
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 20;

let config = { port: DEFAULT_PORT, potacatPath: 'auto', https: true };
let startedAt = null;

// --- Load config ---
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = { ...config, ...JSON.parse(raw) };
  } catch {
    // Config is optional — defaults are fine
    console.log(`[Launcher] No launcher-config.json found, using defaults (port ${DEFAULT_PORT})`);
  }
}

// --- Get passphrase from POTACAT settings ---
function getPassphrase() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    // Custom passphrase takes priority, then callsign
    if (settings.launcherPassphrase) return settings.launcherPassphrase.trim();
    if (settings.myCallsign) return settings.myCallsign.trim();
  } catch {}
  return null;
}

// --- CLI args override ---
function parseArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) config.port = parseInt(args[++i], 10);
    if (args[i] === '--no-tls') config.https = false;
  }
}

// --- Process detection ---
const MY_PID = process.pid;

/** Get all PIDs of POTACAT.exe except our own launcher process */
function getOtherPids() {
  try {
    if (IS_WIN) {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${PROCESS_NAME}" /FO CSV /NH`, {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      const pids = [];
      const re = /"[^"]*","(\d+)"/g;
      let m;
      while ((m = re.exec(out)) !== null) {
        const pid = parseInt(m[1], 10);
        if (pid !== MY_PID) pids.push(pid);
      }
      return pids;
    } else {
      const out = execSync(`pgrep -x "${PROCESS_NAME}"`, { encoding: 'utf8', timeout: 5000 });
      return out.trim().split('\n').map(s => parseInt(s, 10)).filter(p => p && p !== MY_PID);
    }
  } catch {
    return [];
  }
}

function isRunning() {
  return getOtherPids().length > 0;
}

function getPid() {
  const pids = getOtherPids();
  return pids.length > 0 ? pids[0] : null;
}

// --- ECHOCAT port probe ---
function isEchocatListening() {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(ECHOCAT_PORT, '127.0.0.1');
  });
}

// --- Find POTACAT exe ---
function findPotacatPath() {
  if (config.potacatPath && config.potacatPath !== 'auto') {
    if (fs.existsSync(config.potacatPath)) return config.potacatPath;
    console.warn(`[Launcher] Configured path not found: ${config.potacatPath}`);
  }

  if (IS_WIN) {
    try {
      const out = execSync('reg query "HKCU\\Software\\Classes\\potacat\\shell\\open\\command" /ve', {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      const match = out.match(/"([^"]+POTACAT\.exe)"/i);
      if (match && fs.existsSync(match[1])) return match[1];
    } catch {}
  }

  const candidates = [];
  if (IS_WIN) {
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'POTACAT', 'POTACAT.exe'));
    candidates.push(path.join(process.env.PROGRAMFILES || '', 'POTACAT', 'POTACAT.exe'));
  } else if (IS_MAC) {
    candidates.push('/Applications/POTACAT.app/Contents/MacOS/POTACAT');
  } else {
    candidates.push('/usr/bin/POTACAT');
    candidates.push(path.join(os.homedir(), 'POTACAT.AppImage'));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// --- Start / Stop / Restart ---
function startPotacat() {
  const exePath = findPotacatPath();
  if (!exePath) return { ok: false, error: 'POTACAT executable not found. Set potacatPath in launcher-config.json.' };
  if (isRunning()) return { ok: true, already: true, pid: getPid() };

  try {
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    startedAt = Date.now();
    console.log(`[Launcher] Started POTACAT (PID ${child.pid}) from ${exePath}`);
    return { ok: true, pid: child.pid };
  } catch (err) {
    console.error(`[Launcher] Failed to start: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function stopPotacat() {
  const pids = getOtherPids();
  if (pids.length === 0) return { ok: true, already: true };
  try {
    // Kill only GUI POTACAT processes, not our own launcher
    for (const pid of pids) {
      if (IS_WIN) {
        execSync(`taskkill /PID ${pid} /F`, { timeout: 10000, windowsHide: true });
      } else {
        execSync(`kill ${pid}`, { timeout: 10000 });
      }
    }
    startedAt = null;
    console.log('[Launcher] Stopped POTACAT (PIDs:', pids.join(', ') + ')');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function restartPotacat() {
  stopPotacat();
  await new Promise(r => setTimeout(r, 3000));
  return startPotacat();
}

// --- Rate limiting ---
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  let hits = rateLimitMap.get(ip) || [];
  hits = hits.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (hits.length >= RATE_LIMIT_MAX) return false;
  hits.push(now);
  rateLimitMap.set(ip, hits);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateLimitMap) {
    const filtered = hits.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (filtered.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, filtered);
  }
}, 300000);

// --- Auth (callsign-based) ---
function checkAuth(req) {
  const passphrase = getPassphrase();
  if (!passphrase) return false; // No callsign configured = locked out

  // Check Authorization header: Bearer <callsign>
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const val = authHeader.slice(7).trim();
    if (val.toUpperCase() === passphrase.toUpperCase()) return true;
  }
  // Check query param: ?p=<callsign>
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.searchParams.get('p');
  if (p && p.toUpperCase() === passphrase.toUpperCase()) return true;
  return false;
}

// --- Local IPs ---
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

// --- TLS cert (same pure-Node approach as ECHOCAT) ---
function derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}
function derSeq(bufs) { const b = Buffer.concat(bufs); return Buffer.concat([Buffer.from([0x30]), derLen(b.length), b]); }
function derSet(bufs) { const b = Buffer.concat(bufs); return Buffer.concat([Buffer.from([0x31]), derLen(b.length), b]); }
function derOid(h) { const b = Buffer.from(h, 'hex'); return Buffer.concat([Buffer.from([0x06, b.length]), b]); }
function derUtf8(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([0x0c]), derLen(b.length), b]); }
function derBitString(b) { return Buffer.concat([Buffer.from([0x03]), derLen(b.length + 1), Buffer.from([0x00]), b]); }
function derInt(b) { if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]); return Buffer.concat([Buffer.from([0x02]), derLen(b.length), b]); }
function derExplicit(tag, c) { return Buffer.concat([Buffer.from([0xa0 | tag]), derLen(c.length), c]); }
function derOctetString(b) { return Buffer.concat([Buffer.from([0x04]), derLen(b.length), b]); }
function derGeneralizedTime(d) { const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; const b = Buffer.from(s, 'ascii'); return Buffer.concat([Buffer.from([0x18]), derLen(b.length), b]); }

function generateTlsCert() {
  const certPath = path.join(CONFIG_DIR, 'launcher-cert.pem');
  const keyPath = path.join(CONFIG_DIR, 'launcher-key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const stat = fs.statSync(certPath);
      if (Date.now() - stat.mtimeMs < 365 * 24 * 60 * 60 * 1000) {
        return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
      }
    } catch {}
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const sha256WithRsa = derSeq([derOid('2a864886f70d01010b'), Buffer.from([0x05, 0x00])]);
  const cn = derSeq([derOid('550403'), derUtf8('POTACAT Launcher')]);
  const org = derSeq([derOid('55040a'), derUtf8('POTACAT')]);
  const issuer = derSeq([derSet([cn]), derSet([org])]);
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000);
  const validity = derSeq([derGeneralizedTime(notBefore), derGeneralizedTime(notAfter)]);

  const ipAddresses = ['127.0.0.1', ...getLocalIPs()];
  const sanEntries = ipAddresses.map(ip => {
    const parts = ip.split('.').map(Number);
    return Buffer.concat([Buffer.from([0x87, 4]), Buffer.from(parts)]);
  });
  const sanExt = derSeq([derOid('551d11'), derOctetString(derSeq(sanEntries))]);
  const basicConstraints = derSeq([derOid('551d13'), Buffer.from([0x01, 0x01, 0xff]), derOctetString(derSeq([]))]);
  const keyUsage = derSeq([derOid('551d0f'), Buffer.from([0x01, 0x01, 0xff]), derOctetString(Buffer.concat([Buffer.from([0x03, 0x02, 0x05, 0x80])]))]);
  const extKeyUsage = derSeq([derOid('551d25'), derOctetString(derSeq([derOid('2b06010505070301')]))]);
  const extensions = derExplicit(3, derSeq([basicConstraints, keyUsage, extKeyUsage, sanExt]));

  const version = derExplicit(0, derInt(Buffer.from([0x02])));
  const tbsCert = derSeq([version, derInt(crypto.randomBytes(8)), sha256WithRsa, issuer, validity, issuer, publicKey, extensions]);
  const signer = crypto.createSign('SHA256');
  signer.update(tbsCert);
  const cert = derSeq([tbsCert, sha256WithRsa, derBitString(signer.sign(privateKey))]);
  const certPem = '-----BEGIN CERTIFICATE-----\n' + cert.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';

  fs.writeFileSync(certPath, certPem);
  fs.writeFileSync(keyPath, privateKey);
  console.log(`[Launcher] Generated TLS cert (SAN: ${ipAddresses.join(', ')})`);
  return { cert: certPem, key: privateKey };
}

// --- Format uptime ---
function formatUptime(ms) {
  if (ms < 60000) return Math.floor(ms / 1000) + 's';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// --- Status page HTML ---
function statusPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>POTACAT Launcher</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 24px 16px; }
  h1 { font-size: 20px; color: #4ecca3; margin-bottom: 20px; letter-spacing: 1px; }
  .card { background: #16213e; border-radius: 8px; padding: 20px; width: 100%; max-width: 360px; margin-bottom: 16px; }
  .status-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; font-size: 14px; }
  .status-row + .status-row { border-top: 1px solid #1a1a2e; }
  .label { color: #999; }
  .badge { padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge.running { background: #2a6e4e; color: #4ecca3; }
  .badge.stopped { background: #5a2030; color: #e94560; }
  .badge.listening { background: #2a6e4e; color: #4ecca3; }
  .badge.closed { background: #444; color: #999; }
  .buttons { display: flex; gap: 8px; width: 100%; max-width: 360px; }
  .btn { flex: 1; padding: 12px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-start { background: #4ecca3; color: #1a1a2e; }
  .btn-restart { background: #f0a500; color: #1a1a2e; }
  .btn-stop { background: #e94560; color: #fff; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #16213e; border: 1px solid #4ecca3; color: #4ecca3; padding: 8px 20px; border-radius: 6px; font-size: 13px; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
  .toast.show { opacity: 1; }
  #login { text-align: center; }
  #login input { background: #1a1a2e; border: 1px solid #333; color: #e0e0e0; padding: 10px; border-radius: 6px; width: 100%; max-width: 280px; font-size: 16px; margin: 12px 0; text-align: center; text-transform: uppercase; letter-spacing: 1px; }
  #login button { background: #4ecca3; color: #1a1a2e; border: none; padding: 10px 28px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .note { color: #666; font-size: 11px; margin-top: 16px; text-align: center; max-width: 360px; }
</style>
</head>
<body>
<h1>POTACAT LAUNCHER</h1>

<div id="login" class="card">
  <p style="color:#999;margin-bottom:8px;">Enter your callsign</p>
  <input type="text" id="pass-input" placeholder="W1AW" autocomplete="new-password" autocapitalize="characters" spellcheck="false">
  <br><button onclick="doLogin()">Connect</button>
  <p id="login-err" style="color:#e94560;font-size:12px;margin-top:8px;display:none;"></p>
</div>

<div id="app" style="display:none;width:100%;max-width:360px;">
  <div class="card">
    <div class="status-row">
      <span class="label">POTACAT</span>
      <span id="s-app" class="badge stopped">--</span>
    </div>
    <div class="status-row">
      <span class="label">ECHOCAT</span>
      <span id="s-echo" class="badge closed">--</span>
    </div>
    <div class="status-row">
      <span class="label">PID</span>
      <span id="s-pid">--</span>
    </div>
    <div class="status-row">
      <span class="label">Uptime</span>
      <span id="s-uptime">--</span>
    </div>
  </div>
  <div class="buttons">
    <button class="btn btn-start" id="b-start" onclick="doAction('start')">Start</button>
    <button class="btn btn-restart" id="b-restart" onclick="doAction('restart')">Restart</button>
    <button class="btn btn-stop" id="b-stop" onclick="doAction('stop')">Stop</button>
  </div>
</div>

<div id="toast" class="toast"></div>
<p class="note">POTACAT Remote Launcher</p>

<script>
let passphrase = localStorage.getItem('launcher-pass') || '';

if (passphrase) { tryLogin(passphrase, true); }

function doLogin() {
  const val = document.getElementById('pass-input').value.trim().toUpperCase();
  if (!val) return;
  tryLogin(val, false);
}

document.getElementById('pass-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

async function tryLogin(pass, silent) {
  try {
    const r = await fetch('/status', { headers: { 'Authorization': 'Bearer ' + pass } });
    if (r.status === 401) {
      localStorage.removeItem('launcher-pass');
      if (!silent) {
        const err = document.getElementById('login-err');
        err.textContent = 'Wrong callsign';
        err.style.display = '';
      }
      document.getElementById('login').style.display = '';
      return;
    }
    passphrase = pass;
    localStorage.setItem('launcher-pass', pass);
    showApp();
  } catch {
    if (!silent) {
      const err = document.getElementById('login-err');
      err.textContent = 'Connection failed';
      err.style.display = '';
    }
  }
}

function showApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = '';
  refresh();
  setInterval(refresh, 5000);
}

async function apiFetch(path, method) {
  try {
    const r = await fetch(path, { method: method || 'GET', headers: { 'Authorization': 'Bearer ' + passphrase } });
    if (r.status === 401) { localStorage.removeItem('launcher-pass'); location.reload(); return null; }
    return await r.json();
  } catch { return null; }
}

async function refresh() {
  const d = await apiFetch('/status');
  if (!d) return;
  const sApp = document.getElementById('s-app');
  sApp.textContent = d.running ? 'RUNNING' : 'STOPPED';
  sApp.className = 'badge ' + (d.running ? 'running' : 'stopped');
  const sEcho = document.getElementById('s-echo');
  sEcho.textContent = d.echocat ? 'LISTENING' : 'CLOSED';
  sEcho.className = 'badge ' + (d.echocat ? 'listening' : 'closed');
  document.getElementById('s-pid').textContent = d.pid || '--';
  document.getElementById('s-uptime').textContent = d.uptime || '--';
}

async function doAction(action) {
  const btns = document.querySelectorAll('.btn');
  btns.forEach(b => b.disabled = true);
  toast(action === 'start' ? 'Starting...' : action === 'restart' ? 'Restarting...' : 'Stopping...');
  const d = await apiFetch('/' + action, 'POST');
  if (d && d.ok) toast(action === 'stop' ? 'Stopped' : 'Started (PID ' + (d.pid || '?') + ')');
  else toast('Error: ' + (d ? d.error : 'no response'), true);
  setTimeout(async () => { await refresh(); btns.forEach(b => b.disabled = false); }, action === 'restart' ? 4000 : 2000);
}

function toast(msg, err) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = err ? '#e94560' : '#4ecca3';
  el.style.color = err ? '#e94560' : '#4ecca3';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}
</script>
</body>
</html>`;
}

// --- HTTP handler ---
async function handleRequest(req, res) {
  const ip = req.socket.remoteAddress || '';

  if (!checkRateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Status page — serves HTML, auth handled client-side
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(statusPageHtml());
    return;
  }

  // All API endpoints require auth
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (pathname === '/status' && req.method === 'GET') {
    const running = isRunning();
    const pid = running ? getPid() : null;
    const echocat = await isEchocatListening();
    let uptime = null;
    if (running && startedAt) uptime = formatUptime(Date.now() - startedAt);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running, pid, echocat, uptime }));
    return;
  }

  if (pathname === '/start' && req.method === 'POST') {
    const result = startPotacat();
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === '/restart' && req.method === 'POST') {
    const result = await restartPotacat();
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === '/stop' && req.method === 'POST') {
    const result = stopPotacat();
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// --- Main ---
loadConfig();
parseArgs();

const passphrase = getPassphrase();
if (!passphrase) {
  console.error('[Launcher] No callsign found in POTACAT settings.');
  console.error('[Launcher] Set your callsign in POTACAT Settings > General, or add "launcherPassphrase" to settings.json.');
  process.exit(1);
}

let server;
if (config.https) {
  const tls = generateTlsCert();
  if (tls) {
    server = https.createServer({ cert: tls.cert, key: tls.key }, handleRequest);
  } else {
    console.warn('[Launcher] TLS cert generation failed, falling back to HTTP');
    server = http.createServer(handleRequest);
  }
} else {
  server = http.createServer(handleRequest);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[Launcher] Port ${config.port} already in use — another launcher is running. Exiting.`);
    process.exit(0); // exit cleanly, not a crash
  } else {
    console.error('[Launcher] Server error:', err.message);
    process.exit(1);
  }
});

server.listen(config.port, '0.0.0.0', () => {
  const proto = config.https ? 'https' : 'http';
  const ips = getLocalIPs();
  console.log(`[Launcher] POTACAT Remote Launcher running on port ${config.port}`);
  console.log(`[Launcher] Passphrase: your callsign (${passphrase})`);
  console.log(`[Launcher] Local:     ${proto}://127.0.0.1:${config.port}/`);
  for (const ip of ips) {
    const label = ip.startsWith('100.') ? ' (Tailscale)' : '';
    console.log(`[Launcher] Network:   ${proto}://${ip}:${config.port}/${label}`);
  }
  const exePath = findPotacatPath();
  console.log(`[Launcher] POTACAT:   ${exePath || 'NOT FOUND — set potacatPath in config'}`);
  console.log(`[Launcher] Running:   ${isRunning() ? 'YES' : 'NO'}`);
});

process.on('SIGINT', () => { console.log('\n[Launcher] Shutting down'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
