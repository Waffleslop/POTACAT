'use strict';
// The external-logger fan-out of a logged QSO: the main logbook (MacLoggerDX,
// N1MM/Log4OM/HRD/ACLog UDP, Wavelog, ...: main.js forwardToLogbook), the
// Extra UDP destination, the QRZ Logbook and Club Log's real-time upload.
//
// Two callers share it so they cannot drift apart:
//   - saveQsoRecord (main.js), the live path: every QSO logged at this
//     desktop, by any surface, including a phone logging through it;
//   - the Cloud pull (lib/cloud-ipc.js), for this station's own QSOs logged
//     on a paired phone while it had no link to this desktop (GitHub #267,
//     NA4DQ: an off-grid activation reached the Cloud log but never
//     MacLoggerDX). The pull decides WHICH QSOs: lib/cloud-pull-forward.js.
//
// The senders are injected (`d`) so the gates can be tested without Electron.
// Respots and the SOTA chase upload stay in saveQsoRecord: they belong to the
// moment of the contact, not to a logger.

/**
 * Main logbook, Extra UDP and QRZ Logbook, in that order, each gated on the
 * operator's settings (`ops`). A failure is reported, never thrown.
 *
 * @param {object} qsoData - the app's QSO shape (callsign, frequency kHz, ...)
 * @param {object} ops - the settings of the operator the QSO is logged for
 * @param {object} d - { forwardToLogbook(q, ops), sendExtraUdp(q, host, port, format),
 *                       sendToQrzLogbook(q, ops), log(msg), error(msg) }
 * @returns {Promise<{logbookError?: string, qrzError?: string}>}
 */
async function forwardToLoggers(qsoData, ops, d) {
  const log = d.log || (() => {});
  const error = d.error || (() => {});
  let logbookError, qrzError;
  // All of an n-fer's POTA parks in the one forwarded record (lib/qso-expand.js).
  if (qsoData.forwardPotaRefs) {
    qsoData = { ...qsoData, potaRef: qsoData.forwardPotaRefs };
    delete qsoData.forwardPotaRefs;
  }

  // skipLogbookForward: multi-park activations send one ADIF record per park
  // ref, but external logbooks only need one QSO per physical contact.
  if (ops.sendToLogbook && ops.logbookType && !qsoData.skipLogbookForward) {
    try {
      // Name the TARGET: a UDP send "succeeds" whether or not anything is
      // listening, so when a logbook never receives, the host:port in this
      // line is the whole diagnosis (KI4GT's WRL report had no way to tell).
      log(`[Logbook] Forwarding QSO to ${ops.logbookType} at ${ops.logbookHost || '127.0.0.1'}:${ops.logbookPort || '(default port)'}: ${qsoData.callsign} ${qsoData.frequency}kHz ${qsoData.mode}`);
      await d.forwardToLogbook(qsoData, ops);
      log(`[Logbook] QSO sent (UDP delivery is fire-and-forget — if the logbook never receives, check the host/port above and that it is actually listening)`);
    } catch (fwdErr) {
      log(`[Logbook] Forwarding failed: ${fwdErr.message}`);
      error('Logbook forwarding failed: ' + fwdErr.message);
      logbookError = fwdErr.message;
    }
  }

  // Optional: also fire the QSO at a user-defined extra UDP destination
  // (parallel to the main logbook). For users who want GridTracker / JTAlert
  // / etc. to see logged QSOs without going through Log4OM as a middleman.
  if (ops.extraUdpEnabled && !qsoData.skipLogbookForward) {
    const host = ops.extraUdpHost || '127.0.0.1';
    const port = parseInt(ops.extraUdpPort, 10) || 2237;
    const format = ops.extraUdpFormat || 'wsjtx';
    try {
      log(`[Extra UDP] Broadcasting QSO to ${host}:${port} (${format})`);
      await d.sendExtraUdp(qsoData, host, port, format);
      log(`[Extra UDP] Sent`);
    } catch (extraErr) {
      log(`[Extra UDP] Send failed: ${extraErr.message}`);
      error('Extra UDP send failed: ' + extraErr.message);
    }
  }

  // Upload to QRZ Logbook if enabled (independent of logbook forwarding)
  if (ops.qrzLogbook && ops.qrzApiKey && !qsoData.skipLogbookForward) {
    try {
      await d.sendToQrzLogbook(qsoData, ops);
    } catch (qrzErr) {
      error('QRZ Logbook upload failed: ' + qrzErr.message);
      qrzError = qrzErr.message;
    }
  }

  return { logbookError, qrzError };
}

/**
 * Club Log real-time upload — never a gate on logging. #142: the account is
 * the logged operator's (`ops`; a "Log as" operator without Club Log set up
 * uploads nowhere), and the contact is queued (lib/clublog-outbox.js), so
 * Save never waits on Club Log and a refused login pauses that account
 * instead of failing every QSO.
 *
 * @param {object} d - { addClublog({creds, adif, uuid, call}), buildAdifRecord(q), newUuid(), log(msg) }
 * @returns {boolean} queued
 */
function queueClublog(qsoData, ops, d) {
  if (ops.clublogEnable && ops.clublogRealtime !== false && !qsoData.skipLogbookForward
      && ops.clublogEmail && ops.clublogPassword) {
    try {
      d.addClublog({
        creds: { email: ops.clublogEmail, password: ops.clublogPassword, callsign: ops.clublogCallsign || ops.myCallsign },
        adif: d.buildAdifRecord(qsoData),
        uuid: qsoData.uuid || d.newUuid(),
        call: qsoData.callsign,
      });
      return true;
    } catch (e) {
      if (d.log) d.log(`[ClubLog] Error: ${e.message}`);
    }
  }
  return false;
}

module.exports = { forwardToLoggers, queueClublog };
