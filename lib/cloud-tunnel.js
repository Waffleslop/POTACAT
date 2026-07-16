'use strict';

// POTACAT Cloud — desktop-side tunnel manager.
//
// Owns:
//   - persisted state file (userData/cloud-tunnel.json)
//   - in-memory state machine: off | provisioning | connecting | live | reconnecting | error
//   - 5-min health-check poll against GET /v1/cloud-tunnel/status
//   - (later, #35) the cloudflared child process + provision/revoke API calls
//
// Emits 'change' on every state transition. Consumers (tray indicator,
// Settings panel, pairing QR) read getState() and listen to 'change'.
//
// Hard guardrails:
//   1. Health-check interval is 300_000 ms (5 min). NEVER 60s — cost
//      guardrail, the cloud's Workers free tier overflows at 60s × 1000
//      users.
//   2. Hostname pattern (<callsign>.potacat.com) is returned by
//      the cloud /provision endpoint; never constructed client-side.
//   3. JWT auth is owned by lib/cloud-sync.js; this module never rolls
//      its own auth path — it calls into the shared CloudSyncClient.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min — see guardrail #1 above.
const CONFIG_FILENAME = 'cloud-tunnel.json';

// Spawn restart backoff (#35): exponential 1s → 30s cap, up to 5 attempts.
const SPAWN_RESTART_MAX = 5;
const SPAWN_RESTART_BASE_MS = 1000;
const SPAWN_RESTART_CAP_MS = 30000;

// DNS-degraded detection (tunnel-dns-degraded-notice; KE4EST 2026-06-12).
// cloudflared keeps its edge connections alive by periodically
// re-resolving region*.v2.argotunnel.com through the MACHINE's resolver
// (the home router, usually). When that resolver stops answering, the
// refresh fails and the tunnel decays — but cloudflared does NOT exit,
// so _status stays 'live' and the user sees "it just quit, nothing
// changed". We watch stderr for the DNS-failure lines and, after a
// couple inside the window, flip a `degraded` modifier (NOT a status —
// the tunnel is still nominally up) so the UI can show an actionable
// notice. Cleared on the next successful connection-registered line or
// once the errors age out of the window.
const DNS_DEGRADE_WINDOW_MS = 5 * 60 * 1000; // 5 min
const DNS_DEGRADE_THRESHOLD = 2;             // ≥2 DNS errors in the window
const DNS_DEGRADE_HINT =
  "Your computer's DNS server (usually your router) stopped responding, so the " +
  'Cloud Tunnel can\'t stay connected. Set the desktop\'s DNS to 1.1.1.1 and 8.8.8.8, ' +
  'or reboot the router, then turn the tunnel off and on.';

class CloudTunnelManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.userDataPath - app.getPath('userData')
   * @param {() => object} opts.getCloudSync - returns the shared CloudSyncClient (auth + http)
   * @param {() => string|null} opts.getCloudflaredPath - resolveCloudflaredPath() from lib/cloudflared
   * @param {(msg: string) => void} [opts.log] - optional logger
   * @param {object} [opts.safeStorage] - Electron safeStorage (if available)
   */
  constructor(opts) {
    super();
    this._userDataPath = opts.userDataPath;
    // Honor a caller-supplied (profile-scoped) config path. main.js passes
    // profiles/<CALL>/cloud-tunnel.json; the profile migration moves the file
    // there and deletes the root copy, so hardcoding the root path here meant
    // loadFromDisk silently found nothing and the tunnel never auto-started
    // (and enable() persisted back to the root — the "config drift" the
    // migration was papering over). Fall back to the root path for callers
    // (and tests) that don't specify one. K3SBP 2026-07-15.
    this._configPath = opts.configPath || path.join(this._userDataPath, CONFIG_FILENAME);
    this._getCloudSync = opts.getCloudSync;
    this._getCloudflaredPath = opts.getCloudflaredPath;
    this._log = opts.log || (() => {});
    this._safeStorage = opts.safeStorage || null;
    this._spawn = opts.spawn || spawn; // injectable for tests

    // Persisted state (mirrors what lives in cloud-tunnel.json on disk).
    // tunnelToken is kept in memory ONLY after decrypt; never logged.
    this._enabled = false;
    this._cloudHost = '';
    this._tunnelId = '';
    this._tunnelToken = '';
    this._createdAt = '';

    // Volatile runtime state.
    this._status = 'off'; // off | provisioning | connecting | live | reconnecting | error
    this._lastError = '';
    this._lastCheckAt = 0;
    this._child = null;
    this._healthTimer = null;
    this._restartAttempts = 0;
    this._restartTimer = null;
    this._stopping = false;
    // DNS-degraded modifier (see DNS_DEGRADE_* above). A boolean ON TOP
    // of _status — the tunnel may still be 'live' while degraded.
    this._degraded = false;
    this._degradedReason = '';
    this._dnsErrorTimes = []; // timestamps of recent cloudflared DNS errors
  }

  // ── Public API ────────────────────────────────────────────────────

  getState() {
    return {
      enabled: this._enabled,
      cloudHost: this._cloudHost,
      tunnelId: this._tunnelId,
      status: this._status,
      lastError: this._lastError,
      lastCheckAt: this._lastCheckAt,
      // degraded: the tunnel is nominally up (status may be 'live') but
      // cloudflared can't refresh DNS — surface an actionable notice.
      degraded: this._degraded,
      degradedReason: this._degradedReason,
      // tunnelToken is NEVER returned — it's a secret.
    };
  }

  /**
   * Classify a single cloudflared stderr line. Pure + static so the
   * detection is unit-testable without spawning the binary.
   *   'registered' → an edge connection came up (recovery signal)
   *   'dns-error'  → the local resolver failed to resolve the CF edge
   *   null         → anything else
   */
  static _classifyCloudflaredLine(line) {
    const s = String(line || '').toLowerCase();
    if (/connection registered|registered tunnel connection/.test(s)) return 'registered';
    if (/failed to refresh dns/.test(s)) return 'dns-error';
    // Generic resolver failure against the CF edge hostname.
    if (/argotunnel\.com/.test(s) &&
        /(i\/o timeout|no such host|server misbehaving|lookup .* timeout)/.test(s)) {
      return 'dns-error';
    }
    return null;
  }

  _recordDnsError(now) {
    this._dnsErrorTimes.push(now);
    const cutoff = now - DNS_DEGRADE_WINDOW_MS;
    this._dnsErrorTimes = this._dnsErrorTimes.filter((t) => t >= cutoff);
    if (this._dnsErrorTimes.length >= DNS_DEGRADE_THRESHOLD) {
      this._setDegraded(true, DNS_DEGRADE_HINT);
    }
  }

  /** Recovery: DNS is answering again — drop the error history + flag. */
  _clearDnsDegraded() {
    this._dnsErrorTimes = [];
    this._setDegraded(false, '');
  }

  _setDegraded(next, reason) {
    if (this._degraded === next) return;
    this._degraded = next;
    this._degradedReason = next ? reason : '';
    if (next) {
      // Land the operator-facing guidance in the same log the raw
      // cloudflared DNS errors are streaming into.
      this._log('[cloud-tunnel] DEGRADED: ' + reason);
    } else {
      this._log('[cloud-tunnel] DNS recovered — tunnel no longer degraded');
    }
    this.emit('change', this.getState());
  }

  /** Cloud host string for the pairing QR, or '' when LAN-only. */
  getCloudHost() {
    return (this._enabled && this._cloudHost) ? this._cloudHost : '';
  }

  /**
   * Read cloud-tunnel.json at startup. If the file says enabled, the
   * health-check + child process come up automatically (#35 handles
   * the spawn; #38 starts the health-check).
   */
  loadFromDisk() {
    try {
      if (!fs.existsSync(this._configPath)) {
        this._setStatus('off');
        return false;
      }
      const raw = fs.readFileSync(this._configPath, 'utf8');
      const cfg = JSON.parse(raw);
      this._enabled = !!cfg.enabled;
      this._cloudHost = String(cfg.cloudHost || '');
      this._tunnelId = String(cfg.tunnelId || '');
      this._createdAt = String(cfg.createdAt || '');
      this._tunnelToken = this._decryptToken(cfg.tunnelToken, !!cfg.tokenEncrypted);
      // Auto-start child + health-check on app launch when a token is
      // persisted. A failed safeStorage decrypt used to park the state at
      // 'connecting' forever with no spawn and no explanation — surface it
      // as an error so the Settings panel says WHY and offers re-enable.
      if (this._enabled && !this._tunnelToken) {
        this._lastError = 'saved tunnel token could not be decrypted — click Enable to re-provision';
        this._setStatus('error');
        this._log('[cloud-tunnel] enabled config found but token decrypt failed — re-enable to re-provision');
        return this._enabled;
      }
      this._setStatus(this._enabled ? 'connecting' : 'off');
      if (this._enabled && this._tunnelToken) {
        this._spawnCloudflared();
      }
      return this._enabled;
    } catch (err) {
      this._log('[cloud-tunnel] loadFromDisk failed: ' + (err.message || err));
      this._setStatus('off');
      return false;
    }
  }

  // ── Health check (#38) ────────────────────────────────────────────

  startHealthCheck() {
    if (this._healthTimer) return;
    if (!this._enabled) return;
    // First check fires on next tick so callers see the initial state
    // settle before the network call lands.
    this._healthTimer = setInterval(() => this._checkOnce(), HEALTH_CHECK_INTERVAL_MS);
    // Fire an immediate check so the tray doesn't sit in 'connecting'
    // for the full 5 minutes after enable.
    setImmediate(() => this._checkOnce());
  }

  stopHealthCheck() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  async _checkOnce() {
    if (!this._enabled) return;
    // Quiet recovery: if the DNS errors have aged out of the window with
    // no new ones, clear the degraded flag even without a fresh
    // "registered" line (the stderr path clears it immediately on
    // reconnect; this covers a recovery that produced no new log lines).
    const cutoff = Date.now() - DNS_DEGRADE_WINDOW_MS;
    this._dnsErrorTimes = this._dnsErrorTimes.filter((t) => t >= cutoff);
    if (this._degraded && this._dnsErrorTimes.length === 0) this._setDegraded(false, '');
    const sync = this._getCloudSync && this._getCloudSync();
    if (!sync) {
      this._log('[cloud-tunnel] health-check skipped — no cloud-sync client');
      return;
    }
    try {
      // `_authedRequest` is the existing client helper — see the
      // top-of-file guardrail #3 (no new auth path).
      const res = await sync._authedRequest('GET', '/v1/cloud-tunnel/status');
      this._lastCheckAt = Date.now();
      if (res && res.healthy) {
        this._lastError = '';
        this._setStatus('live');
        // Cloud is the source of truth for cloudHost — refresh in case
        // we drifted (e.g. after a server-side rebuild).
        if (res.cloudHost && res.cloudHost !== this._cloudHost) {
          this._cloudHost = res.cloudHost;
          this._persist();
        }
      } else {
        this._setStatus('reconnecting');
        // If the child has already exited, restart it (#35). The
        // health-check is the recovery path that picks up where the
        // immediate spawn-restart backoff gave up.
        if (this._enabled && !this._child) {
          this._log('[cloud-tunnel] status unhealthy + no child running — respawn');
          this._spawnCloudflared();
        }
      }
    } catch (err) {
      this._lastCheckAt = Date.now();
      this._lastError = err.message || String(err);
      // Network errors / 401s are not fatal — keep showing
      // 'reconnecting' so the user knows something's off, and the
      // next poll re-tries.
      this._setStatus('reconnecting');
      this._log('[cloud-tunnel] health-check error: ' + this._lastError);
    }
  }

  // ── Provision / Revoke / Child process (#35) ──────────────────────

  /**
   * Provision (or reuse — endpoint is idempotent) the user's tunnel,
   * persist the token, and spawn the cloudflared child process.
   *
   * Throws:
   *   - 'entitlement-required' when the cloud returns 402 — caller
   *     should route the user to the IAP/web-checkout paywall.
   *   - 'cloudflared-missing' when no binary is on disk.
   *   - 'auth-required' when no JWT is configured.
   *   - other Error.message strings for unexpected failures.
   */
  async enable() {
    const sync = this._getCloudSync && this._getCloudSync();
    if (!sync) throw new Error('auth-required');
    const cfPath = this._getCloudflaredPath && this._getCloudflaredPath();
    if (!cfPath) throw new Error('cloudflared-missing');

    this._setStatus('provisioning');
    let res;
    try {
      // Idempotent — cloud returns the existing tunnel if one is on
      // the user's row already, mints a new one otherwise.
      res = await sync._authedRequest('POST', '/v1/cloud-tunnel/provision', {});
    } catch (err) {
      // 402 lands here as Error('Cloud subscription required') (or
      // similar) — the cloud's status middleware sets that message.
      // Normalize to the canonical 'entitlement-required' code so the
      // renderer doesn't have to string-match.
      const msg = String(err.message || err);
      if (/402|entitlement|subscription/i.test(msg)) {
        this._lastError = msg;
        this._setStatus('off');
        const e = new Error('entitlement-required');
        e.cause = err;
        throw e;
      }
      this._lastError = msg;
      this._setStatus('off');
      throw err;
    }

    if (!res || !res.tunnelToken || !res.cloudHost) {
      this._setStatus('off');
      throw new Error('Provision response missing tunnelToken/cloudHost');
    }
    // If a child is already running, it was spawned with a previous
    // token. After re-provisioning (e.g. drift recovery — cloud
    // returned a brand-new tunnelId because our old one was revoked
    // server-side), the OLD child will keep retrying "Unauthorized:
    // Tunnel not found" forever because cloudflared exponential-
    // backoffs without ever exiting on auth errors. Kill it
    // explicitly so the next _spawnCloudflared actually spawns.
    const tunnelChanged =
      this._tunnelId && res.tunnelId && this._tunnelId !== String(res.tunnelId);
    if (this._child && tunnelChanged) {
      this._log(`[cloud-tunnel] tunnel changed (${this._tunnelId} → ${res.tunnelId}); killing stale cloudflared before respawn`);
      this._killChild();
    }
    this._enabled = true;
    this._cloudHost = String(res.cloudHost);
    this._tunnelId = String(res.tunnelId || '');
    this._tunnelToken = String(res.tunnelToken);
    this._createdAt = new Date().toISOString();
    this._lastError = '';
    this._persist();
    this._setStatus('connecting');
    this._spawnCloudflared();
    this.startHealthCheck();
    return this.getState();
  }

  /** Kill the current cloudflared child if any. Safe to call when
   *  there's no child. SIGTERM first, SIGKILL if it doesn't exit
   *  within 3s. Called by enable() on token rotation and by disable()
   *  on user-initiated teardown. */
  _killChild() {
    const child = this._child;
    if (!child) return;
    this._child = null; // detach immediately so on('exit') doesn't re-schedule
    try {
      child.kill('SIGTERM');
    } catch (err) {
      this._log(`[cloud-tunnel] SIGTERM failed: ${err.message || err}`);
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      } catch { /* already gone */ }
    }, 3000);
  }

  /**
   * Disable the tunnel — kill the child, best-effort tell the cloud to
   * revoke (DNS + CF tunnel deletion), wipe the persisted token. The
   * cloud-side revoke is best-effort because users on broken networks
   * still need the OFF state to take effect locally; the cloud's daily
   * stale-tunnel sweep handles orphans (cloud task #47).
   */
  async disable() {
    this._stopping = true;
    this.stopHealthCheck();
    this._killCloudflared();
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    this._restartAttempts = 0;

    const sync = this._getCloudSync && this._getCloudSync();
    if (sync && this._enabled) {
      try {
        await sync._authedRequest('POST', '/v1/cloud-tunnel/revoke', {});
      } catch (err) {
        this._log('[cloud-tunnel] revoke failed (continuing locally): ' + (err.message || err));
      }
    }
    this._wipe();
    this._lastError = '';
    this._setStatus('off');
    this._stopping = false;
    return this.getState();
  }

  _spawnCloudflared() {
    if (this._child) return;
    if (!this._tunnelToken) {
      this._log('[cloud-tunnel] _spawnCloudflared skipped — no token');
      return;
    }
    const cfPath = this._getCloudflaredPath && this._getCloudflaredPath();
    if (!cfPath) {
      this._lastError = 'cloudflared binary missing';
      this._setStatus('error');
      return;
    }
    // --protocol http2 pins the tunnel to TCP/TLS instead of QUIC. QUIC's
    // default behavior tears down the control stream when the local box
    // can't service the UDP socket within QUIC's tight latency budget —
    // K3SBP's 2026-06-02 session showed the failure-retry cycle firing
    // every ~30s under sustained VITA-49 audio load. http2 trades ~10–30 ms
    // of stream latency for a connection that survives renderer CPU stalls.
    const cfArgs = ['tunnel', 'run', '--protocol', 'http2', '--token', this._tunnelToken];
    const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
    // Try the bundled binary; if it fails with an architecture mismatch
    // (EBADARCH/-86 on Mac, ENOEXEC on Linux — the binary's CPU type
    // doesn't match this machine), fall back to a system-installed
    // cloudflared, then give a CLEAR error instead of "Unknown system
    // error -86". N3VD 2026-06-12.
    let lazyCloudflared = null;
    try { lazyCloudflared = require('./cloudflared'); } catch { /* optional */ }
    const tryPaths = [cfPath];
    let child = null;
    let archFailed = false;
    let lastErr = null;
    for (let i = 0; i < tryPaths.length; i++) {
      const p = tryPaths[i];
      this._log(`[cloud-tunnel] spawn ${p} tunnel run --protocol http2 --token <redacted>`);
      try {
        child = this._spawn(p, cfArgs, spawnOpts);
        break;
      } catch (err) {
        lastErr = err;
        if (lazyCloudflared && lazyCloudflared.isArchSpawnError(err)) {
          archFailed = true;
          const sys = lazyCloudflared.findSystemCloudflared && lazyCloudflared.findSystemCloudflared();
          if (sys && !tryPaths.includes(sys)) {
            this._log(`[cloud-tunnel] bundled cloudflared is the wrong CPU arch — trying system binary at ${sys}`);
            tryPaths.push(sys);
            continue;
          }
        }
        break;
      }
    }
    if (!child) {
      if (archFailed || (lazyCloudflared && lazyCloudflared.isArchSpawnError(lastErr))) {
        this._lastError = "The Cloud Tunnel helper (cloudflared) doesn't match this computer's processor. "
          + 'Install it with "brew install cloudflared", or reinstall POTACAT for your Mac\'s chip '
          + '(Apple Silicon vs Intel). If LAN + Tailscale already work for you, you don\'t need the tunnel.';
      } else {
        this._lastError = 'spawn failed: ' + ((lastErr && lastErr.message) || lastErr || 'unknown');
      }
      this._setStatus('error');
      return;
    }
    this._child = child;

    // cloudflared emits its informational lines to stderr (notably
    // "Registered tunnel connection" / "Connection registered"). The
    // exact wording has drifted across versions — match both
    // variants. Stdout is reserved for explicit JSON output modes
    // we don't use.
    const onStderr = (chunk) => {
      const s = chunk.toString('utf8');
      for (const line of s.split(/\r?\n/)) {
        if (!line) continue;
        const kind = CloudTunnelManager._classifyCloudflaredLine(line);
        if (kind === 'registered') {
          this._lastError = '';
          this._restartAttempts = 0;
          this._clearDnsDegraded(); // DNS is clearly working again
          this._setStatus('live');
        } else if (kind === 'dns-error') {
          this._recordDnsError(Date.now());
        }
      }
      // Don't spam the full stderr — pass through compact lines only.
      const compact = s.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 240);
      if (compact) this._log('[cloudflared] ' + compact);
    };
    child.stderr.on('data', onStderr);
    child.stdout.on('data', () => {}); // drain

    child.on('exit', (code, signal) => {
      this._log(`[cloud-tunnel] cloudflared exited code=${code} signal=${signal}`);
      this._child = null;
      if (this._stopping || !this._enabled) return;
      this._scheduleRestart();
    });
    child.on('error', (err) => {
      this._log('[cloud-tunnel] cloudflared error: ' + (err.message || err));
      // Some Node/macOS versions surface an arch mismatch here (async)
      // rather than as a sync throw above — give the same clear message.
      if (lazyCloudflared && lazyCloudflared.isArchSpawnError(err)) {
        this._lastError = "The Cloud Tunnel helper (cloudflared) doesn't match this computer's processor. "
          + 'Install it with "brew install cloudflared", or reinstall POTACAT for your Mac\'s chip '
          + '(Apple Silicon vs Intel). If LAN + Tailscale already work for you, you don\'t need the tunnel.';
        this._setStatus('error');
      }
    });
  }

  _scheduleRestart() {
    if (this._restartAttempts >= SPAWN_RESTART_MAX) {
      this._lastError = `cloudflared failed to stay up after ${SPAWN_RESTART_MAX} restarts`;
      this._setStatus('error');
      return;
    }
    const delay = Math.min(
      SPAWN_RESTART_BASE_MS * Math.pow(2, this._restartAttempts),
      SPAWN_RESTART_CAP_MS
    );
    this._restartAttempts += 1;
    this._setStatus('reconnecting');
    this._log(`[cloud-tunnel] restart attempt ${this._restartAttempts}/${SPAWN_RESTART_MAX} in ${delay}ms`);
    if (this._restartTimer) clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._spawnCloudflared();
    }, delay);
  }

  _killCloudflared() {
    if (!this._child) return;
    try {
      this._child.removeAllListeners();
      // On Windows, kill() sends SIGTERM-equivalent via TerminateProcess
      // (no graceful shutdown). On POSIX, SIGTERM gives cloudflared a
      // moment to close tunnel connections cleanly before we walk away.
      this._child.kill();
    } catch {}
    this._child = null;
  }

  // ── Persistence ───────────────────────────────────────────────────

  _persist() {
    const cfg = {
      enabled: this._enabled,
      cloudHost: this._cloudHost,
      tunnelId: this._tunnelId,
      createdAt: this._createdAt,
    };
    if (this._tunnelToken) {
      const enc = this._encryptToken(this._tunnelToken);
      cfg.tunnelToken = enc.value;
      cfg.tokenEncrypted = enc.encrypted;
    }
    try {
      const tmp = this._configPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this._configPath);
      // chmod is a no-op on Windows but harmless.
      try { fs.chmodSync(this._configPath, 0o600); } catch {}
    } catch (err) {
      this._log('[cloud-tunnel] persist failed: ' + (err.message || err));
    }
  }

  _wipe() {
    this._enabled = false;
    this._cloudHost = '';
    this._tunnelId = '';
    this._tunnelToken = '';
    this._createdAt = '';
    try {
      if (fs.existsSync(this._configPath)) fs.unlinkSync(this._configPath);
    } catch (err) {
      this._log('[cloud-tunnel] wipe failed: ' + (err.message || err));
    }
  }

  _encryptToken(plain) {
    if (this._safeStorage && this._safeStorage.isEncryptionAvailable && this._safeStorage.isEncryptionAvailable()) {
      try {
        const buf = this._safeStorage.encryptString(plain);
        return { value: buf.toString('base64'), encrypted: true };
      } catch (err) {
        this._log('[cloud-tunnel] safeStorage.encrypt failed, falling back to plaintext: ' + (err.message || err));
      }
    }
    return { value: plain, encrypted: false };
  }

  _decryptToken(stored, encrypted) {
    if (!stored) return '';
    if (!encrypted) return stored;
    if (this._safeStorage && this._safeStorage.isEncryptionAvailable && this._safeStorage.isEncryptionAvailable()) {
      try {
        return this._safeStorage.decryptString(Buffer.from(stored, 'base64'));
      } catch (err) {
        this._log('[cloud-tunnel] safeStorage.decrypt failed: ' + (err.message || err));
        return '';
      }
    }
    // Persisted as encrypted but safeStorage is no longer available
    // (e.g. user moved profile dir). Caller will need to re-provision.
    return '';
  }

  // ── Internals ─────────────────────────────────────────────────────

  _setStatus(next) {
    if (this._status === next) return;
    // Turning off clears any DNS-degraded state in the same change
    // emit (no separate event) — a stopped tunnel isn't "degraded".
    if (next === 'off' && this._degraded) {
      this._degraded = false;
      this._degradedReason = '';
      this._dnsErrorTimes = [];
    }
    const prev = this._status;
    this._status = next;
    this._log(`[cloud-tunnel] status ${prev} → ${next}` + (this._lastError ? ` (err: ${this._lastError.slice(0, 80)})` : ''));
    this.emit('change', this.getState());
  }

  // For tests + clean shutdown.
  shutdown() {
    this._stopping = true;
    this.stopHealthCheck();
    this._killCloudflared();
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    this.removeAllListeners();
  }
}

module.exports = {
  CloudTunnelManager,
  HEALTH_CHECK_INTERVAL_MS,
  SPAWN_RESTART_MAX,
  SPAWN_RESTART_BASE_MS,
  SPAWN_RESTART_CAP_MS,
};
