// PSKReporter HTTP client — polls live FreeDV reception reports
// The MQTT feed at mqtt.pskreporter.info does NOT carry FreeDV spots,
// so we poll the XML API at retrieve.pskreporter.info instead.
const https = require('https');
const { EventEmitter } = require('events');
const { freqToBand } = require('./bands');

const QUERY_URL = 'https://retrieve.pskreporter.info/query';
const POLL_INTERVAL = 300000; // 5 minutes between polls (API rate-limits aggressively)
const BACKOFF_INTERVAL = 600000; // 10 minutes after a 503 (rate-limit = back off HARD)

// Transient gateway hiccups (500/502/504). retrieve.pskreporter.info sits
// behind a gateway that 502s constantly and self-heals in seconds — K3SBP
// hit one the instant the app started (2026-06-13). A single one of these
// should NOT blank the map for 5 minutes or alarm the operator with an
// error: retry soon with escalating backoff (30s, 60s, 120s, 240s), stay
// "connected" the whole time, and only fall back to the slow poll + a real
// error after MAX_TRANSIENT_RETRIES consecutive failures. The cap stays
// under POLL_INTERVAL so a flaky gateway is retried sooner, never later.
const GATEWAY_RETRY_BASE = 30000;   // first transient retry after 30s
const GATEWAY_RETRY_CAP = 240000;   // …escalating to at most 4 min
const MAX_TRANSIENT_RETRIES = 4;

class PskrClient extends EventEmitter {
  constructor() {
    super();
    this._pollTimer = null;
    this._active = false;
    this.connected = false;
    this.nextPollAt = null; // timestamp (ms) of next scheduled poll
    this._transientRetries = 0; // consecutive 5xx-gateway failures
  }

  connect(config = {}) {
    this.disconnect();
    this._config = config;
    this._active = true;
    this._transientRetries = 0;
    this._poll();
  }

  // Pure decision for what to do after a poll completes, given the HTTP
  // status code (200, 503, 5xx, …) and how many consecutive transient
  // gateway failures we've already absorbed. Kept side-effect-free so it
  // can be unit-tested without the network (see test/pskreporter-test.js),
  // matching cloud-tunnel's _classifyCloudflaredLine pattern. `kind` is one
  // of: 'ok' | 'transient-retry' | 'rate-limited' | 'fail'.
  static decidePollOutcome(statusCode, transientRetries = 0) {
    if (statusCode === 200) return { kind: 'ok' };
    // 503 = PSKReporter telling US to slow down → back off hard, but the
    // service is up so the map stays "connected" (historical behavior).
    if (statusCode === 503) {
      return { kind: 'rate-limited', delay: BACKOFF_INTERVAL, markDisconnected: false };
    }
    // 500/502/504 = the gateway burped, not us. Quick escalating retry
    // while we still have attempts left; don't drop the connection.
    const transient = (statusCode === 500 || statusCode === 502 || statusCode === 504);
    if (transient && transientRetries < MAX_TRANSIENT_RETRIES) {
      const delay = Math.min(GATEWAY_RETRY_BASE * Math.pow(2, transientRetries), GATEWAY_RETRY_CAP);
      return { kind: 'transient-retry', delay, markDisconnected: false };
    }
    // Any other HTTP error, or transient retries exhausted: surface it,
    // mark disconnected, resume the normal slow poll.
    return { kind: 'fail', delay: POLL_INTERVAL, markDisconnected: true };
  }

  _poll() {
    if (!this._active) return;

    // If senderCallsign is set, query by sender (PSKReporter Map view — all modes);
    // otherwise fall back to FreeDV-only mode (existing behavior)
    let url;
    if (this._config && this._config.senderCallsign) {
      const call = encodeURIComponent(this._config.senderCallsign);
      url = `${QUERY_URL}?senderCallsign=${call}&flowStartSeconds=-900&rronly=1&rptlimit=500&appcontact=potacat-app`;
    } else {
      url = `${QUERY_URL}?mode=FREEDV&flowStartSeconds=-900&rronly=1&rptlimit=100&appcontact=potacat-app`;
    }

    const label = (this._config && this._config.senderCallsign) ? `spots for ${this._config.senderCallsign}` : 'FreeDV spots';
    this.emit('log', `PSKReporter: fetching ${label}...`);
    const req = https.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'POTACAT/0.9.7 (Electron)' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (!this._active) return;

        const outcome = PskrClient.decidePollOutcome(res.statusCode, this._transientRetries);

        if (outcome.kind === 'ok') {
          this._transientRetries = 0;
          const wasDisconnected = !this.connected;
          this.connected = true;
          const count = this._parseXml(body);
          // Say what came back — "fetching..." followed by silence read as a
          // hung request (K3SBP 2026-07-18: "is desktop collecting
          // propagation?" — it was; the polls were succeeding silently).
          this.emit('log', count > 0
            ? `PSKReporter: ${count} reception report${count === 1 ? '' : 's'} for ${label}`
            : `PSKReporter: no reports in the last 15 min for ${label} — the map fills in after you transmit`);
          this._schedulePoll(POLL_INTERVAL);
          // Emit status AFTER parseXml and schedulePoll so spot count + nextPollAt are accurate
          if (wasDisconnected) {
            this.emit('status', { connected: true });
          }
          this.emit('pollDone');
        } else if (outcome.kind === 'transient-retry') {
          this._transientRetries++;
          // Soft 'log', not 'error' — a single gateway 502 is noise, not a
          // fault the operator needs to act on. Stays "connected".
          this.emit('log', `PSKReporter HTTP ${res.statusCode} — transient, retrying in ${Math.round(outcome.delay / 1000)}s (attempt ${this._transientRetries}/${MAX_TRANSIENT_RETRIES})`);
          this._schedulePoll(outcome.delay);
        } else {
          this._transientRetries = 0;
          this.emit('error', outcome.kind === 'rate-limited'
            ? 'PSKReporter: rate limited, backing off'
            : `PSKReporter HTTP ${res.statusCode}`);
          if (outcome.markDisconnected && this.connected) {
            this.connected = false;
            this.emit('status', { connected: false });
          }
          this._schedulePoll(outcome.delay);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
    });

    req.on('error', (err) => {
      if (!this._active) return;
      this.emit('error', `PSKReporter: ${err.message}`);
      if (this.connected) {
        this.connected = false;
        this.emit('status', { connected: false });
      }
      this._schedulePoll(BACKOFF_INTERVAL);
    });
  }

  /**
   * One-shot early poll after the operator starts transmitting. The steady
   * 5-minute cadence can straddle an entire FT8 session — K3SBP 2026-07-18:
   * first TX at 00:48:15, prior poll at 00:48:08, next at 00:53 — so the map
   * sat empty for the whole 4-minute run. PSKReporter ingests receiver
   * batches within ~1-2 min, so one pull ~90s after TX begins shows the
   * operator their propagation while they're still transmitting.
   * Rate-limit-safe: skipped when the regular poll is already near, and at
   * most one early poll per POLL_INTERVAL (the API's requested cadence).
   */
  pollSoon(delayMs = 90000) {
    if (!this._active) return;
    const fireAt = Date.now() + delayMs;
    // Regular poll already lands within a minute of the early one — let it.
    if (this.nextPollAt && this.nextPollAt <= fireAt + 60000) return;
    if (this._lastEarlyPollAt && Date.now() - this._lastEarlyPollAt < POLL_INTERVAL) return;
    this._lastEarlyPollAt = Date.now();
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
    this.emit('log', `PSKReporter: TX detected — checking for reception reports in ${Math.round(delayMs / 1000)}s`);
    this._schedulePoll(delayMs);
  }

  _schedulePoll(interval) {
    if (!this._active || this._pollTimer) return;
    this.nextPollAt = Date.now() + interval;
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      this.nextPollAt = null;
      this._poll();
    }, interval);
  }

  _parseXml(xml) {
    // [^>]*? (not [^/>]+): a '/' INSIDE an attribute value — a portable
    // receiver callsign like receiverCallsign="EA8/DL1ABC" — must not stop
    // the match. The old class silently dropped every report containing a
    // slash anywhere in its attributes. Returns the parsed-report count so
    // the poll log can say what came back.
    const reportRe = /<receptionReport\s+([^>]*?)\/>/g;
    let count = 0;
    let m;
    while ((m = reportRe.exec(xml)) !== null) {
      const attrs = m[1];
      const get = (name) => {
        const am = attrs.match(new RegExp(`${name}="([^"]*)"`));
        return am ? am[1] : '';
      };

      const callsign = get('senderCallsign');
      const spotter = get('receiverCallsign');
      const freqHz = parseInt(get('frequency'), 10);
      if (!callsign || !freqHz) continue;

      const freqKhz = freqHz / 1000;
      const freqMHz = freqHz / 1e6;
      const band = freqToBand(freqMHz) || '';
      const snr = get('sNR') ? parseInt(get('sNR'), 10) : null;

      const flowStart = parseInt(get('flowStartSeconds'), 10);
      const spotTime = flowStart
        ? new Date(flowStart * 1000).toISOString()
        : new Date().toISOString();

      count++;
      this.emit('spot', {
        callsign,
        spotter,
        frequency: String(Math.round(freqKhz * 10) / 10),
        freqMHz,
        mode: (get('mode') || 'FREEDV').toUpperCase(),
        band,
        snr,
        senderGrid: get('senderLocator'),
        receiverGrid: get('receiverLocator'),
        spotTime,
      });
    }
    return count;
  }

  disconnect() {
    this._active = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this.connected = false;
  }
}

module.exports = { PskrClient };
