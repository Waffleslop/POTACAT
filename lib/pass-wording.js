'use strict';

// What a Guest Pass guest is told, in one place (GitHub #541).
//
// A guest used one pass on the phone and on POTACAT as a remote. The pass
// was fine; POTACAT read a "the owner is on the radio" refusal as a dead
// pass and said it had been revoked. Every surface that tells a guest about
// their pass asks this module, so a waiting pass never reads as a dead one:
// only an expired or cancelled pass (or an older station's bare refusal)
// ends it.
//
// Dual-mode: POTACAT-as-remote loads it with a <script> tag (window.PassWording),
// ECHOCAT Web gets it inlined by remote-server.js, and lib/remote-client.js
// requires it for the retry timing. Pure.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PassWording = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const STILL_GOOD = 'Your pass is still good.';
  const CHECK_FAILED = 'Couldn\'t check your pass just now. Trying again.';

  // Waiting for a busy rig: ask again every minute.
  const RIG_IN_USE_RETRY_MS = 60 * 1000;
  // Cloud could not answer: 30 s, 1 min, 2 min, 4 min, then every 5 min.
  const CHECK_RETRY_BASE_MS = 30 * 1000;
  const CHECK_RETRY_MAX_MS = 5 * 60 * 1000;
  const NOT_STARTED_MAX_WAIT_MS = 6 * 60 * 60 * 1000;

  // Pass-ended reasons that end the pass itself. Every other reason
  // (left, disconnected, superseded, owner_override) closed one session;
  // the pass can be used again.
  const TERMINAL_END_REASONS = new Set(['expired', 'revoked']);

  function ownerName(owner) {
    const s = String(owner || '').trim().toUpperCase();
    return s || 'the owner';
  }

  function capFirst(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function hhmmUtc(endsAt) {
    const t = typeof endsAt === 'number' ? endsAt : Date.parse(endsAt);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const pad = (n) => (n < 10 ? '0' : '') + n;
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }

  function startsText(at) {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return 'This pass has not started yet. POTACAT connects when it starts.';
    return 'This pass starts at ' + hhmmUtc(t) + ' ' + new Date(t).toISOString().slice(0, 10) + '. POTACAT connects then.';
  }

  function endedText(endsAt) {
    const at = hhmmUtc(endsAt);
    return at ? 'Your Guest Pass ended at ' + at + '.' : 'Your Guest Pass has ended.';
  }

  function cancelledText(owner) {
    return capFirst(ownerName(owner)) + ' cancelled your Guest Pass.';
  }

  function waitingTitle(owner) {
    return 'Waiting: ' + ownerName(owner) + ' is using the radio';
  }

  function deviceWord(device) {
    const d = String(device || '').toLowerCase();
    if (/ios|iphone|android|phone|mobile/.test(d)) return 'phone';
    return 'other device';
  }

  /**
   * Is this auth-fail worth asking again? rig_in_use and pass_check_failed
   * are; pass_not_valid is not, and neither is a refusal with no code (an
   * older station that cannot say why).
   */
  function isRetryableAuthFail(code, reason) {
    if (code === 'pass_not_valid') return reason === 'not_started';
    return code === 'rig_in_use' || code === 'pass_check_failed';
  }

  /**
   * How long to wait before asking the station again after this auth-fail.
   * null = do not ask again (the pass is over).
   * @param {string} code
   * @param {number} attempt 0 for the first refusal in a row
   * @param {{reason?: string, at?: string, now?: number}} [o] pass_not_valid's
   *   reason and start time: a pass that has not started yet is asked again
   *   when it starts.
   */
  function retryDelayMs(code, attempt, o) {
    if (code === 'pass_not_valid') {
      if (!o || o.reason !== 'not_started') return null;
      const at = Date.parse(o.at);
      const now = typeof o.now === 'number' ? o.now : Date.now();
      if (!Number.isFinite(at)) return CHECK_RETRY_MAX_MS;
      // At the start time (a few seconds after, for clock skew); a long wait
      // is broken into 6 h steps, which a timer can hold.
      return Math.min(Math.max(at - now + 5000, 5000), NOT_STARTED_MAX_WAIT_MS);
    }
    if (code === 'rig_in_use') return RIG_IN_USE_RETRY_MS;
    if (code === 'pass_check_failed') {
      const n = Math.max(0, Math.floor(Number(attempt) || 0));
      return Math.min(CHECK_RETRY_BASE_MS * Math.pow(2, n), CHECK_RETRY_MAX_MS);
    }
    return null;
  }

  function isTerminalEndReason(reason) {
    return TERMINAL_END_REASONS.has(String(reason || ''));
  }

  /**
   * @param {object} p
   * @param {'auth-fail'|'pass-ended'|'kicked'|'paused'} p.kind
   * @param {string} [p.code]    auth-fail code (rig_in_use | pass_check_failed | pass_not_valid)
   * @param {string} [p.by]      rig_in_use: 'owner' | 'guest'
   * @param {string} [p.reason]  pass-ended reason, or pass_not_valid's reason
   * @param {string} [p.at]      pass_not_valid: when the pass ended or starts (Cloud's `at`)
   * @param {string} [p.owner]   owner's callsign
   * @param {number|string} [p.endsAt] the pass's end time
   * @param {string} [p.device]  kicked: the platform that took the radio
   * @returns {{title: string, line: string, stillGood: boolean, terminal: boolean, action: string}}
   *   line already carries "Your pass is still good." when stillGood.
   *   action is the button label ('' = none).
   */
  function describe(p) {
    const o = p || {};
    const kind = String(o.kind || '');
    const owner = o.owner;
    const good = (title, extra, action) => ({
      title,
      line: extra ? extra + ' ' + STILL_GOOD : STILL_GOOD,
      stillGood: true,
      terminal: false,
      action: action || '',
    });
    const over = (title, line) => ({ title, line: line || '', stillGood: false, terminal: true, action: '' });

    if (kind === 'paused') {
      return good(waitingTitle(owner) + '.',
        'You can keep listening. You\'re back on the air as soon as ' + ownerName(owner) + ' gives it back.', '');
    }
    if (kind === 'kicked') {
      return good('Your ' + deviceWord(o.device) + ' has the radio. One device at a time.', '', 'Use it here instead');
    }
    if (kind === 'pass-ended') {
      const reason = String(o.reason || '');
      if (reason === 'expired') return over(endedText(o.endsAt));
      if (reason === 'revoked') return over(cancelledText(owner));
      return good('', '', 'Connect again');
    }
    if (kind === 'auth-fail') {
      const code = String(o.code || '');
      if (code === 'rig_in_use') {
        return o.by === 'guest'
          ? good('Another guest is using the radio.', '', 'Try now')
          : good(waitingTitle(owner), '', 'Try now');
      }
      if (code === 'pass_check_failed') {
        // The pass is fine; only Cloud did not answer. Say so (plan v2: every
        // state but "over" says the pass is still good).
        return good(CHECK_FAILED, '', 'Try now');
      }
      if (code === 'pass_not_valid') {
        const reason = String(o.reason || '');
        if (reason === 'expired') return over(endedText(o.at || o.endsAt));
        if (reason === 'cancelled' || reason === 'revoked') return over(cancelledText(owner));
        if (reason === 'not_started') {
          return { title: startsText(o.at), line: '', stillGood: false, terminal: false, action: 'Try now' };
        }
        return over('This pass code is not known. Check the link from ' + ownerName(owner) + '.');
      }
      // An older station's bare refusal: it cannot say why, so the pass is
      // treated as over, but never called revoked.
      return over('This pass was not accepted.', 'Ask the owner for a fresh link.');
    }
    return { title: '', line: '', stillGood: false, terminal: false, action: '' };
  }

  /**
   * The extra fields a station puts on a Guest Pass auth-fail, so a client
   * that does not carry this module can still show the state as is:
   *   state: 'over' (pass_not_valid) | 'reconnecting' (pass_check_failed) | 'waiting' (rig_in_use)
   *   stateReason: over -> expired | cancelled | not_started | unknown;
   *                reconnecting -> check-failed; waiting -> owner | other-guest
   *   text: the words, title and line together.
   * @returns {{state: string, stateReason: string, text: string}|null} null for a code it does not know
   */
  function authFailFields(p) {
    const o = p || {};
    const code = String(o.code || '');
    let state, stateReason;
    if (code === 'pass_not_valid') {
      state = 'over';
      stateReason = ['expired', 'cancelled', 'not_started'].includes(o.reason) ? o.reason : 'unknown';
    } else if (code === 'pass_check_failed') {
      state = 'reconnecting'; stateReason = 'check-failed';
    } else if (code === 'rig_in_use') {
      state = 'waiting'; stateReason = o.by === 'guest' ? 'other-guest' : 'owner';
    } else {
      return null;
    }
    const w = describe({ kind: 'auth-fail', code, by: o.by, reason: stateReason, at: o.at, owner: o.owner });
    return { state, stateReason, text: [w.title, w.line].filter(Boolean).join(' ') };
  }

  // ---------------------------------------------------------------------------
  // pass-state words (#541 step 2): one sentence set per state and reason, for
  // the station's pass-state message (lib/pass-state.js). Every surface reads
  // this table: POTACAT as a remote, ECHOCAT Web, and (copied) the phone.
  //
  // title: the first entry whose placeholders all have a value is used.
  // line:  every entry whose placeholders all have a value, in order; then
  //        the owner's message, then "Your pass is still good." (every state
  //        but over).
  // Placeholders: {OWNER} the owner's call ("the owner" when unknown),
  // {END} the pass's end (HH:MM UTC), {TAKE} when the owner takes the radio
  // (HH:MM UTC), {START} when the pass starts (HH:MM UTC YYYY-MM-DD),
  // {DEVICE} the guest's other device, {APP} the app's name.
  // action: the one button ('' = none).
  const STATE_TABLE = {
    'on-air/none': {
      title: ['You\'re on the air.'],
      line: ['Your pass runs until {END}.'],
      action: '',
    },
    'on-air/ends-soon': {
      title: ['Your pass ends soon, at {END}.', 'Your pass ends soon.'],
      line: [],
      action: '',
    },
    'on-air/owner-soon': {
      title: ['{OWNER} will take the radio at {TAKE}.', '{OWNER} will take the radio soon.'],
      line: ['You can keep operating until then.'],
      action: '',
    },
    'waiting/owner-has-radio': {
      title: ['Waiting: {OWNER} is using the radio.'],
      line: ['You can keep listening. You\'re back on the air as soon as {OWNER} gives it back.'],
      action: '',
    },
    'waiting/owner-idle': {
      title: ['The radio at {OWNER}\'s station is free.'],
      line: ['Press Take the radio to go back on the air.'],
      action: 'Take the radio',
    },
    'waiting/other-device': {
      title: ['Your pass is in use on your {DEVICE}.', 'Your pass is in use on another device.'],
      line: ['One device at a time.'],
      action: 'Use it here instead',
    },
    'waiting/other-guest': {
      title: ['Another guest is using the radio.'],
      line: [],
      action: 'Try now',
    },
    'waiting/rig-in-use': {
      title: ['Someone else is using the radio.'],
      line: [],
      action: 'Try now',
    },
    'waiting/not_started': {
      title: ['This pass starts at {START}. {APP} connects then.', 'This pass has not started yet. {APP} connects when it starts.'],
      line: [],
      action: 'Try now',
    },
    'reconnecting/check-failed': {
      title: [CHECK_FAILED],
      line: [],
      action: 'Try now',
    },
    'reconnecting/network': {
      title: ['Can\'t reach {OWNER}\'s station. Trying again.'],
      line: [],
      action: 'Try now',
    },
    'reconnecting/station-offline': {
      title: ['{OWNER}\'s station is not online right now. Trying again.'],
      line: [],
      action: 'Try now',
    },
    'reconnecting/station-unavailable': {
      title: ['{OWNER}\'s station can\'t take guests right now. Trying again every 5 minutes.'],
      line: [],
      action: 'Try now',
    },
    'over/expired': {
      title: ['Your Guest Pass ended at {END}.', 'Your Guest Pass has ended.'],
      line: [],
      action: '',
    },
    'over/cancelled': {
      title: ['{OWNER} cancelled your Guest Pass.'],
      line: [],
      action: '',
    },
    'over/unknown': {
      title: ['This pass code is not known. Check the link from {OWNER}.'],
      line: [],
      action: '',
    },
  };

  function startsAt(at) {
    const t = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(t)) return '';
    return hhmmUtc(t) + ' ' + new Date(t).toISOString().slice(0, 10);
  }

  function fill(tpl, vals) {
    let missing = false;
    const out = tpl.replace(/\{([A-Z]+)\}/g, (m, k) => {
      const v = vals[k];
      if (!v) { missing = true; return ''; }
      return v;
    });
    return missing ? null : capFirst(out);
  }

  /**
   * The guest's words for a pass-state.
   * @param {{state: string, reason: string, endsAt?: string, takeAt?: string, message?: string, device?: string}} ps
   * @param {{owner?: string, app?: string}} [o]
   * @returns {{title: string, line: string, text: string, stillGood: boolean, terminal: boolean, action: string}}
   *   text is title and line together; line already carries "Your pass is
   *   still good." when stillGood. An unknown state/reason gives empty words.
   */
  function describeState(ps, o) {
    const p = ps || {};
    const opt = o || {};
    const row = STATE_TABLE[String(p.state || '') + '/' + String(p.reason || '')];
    if (!row) return { title: '', line: '', text: '', stillGood: false, terminal: false, action: '' };
    const owner = ownerName(opt.owner);
    const vals = {
      OWNER: owner,
      END: hhmmUtc(p.endsAt),
      TAKE: hhmmUtc(p.takeAt),
      START: startsAt(p.takeAt),
      DEVICE: String(p.device || '').trim(),
      APP: opt.app || 'POTACAT',
    };
    let title = '';
    for (const t of row.title) { const s = fill(t, vals); if (s != null) { title = s; break; } }
    const lines = [];
    for (const t of row.line) { const s = fill(t, vals); if (s != null) lines.push(s); }
    const msg = typeof p.message === 'string' ? p.message.trim() : '';
    if (msg) lines.push('Message from ' + owner + ': "' + msg + '"');
    const over = p.state === 'over';
    if (!over) lines.push(STILL_GOOD);
    const line = lines.join(' ');
    return {
      title,
      line,
      text: [title, line].filter(Boolean).join(' '),
      stillGood: !over,
      terminal: over,
      action: row.action,
    };
  }

  // Cloud /redeem error codes, in words. A code we do not know keeps the
  // fallback; a raw snake_case code is never shown.
  const REDEEM_ERRORS = {
    pass_claimed_by_another: 'This pass is already in use with another account. Sign in with the account you used first.',
    cannot_redeem_own_pass: 'This is your own pass. Send the link to your guest.',
    pass_for_another_callsign: 'This pass was made for another callsign. Sign in as that operator, or ask the owner for a pass in your callsign.',
  };

  function redeemErrorText(code, fallback) {
    const c = String(code || '').trim();
    if (REDEEM_ERRORS[c]) return REDEEM_ERRORS[c];
    if (c && /\s/.test(c)) return c; // already words, not a code
    return fallback || 'The pass could not be redeemed.';
  }

  return {
    STILL_GOOD,
    CHECK_FAILED,
    RIG_IN_USE_RETRY_MS,
    CHECK_RETRY_MAX_MS,
    describe,
    describeState,
    STATE_TABLE,
    authFailFields,
    retryDelayMs,
    isRetryableAuthFail,
    isTerminalEndReason,
    redeemErrorText,
    hhmmUtc,
    SDR_NOT_OWNERS: "On a Guest Pass you can use the station's own SDRs, not add a new one.", // #543
  };
}));
