/**
 * The text of ECHOCAT Web's red "JS error" banner (renderer/remote.js).
 *
 * Chrome puts "TypeError: message" on the first line of error.stack; Safari
 * (every browser on an iPhone) and Firefox put only the frames there. The
 * banner used the stack in place of the message, so an iPhone showed
 * "global code@https://host/:1:16" and nothing else (#806). These helpers
 * always lead with the error's name and message, then the stack, and do not
 * repeat the message when the stack already starts with it.
 *
 * Dual-mode: Node require() gets module.exports, ECHOCAT Web gets
 * window.ErrorBannerText (inlined by lib/remote-server.js). Pure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ErrorBannerText = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function safeString(v) {
    try { return String(v); } catch (_) { return Object.prototype.toString.call(v); }
  }

  /** Name, message and stack of anything thrown or rejected. */
  function formatError(err) {
    if (err === null || err === undefined) return safeString(err) + ' (no error object)';
    if (typeof err !== 'object' && typeof err !== 'function') return safeString(err);
    let name = '';
    let message = '';
    let stack = '';
    try { name = err.name ? safeString(err.name) : ''; } catch (_) { /* ignore */ }
    try { message = err.message !== undefined && err.message !== null ? safeString(err.message) : ''; } catch (_) { /* ignore */ }
    try { stack = typeof err.stack === 'string' ? err.stack.trim() : ''; } catch (_) { /* ignore */ }
    if (!message && !stack) {
      // Not an Error: a plain object or something like it.
      try {
        const json = JSON.stringify(err);
        if (json && json !== '{}') return json;
      } catch (_) { /* circular: fall through */ }
      return name || safeString(err);
    }
    const head = name && message ? name + ': ' + message : (message || name || 'Error');
    if (!stack) return head;
    if (stack.indexOf(head) === 0) return stack; // Chrome: the stack already leads with it
    return head + '\n' + stack;
  }

  /** The window 'error' event: { src, text } for the banner. */
  function formatErrorEvent(e) {
    const ev = e || {};
    const filename = ev.filename || '';
    const src = filename + ':' + (ev.lineno || '?') + (ev.colno ? ':' + ev.colno : '');
    const text = ev.error !== undefined && ev.error !== null
      ? formatError(ev.error)
      : (ev.message ? safeString(ev.message) : 'unknown');
    return { src, text };
  }

  /** The window 'unhandledrejection' event's reason: { src, text }. */
  function formatRejection(reason) {
    return { src: 'unhandledrejection', text: formatError(reason) };
  }

  return { formatError, formatErrorEvent, formatRejection };
});
