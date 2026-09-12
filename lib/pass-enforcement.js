'use strict';

// POTACAT Cloud — desktop-side Guest Pass enforcement (Phase 2 #43).
//
// Owns:
//   - state machine: idle | pending | active | expiring | ended
//   - pass profile loaded from cloud GET /v1/passes/:code
//   - synchronous CAT-command interceptor invoked by tuneRadio() + the
//     gated PTT / TX-power helpers in main.js
//   - monotonic expiry timer — never trusts the phone's clock
//
// The interceptor returns { allowed: true } when no pass session is
// active (idle state) so the common case is zero-cost. When active, it
// rejects out-of-band tunes, clamps TX-power, and refuses TX-enable
// for rigs that don't expose CAT-readable power.
//
// Hard guardrails (from D:\Projects\potacat-meta\guest-pass-and-tunnel-concept.md):
//   1. Desktop is the SOLE enforcement point. Phone is courtesy UI only.
//   2. Time enforcement is desktop-side via monotonic clock; force-close
//      session on expiry, never trust phone clock.
//   3. Rigs without CAT-readable TX power → TX disabled entirely (cleaner
//      legal posture than warn-and-allow).
//   4. Out-of-band CAT commands are REJECTED, never sent to the rig.

const { EventEmitter } = require('events');
const { isOutOfPrivilege, PRIVILEGE_MAP, CW_DIGI_MODES, PHONE_MODES } = require('./privileges');

// Cloud short-class → lib/privileges.js long-class.
const CLASS_MAP = {
  tech: 'us_technician',
  general: 'us_general',
  extra: 'us_extra',
};

const EXPIRING_WARN_MS = 60 * 1000; // 60s before expiry, emit 'expiring'
// While a session is live, re-read the pass from the cloud this often. The
// cloud never pushes a revoke to the shack (DELETE /v1/passes/:code just
// flips the row and closes the sessions), so an owner who revoked from
// their mobile device — or from a second desktop — was only honoured at
// the pass's natural expiry. One GET a minute per live session is the
// whole cost; the cloud's pass limiter counts failures only, and the one
// 404 that means "revoked" ends the session, so it is never repeated.
const REVALIDATE_MS = 60 * 1000;
const PASS_VALIDATE_URL = (code) => `https://api.potacat.com/v1/passes/${encodeURIComponent(code)}`;

class PassEnforcement extends EventEmitter {
  /**
   * @param {object} opts
   * @param {(msg: string) => void} [opts.log]
   * @param {() => boolean} [opts.rigPowerReadable] - true if the connected rig exposes
   *   TX power over CAT. Used to decide TX-disable vs clamp behavior.
   * @param {number} [opts.revalidateMs] - cloud re-read interval while a session is
   *   live (default REVALIDATE_MS; 0 disables — tests).
   */
  constructor(opts = {}) {
    super();
    this._log = opts.log || (() => {});
    this._rigPowerReadable = opts.rigPowerReadable || (() => true);
    this._revalidateMs = Number.isFinite(opts.revalidateMs) ? opts.revalidateMs : REVALIDATE_MS;
    this._revalidateTimer = null;

    this._state = 'idle';
    this._pass = null;            // { code, owner_callsign, privilege_class (long form), max_power_w, allowed_modes, ... }
    this._expiresAtMs = 0;         // absolute wall-clock ms — from cloud, monotonic-checked locally
    this._expiryTimer = null;
    this._expiringTimer = null;
    this._lastReason = '';
  }

  // ── Public API ────────────────────────────────────────────────────

  getState() {
    return this._state;
  }

  getSessionStatus() {
    if (this._state === 'idle') return { state: 'idle' };
    const remaining = Math.max(0, this._expiresAtMs - Date.now());
    return {
      state: this._state,
      code: this._pass && this._pass.code,
      ownerCallsign: this._pass && this._pass.owner_callsign,
      privilegeClass: this._pass && this._pass.privilege_class_short, // user-facing short form
      maxPowerW: this._pass && this._pass.max_power_w,
      allowedModes: this._pass && this._pass.allowed_modes,
      stationCallsign: this._pass && this._pass.station_callsign,
      operatorCallsign: this._pass && this._pass.operator_callsign,
      controlOperatorCallsign: this._pass && this._pass.control_operator_callsign,
      expiresAt: this._expiresAtMs ? new Date(this._expiresAtMs).toISOString() : null,
      remainingSeconds: Math.floor(remaining / 1000),
    };
  }

  /**
   * Load a pass profile from the cloud. Transitions idle → pending → active.
   * @param {string} code - pass code (case-insensitive; cloud normalizes)
   */
  async loadPass(code) {
    if (this._state !== 'idle') {
      throw new Error(`Cannot load pass in state ${this._state} — call endPass() first.`);
    }
    this._state = 'pending';
    this.emit('state-change', this._state);

    try {
      this._log(`pass-enforcement: validating code=${code} via ${PASS_VALIDATE_URL(code)}`);
      const res = await fetch(PASS_VALIDATE_URL(code), { method: 'GET' });
      if (res.status === 404) {
        this._log(`pass-enforcement: HTTP 404 — code not found / expired / revoked at cloud`);
        this._state = 'idle';
        this.emit('state-change', this._state);
        throw new Error('Pass not found, expired, or revoked.');
      }
      if (res.status === 429) {
        this._log(`pass-enforcement: HTTP 429 — rate limited by cloud (10 validates/min/IP). Retry shortly.`);
        this._state = 'idle';
        this.emit('state-change', this._state);
        throw new Error('Too many validation attempts. Try again in a minute.');
      }
      if (!res.ok) {
        this._log(`pass-enforcement: HTTP ${res.status} ${res.statusText} — cloud rejected validate`);
        this._state = 'idle';
        this.emit('state-change', this._state);
        throw new Error(`Pass validate failed: HTTP ${res.status}`);
      }
      const pass = await res.json();
      const longClass = CLASS_MAP[pass.privilege_class];
      if (!longClass) {
        this._state = 'idle';
        this.emit('state-change', this._state);
        throw new Error(`Unsupported privilege class: ${pass.privilege_class}`);
      }
      this._pass = {
        ...pass,
        privilege_class_short: pass.privilege_class,   // 'tech' | 'general' | 'extra'
        privilege_class: longClass,                    // 'us_technician' | etc. for isOutOfPrivilege
      };
      this._expiresAtMs = new Date(pass.expires_at).getTime();

      // Reject already-expired passes immediately.
      if (this._expiresAtMs <= Date.now()) {
        this._pass = null;
        this._expiresAtMs = 0;
        this._state = 'idle';
        this.emit('state-change', this._state);
        throw new Error('Pass already expired.');
      }

      this._state = 'active';
      this._scheduleExpiry();
      this._log(`pass-enforcement: active code=${pass.code} class=${pass.privilege_class} maxW=${pass.max_power_w} expires=${pass.expires_at}`);
      this.emit('state-change', this._state);
      return this.getSessionStatus();
    } catch (err) {
      if (this._state !== 'idle') {
        this._state = 'idle';
        this.emit('state-change', this._state);
      }
      throw err;
    }
  }

  /**
   * Force-end the current session. Idempotent.
   * @param {'expired'|'revoked'|'owner_override'|'guest_disconnect'} reason
   */
  endPass(reason = 'owner_override') {
    if (this._state === 'idle' || this._state === 'ended') return;
    if (this._expiryTimer) clearTimeout(this._expiryTimer);
    if (this._expiringTimer) clearTimeout(this._expiringTimer);
    if (this._revalidateTimer) clearInterval(this._revalidateTimer);
    this._expiryTimer = null;
    this._expiringTimer = null;
    this._revalidateTimer = null;
    this._lastReason = reason;
    this._state = 'ended';
    this._log(`pass-enforcement: ended reason=${reason} code=${this._pass && this._pass.code}`);
    this.emit('ended', { reason, code: this._pass && this._pass.code });
    this.emit('state-change', this._state);
    // Settle back to idle after listeners react.
    setImmediate(() => {
      this._pass = null;
      this._expiresAtMs = 0;
      this._state = 'idle';
      this.emit('state-change', this._state);
    });
  }

  /**
   * End the live session only if it rides the given pass. For the owner's
   * own revoke (Share My Rig "Revoke"): the cloud DELETE is authoritative
   * but silent, so the shack that issued it ends the guest itself, now,
   * rather than a minute later when the poll notices.
   * @returns {boolean} true if a session was ended
   */
  endPassIfCode(code, reason = 'revoked') {
    const live = this._pass && this._pass.code;
    if (!live || !code || String(live).toLowerCase() !== String(code).toLowerCase()) return false;
    if (this._state !== 'active' && this._state !== 'expiring') return false;
    this.endPass(reason);
    return true;
  }

  /**
   * Synchronous CAT-command filter. Called by tuneRadio() and the
   * gated TX-power / PTT helpers in main.js. Zero-cost in idle state.
   *
   * @param {object} cmd - { type, freqHz?, mode?, watts?, state? }
   * @returns {{ allowed: boolean, reason?: string, userVisible?: string }}
   */
  interceptCatCommand(cmd) {
    if (this._state !== 'active' && this._state !== 'expiring') {
      return { allowed: true };
    }

    if (Date.now() >= this._expiresAtMs) {
      this.endPass('expired');
      return { allowed: false, reason: 'expired', userVisible: 'Pass expired.' };
    }

    switch (cmd.type) {
      case 'tune': {
        const freqKhz = cmd.freqHz / 1000;
        const mode = (cmd.mode || '').toUpperCase();
        if (isOutOfPrivilege(freqKhz, mode, this._pass.privilege_class)) {
          return {
            allowed: false,
            reason: 'out_of_band',
            userVisible: this._formatOutOfBand(freqKhz, mode),
          };
        }
        // Mode restriction (if pass narrows modes further than class allows).
        if (this._pass.allowed_modes && this._pass.allowed_modes.length > 0) {
          if (!this._modeMatchesAllowedList(mode, this._pass.allowed_modes)) {
            return {
              allowed: false,
              reason: 'mode_not_allowed',
              userVisible: `Mode ${mode} is not permitted by this pass (allowed: ${this._pass.allowed_modes.join(', ')}).`,
            };
          }
        }
        return { allowed: true };
      }

      case 'tx_power': {
        const watts = Number(cmd.watts);
        if (!Number.isFinite(watts) || watts <= 0) {
          return { allowed: false, reason: 'invalid_power', userVisible: 'Invalid TX power.' };
        }
        const max = this._pass.max_power_w;
        if (watts > max) {
          return {
            allowed: false,
            reason: 'over_power',
            userVisible: `TX power ${watts}W exceeds pass cap (${max}W). Clamping.`,
            clampTo: max,
          };
        }
        return { allowed: true };
      }

      case 'tx_enable': {
        if (!this._rigPowerReadable()) {
          // Concept doc §"Power-cap": no CAT-readable power → TX disabled entirely.
          return {
            allowed: false,
            reason: 'tx_disabled_no_power_cat',
            userVisible: 'This rig does not expose TX power over CAT. TX is disabled during the pass session.',
          };
        }
        return { allowed: true };
      }

      default:
        // Unknown command types fall through allowed — interceptor only gates
        // the regulated surface (tune/power/PTT). Filter-width, AGC, etc.
        // are operator-discretion and not restricted by pass policy.
        return { allowed: true };
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  _scheduleExpiry() {
    const now = Date.now();
    const msUntilExpiry = Math.max(0, this._expiresAtMs - now);
    const msUntilExpiring = Math.max(0, msUntilExpiry - EXPIRING_WARN_MS);

    if (this._expiringTimer) clearTimeout(this._expiringTimer);
    if (this._expiryTimer) clearTimeout(this._expiryTimer);

    if (msUntilExpiring > 0) {
      this._expiringTimer = setTimeout(() => {
        if (this._state === 'active') {
          this._state = 'expiring';
          this.emit('expiring', { remainingMs: Math.max(0, this._expiresAtMs - Date.now()) });
          this.emit('state-change', this._state);
        }
      }, msUntilExpiring);
    } else if (this._state === 'active') {
      // Already inside the warn window — emit immediately.
      this._state = 'expiring';
      this.emit('expiring', { remainingMs: msUntilExpiry });
      this.emit('state-change', this._state);
    }

    this._expiryTimer = setTimeout(() => {
      this.endPass('expired');
    }, msUntilExpiry);

    if (this._revalidateTimer) clearInterval(this._revalidateTimer);
    this._revalidateTimer = null;
    if (this._revalidateMs > 0) {
      this._revalidateTimer = setInterval(() => { this._revalidate().catch(() => {}); }, this._revalidateMs);
      if (typeof this._revalidateTimer.unref === 'function') this._revalidateTimer.unref();
    }
  }

  // Re-read the live pass. The cloud answers one 404 for missing, expired,
  // revoked and not-yet-started alike (enumeration defense), and a session
  // that is live here cannot be missing or unstarted, so 404 = revoked.
  // Anything else — 429, 5xx, no network — is not evidence of anything and
  // is left for the next tick; a shorter expires_at (the cloud cannot
  // lengthen one) is adopted so the local timers stay authoritative.
  async _revalidate() {
    if (this._state !== 'active' && this._state !== 'expiring') return;
    const code = this._pass && this._pass.code;
    if (!code) return;
    let res;
    try { res = await fetch(PASS_VALIDATE_URL(code), { method: 'GET' }); } catch { return; }
    if (this._state !== 'active' && this._state !== 'expiring') return;
    if (!this._pass || this._pass.code !== code) return;
    if (res.status === 404) {
      this._log(`pass-enforcement: code=${code} no longer valid at the cloud — ending the session`);
      this.endPass('revoked');
      return;
    }
    if (!res.ok) return;
    let pass;
    try { pass = await res.json(); } catch { return; }
    const expMs = pass && pass.expires_at ? new Date(pass.expires_at).getTime() : NaN;
    if (Number.isFinite(expMs) && expMs < this._expiresAtMs) {
      this._expiresAtMs = expMs;
      this._scheduleExpiry();
    }
  }

  _modeMatchesAllowedList(mode, allowed) {
    const m = (mode || '').toUpperCase();
    // Cloud passes can use either FCC categories ('CW', 'PHONE', 'DATA')
    // or specific mode strings ('FT8', 'USB'). Match both shapes.
    for (const a of allowed) {
      const up = a.toUpperCase();
      if (up === m) return true;
      if (up === 'PHONE' && PHONE_MODES.has(m)) return true;
      if ((up === 'CW' || up === 'DATA' || up === 'DIGI') && CW_DIGI_MODES.has(m)) return true;
    }
    return false;
  }

  _formatOutOfBand(freqKhz, mode) {
    // Find which sub-band the requested freq falls in for the operator's class
    // and explain the limit in plain English.
    const ranges = PRIVILEGE_MAP[this._pass.privilege_class] || [];
    const classShort = this._pass.privilege_class_short || '';
    const freqMhz = (freqKhz / 1000).toFixed(3);
    for (const [lo, hi, allowed] of ranges) {
      if (freqKhz >= lo && freqKhz <= hi) {
        if (allowed === 'cw_digi') {
          return `Out of band: ${freqMhz} MHz allows CW/digital only on ${classShort} privileges.`;
        }
        if (allowed === 'phone') {
          return `Out of band: ${freqMhz} MHz allows phone modes only on ${classShort} privileges.`;
        }
      }
    }
    return `Out of band: ${freqMhz} MHz is outside ${classShort} privileges.`;
  }
}

module.exports = { PassEnforcement, CLASS_MAP };
