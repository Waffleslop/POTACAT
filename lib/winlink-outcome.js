// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// How a Winlink session ended, in the words every surface shows (#425).
//
// A session that connected, moved data for three minutes and then lost the
// link used to read "Failed connect: HTTP 500 — Session failure
// {"NumReceived":0}" (AE5JE, ARDOP on 40 m): POTACAT's own name for the HTTP
// call, Pat's status code and Pat's reply body, none of which say what
// happened or what to do. Pat answers /api/connect with that same body for
// EVERY session that did not finish (api/api.go ConnectHandler: "Session
// failure" plus the Inbox count), so the reply cannot tell a call nobody
// answered from a link that dropped half way. What POTACAT saw can.
//
// ONE function, describeOutcome(), turns those facts into the sentence. main.js
// calls it once per session and sends the result to every surface: the mail
// window's status bar and card, ECHOCAT Web's Mail tab and the phone
// (session.error / session.text / session.outcome on winlink-session and
// winlink-state). No surface words an ending itself, and Pat's raw reply goes
// to the log only (summaryLine()).
//
// Pure: no fs, no Electron, no clock.

'use strict';

const FreqDots = require('./freq-dots'); // 7.103.00 MHz, the way the VFO shows it

// Pat (wl2k-go transport/ardop tnc.go init()) sets the modem's ARQTIMEOUT to
// this on every connect: ardop.DefaultARQTimeout = 90 * time.Second. ardopcf's
// own default is 120 (ARDOPC.c: unsigned int ARQTimeout = 120). POTACAT's
// build of Pat can be asked for another value (lib/winlink-pat.js
// ARDOP_ARQ_TIMEOUT), so the sentence takes the value in force for the
// session (o.arqTimeoutS) and falls back to this one.
const PAT_ARDOP_ARQ_TIMEOUT_S = 90;

/** Whole seconds within what ardopcf accepts (30..240), or Pat's own 90. */
function _arqTimeoutS(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 30 && n <= 240 ? n : PAT_ARDOP_ARQ_TIMEOUT_S;
}

const MODEM_NAMES = Object.freeze({ ardop: 'ardopcf', packet: 'Dire Wolf', vara: 'VARA HF', varafm: 'VARA FM', mercury: 'Mercury' });
const MODE_WORDS = Object.freeze({ telnet: 'internet', ardop: 'ARDOP', packet: 'Packet', vara: 'VARA HF', varafm: 'VARA FM', mercury: 'Mercury' });

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function _count(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function gatewayName(gateway) {
  const g = String(gateway || '').toUpperCase().replace(/[^A-Z0-9/-]/g, '');
  return g || 'the gateway';
}

/**
 * A reason written by POTACAT (a refusal line, a device error, a setup
 * message) made safe for a status line: no HTTP status, no JSON, no name of an
 * internal call, one line, a sane length. What it removes is never the
 * meaning: those parts are Pat's or Node's, and they are in the log.
 */
function plainReason(s, max = 260) {
  let t = String(s == null ? '' : s);
  t = t.replace(/\{[^{}]*\}/g, ' ').replace(/[{}]/g, ' ');           // JSON, or what is left of it
  t = t.replace(/\bHTTP\s*\d{3}\b\s*[—:-]?\s*/gi, ' ');               // "HTTP 500 — "
  t = t.replace(/\bSession failure\b/gi, ' ');                       // Pat's body
  t = t.replace(/\bFailed connect\b:?/gi, ' ');
  // Leading labels, in whatever order they were stacked ("Stopped: connect: ..."):
  // the state word and PatHttpError's name for the call.
  for (let i = 0; i < 4; i++) t = t.replace(/^[\s—:;,.-]*(?:Stopped|Failed|connect)\s*:\s*/i, ' ');
  t = t.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (/^(?:Stopped|Failed|connect)$/i.test(t.replace(/[\s—:;,.-]+/g, ''))) t = '';   // a label with nothing after it
  t = t.replace(/^[\s—:;,.-]+/, '').replace(/[\s—:;,-]+$/, '');
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}

function _sentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return /[.!?…]$/.test(t) ? t : t + '.';
}

/**
 * Messages Pat took into the Inbox during a session that did not finish, from
 * its /api/connect reply body ('Session failure\n{"NumReceived":2}'). Pat
 * counts the Inbox before and after, so this is what really arrived. null when
 * the body does not say.
 */
function receivedFromPatBody(body) {
  const m = /"NumReceived"\s*:\s*(\d+)/.exec(String(body || ''));
  return m ? Number(m[1]) : null;
}

/**
 * What the session moved, from what POTACAT can read back and nothing else:
 *   sent     = Outbox when the session started minus Outbox now (Pat moves a
 *              message out of the Outbox only once the gateway has taken it);
 *   received = Pat's own Inbox count for the session;
 *   outbox   = the Outbox now.
 * A number POTACAT could not read is null and is not mentioned.
 */
function movedFacts({ queued, outbox, received } = {}) {
  const q = _count(queued), o = _count(outbox), r = _count(received);
  return { sent: q != null && o != null ? Math.max(0, q - o) : null, received: r, outbox: o, queued: q };
}

function _soFar(f) {
  const parts = [];
  if (f.sent != null) parts.push(`${f.sent} sent`);
  if (f.received != null) parts.push(`${f.received} received`);
  return parts.length ? `So far: ${parts.join(', ')}.` : '';
}

function _outboxLine(f, { connected } = {}) {
  if (f.outbox == null) return '';
  if (f.outbox > 0) {
    return connected
      ? `${plural(f.outbox, 'message is', 'messages are')} still in your Outbox and will go on the next try.`
      : `${plural(f.outbox, 'message is', 'messages are')} still in your Outbox.`;
  }
  if (connected && f.queued != null && f.queued > 0) return 'Your Outbox is empty: everything you wrote was sent.';
  return '';
}

const NEXT_RADIO = 'Try again, or try another gateway or another band.';
const NEXT_AFTER_RETRY = 'POTACAT already tried once more by itself. Try another gateway or another band, or try again later.';
const NEXT_INTERNET = 'Check this computer\'s internet connection, then try again.';

/** A finished exchange — the sentence every surface already showed. */
function doneText({ mode, gateway, sent, received } = {}) {
  const s = _count(sent) || 0, r = _count(received) || 0;
  const via = mode === 'telnet' ? 'over the internet' : `via ${gatewayName(gateway)} (${MODE_WORDS[mode] || mode || 'radio'})`;
  const out = s ? `Sent ${plural(s, 'message', 'messages')} ${via}` : `Checked mail ${via} — nothing to send`;
  const inb = r ? `${plural(r, 'new message', 'new messages')} in your Inbox` : 'no new mail';
  return `${out}; ${inb}.`;
}

// A cause POTACAT knows from its own side. Each of these already writes its
// own [Winlink] line when it happens; the status names the same cause.
//   word   the state word (the mail window's label; ECHOCAT Web's prefix)
//   title  (ctx) => the first sentence
//   next   the next step, or '' when the title already is one
const CAUSES = {
  operator: { word: 'Stopped', errorKind: 'stopped', title: () => 'You stopped the session.', next: '' },
  stall: { word: 'Stopped', errorKind: 'stopped', retry: true, title: () => 'POTACAT stopped the session: nothing moved for 3 minutes.', next: NEXT_RADIO },
  cap: { word: 'Stopped', errorKind: 'stopped', title: (c) => `POTACAT stopped the session at its ${c.capMin ? c.capMin + '-minute ' : 'time '}limit.`, next: 'Press Send / Receive again to carry on.' },
  swr: { word: 'Stopped', errorKind: 'stopped', title: (c) => `POTACAT stopped transmitting: the SWR guard tripped${c.detail ? ' (' + c.detail + ')' : ''}.`, next: 'Check the antenna and its match, then try again.' },
  'ptt-refused': { word: 'Stopped', errorKind: 'stopped', title: (c) => `The radio did not transmit${c.detail ? ': ' + c.detail : ''}.`, next: 'Put that right, then try again.' },
  'tx-failsafe': { word: 'Stopped', errorKind: 'stopped', title: () => 'POTACAT stopped the session: the transmitter stayed keyed for 30 seconds, so POTACAT unkeyed it.', next: 'Check that the radio has gone back to receive, then try again.' },
  'audio-device': { word: 'Stopped', errorKind: 'stopped', title: (c) => `The radio's sound device stopped${c.detail ? ': ' + c.detail : ''}.`, next: 'Check the radio\'s USB cable and its sound device in Settings > Radio, then try again.' },
  'audio-stopped': { word: 'Stopped', errorKind: 'stopped', title: () => 'POTACAT\'s modem audio stopped, so the session could not go on.', next: 'Try again. If it happens again, send a Report a Bug.' },
  'modem-stopped': { word: 'Stopped', errorKind: 'stopped', title: (c) => `The modem (${c.modem}) stopped during the session.`, next: 'Try again. If it happens again, send a Report a Bug.' },
  preempted: { word: 'Stopped', errorKind: 'stopped', title: () => 'The session was stopped because another part of POTACAT took the radio.', next: 'Try again when the radio is free.' },
  internal: { word: 'Stopped', errorKind: 'stopped', title: () => 'POTACAT hit an error and stopped the session.', next: 'Try again, and send a Report a Bug so it can be fixed.' },
  'pat-stopped': { word: 'Failed', errorKind: 'failed', title: () => 'The Winlink mail program (Pat) stopped during the session.', next: 'Try again. If it happens again, send a Report a Bug.' },
  'pat-lost': { word: 'Failed', errorKind: 'failed', title: () => 'POTACAT lost touch with the Winlink mail program (Pat) during the session.', next: 'Try again. If it happens again, send a Report a Bug.' },
  closing: { word: 'Stopped', errorKind: 'stopped', title: () => 'The session ended because POTACAT was closing.', next: '' },
  'turned-off': { word: 'Stopped', errorKind: 'stopped', title: () => 'The session ended because Winlink was turned off.', next: '' },
  stopped: { word: 'Stopped', errorKind: 'stopped', title: (c) => `POTACAT stopped the session${c.detail ? ': ' + c.detail : ''}.`, next: '' },
};

/**
 * Who ended an ARDOP link, in a clause, from what ardopcf's own log said
 * (lib/winlink-diag.js modem 'end' events). '' when it did not say.
 */
function _endClause(modemEnd, g, arqTimeoutS) {
  const by = modemEnd && modemEnd.by;
  if (by === 'timeout') return `nothing got through for ${_arqTimeoutS(arqTimeoutS)} seconds, so the modem ended the link`;
  if (by === 'gateway') return `${g} ended the link`;
  if (by === 'no-end') return `${g} stopped answering`;
  return '';
}

/**
 * The ending of one session, for every surface.
 *
 * @param {object} o
 * @param {'done'|'error'} o.state
 * @param {string} o.mode            telnet | ardop | packet | vara | varafm | mercury
 * @param {string} [o.gateway]
 * @param {boolean} [o.dialed]       POTACAT got as far as asking Pat to call
 * @param {boolean} [o.connected]    the link came up (Pat said so)
 * @param {{kind:string, detail?:string}} [o.cause]  a cause known from POTACAT's side (a CAUSES key)
 * @param {string} [o.hint]          what a Pat log line said: login-failed | no-answer | transport-down | rig-refused | vara-*
 * @param {string} [o.hintText]      POTACAT's sentence for that hint
 * @param {string} [o.setupText]     POTACAT's own reason a session could not start (before any call)
 * @param {number} [o.sent]          done only: messages sent (Pat's progress frames)
 * @param {number|null} [o.received] messages that reached the Inbox
 * @param {number|null} [o.queued]   the Outbox when the session started
 * @param {number|null} [o.outbox]   the Outbox now (null = not read)
 * @param {{by:string}} [o.modemEnd] who ended the link, if the modem said
 * @param {number} [o.arqTimeoutS]   ARDOP: the link timeout in force, seconds (90 when not given)
 * @param {boolean} [o.modemAudioClosed]  the modem closed its audio connection to POTACAT mid-session
 * @param {number} [o.txCutMs]       transmit audio the sound card would not take, this session
 * @param {number} [o.capMin]
 * @returns {{kind:string, ok:boolean, word:string, errorKind:string, title:string, detail:string, next:string, text:string, retry:boolean}}
 */
function describeOutcome(o = {}) {
  const mode = String(o.mode || '');
  const radio = mode !== 'telnet';
  const g = gatewayName(o.gateway);
  const modem = MODEM_NAMES[mode] || 'the modem';
  const facts = movedFacts(o);
  const build = (kind, word, errorKind, title, detailParts, next, extra = {}) => {
    const detail = detailParts.filter(Boolean).join(' ');
    const t = _sentence(title);
    return { kind, ok: false, word, errorKind, title: t, detail, next: next || '', text: [t, detail, next].filter(Boolean).join(' '), retry: !!extra.retry };
  };

  if (o.state === 'done') {
    const text = doneText({ mode, gateway: o.gateway, sent: o.sent, received: o.received });
    return { kind: 'done', ok: true, word: 'Finished', errorKind: '', title: text, detail: '', next: '', text, retry: false };
  }

  const connected = !!o.connected;
  const moved = connected ? [_soFar(facts), _outboxLine(facts, { connected: true })] : [_outboxLine(facts, { connected: false })];

  // 1. A cause POTACAT knows from its own side.
  const ck = o.cause && o.cause.kind;
  if (ck && CAUSES[ck]) {
    const c = CAUSES[ck];
    const title = c.title({ detail: plainReason(o.cause.detail, 200), modem, capMin: o.capMin, gateway: g });
    return build(ck, c.word, c.errorKind, title, moved, c.next, { retry: !!c.retry && radio });
  }

  // 2. Winlink refused the password: that happens after the link is up, and it is not a drop.
  if (o.hint === 'login-failed') {
    return build('login-failed', 'Failed', 'login-failed', plainReason(o.hintText, 320) || 'Winlink refused the password. Check it in Settings > Station > Winlink.', moved, '');
  }

  // 3. The session never got as far as a call: POTACAT's own reason.
  if (!o.dialed) {
    const why = plainReason(o.setupText || o.hintText, 420) || 'The session could not start. See the [Winlink] lines in the log.';
    return build('setup', 'Failed', o.hint || 'failed', why, [], '');
  }

  // 4. The link came up, then ended before the exchange finished.
  if (connected) {
    if (!radio) {
      return build('dropped', 'Link dropped', 'dropped', 'The internet connection to Winlink closed before the mail exchange finished.', moved, NEXT_INTERNET);
    }
    if (o.modemAudioClosed) {
      return build('modem-audio-closed', 'Link dropped', 'dropped',
        `The modem (${modem}) closed its audio connection to POTACAT, and the link to ${g} ended before the mail exchange finished.`,
        moved, 'Try again. If it happens again, send a Report a Bug.', { retry: true });
    }
    const clause = mode === 'ardop' ? _endClause(o.modemEnd, g, o.arqTimeoutS) : '';
    // The automatic retry dropped too: POTACAT does not try a third time by itself.
    const title = o.autoRetry
      ? `The link to ${g} dropped again${clause ? ': ' + clause : ''}.`
      : `The link to ${g} dropped before the mail exchange finished${clause ? ': ' + clause : ''}.`;
    const cut = _count(o.txCutMs);
    const audio = cut ? `POTACAT's transmit audio was interrupted for ${cut} ms during the session, which can break a link.` : '';
    return build('dropped', 'Link dropped', 'dropped', title, [...moved, audio], o.autoRetry ? NEXT_AFTER_RETRY : NEXT_RADIO, { retry: true });
  }

  // 5. Never connected.
  if (o.hint === 'transport-down' || o.hint === 'rig-refused') {
    const why = plainReason(o.hintText, 320) || (o.hint === 'rig-refused' ? 'POTACAT refused the tune or the transmission. See the [Winlink] lines in the log.' : `The modem (${modem}) is not answering.`);
    return build(o.hint, 'Failed', o.hint, why, moved, '');
  }
  if (!radio) {
    return build('not-connected', 'Not connected', 'not-connected', 'Could not reach Winlink over the internet.', moved, NEXT_INTERNET);
  }
  if (o.hint === 'no-answer') {
    return build('no-answer', 'No answer', 'no-answer', `${g} did not answer.`, moved, NEXT_RADIO, { retry: true });
  }
  return build('not-connected', 'Not connected', 'not-connected', `The call to ${g} did not connect.`, moved, NEXT_RADIO, { retry: true });
}

// ── the one summary line for the log (#425 B1) ───────────────────────────────

function _dur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 'not known';
  const s = Math.round(n / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

const KIND_WORDS = {
  done: 'mail exchanged',
  dropped: 'the link dropped after it connected',
  'modem-audio-closed': 'the link dropped after it connected (the modem closed its audio connection)',
  'no-answer': 'never connected (no answer)',
  'not-connected': 'never connected',
  setup: 'never called (could not start)',
  'login-failed': 'Winlink refused the password',
};

/**
 * One line that says how a session ended, with everything a reader needs to
 * tell a lost path from a POTACAT fault without asking for more: the gateway,
 * the dial, the mode, how long it ran, what moved, the modem's last state,
 * which side ended it if the modem said, the audio's health, and Pat's own
 * last words (the raw reply lives here and in Pat's log, never in the status).
 */
function summaryLine(o = {}) {
  const out = o.outcome || {};
  const facts = movedFacts(o);
  const kind = KIND_WORDS[out.kind] || (out.kind ? `stopped by POTACAT (${out.kind})` : 'ended');
  const parts = [`session summary: ${kind}${o.connected && out.kind !== 'done' && !/dropped/.test(out.kind || '') ? ', after the link had connected' : ''}${o.autoRetry ? ' (this was the automatic retry after a dropped link)' : ''}`];
  if (o.mode !== 'telnet') {
    parts.push(`gateway ${gatewayName(o.gateway)}`);
    const k = Number(o.dialKhz);
    parts.push(`dial ${Number.isFinite(k) && k > 0 ? k.toFixed(1) + ' kHz' : 'not known'}`);
  }
  parts.push(`mode ${MODE_WORDS[o.mode] || o.mode || 'not known'}`);
  // ARDOP: the link timeout in force. "set" = the modem's own log showed Pat
  // giving it that value; "asked" = what POTACAT asked Pat for, not seen there.
  if (o.mode === 'ardop') {
    const set = Number(o.arqTimeoutSetS), asked = Number(o.arqTimeoutAskedS);
    if (set > 0) parts.push(`link timeout ${set} s (set in the modem${asked > 0 && asked !== set ? `; POTACAT asked for ${asked} s` : ''})`);
    else if (asked > 0) parts.push(`link timeout ${asked} s asked (the modem's log did not show it being set)`);
  }
  parts.push(`ran ${_dur(o.ranMs)}${o.connectedMs != null ? ` (connected for ${_dur(o.connectedMs)})` : o.connected ? '' : ' (never connected)'}`);
  const moved = [];
  moved.push(facts.sent != null ? `${facts.sent} sent` : 'sent not known');
  moved.push(facts.received != null ? `${facts.received} received` : 'received not known');
  moved.push(facts.outbox != null ? `${facts.outbox} in the Outbox` : 'Outbox not read');
  if (o.inProgress) moved.push(String(o.inProgress).slice(0, 80));
  parts.push(`moved: ${moved.join(', ')}`);
  parts.push(`last modem state: ${o.modemState ? String(o.modemState).slice(0, 240) : 'not reported'}`);
  parts.push(`ended by: ${o.endedBy ? String(o.endedBy).slice(0, 140) : 'not reported'}`);
  if (o.radioMode) parts.push(`radio mode: ${String(o.radioMode).slice(0, 200)}`);
  if (o.audio) parts.push(`audio: ${String(o.audio).slice(0, 200)}`);
  // #300: the receive peak, what our overs sent to the radio, and the plain-words warning when that was full scale.
  if (o.levels) parts.push(`levels: ${String(o.levels).slice(0, 200)}`);
  if (o.levelsAdvice) parts.push(String(o.levelsAdvice).slice(0, 260));
  if (o.patLine) parts.push(`Pat's last line: ${String(o.patLine).replace(/[\r\n]+/g, ' ').slice(0, 160)}`);
  if (o.raw) parts.push(`Pat's reply: ${String(o.raw).replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
  return parts.join('; ');
}

/**
 * The summary lines kept in memory for Report a Bug: the last `radio` radio
 * sessions and the last `internet` internet ones. The internet auto-check runs
 * every half hour, and must never push the radio session that dropped out of
 * the report. `list` is changed in place: [{ at, radio, line }], oldest first.
 */
function keepSummary(list, entry, { radio = 8, internet = 2 } = {}) {
  list.push({ at: Number(entry.at) || 0, radio: !!entry.radio, line: String(entry.line || '') });
  for (const [isRadio, max] of [[true, radio], [false, internet]]) {
    let over = list.filter((e) => e.radio === isRadio).length - max;
    for (let i = 0; i < list.length && over > 0; i++) if (list[i].radio === isRadio) { list.splice(i--, 1); over--; }
  }
  return list;
}

/** Those lines as text, each with its UTC time, oldest first. */
function summaryLines(list) {
  return (list || []).map((e) => `${new Date(e.at).toISOString().slice(0, 19)}Z ${e.line}`);
}

/** "Who ended it" for the summary line, from the modem's end event and POTACAT's own cause. */
function endedByText({ cause, modemEnd, mode } = {}) {
  const by = modemEnd && modemEnd.by;
  const said = modemEnd && modemEnd.text ? ` (${modemEnd.text})` : '';
  if (cause && cause.kind) return `POTACAT (${cause.kind}${cause.detail ? ': ' + plainReason(cause.detail, 80) : ''})`;
  if (by === 'timeout') return `this station's modem, on its ARQ timeout${said}`;
  if (by === 'gateway') return `the gateway${said}`;
  if (by === 'no-end') return `this station's modem; the gateway did not acknowledge the disconnect${said}`;
  if (by === 'host') return (modemEnd && modemEnd.text) || 'Pat asked the modem to disconnect';
  return mode === 'ardop' ? 'the modem did not say' : 'not reported by this modem';
}

// ── the automatic retry after a dropped link (#425) ──────────────────────────

/**
 * The sentence for a pending, started or abandoned automatic retry
 * (lib/winlink-auto-retry.js decides; this words it, for every surface).
 * @param {object} r
 * @param {string} r.state     counting | waiting-clear | starting | cancelled | skipped
 * @param {string} r.gateway
 * @param {number} [r.inS]     seconds left on the countdown
 * @param {boolean} [r.noCat]  the radio has no CAT control: its dial cannot be checked
 * @param {number} [r.dialKhz]
 * @param {string} [r.why]     cancelled / skipped: the reason ('busy' = the channel stayed busy)
 * @param {number} [r.waitedS] waiting-clear: seconds waited so far
 * @param {number} [r.maxWaitS]
 */
function retryText(r = {}) {
  const g = gatewayName(r.gateway);
  const k = Number(r.dialKhz);
  const mhz = Number.isFinite(k) && k > 0 ? FreqDots.khzMhz(k) : 'the gateway\'s frequency';
  const dial = r.noCat ? ` The radio must still be on ${mhz}.` : '';
  switch (r.state) {
    case 'counting': return `Trying ${g} again in ${Math.max(0, Math.round(Number(r.inS) || 0))} s.${dial}`;
    case 'waiting-clear': return `Waiting for the channel to clear before trying ${g} again (${Math.max(0, Math.round(Number(r.waitedS) || 0))} s of ${Math.round(Number(r.maxWaitS) || 60)} s).${dial}`;
    case 'starting': return `Trying ${g} again now (automatic retry).`;
    case 'cancelled': return `Not retried: ${r.why || 'it was cancelled'}.`;
    case 'skipped': return r.why === 'busy' ? 'Not retried: the channel stayed busy.' : `Not retried: ${r.why || 'the radio was not ready'}.`;
    default: return '';
  }
}

// ── the gateway history's "Last result" (#254) ───────────────────────────────

/**
 * One attempt from Pat's event log, in the same words. Pat's own error text
 * (Go errors: "dial tcp ...", "EOF") never shows; it only picks the wording.
 */
function historyResult(a = {}) {
  if (a.exchanged) {
    const s = a.sent || 0, r = a.received || 0;
    return 'Mail exchanged' + (s || r ? ` (${s} sent, ${r} received)` : '');
  }
  const e = String(a.error || '').toLowerCase();
  if (a.connected) {
    if (/secure login|password/.test(e)) return 'Winlink refused the password';
    if (/abort|cancel/.test(e)) return 'Stopped';
    // Pat writes the exchange's error when the link is lost ("connection
    // lost", seen in the no-RF loopback). With no exchange event at all Pat
    // never finished the exchange (the operator's Abort, POTACAT closed): the
    // log cannot say which, so neither does this.
    return e ? 'Link dropped before the mail exchange finished' : 'Connected, but the mail exchange did not finish';
  }
  if (/timeout|no answer/.test(e)) return 'Did not answer';
  if (/clear channel|busy/.test(e)) return 'Stopped: the channel was busy';
  if (/abort|cancel/.test(e)) return 'Stopped';
  if (/port closed|connection refused|not running|no such|tnc closed/.test(e)) return 'The modem was not running';
  return 'Did not connect';
}

module.exports = {
  PAT_ARDOP_ARQ_TIMEOUT_S,
  describeOutcome,
  doneText,
  summaryLine,
  keepSummary,
  summaryLines,
  endedByText,
  movedFacts,
  receivedFromPatBody,
  plainReason,
  historyResult,
  retryText,
  NEXT_AFTER_RETRY,
  gatewayName,
  CAUSE_KINDS: Object.freeze(Object.keys(CAUSES)),
};
