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

  // --- Errors that cannot be ours (#806 follow-up) ---
  // Brave for iOS (WebKit) runs its own user scripts in the page. When one
  // throws, the page sees an error at "https://host/:1" whose stack is only
  // "global code@https://host/:1:16". Line 1 of every page remote-server
  // serves (the inlined page, the connect page, the stub) is "<!doctype
  // html>" alone, and browsers count inline-script lines from the top of
  // the document, so no code of ours runs at line 1 of the page
  // (test/error-banner-text-test.js guards that). Those errors are noise.

  function stripHash(u) {
    const s = safeString(u || '');
    const i = s.indexOf('#');
    return i >= 0 ? s.slice(0, i) : s;
  }

  // Every stack line that ends in ":line:col" is a frame. Lines without one
  // (Chrome's "TypeError: msg" head, Safari's "fn@[native code]") carry no
  // position and are skipped. Returns [{ url, line }]; url is '' when the
  // frame has no URL we can read (eval, <anonymous>), which never matches.
  function stackFrames(stack) {
    if (typeof stack !== 'string' || !stack) return [];
    const out = [];
    const lines = stack.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].trim();
      const pos = /:(\d+):(\d+)\)?$/.exec(ln);
      if (!pos) continue;
      const head = ln.slice(0, pos.index);
      const m = /([a-z][a-z0-9+.-]*:\/\/[^\s()@]*)$/i.exec(head);
      out.push({ url: m ? m[1] : '', line: Number(pos[1]) });
    }
    return out;
  }

  /**
   * True when an error cannot come from our code: every stack frame is at
   * line 1 of the page, or (no frames) the reported line is 1 of the page or
   * of no file at all. Without the page URL nothing is foreign.
   * input: { filename, lineno, stack, pageUrl }
   */
  function isForeignError(input) {
    const o = input || {};
    const page = stripHash(o.pageUrl);
    if (!page) return false;
    const frames = stackFrames(o.stack);
    if (frames.length) {
      for (let i = 0; i < frames.length; i++) {
        if (frames[i].line !== 1 || stripHash(frames[i].url) !== page) return false;
      }
      return true;
    }
    if (Number(o.lineno) !== 1) return false;
    const file = stripHash(o.filename);
    return !file || file === page;
  }

  function stackOf(err) {
    try { return err && typeof err.stack === 'string' ? err.stack : ''; } catch (_) { return ''; }
  }

  /** The window 'error' event, judged against the page URL (location.href). */
  function isForeignErrorEvent(e, pageUrl) {
    const ev = e || {};
    return isForeignError({ filename: ev.filename || '', lineno: ev.lineno, stack: stackOf(ev.error), pageUrl });
  }

  /** An unhandledrejection reason: foreign only with a stack whose frames are all at page line 1. */
  function isForeignRejection(reason, pageUrl) {
    const stack = stackOf(reason);
    if (!stackFrames(stack).length) return false;
    return isForeignError({ stack, pageUrl });
  }

  return { formatError, formatErrorEvent, formatRejection, isForeignError, isForeignErrorEvent, isForeignRejection };
});
