'use strict';

// Which way a Flex's GUI slot goes: through POTACAT (Flex Direct) or to
// ECHOCAT, which takes the radio itself over FlexRadio's SmartLink.
//
// Casey 2026-11-17: "easy to choose, on a Flex, whether I go through my
// computer or via Flex SmartLink while on ECHOCAT." The 8600M licenses ONE GUI
// client (licensed_clients=1; a second `client gui` gets F3000001), and a
// SmartLink client only gets audio when it is the radio's only GUI client. So
// choosing SmartLink on the mobile device is a hand-over: POTACAT lets go of
// its GUI slot on request and takes it back cleanly. Design: the workspace's
// docs/smartlink-spec-2026-11-16.md, sections 6a and 6b.
//
// This file is the rule: the four states, what moves between them, when a
// release is refused and with which sentence, when the person at the desk is
// asked, the 60-second no-GUI-client reclaim, and the reclaim retry window.
// main.js only wires it (lib/flex-gui-watch.js watches the radio's clients).
//
//   pc          POTACAT holds the radio as its own GUI client (Flex Direct).
//   releasing   POTACAT is stopping its automation and closing its links.
//   released    The radio is ECHOCAT's. Nothing in POTACAT reconnects or
//               reclaims; a non-GUI LAN connection watches the GUI clients.
//               Kept in settings, so it survives a restart.
//   reclaiming  POTACAT is asking for its GUI slot back (`client gui <id>`).
//
// Pure: no sockets, no timers. The clock is passed in.

const STATES = Object.freeze(['pc', 'releasing', 'released', 'reclaiming']);

const NO_GUI_RECLAIM_MS = 60 * 1000;   // radio with no GUI client this long: take it back
const DESK_RECENT_MS = 2 * 60 * 1000;  // the computer used this recently: ask first
const DESK_ASK_TIMEOUT_MS = 30 * 1000; // no answer at the desk in this time: refuse
const RECLAIM_RETRY_MS = 2000;         // F3000001: try again this often
const RECLAIM_WINDOW_MS = 20 * 1000;   // ... for this long, then give up
const RADIO_FULL = 0xF3000001;         // "The maximum number of connected clients has been reached"

// Every sentence a person sees, in one place. "FlexRadio SmartLink", never a
// bare "SmartLink" (the spec's wording rule); "mobile device", not "phone".
const TEXT = Object.freeze({
  transmitting: 'The radio is transmitting. Try again when it stops.',
  winlink: 'A Winlink session is running on the computer. Try again when it ends.',
  guest: 'A guest has the radio.',
  notFlexDirect: 'POTACAT is not running this Flex as its own client (Flex Direct), so there is nothing to hand over.',
  busy: 'POTACAT is already handing the radio over. Try again in a moment.',
  deskSaidNo: 'The person at the computer did not agree.',
  stillHeld: 'The radio is still held by another client.',
  unreachable: 'POTACAT could not reach the radio to take it back.',
  rigRefused: 'The radio is on FlexRadio SmartLink with your mobile device.',
  banner: 'The radio is with ECHOCAT through FlexRadio SmartLink.',
  takeBackWarn: 'Your mobile device will lose the radio.',
  deskAsk: 'Your mobile device asks for the radio, to use it through FlexRadio SmartLink. POTACAT will let go of the radio.',
});

// ECHOCAT messages that need the radio. While released they are refused with
// TEXT.rigRefused; spots, logging and everything else keep working. Stopping
// something (estop, a halt, cw-stop) is never refused.
const RIG_TYPES = new Set([
  'tune', 'ptt', 'set-mode', 'set-filter', 'filter-step', 'set-nb', 'set-vfo',
  'swap-vfo', 'set-rfgain', 'set-txpower', 'set-tx-drive', 'set-rx-level',
  'set-cw-filter', 'set-ssb-filter', 'set-digital-filter',
  'scan-control', 'scan-step', 'rig-control', 'set-atu', 'atu-tune',
  'apply-vfo-profile', 'apply-rig-preset', 'rig-reconnect', 'scope-enable-radio',
  'swr-guard-override',
  'paddle', 'cw-key', 'cw-text', 'voice-macro-play', 'voice-macro-play-audio',
  'sstv-photo', 'freedv-start', 'freedv-set-tx',
  'jtcat-start', 'jtcat-call-cq', 'jtcat-reply', 'jtcat-enable-tx',
  'jtcat-wspr-beacon', 'jtcat-full-auto-cq', 'jtcat-tune-toggle', 'jtcat-set-band',
  'jtcat-psk-send', 'jtcat-jtty-send', 'jtcat-start-multi-remote',
  'js8-start', 'js8-send', 'js8-send-hb', 'js8-heartbeat', 'js8-send-sms', 'js8-set-band',
  'winlink-connect', 'winlink-qsy', 'winlink-retry',
]);

function isRigCommand(msg) {
  const type = msg && typeof msg === 'object' ? msg.type : msg;
  return RIG_TYPES.has(String(type || ''));
}

/** True when someone at the computer used it in the last two minutes and can
 *  see POTACAT: the OS idle time (keyboard or mouse anywhere on the PC), a
 *  visible main window, not headless. markUserActive() is not used: ECHOCAT's
 *  own actions also stamp it, so the asking device would look like the desk. */
function deskInUse({ systemIdleSec, windowVisible, headless } = {}) {
  if (headless || !windowVisible || systemIdleSec == null) return false;
  const idle = Number(systemIdleSec);
  if (!Number.isFinite(idle) || idle < 0) return false;
  return idle * 1000 < DESK_RECENT_MS;
}

/**
 * What to do with a flex-release request.
 * ctx: { state, flexDirect, guestPass, transmitting, winlink, deskInUse }
 * Returns { action: 'done' } (already released), { action: 'refuse', error },
 * { action: 'ask' } (ask the person at the desk first) or { action: 'release' }.
 */
function decideRelease(ctx = {}) {
  const state = ctx.state || 'pc';
  if (state === 'released') return { action: 'done' };
  if (state !== 'pc') return { action: 'refuse', error: TEXT.busy };
  if (!ctx.flexDirect) return { action: 'refuse', error: TEXT.notFlexDirect };
  if (ctx.guestPass) return { action: 'refuse', error: TEXT.guest };
  if (ctx.transmitting) return { action: 'refuse', error: TEXT.transmitting };
  if (ctx.winlink) return { action: 'refuse', error: TEXT.winlink };
  if (ctx.deskInUse) return { action: 'ask' };
  return { action: 'release' };
}

/**
 * After one failed `client gui` during a reclaim: try again or give up.
 * status: the radio's reply code (number) or null for no reply / no link.
 * Returns { action: 'retry', delayMs } or { action: 'fail', error }.
 */
function reclaimNext({ startedAt, now, status } = {}) {
  const full = status != null && (Number(status) >>> 0) === RADIO_FULL;
  if (now + RECLAIM_RETRY_MS - startedAt <= RECLAIM_WINDOW_MS) return { action: 'retry', delayMs: RECLAIM_RETRY_MS };
  return { action: 'fail', error: full ? TEXT.stillHeld : TEXT.unreachable };
}

/** Status code as the log shows it (F3000001). */
function statusHex(status) {
  return status == null ? 'none' : (Number(status) >>> 0).toString(16).toUpperCase();
}

class FlexRoute {
  /** saved: settings.flexRoute ({state:'released', since, holder}) or null. */
  constructor({ now = Date.now, saved = null } = {}) {
    this._now = now;
    this._state = 'pc';
    this._since = now();
    this._holder = null;
    this._noGuiSince = null;
    if (saved && saved.state === 'released') {
      this._state = 'released';
      this._since = Number.isFinite(saved.since) ? saved.since : now();
      this._holder = typeof saved.holder === 'string' && saved.holder ? saved.holder : null;
    }
  }

  get state() { return this._state; }
  get since() { return this._since; }
  get holder() { return this._holder; }
  /** The radio is not POTACAT's: nothing may reconnect or reclaim it on its own. */
  get held() { return this._state === 'released' || this._state === 'releasing'; }

  /** The wire shape (S2C flex-route without its type). */
  snapshot() {
    const out = { state: this._state, since: this._since };
    if (this._holder && this._state !== 'pc') out.holder = this._holder;
    return out;
  }

  /** What goes in settings. A reclaim in progress is still released on disk:
   *  a crash in the middle comes back released and the 60 s rule finishes it. */
  toSaved() {
    if (this._state === 'released' || this._state === 'reclaiming') {
      const out = { state: 'released', since: this._since };
      if (this._holder) out.holder = this._holder;
      return out;
    }
    return null;
  }

  _go(state) {
    this._state = state;
    this._since = this._now();
    this._noGuiSince = null;
    return true;
  }

  beginRelease(holder) {
    if (this._state !== 'pc') return false;
    this._holder = typeof holder === 'string' && holder ? holder.slice(0, 64) : 'ECHOCAT';
    return this._go('releasing');
  }

  finishRelease(ok) {
    if (this._state !== 'releasing') return false;
    if (!ok) { this._holder = null; return this._go('pc'); }
    return this._go('released');
  }

  beginReclaim() {
    if (this._state !== 'released') return false;
    return this._go('reclaiming');
  }

  finishReclaim(ok) {
    if (this._state !== 'reclaiming') return false;
    if (ok) { this._holder = null; return this._go('pc'); }
    return this._go('released');
  }

  /** The radio's GUI clients as the watch sees them (POTACAT's own watch is
   *  never one). Starts or stops the no-GUI clock while released. */
  noteGuiClients(count) {
    if (this._state !== 'released') { this._noGuiSince = null; return; }
    if (count > 0) this._noGuiSince = null;
    else if (this._noGuiSince == null) this._noGuiSince = this._now();
  }

  /** The watch lost the radio: nothing is known, so the clock stops. */
  noteWatchLost() { this._noGuiSince = null; }

  /** ms the radio has had no GUI client, or null. */
  noGuiForMs() {
    return this._noGuiSince == null ? null : this._now() - this._noGuiSince;
  }

  /** Released and the radio has had no GUI client for 60 s straight. */
  autoReclaimDue() {
    const ms = this.noGuiForMs();
    return this._state === 'released' && ms != null && ms >= NO_GUI_RECLAIM_MS;
  }
}

module.exports = {
  STATES, TEXT, RIG_TYPES, RADIO_FULL,
  NO_GUI_RECLAIM_MS, DESK_RECENT_MS, DESK_ASK_TIMEOUT_MS, RECLAIM_RETRY_MS, RECLAIM_WINDOW_MS,
  FlexRoute, decideRelease, reclaimNext, deskInUse, isRigCommand, statusHex,
};
