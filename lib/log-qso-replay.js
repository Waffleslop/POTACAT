'use strict';
// log-qso is idempotent by uuid (activation review 2026-11-17, fix 6, #733).
//
// A phone that sent a QSO and never heard log-ok (it slept, the link dropped)
// may send it again under the same uuid. The desktop used to write it again:
// a second ADIF record with the same uuid, which the next Cloud reconcile gave
// a fresh uuid and pushed, so the duplicate reached the Cloud too.
//
// The reply book holds, per uuid, the log-ok the first write produced, and
// which uuids are being saved right now. A log-qso claims its uuid first:
//   - known (in the book, or in the log through lib/qso-log.js hasUuid):
//     nothing is written; the first reply goes back under the new reqId;
//   - being saved: the claim waits for that save, then decides;
//   - unknown: the caller saves, remembers the reply and releases the claim.
// A log-qso with no uuid claims nothing and is saved as before.
//
// Pure apart from the timers of an awaited promise.

const { adifAppMode } = require('./adif-mode');

const BOOK_LIMIT = 500;

function createReplyBook({ limit = BOOK_LIMIT } = {}) {
  const replies = new Map(); // uuid -> log-ok reply (oldest first)
  const saving = new Map(); // uuid -> promise that settles when that save ends

  function remember(uuid, reply) {
    if (!uuid || !reply) return;
    replies.delete(uuid);
    replies.set(uuid, reply);
    while (replies.size > limit) replies.delete(replies.keys().next().value);
  }
  function patch(uuid, fields) {
    const r = uuid && replies.get(uuid);
    if (r) replies.set(uuid, { ...r, ...fields });
  }
  /**
   * @param {string} uuid
   * @param {(uuid: string) => object|null} fromLog - the reply rebuilt from
   *   the log when the uuid is there (after a restart the book is empty)
   * @returns {Promise<{prior: object}|{release: Function}>}
   */
  async function claim(uuid, fromLog) {
    if (!uuid) return { release: () => {} };
    while (saving.has(uuid)) await saving.get(uuid);
    const prior = replies.get(uuid) || (fromLog && fromLog(uuid)) || null;
    if (prior) return { prior };
    // No await between the check and here: two claims cannot both pass.
    let end;
    saving.set(uuid, new Promise((resolve) => { end = resolve; }));
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        saving.delete(uuid);
        end();
      },
    };
  }
  return { claim, remember, patch };
}

/** The first reply, again, for the request that repeated it. */
function replayReply(prior, reqId) {
  const out = { ...prior, alreadyLogged: true };
  if (reqId === undefined) delete out.reqId;
  else out.reqId = reqId;
  return out;
}

function khzText(freqMhz) {
  const mhz = parseFloat(freqMhz);
  if (!Number.isFinite(mhz) || mhz <= 0) return '';
  return String(Number((mhz * 1000).toFixed(3)));
}

/**
 * A log-ok rebuilt from the saved records holding the uuid (raw ADIF field
 * maps, lib/adif parseAllRawQsos). The same shape as the reply the first
 * write produced, less what lived only in memory then (the session number).
 */
function replyFromLogRecords(raws, { operator = '', cloudJournal } = {}) {
  if (!Array.isArray(raws) || !raws.length) return null;
  const records = raws.map((q) => {
    const r = {
      uuid: q.APP_POTACAT_UUID || '', callsign: q.CALL || '', sig: q.SIG || '', sigInfo: q.SIG_INFO || '',
      mySig: q.MY_SIG || '', mySigInfo: q.MY_SIG_INFO || '', operator,
    };
    const saved = {
      frequency: khzText(q.FREQ), band: q.BAND || '', mode: q.MODE ? adifAppMode(q.MODE, q.SUBMODE) : '',
      state: q.STATE || '', gridsquare: q.GRIDSQUARE || '', country: q.COUNTRY || '', dxcc: q.DXCC || '',
      name: q.NAME || '', county: q.CNTY || '',
    };
    for (const [k, v] of Object.entries(saved)) if (v) r[k] = String(v);
    return r;
  });
  const first = raws[0];
  const reply = {
    success: true,
    callsign: [...new Set(records.map((r) => r.callsign))].join(', '),
    timeUtc: first.TIME_ON || '',
    freqKhz: records[0].frequency || '',
    mode: records[0].mode || '',
    band: records[0].band || '',
    rstSent: first.RST_SENT || '',
    rstRcvd: first.RST_RCVD || '',
    uuid: records[0].uuid,
    records,
    resposted: false,
    respotError: '',
  };
  if (cloudJournal !== undefined) reply.cloudJournal = !!cloudJournal;
  return reply;
}

module.exports = { createReplyBook, replayReply, replyFromLogRecords, BOOK_LIMIT };
