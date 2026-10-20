'use strict';
//
// "Keep the tuner on after a tune cycle" (KF0HOG, FT-710 + mAT-30, 2026-10-20).
//
// A Yaesu of the AC001;/AC000;/AC003; family runs a full tune on AC003;
// and, with an external tuner on the TUNER jack, switches the tuner OFF when
// the cycle ends (the mAT-30's Online LED goes out) — the operator then has
// to press TUNE on the radio before every QSO. Station Master Pro's answer
// is manual ON/OFF buttons; ours is a per-rig option that watches the tune
// through `AC;` and sends AC001; the moment the radio reports the tuner off.
//
// Pure: the decision per poll reply lives here, main.js does the polling
// and the sending. The FT-710 answers `AC;` with `AC00P;` — P = 0 tuner
// off, 1 tuner on, 2 tuning in progress.

const ATU_KEEP_ON_TIMEOUT_MS = 20000;   // a tune cycle is a few seconds; this is the give-up
const ATU_KEEP_ON_POLL_MS = 500;
const ATU_KEEP_ON_FIRST_POLL_MS = 1500; // let the radio start before the first question

/** @returns {'off'|'on'|'tuning'|'unknown'} */
function parseAcReply(reply) {
  const m = /^AC(\d)(\d)(\d);?$/.exec(String(reply || '').trim());
  if (!m) return 'unknown';
  if (m[3] === '0') return 'off';
  if (m[3] === '1') return 'on';
  if (m[3] === '2') return 'tuning';
  return 'unknown';
}

/**
 * What to do after one `AC;` poll.
 * @param {{reply: string|null, elapsedMs: number}} s
 * @returns {{action: 'send-on'|'done'|'poll'|'give-up', state: string, reason?: string}}
 */
function decideAtuKeepOn({ reply, elapsedMs }) {
  const state = parseAcReply(reply);
  if (state === 'off') return { action: 'send-on', state };
  // "On" is not the end: a radio may report the tuner ON for the whole
  // cycle and only switch it OFF when the cycle completes — which is the
  // exact moment this exists for. Keep asking until the window closes.
  if (elapsedMs >= ATU_KEEP_ON_TIMEOUT_MS) {
    if (state === 'on') return { action: 'done', state, reason: 'the tuner stayed on' };
    return { action: 'give-up', state, reason: state === 'tuning' ? 'still tuning after 20 s' : 'no readable AC; reply in 20 s' };
  }
  return { action: 'poll', state };
}

module.exports = { parseAcReply, decideAtuKeepOn, ATU_KEEP_ON_TIMEOUT_MS, ATU_KEEP_ON_POLL_MS, ATU_KEEP_ON_FIRST_POLL_MS };
