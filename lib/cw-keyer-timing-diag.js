'use strict';
// ECHOCAT Web page keyer: a timing record of one paddle over (#244).
//
// LZ3AW hears extra dots and dashes from a paddle on ECHOCAT Web. The
// suspected cause, unproven on a real phone: the page keyer chooses each
// next element about 20 ms before it sounds, the operator lets go on what he
// HEARS, and the phone plays the sound about 40 ms after the audio clock
// says it starts. So his release reaches the page after one more element is
// already sounding. This module measures that. It decides nothing: it is
// told what the keyer did and when, and it never talks back to the keyer.
//
// "Chosen" here is the moment the keyer decides an element (the task note
// calls it "committed (decided)"). It is NOT the commit of
// lib/cw-sidetone-commit.js, which is the later moment the sidetone starts.
//
// Per element (a ring, the last ELEMENT_CAP of the over):
//   - when the keyer chose it (the page clock, performance.now());
//   - when its sidetone was scheduled to start (the audio clock);
//   - the lead between the two (ms, measured on the audio clock);
//   - the device's AudioContext.outputLatency then (NaN where the browser
//     has none).
// Per paddle edge (a ring, the last EDGE_CAP): the contact, press or release,
// and the time on the same page clock.
//
// Cost on the keying path: a few numbers written into arrays made once.
// Nothing is allocated per element or per edge and nothing is logged.
//
// One over = keying with no 2 s gap. The page sends its summary as one small
// `cw-timing` message (docs/echocat-protocol.md) and the desktop logs one
// line from it (formatLine). No callsign and no message text: counts and
// milliseconds only.
//
// Dual-mode: `require()` in tests and lib/remote-server.js,
// `window.CwKeyerTimingDiag` in ECHOCAT Web (inlined by lib/remote-server.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CwKeyerTimingDiag = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ELEMENT_CAP = 256; // about 50 s of solid dits at 25 wpm
  var EDGE_CAP = 512;
  var QUIET_MS = 2000;   // this long with no element and no edge ends the over
  var MODES = ['iambicA', 'iambicB', 'straight'];

  /**
   * The record of one over.
   *   element(chosenMs, startAudioMs, leadMs, outputLatencySec)
   *   withdrawn()             the element just recorded was taken back before it sounded
   *   edge(contact, pressed, atMs)   contact: 0 = dit, 1 = dah (the physical contact)
   *   lastAt()                page-clock time of the last element or edge, -1 when empty
   *   snapshot()              plain arrays, oldest first
   *   clear()
   */
  function createRecorder(opts) {
    var cap = (opts && opts.elementCap > 0) ? (opts.elementCap | 0) : ELEMENT_CAP;
    var edgeCap = (opts && opts.edgeCap > 0) ? (opts.edgeCap | 0) : EDGE_CAP;
    var chosen = new Float64Array(cap), startAudio = new Float64Array(cap);
    var lead = new Float64Array(cap), outLat = new Float64Array(cap);
    var head = 0, held = 0, total = 0, taken = 0;
    var edgeAt = new Float64Array(edgeCap), edgeCode = new Uint8Array(edgeCap);
    var edgeHead = 0, edgeHeld = 0;
    var down0 = false, down1 = false; // kept across overs: a contact held through a flush
    var last = -1;

    return {
      element: function (chosenMs, startAudioMs, leadMs, outputLatencySec) {
        chosen[head] = chosenMs;
        startAudio[head] = startAudioMs;
        lead[head] = leadMs;
        outLat[head] = (typeof outputLatencySec === 'number') ? outputLatencySec * 1000 : NaN;
        head = (head + 1) % cap;
        if (held < cap) held++;
        total++;
        last = chosenMs;
      },
      withdrawn: function () {
        if (!held) return;
        head = (head + cap - 1) % cap;
        held--; total--; taken++;
      },
      edge: function (contact, pressed, atMs) {
        pressed = !!pressed;
        // A repeated state (key auto-repeat, a release-all on blur) is not an edge.
        if (contact === 1) { if (down1 === pressed) return; down1 = pressed; }
        else { if (down0 === pressed) return; down0 = pressed; }
        edgeAt[edgeHead] = atMs;
        edgeCode[edgeHead] = (contact === 1 ? 2 : 0) + (pressed ? 1 : 0);
        edgeHead = (edgeHead + 1) % edgeCap;
        if (edgeHeld < edgeCap) edgeHeld++;
        last = atMs;
      },
      lastAt: function () { return last; },
      snapshot: function () {
        var elements = [], edges = [], i, k;
        for (i = 0; i < held; i++) {
          k = (head + cap - held + i) % cap;
          elements.push({ chosenMs: chosen[k], startAudioMs: startAudio[k], leadMs: lead[k], outputLatencyMs: outLat[k] });
        }
        for (i = 0; i < edgeHeld; i++) {
          k = (edgeHead + edgeCap - edgeHeld + i) % edgeCap;
          edges.push({ atMs: edgeAt[k], contact: (edgeCode[k] & 2) ? 'dah' : 'dit', pressed: !!(edgeCode[k] & 1) });
        }
        return { elements: elements, edges: edges, total: total, withdrawn: taken };
      },
      clear: function () { head = 0; held = 0; total = 0; taken = 0; edgeHead = 0; edgeHeld = 0; last = -1; },
    };
  }

  function finite(v) { return typeof v === 'number' && isFinite(v); }

  /**
   * The numbers of one over, from a snapshot. `info`: { mode, wpm,
   * baseLatencySec } (baseLatencySec: AudioContext.baseLatency, or anything
   * else where the browser has none). Returns null for an over with no
   * iambic element (straight key, or nothing keyed).
   */
  function summarize(snap, info) {
    var els = (snap && snap.elements) || [], edges = (snap && snap.edges) || [];
    if (!els.length) return null;
    var i;
    var lastRelease = null;
    for (i = edges.length - 1; i >= 0; i--) if (!edges[i].pressed) { lastRelease = edges[i].atMs; break; }

    var leads = [], afterN = 0, afterMin = null, afterMax = null, outMin = null, outMax = null;
    for (i = 0; i < els.length; i++) {
      leads.push(els[i].leadMs);
      if (lastRelease != null && els[i].chosenMs > lastRelease) {
        var by = els[i].chosenMs - lastRelease;
        afterN++;
        if (afterMin == null || by < afterMin) afterMin = by;
        if (afterMax == null || by > afterMax) afterMax = by;
      }
      var o = els[i].outputLatencyMs;
      if (finite(o)) {
        if (outMin == null || o < outMin) outMin = o;
        if (outMax == null || o > outMax) outMax = o;
      }
    }
    leads.sort(function (a, b) { return a - b; });
    var mid = leads.length >> 1;
    var med = (leads.length % 2) ? leads[mid] : (leads[mid - 1] + leads[mid]) / 2;
    var lastEl = els[els.length - 1];
    var out = {
      elements: Math.max(els.length, (snap.total | 0)),
      measured: els.length,
      withdrawn: snap.withdrawn | 0,
      edges: edges.length,
      mode: (info && info.mode) || '',
      wpm: (info && info.wpm) || 0,
      afterReleaseN: afterN,
      afterReleaseMinMs: afterMin == null ? null : Math.round(afterMin),
      afterReleaseMaxMs: afterMax == null ? null : Math.round(afterMax),
      leadMinMs: Math.round(leads[0]),
      leadMedMs: Math.round(med),
      leadMaxMs: Math.round(leads[leads.length - 1]),
      baseLatencyMs: (info && finite(info.baseLatencySec)) ? Math.round(info.baseLatencySec * 1000) : null,
      outputLatencyMinMs: outMin == null ? null : Math.round(outMin),
      outputLatencyMaxMs: outMax == null ? null : Math.round(outMax),
      // The last release against the scheduled sidetone start of the last
      // element, both on the page clock: above zero, he let go after it began.
      lastReleaseAfterStartMs: lastRelease == null ? null : Math.round(lastRelease - (lastEl.chosenMs + lastEl.leadMs)),
    };
    return out;
  }

  /** The wire message for a summary: numbers and the mode name only; unknowns are left out. */
  function toMessage(summary) {
    var msg = { type: 'cw-timing' };
    for (var k in summary) {
      if (!Object.prototype.hasOwnProperty.call(summary, k)) continue;
      if (summary[k] == null) continue;
      msg[k] = summary[k];
    }
    return msg;
  }

  /**
   * The one log line for a `cw-timing` message. Everything in it is a number
   * read from the message or one of three mode names; nothing a client sends
   * is copied into the log as text.
   */
  function formatLine(msg) {
    msg = msg || {};
    function has(k) { return finite(msg[k]); }
    function n(k) { return has(k) ? String(Math.max(-600000, Math.min(600000, Math.round(Number(msg[k]))))) : '?'; }
    function signed(k) { if (!has(k)) return '?'; var v = Math.round(Number(msg[k])); return (v >= 0 ? '+' : '') + n(k); }
    var mode = MODES.indexOf(msg.mode) >= 0 ? msg.mode : '?';
    var parts = [];
    var head = n('elements') + ' elements';
    if (has('measured') && has('elements') && Number(msg.measured) < Number(msg.elements)) head += ' (last ' + n('measured') + ' measured)';
    parts.push(head + ', ' + mode + ' ' + n('wpm') + ' wpm');

    if (!has('lastReleaseAfterStartMs')) {
      parts.push('no paddle release seen');
    } else {
      var after = n('afterReleaseN') + ' chosen after the last release';
      if (Number(msg.afterReleaseN) > 0) {
        after += (Number(msg.afterReleaseN) > 1 && n('afterReleaseMinMs') !== n('afterReleaseMaxMs'))
          ? ' (' + signed('afterReleaseMinMs') + ' to ' + signed('afterReleaseMaxMs') + ' ms)'
          : ' (' + signed('afterReleaseMaxMs') + ' ms)';
      }
      parts.push(after);
    }

    parts.push('lead min/med/max ' + n('leadMinMs') + '/' + n('leadMedMs') + '/' + n('leadMaxMs') + ' ms');

    var hasBase = has('baseLatencyMs'), hasOut = has('outputLatencyMaxMs');
    if (!hasBase && !hasOut) {
      parts.push('output latency unknown');
    } else {
      var outTxt = !hasOut ? 'unknown'
        : (has('outputLatencyMinMs') && n('outputLatencyMinMs') !== n('outputLatencyMaxMs'))
          ? n('outputLatencyMinMs') + '-' + n('outputLatencyMaxMs') : n('outputLatencyMaxMs');
      var total = (hasBase ? Number(n('baseLatencyMs')) : 0) + (hasOut ? Number(n('outputLatencyMaxMs')) : 0);
      parts.push('output latency ' + total + ' ms (base ' + (hasBase ? n('baseLatencyMs') : 'unknown') + ' + output ' + outTxt + ')');
    }

    if (has('lastReleaseAfterStartMs')) {
      var d = Math.round(Number(msg.lastReleaseAfterStartMs));
      parts.push('last release ' + String(Math.min(600000, Math.abs(d))) + ' ms ' + (d >= 0 ? 'after' : 'before') + " the last element's start");
    }
    if (has('withdrawn') && Number(msg.withdrawn) > 0) parts.push(n('withdrawn') + ' withdrawn before sounding');
    return '[CW] page keyer timing, last over: ' + parts.join('; ');
  }

  return {
    ELEMENT_CAP: ELEMENT_CAP, EDGE_CAP: EDGE_CAP, QUIET_MS: QUIET_MS,
    createRecorder: createRecorder, summarize: summarize, toMessage: toMessage, formatLine: formatLine,
  };
}));
