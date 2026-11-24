'use strict';
/**
 * QSO sounds and milestone banners (#1041): which sound a logged contact
 * makes, which daily milestones are marked, and what each one says.
 *
 * Everything here hangs off events that already exist. main.js says "a
 * contact went into the log" (qso-logged, from saveQsoRecord, the one place
 * every log path passes through) or "a save was refused" (qso-log-failed,
 * from logContact's own result). Nothing here builds, reads back or changes a
 * record. Whether a sound may play now, and on which output, is not decided
 * here: that is lib/sound-guard.js, asked before every play.
 *
 * A contact:
 *   - plays the coin (potacat-coin), or the operator's own "QSO logged chime"
 *     when they picked one before this build (contactSound);
 *   - a dupe plays two falling notes instead (potacat-dupe);
 *   - contacts closer together than PILEUP_GAP_MS play the short coin;
 *   - contacts inside BURST_MS of the last sound are one event and make one
 *     sound: the records of one contact (an n-fer, several callsigns) and the
 *     several contacts a Fox logs in one cycle;
 *   - a refused save plays the buzz (potacat-save-failed), also with Sounds
 *     switched off;
 *   - an ADIF import or a Cloud sync never reaches these events: silent.
 *
 * Sound follows the operator (playsHere): the device that logged the contact
 * plays it. A contact a phone logged through this desktop is silent here.
 *
 * Milestones, counted per UTC day on the counter the cat celebration always
 * used: MILESTONES get a one-line banner and, from 10 up, their own sound
 * after the coin. CAT_RUNGS keep the cat celebration as it was, without sound.
 *
 * Dual-mode: require() in main and tests, window.QsoSounds in the main window.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QsoSounds = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /** Contacts per UTC day that get a banner (and, from 10 up, a sound). */
  const MILESTONES = [1, 10, 25, 50, 100, 250];
  /** The cat celebration's own rungs: as before this build, no sound. */
  const CAT_RUNGS = [150, 200, 500];

  /** The sound of each milestone. 1 has none: the coin and the banner mark it. */
  const MILESTONE_SOUND = {
    10: 'potacat-010-pickup',
    25: 'potacat-025-power-up',
    50: 'potacat-050-stage-get',
    100: 'potacat-100-boss-down',
    250: 'potacat-250-world-clear',
  };
  const COIN = 'potacat-coin';
  const COIN_SHORT = 'potacat-coin-short';
  const DUPE = 'potacat-dupe';
  const SAVE_FAILED = 'potacat-save-failed';
  /** Every file in renderer/sounds/ (scripts/make-qso-sounds.js makes them), without ".wav". */
  const FILES = [COIN, COIN_SHORT, DUPE, SAVE_FAILED].concat(MILESTONES.map((m) => MILESTONE_SOUND[m]).filter(Boolean));

  /** The "QSO logged chime" flavours an operator could pick before this build. */
  const CHIME_FLAVOURS = ['soft', 'twotone', 'bell', 'morse-r'];

  const PILEUP_GAP_MS = 20000; // contacts closer together than this play the short coin
  const BURST_MS = 1500;       // logged events closer together than this are one sound
  const LIVE_MS = 3000;        // a count that rises this soon after a logged contact is that contact's
  const BANNER_MS = 3000;      // a milestone banner stays this long, then fades

  /** Settings, with the defaults: everything on. */
  const DEFAULTS = Object.freeze({
    soundsOn: true,          // Sounds (the master switch)
    soundContact: true,      // Contact logged sound
    soundMilestones: true,   // Milestone sounds
    milestoneBanners: true,  // Milestone banners
    soundVolume: 80,         // Volume, 10 to 100
    soundOutput: '',         // Sound output: '' is Automatic
  });
  const VOLUME_MIN = 10, VOLUME_MAX = 100;

  function volumeOf(v) {
    const n = Number(v);
    if (v == null || v === '' || !isFinite(n)) return DEFAULTS.soundVolume;
    return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(n)));
  }

  /** What the Sounds pane holds, read from settings (a missing key is its default). */
  function readSettings(s) {
    s = s || {};
    return {
      on: s.soundsOn !== false,
      contact: s.soundContact !== false,
      milestones: s.soundMilestones !== false,
      banners: s.milestoneBanners !== false,
      volume: volumeOf(s.soundVolume),
      output: typeof s.soundOutput === 'string' ? s.soundOutput : '',
      outputLabel: typeof s.soundOutputLabel === 'string' ? s.soundOutputLabel : '',
    };
  }

  /**
   * The contact sound: the chime flavour the operator picked before this
   * build, kept; the coin for everyone else ('off', nothing, anything unknown).
   */
  function contactSound(qsoChime) {
    return CHIME_FLAVOURS.includes(qsoChime) ? qsoChime : 'coin';
  }

  /**
   * The one-time "Keep it, or turn it off" banner: owed to an operator who
   * never picked a chime, so the coin is new to them, and who has not been
   * asked yet.
   */
  function coinOfferDue(s) {
    s = s || {};
    const cfg = readSettings(s);
    return cfg.on && cfg.contact && contactSound(s.qsoChime) === 'coin' && s.soundCoinOffered !== true;
  }
  const COIN_OFFER = Object.freeze({
    text: 'New: a short sound each time a contact is logged.',
    keep: 'Keep it',
    off: 'Turn it off',
  });

  /** "First contact today", "10 contacts today". */
  function milestoneText(m) {
    return Number(m) === 1 ? 'First contact today' : Number(m) + ' contacts today';
  }

  /**
   * Does THIS desktop make the sound for a logged (or refused) contact?
   * Not when a phone logged it through this desktop: the phone plays it.
   * @param {object} evt  { origin, fromDevice }
   *   origin      saveQsoRecord's: 'local-manual', 'jtcat-engine', 'wsjtx-bridge',
   *               'ws-log-qso' (an ECHOCAT device's log-qso), 'forwarded-from-host'
   *   fromDevice  a JTCAT contact an ECHOCAT device ran (it carries the device's log source)
   */
  function playsHere(evt) {
    if (!evt) return true;
    if (evt.origin === 'ws-log-qso') return false;
    return !evt.fromDevice;
  }

  function modeKey(m) {
    const u = String(m || '').toUpperCase();
    return u === 'USB' || u === 'LSB' ? 'SSB' : u;
  }
  /**
   * A dupe, by the rule the Activator dupe chip already uses: during an
   * activation, the same callsign on the same band and mode on the same UTC
   * day at the same park of mine. Their park counts too, so the park copies
   * of an n-fer and a park-to-park at a new park are not dupes. A contact
   * logged outside an activation is never a dupe.
   * @param {Array} existing  the worked entries already held for this callsign
   * @param {object} entry    { date, ref, myRef, band, mode } of the new record
   */
  function isDupe(existing, entry) {
    if (!entry || !entry.myRef || !entry.date) return false;
    const band = String(entry.band || '').toUpperCase();
    const mode = modeKey(entry.mode);
    const ref = String(entry.ref || '').toUpperCase();
    const myRef = String(entry.myRef).toUpperCase();
    for (const e of existing || []) {
      if (!e || e.date !== entry.date) continue;
      if (String(e.myRef || '').toUpperCase() !== myRef) continue;
      if (String(e.ref || '').toUpperCase() !== ref) continue;
      if (String(e.band || '').toUpperCase() !== band) continue;
      if (modeKey(e.mode) !== mode) continue;
      return true;
    }
    return false;
  }

  function createState() {
    return {
      loggedAt: null,   // the last logged contact, from any device
      hereAt: null,     // the last one this desktop makes the sound for
      contactAt: null,  // the last contact's time (pileup pace)
      soundAt: null,    // the last contact sound's time (burst)
      seeded: false,
      done: new Set(),
      lastCount: 0,
    };
  }

  /**
   * A contact went into the log (main's qso-logged).
   * @param {object} state     createState()
   * @param {object} evt       { origin, fromDevice, dupe }
   * @param {number} now       ms
   * @param {object} settings  the settings object (soundsOn, soundContact, qsoChime)
   * @returns {{ sound: null | { file: string } | { chime: string } }}
   */
  function contactLogged(state, evt, now, settings) {
    state.loggedAt = now;
    if (!playsHere(evt)) return { sound: null };
    state.hereAt = now;
    const inBurst = state.soundAt != null && now - state.soundAt < BURST_MS;
    const fast = state.contactAt != null && now - state.contactAt < PILEUP_GAP_MS;
    state.contactAt = now;
    if (inBurst) return { sound: null };
    state.soundAt = now;
    const cfg = readSettings(settings);
    if (!cfg.on || !cfg.contact) return { sound: null };
    if (evt && evt.dupe) return { sound: { file: DUPE } };
    const own = contactSound(settings && settings.qsoChime);
    if (own !== 'coin') return { sound: { chime: own } };
    return { sound: { file: fast ? COIN_SHORT : COIN } };
  }

  /**
   * A save was refused (main's qso-log-failed). The buzz plays with Sounds
   * switched off too; only "the phone logged it" keeps this desktop quiet.
   */
  function saveFailed(evt) {
    return { sound: playsHere(evt) ? { file: SAVE_FAILED } : null };
  }

  /**
   * Today's contact count changed (or was read for the first time).
   *
   * The first read marks every rung already passed, silently: no celebration
   * for contacts made before the app started. When that first read is itself
   * a contact's (the log was not read at launch, so the first count arrives
   * with the first contact), the rungs passed BEFORE that contact are the ones
   * marked: each record raises the count by one, so that is count - 1, and the
   * first contact of the day still gets its banner. A count that drops (a new UTC
   * day, a smaller logbook) starts the day's rungs again. When several rungs
   * are passed at once, the highest is the one marked.
   *
   * @param {object} state  createState()
   * @param {number} count  contacts today (UTC)
   * @param {number} now    ms
   * @param {object} [opts]
   * @param {object} [opts.settings]      the settings object; none = all on
   * @param {boolean} [opts.needsContact] the main window: a milestone needs a
   *   contact logged within LIVE_MS (an import or a sync that moves the count
   *   marks its rungs silently). The cat rungs never did and still do not.
   * @param {boolean} [opts.afterContact] this read follows a contact just saved
   *   (main says so; the main window knows from contactLogged)
   * @param {Array} [opts.rungs]          default MILESTONES and CAT_RUNGS
   * @returns {null | { rung, kind: 'milestone'|'cat', text, banner: boolean, sound: string|null }}
   */
  function countChanged(state, count, now, opts) {
    opts = opts || {};
    const rungs = (opts.rungs || MILESTONES.concat(CAT_RUNGS)).slice().sort((a, b) => a - b);
    count = Number(count) || 0;
    const fresh = state.loggedAt != null && now - state.loggedAt <= LIVE_MS;
    if (!state.seeded) {
      state.seeded = true;
      const before = (opts.afterContact || fresh) ? Math.max(0, count - 1) : count;
      state.lastCount = before;
      for (const m of rungs) if (before >= m) state.done.add(m);
      if (before === count) return null;
    }
    if (count < state.lastCount) state.done.clear();
    state.lastCount = count;
    let top = null;
    for (const m of rungs) {
      if (count >= m && !state.done.has(m)) { state.done.add(m); top = m; }
    }
    if (top == null) return null;
    if (CAT_RUNGS.includes(top)) return { rung: top, kind: 'cat', text: '', banner: false, sound: null };
    if (opts.needsContact && !fresh) return null;
    const cfg = readSettings(opts.settings);
    const here = state.hereAt != null && now - state.hereAt <= LIVE_MS;
    const file = MILESTONE_SOUND[top] || null;
    return {
      rung: top,
      kind: 'milestone',
      text: milestoneText(top),
      banner: cfg.banners,
      sound: file && here && cfg.on && cfg.milestones ? file : null,
    };
  }

  /**
   * What a Play or Hear button in Settings > Sounds plays (Casey 2026-11-24:
   * "I can't hear what the sounds will sound like"). The key is the "Sound:"
   * select's value (coin, soft, twotone, bell, morse-r: the sound a contact
   * makes with that choice) or a Hear button's data-sound (dupe, save-failed,
   * or a milestone with a tune: 10, 25, 50, 100, 250).
   * @returns {{ file: string } | { chime: string }}
   */
  function previewSound(key) {
    const k = String(key == null ? '' : key);
    if (k === 'dupe') return { file: DUPE };
    if (k === 'save-failed') return { file: SAVE_FAILED };
    if (/^\d+$/.test(k) && MILESTONE_SOUND[Number(k)]) return { file: MILESTONE_SOUND[Number(k)] };
    const own = contactSound(k);
    return own === 'coin' ? { file: COIN } : { chime: own };
  }

  /** The S2C qso-milestone message for an ECHOCAT device (docs/echocat-protocol.md). */
  function milestoneMessage(m, count) {
    return { type: 'qso-milestone', milestone: m, count: Number(count) || m, mega: false, message: milestoneText(m) };
  }

  return {
    MILESTONES, CAT_RUNGS, MILESTONE_SOUND, FILES, CHIME_FLAVOURS,
    COIN, COIN_SHORT, DUPE, SAVE_FAILED,
    PILEUP_GAP_MS, BURST_MS, LIVE_MS, BANNER_MS, DEFAULTS, VOLUME_MIN, VOLUME_MAX, COIN_OFFER,
    readSettings, contactSound, coinOfferDue, milestoneText, playsHere, isDupe,
    createState, contactLogged, saveFailed, countChanged, milestoneMessage, previewSound,
  };
}));
