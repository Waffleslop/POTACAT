// What an EMPTY Propagation table should say (K3SBP 2026-09-23). A blank
// table read as "nothing is coming in" whether POTACAT had checked a minute
// ago and nobody reported hearing him, PSKReporter had been answering HTTP 526
// for an hour, or every report was hidden by the band filter — three
// different situations with three different next steps, and the page showed
// all of them the same way. This names which one it is, and when the next
// check happens, so a blank table is never a mystery.
//
// Pure and dual-mode (require + window.PropEmptyState): the main window's
// Propagation view and the pop-out render the same sentence.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PropEmptyState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // PSKReporter is asked for the last 15 minutes of reports (flowStartSeconds
  // -900 in lib/pskreporter.js) every 5 minutes.
  const PSKR_WINDOW_MIN = 15;
  const PSKR_POLL_MIN = 5;

  function utc(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(11, 16) + 'z';
  }

  /**
   * @param {object} st
   *   myCallsign        string
   *   showRbn/showPskr  the view's source toggles
   *   hiddenCount       reports inside the max age that the band/mode filters
   *                     hide (older ones are just old, not hidden)
   *   rbn   {connected}
   *   pskr  {connected, lastOkAt, lastError, lastErrorAt, nextPollAt}
   * @returns {{title: string, detail: string}} call only when the table is empty
   */
  function describeEmptyProp(st) {
    st = st || {};
    const call = String(st.myCallsign || '').trim().toUpperCase();
    if (!call) {
      return {
        title: 'Set your callsign in Settings to see who hears you.',
        detail: 'RBN and PSKReporter are looked up by your callsign.',
      };
    }
    if (st.showRbn === false && st.showPskr === false) {
      return { title: 'Both sources are hidden.', detail: 'Tick RBN or PSKReporter above to show their reports.' };
    }
    if (st.hiddenCount > 0) {
      const n = st.hiddenCount;
      return {
        title: `${n} report${n === 1 ? ' is' : 's are'} hidden by the band or mode filter.`,
        detail: 'Widen the filters above to see them.',
      };
    }

    const pskr = st.pskr || {};
    const rbn = st.rbn || {};
    const parts = [];
    let title;

    const pskrFailing = st.showPskr !== false && pskr.lastError
      && (!pskr.lastOkAt || (pskr.lastErrorAt || 0) > pskr.lastOkAt);
    if (pskrFailing) {
      const since = utc(pskr.lastErrorAt);
      title = `PSKReporter is not answering (${pskr.lastError}${since ? ', last tried ' + since : ''}).`;
      parts.push(pskr.nextPollAt
        ? `Trying again at ${utc(pskr.nextPollAt)}.`
        : 'POTACAT keeps trying on its own.');
    } else if (st.showPskr !== false && !pskr.lastOkAt) {
      title = 'Checking PSKReporter for the first time…';
    } else {
      title = `Nobody has reported hearing ${call} in the last ${PSKR_WINDOW_MIN} minutes.`;
      if (st.showPskr !== false) {
        const last = utc(pskr.lastOkAt);
        const next = utc(pskr.nextPollAt);
        parts.push(`PSKReporter is checked every ${PSKR_POLL_MIN} minutes`
          + (last || next ? ` (${[last && 'last ' + last, next && 'next ' + next].filter(Boolean).join(', ')})` : '')
          + ', and again 90 s after you transmit.');
      }
    }

    if (st.showRbn !== false) {
      parts.push(rbn.connected
        ? 'RBN skimmer spots of your CW and RTTY appear as they arrive.'
        : 'RBN is reconnecting.');
    }
    return { title, detail: parts.join(' ') };
  }

  return { describeEmptyProp, PSKR_WINDOW_MIN, PSKR_POLL_MIN };
});
