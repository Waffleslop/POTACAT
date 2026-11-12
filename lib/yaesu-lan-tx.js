'use strict';
// Who transmits over the Yaesu SCU-LAN10 (#227). The unit takes one TX audio
// stream, and the radio one key-down: voice PTT, JTCAT, Tune, SSTV and voice
// macros each hold the LAN for their transmission. A key-down from anyone
// else while it is held is refused before PTT (never keyed, never unkeyed
// under the holder), and a release only cancels its own transmission.
// Before this, a voice PTT cancelled an FT8, Tune or SSTV buffer mid-air,
// and a JTCAT or Tune start unkeyed the radio under an open voice stream
// (Casey's review of PR #349).
// Pure: main.js holds the transport and keys the radio.

const OWNERS = Object.freeze(['voice', 'jtcat', 'tune', 'sstv', 'macro']);

const OWNER_LABELS = Object.freeze({
  voice: 'voice PTT',
  jtcat: 'JTCAT (FT8/FT4)',
  tune: 'Tune',
  sstv: 'an SSTV picture',
  macro: 'a voice macro',
});

// No holder: the key-down has no audio on the LAN, so it would be a silent carrier.
const NO_AUDIO_REFUSAL = "over the Yaesu LAN (SCU-LAN10) POTACAT transmits voice from the VFO window's PTT or ECHOCAT, " +
  'JTCAT (FT8/FT4), Tune, SSTV and voice macros so far; Winlink would send a silent carrier. For those, set Audio Source ' +
  "to the radio's USB sound card on this computer (CAT stays on the LAN).";

// Passed by the key-down that comes after a holder's own (the CAT TX1; the
// holder's PTT ends up in): it passes whenever someone holds the LAN.
const ANY_HOLDER = '*';

function busyRefusal(holder) {
  return `${OWNER_LABELS[holder] || holder} is transmitting over the Yaesu LAN (SCU-LAN10). ` +
    'Wait until it ends, or stop it first.';
}

class YaesuLanTxGate {
  constructor() { this._owner = null; }

  get owner() { return this._owner; }

  /** Take the LAN for `owner`. Null when it holds it now; otherwise the refusal. */
  claim(owner) {
    if (!OWNERS.includes(owner)) throw new Error(`unknown SCU-LAN10 TX owner: ${owner}`);
    if (this._owner && this._owner !== owner) return busyRefusal(this._owner);
    this._owner = owner;
    return null;
  }

  /** Give the LAN back. True only when `owner` held it (its buffer may be cancelled). */
  release(owner) {
    if (!owner || this._owner !== owner) return false;
    this._owner = null;
    return true;
  }

  /** Stuck-TX limit, disconnect: whoever held it. Returns that owner or null. */
  releaseAll() {
    const was = this._owner;
    this._owner = null;
    return was;
  }

  /**
   * The words for a key-down refused on the LAN route; null when it may key.
   * `asking`: the owner keying (passes only while it holds the LAN),
   * ANY_HOLDER (passes while anyone holds it), or null for a key-down from
   * outside the five (logger CAT, FreeDV, a custom CAT button).
   */
  refusal({ route, asking = null }) {
    if (!route) return null;
    if (!this._owner) return NO_AUDIO_REFUSAL;
    if (asking === ANY_HOLDER || asking === this._owner) return null;
    return busyRefusal(this._owner);
  }

  /**
   * May `owner` unkey the radio? On the LAN route only while it holds the LAN
   * or nobody does: a release must never drop someone else's transmission.
   */
  mayUnkey({ route, owner }) {
    if (!route || !this._owner) return true;
    return this._owner === owner;
  }
}

module.exports = {
  OWNERS,
  OWNER_LABELS,
  NO_AUDIO_REFUSAL,
  ANY_HOLDER,
  busyRefusal,
  YaesuLanTxGate,
};
