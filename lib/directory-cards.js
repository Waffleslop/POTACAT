/**
 * ECHOCAT Web's Directory cards for nets and shortwave broadcasts.
 *
 * Every field comes from the community directory sheet (lib/directory.js
 * copies the CSV cells verbatim), so every field is text: it is escaped here
 * before it reaches innerHTML. The desktop window already builds these cards
 * with escaping; this keeps ECHOCAT Web the same.
 *
 * Dual-mode: Node require() gets module.exports, ECHOCAT Web gets
 * window.DirectoryCards (inlined by lib/remote-server.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DirectoryCards = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /** Text for innerHTML: & < > " ' escaped; null/undefined become ''. */
  function escHtml(v) {
    if (v == null) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function statusHtml(cd) {
    if (!cd || !cd.label) return '';
    return '<span class="dir-card-status ' + escHtml(cd.status) + '">' + escHtml(cd.label) + '</span>';
  }

  /** A net card. `o.freqText` is the formatted MHz (FreqDots.khzMhz), `o.band`
   *  the band label, `o.cd` the countdown {status, label}. */
  function netCardHtml(n, o) {
    const net = n || {};
    const opt = o || {};
    return '<div class="dir-card-row"><span class="dir-card-name">' + escHtml(net.name || 'Unknown') + '</span>' + statusHtml(opt.cd) + '</div>'
      + '<div class="dir-card-detail"><span class="dir-card-freq">' + escHtml(opt.freqText || '?') + '</span> ' + escHtml(net.mode || '')
      + (opt.band ? ' · ' + escHtml(opt.band) : '')
      + (net.days && net.days !== 'Daily' ? ' · ' + escHtml(net.days) : '') + '</div>';
  }

  /** A shortwave broadcast card. `o.band`, `o.cd` as for netCardHtml. */
  function swlCardHtml(s, o) {
    const swl = s || {};
    const opt = o || {};
    return '<div class="dir-card-row"><span class="dir-card-name">' + escHtml(swl.station || 'Unknown') + '</span>' + statusHtml(opt.cd) + '</div>'
      + '<div class="dir-card-detail"><span class="dir-card-freq">' + escHtml(swl.frequency || '?') + ' kHz</span>'
      + (swl.language ? ' · ' + escHtml(swl.language) : '')
      + (opt.band ? ' · ' + escHtml(opt.band) : '')
      + (swl.powerKw ? ' · ' + escHtml(swl.powerKw) + 'kW' : '') + '</div>';
  }

  return { escHtml, netCardHtml, swlCardHtml };
});
