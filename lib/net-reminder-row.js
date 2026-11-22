'use strict';
/**
 * What one Net Reminders row says (issue #284): the net's name, and under it
 * its frequency, mode, start time and schedule. A net saved without a name
 * still says which net it is (its frequency and mode) instead of a blank row.
 *
 * Dual-mode: require() in Node/tests, window.NetReminderRow in the pages.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./freq-dots'));
  else root.NetReminderRow = factory(root.FreqDots);
})(typeof self !== 'undefined' ? self : this, function (FreqDots) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function freqText(net) {
    const f = net && net.frequency;
    if (f == null || f === '') return '';
    return (FreqDots && FreqDots.khzMhz(f)) || String(f);
  }

  function scheduleText(sched) {
    if (sched && sched.type === 'weekly') return DAYS.filter((_, i) => (sched.days || []).includes(i)).join(', ');
    if (sched && sched.type === 'dates') return (sched.dates || []).join(', ');
    return 'Daily';
  }

  /** The bold line: the name, else "Net on <freq> <mode>", else "Unnamed net". */
  function title(net) {
    const name = String((net && net.name) || '').trim();
    if (name) return name;
    const f = freqText(net);
    const m = String((net && net.mode) || '').trim();
    const where = [f, m].filter(Boolean).join(' ');
    return where ? 'Net on ' + where : 'Unnamed net';
  }

  /** The small line: "14.300.00 MHz SSB • 18:00 UTC • Mon, Wed". */
  function detail(net) {
    net = net || {};
    const parts = [];
    const fm = [freqText(net), net.mode].filter(Boolean).join(' ');
    if (fm) parts.push(fm);
    if (net.startTime) parts.push(net.startTime + ' ' + (net.timeZone === 'utc' ? 'UTC' : 'Local'));
    parts.push(scheduleText(net.schedule));
    return parts.join(' • ');
  }

  return { title, detail, scheduleText };
});
