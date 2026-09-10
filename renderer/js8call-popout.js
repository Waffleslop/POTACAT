// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8 screen — conversations, not a decoder log.
//
// JS8 is asynchronous messaging, so this groups frames by correspondent,
// keeps an unread count, and folds the heartbeat net out of the way.
// Conversation state lives in MAIN (lib/js8call-threads.js) so counts keep
// accumulating while this window is shut.
//
// JS8 itself is native (lib/js8-engine.js under JTCAT): Start runs it, Stop
// stops it, and there is nothing else to configure — the setup flow this
// window used to carry (JS8Call.ini patching, DAX, slices, virtual audio
// cables) died with the bridge. docs/js8-native-plan.md records the whole
// arc.
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };
  var dotEl = el('jc-dot'), stateEl = el('jc-state'), stationEl = el('jc-station'),
      submodeEl = el('jc-submode'), txEl = el('jc-tx'), actsEl = el('jc-acts'),
      powerBtn = el('jc-power'), cqBtn = el('jc-cq'), hbBtn = el('jc-hb'),
      convsEl = el('jc-convs'), groupsEl = el('jc-groups'), unreadEl = el('jc-unread'),
      headEl = el('jc-threadhead'), colsEl = el('jc-cols'), toEl = el('jc-to'),
      msgsEl = el('jc-msgs'), chipsEl = el('jc-chips'),
      textEl = el('jc-text'), sendBtn = el('jc-send'), onairEl = el('jc-onair'),
      heardEl = el('jc-heard');


  // Instruments + new bar controls (waterfall, band-activity, meters, clock).
  var rxageEl = el('jc-rxage'), haltBtn = el('jc-halt'),
      instrumentsEl = el('jc-instruments'), bandViewEl = el('jc-band'), trafficList = el('jc-band-list'),
      wfWrapEl = el('jc-wf'), wfToggleBtn = el('jc-wf-toggle'),
      wfCanvas = el('jc-waterfall'), wfCtx = wfCanvas.getContext('2d'), wfSilentEl = el('jc-wf-silent'),
      rxGainEl = el('jc-rx-gain'), rxGainValEl = el('jc-rx-gain-val'),
      smeterBar = el('jc-smeter-bar'), smeterVal = el('jc-smeter-val'),
      swrBarEl = el('jc-swr-bar'), swrValEl = el('jc-swr-val'),
      clockEl = el('jc-clock'), clockMsgEl = el('jc-clock-msg');

  var running = false;
  var hbOn = false;
  var openId = null;
  var openCall = '';
  var heard = [];
  var lastList = [];
  var rxGainLevel = 1.0;          // 0..1, drives waterfall brightness
  var txOffsetHz = 1500, rxOffsetHz = 1500;
  var lastDecodeTs = 0;           // for the "am I receiving?" age chip
  var wfHidden = false;           // waterfall hidden by the operator (persisted)

  // Directed queries, one tap. They FILL the box rather than sending, so
  // what leaves is still seen first.
  var CHIPS = ['SNR?', 'GRID?', 'INFO?', 'QSL', '73'];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function hhmm(utc) {
    var n = Number(utc) || Date.now();
    return new Date(n < 1e12 ? n * 1000 : n).toISOString().slice(11, 16);
  }
  function ago(utc) {
    var n = Number(utc) || 0;
    if (!n) return '';
    var ms = Date.now() - (n < 1e12 ? n * 1000 : n);
    var m = Math.round(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    return Math.round(m / 60) + 'h';
  }
  function snrText(v) {
    if (v === null || v === undefined || v === '') return '';
    return (v > 0 ? '+' : '') + v;
  }

  // ── conversations ──────────────────────────────────────────────────────────

  function renderConvs(all) {
    renderGroups(all);
    renderTo(all);
    // Individuals only — groups have their own rail above.
    var list = (all || []).filter(function (t) { return !t.isGroup; });
    convsEl.innerHTML = '';
    if (!list.length) {
      var d = document.createElement('div');
      d.className = 'jc-empty';
      d.style.padding = '16px 12px';
      d.style.fontSize = '11.5px';
      d.textContent = running ? 'No directed traffic yet.' : '';
      convsEl.appendChild(d);
      return;
    }
    list.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'jc-conv' + (t.unread ? ' unread' : '') + (t.isGroup ? ' group' : '') +
        (t.id === openId ? ' sel' : '');
      b.type = 'button';
      var preview = t.lastDir === 'out' ? 'you: ' + t.lastText : t.lastText;
      if (!t.lastText && t.hbCount) preview = t.hbCount + ' heartbeats';
      b.innerHTML =
        '<span class="c">' + esc(t.call) + '</span>' +
        '<span class="p">' + esc(preview) + '</span>' +
        (t.unread ? '<span class="jc-badge">' + t.unread + '</span>'
                  : '<span class="w">' + esc(ago(t.lastUtc)) + '</span>');
      b.addEventListener('click', function () { openThread(t.id); });
      convsEl.appendChild(b);
    });
  }

  // ── groups ─────────────────────────────────────────────────────────────────
  var BASE_GROUPS = ['@ALLCALL', '@HB'];

  function knownGroups(list) {
    var seen = {};
    BASE_GROUPS.forEach(function (g) { seen[g] = true; });
    (list || []).forEach(function (t) { if (t.isGroup && t.call) seen[t.call] = true; });
    return Object.keys(seen).sort(function (a, b) {
      var ai = BASE_GROUPS.indexOf(a), bi = BASE_GROUPS.indexOf(b);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      return a.localeCompare(b);
    });
  }

  function renderGroups(list) {
    groupsEl.innerHTML = '';
    var byId = {};
    (list || []).forEach(function (t) { byId[t.call] = t; });
    knownGroups(list).forEach(function (g) {
      var t = byId[g] || { id: g, call: g, unread: 0, lastText: '', isGroup: true };
      var b = document.createElement('button');
      b.className = 'jc-conv group' + (t.unread ? ' unread' : '') + (t.id === openId ? ' sel' : '');
      b.type = 'button';
      b.innerHTML = '<span class="c">' + esc(g) + '</span>' +
        '<span class="p">' + esc(t.lastText || '') + '</span>' +
        (t.unread ? '<span class="jc-badge">' + t.unread + '</span>' : '');
      b.addEventListener('click', function () { openThread(t.id); });
      groupsEl.appendChild(b);
    });
  }

  /** Destinations for the compose row, current selection preserved. */
  function renderTo(list) {
    var want = toEl.value || openCall || '@ALLCALL';
    var opts = knownGroups(list).slice();
    if (openCall && opts.indexOf(openCall) < 0) opts.unshift(openCall);
    heard.forEach(function (h) { if (opts.indexOf(h.call) < 0) opts.push(h.call); });
    toEl.innerHTML = '';
    opts.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      toEl.appendChild(opt);
    });
    toEl.value = opts.indexOf(want) >= 0 ? want : opts[0];
  }

  function setUnreadTotal(n) {
    unreadEl.textContent = n ? '(' + n + ')' : '';
    unreadEl.style.color = n ? 'var(--accent-green-btn, #4ecca3)' : '';
  }

  async function openThread(id) {
    var r;
    try { r = await window.api.thread(id); } catch (e) { return; }
    openId = id;
    renderThread(r && r.thread);
    // Point the To box at whoever was opened, BEFORE renderConvs rebuilds the
    // list — it preserves the current selection, so setting it after would be
    // overwritten by the previous value.
    if (r && r.thread && r.thread.call) toEl.value = r.thread.call;
    renderConvs(r && r.list);
    setUnreadTotal(r ? r.unread : 0);
    refreshCompose();
    showThreadView(true);
  }

  // The center pane is either the live band (idle) or a conversation transcript
  // (a thread open) — never both, never empty. This is the swap.
  function showThreadView(open) {
    msgsEl.hidden = !open;
    bandViewEl.hidden = !!open;
    if (!open) headEl.hidden = true;
  }
  function closeThread() {
    openId = null; openCall = '';
    renderConvs(lastList);       // drop the selected-row highlight
    showThreadView(false);
    refreshCompose();
  }

  function renderThread(th) {
    msgsEl.innerHTML = '';
    if (!th) { headEl.hidden = true; openCall = ''; return; }
    openCall = th.call;

    headEl.hidden = false;
    var stn = heard.filter(function (h) { return h.call === th.call; })[0];
    headEl.innerHTML =
      '<b>' + esc(th.call) + '</b>' +
      (stn && stn.grid ? '<span>' + esc(stn.grid) + '</span>' : '') +
      (stn && stn.snr !== null && stn.snr !== undefined
        ? '<span class="mono num">' + esc(snrText(stn.snr)) + ' dB</span>' : '') +
      (stn ? '<span style="margin-left:auto;">heard ' + esc(ago(stn.utc)) + ' ago</span>' : '');
    // Back to the band-activity view — the transcript replaced it, so give a
    // way home that doesn't require picking another conversation.
    var backBtn = document.createElement('button');
    backBtn.className = 'jc-btn jc-back';
    backBtn.textContent = '‹ Band';
    backBtn.title = 'Back to band activity';
    backBtn.addEventListener('click', closeThread);
    headEl.insertBefore(backBtn, headEl.firstChild);
    // The conversation IS the QSO record — log it from where it lives.
    // Groups are nets, not QSOs, so no button there.
    if (!th.isGroup) {
      var logBtn = document.createElement('button');
      logBtn.className = 'jc-btn';
      logBtn.textContent = 'Log';
      logBtn.title = 'Log this conversation as a QSO (reports and times come from the exchange)';
      logBtn.style.marginLeft = stn ? '8px' : 'auto';
      logBtn.addEventListener('click', function () {
        window.api.logThread(th.id).then(function (r) {
          if (r && !r.ok) note(esc(r.error || 'Nothing to log.'), 'err');
        }).catch(function () {});
      });
      headEl.appendChild(logBtn);
    }

    // The folded net, stated rather than hidden — it is the difference between
    // "quiet band" and "we chose not to show you 40 heartbeats".
    if (th.hbCount) {
      var f = document.createElement('span');
      f.className = 'jc-fold';
      f.textContent = th.hbCount + (th.hbCount === 1 ? ' heartbeat' : ' heartbeats') + ' hidden';
      msgsEl.appendChild(f);
    }

    th.messages.forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'jc-msg ' + (m.dir === 'out' ? 'out' : 'in');
      var meta = [hhmm(m.utc)];
      if (m.dir === 'out') meta.push('sent');
      else {
        if (m.snr !== null && m.snr !== undefined) meta.push(snrText(m.snr) + ' dB');
        if (m.offset) meta.push(m.offset + ' Hz');
      }
      d.innerHTML = '<div class="m mono num">' + esc(meta.join(' · ')) + '</div>' +
                    '<div class="b">' + esc(m.text) + '</div>';
      msgsEl.appendChild(d);
    });

    if (!th.hbCount && !th.messages.length) {
      var e = document.createElement('div');
      e.className = 'jc-empty';
      e.textContent = 'Nothing in this conversation yet.';
      msgsEl.appendChild(e);
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ── heard now ──────────────────────────────────────────────────────────────

  function renderHeard(list) {
    heard = list || [];
    heardEl.innerHTML = '';
    if (!heard.length) {
      var d = document.createElement('div');
      d.className = 'jc-empty';
      d.style.cssText = 'padding:16px 10px;font-size:11px;';
      d.textContent = running ? 'Nobody decoded yet.' : '';
      heardEl.appendChild(d);
      return;
    }
    heard.forEach(function (h) {
      var b = document.createElement('button');
      b.className = 'jc-stn';
      b.type = 'button';
      b.title = 'Start a conversation with ' + h.call + (h.grid ? ' (' + h.grid + ')' : '');
      b.innerHTML = '<span class="c">' + esc(h.call) + '</span>' +
                    '<span class="s">' + esc(snrText(h.snr)) + '</span>' +
                    '<span class="a">' + esc(ago(h.utc)) + '</span>';
      // Clicking a heard station addresses it — the rail exists to answer "who
      // can I reach", so it should be one click from reaching them.
      b.addEventListener('click', function () {
        openCall = h.call;
        openId = h.call;
        renderConvs(lastList);
        toEl.value = h.call;
        textEl.value = '';
        textEl.focus();
        refreshCompose();
      });
      heardEl.appendChild(b);
    });
  }

  // ── compose ────────────────────────────────────────────────────────────────

  function renderChips() {
    chipsEl.innerHTML = '';
    CHIPS.forEach(function (label) {
      var b = document.createElement('button');
      b.className = 'jc-chip';
      b.type = 'button';
      b.textContent = label;
      b.disabled = !running;
      b.title = 'Put "' + label + '" in the message box';
      b.addEventListener('click', function () {
        // Body only — the To box already carries the destination, and a second
        // one in the text would be transmitted verbatim.
        textEl.value = label;
        textEl.focus();
        refreshCompose();
      });
      chipsEl.appendChild(b);
    });
  }

  /**
   * Preview of what will go on the air.
   *
   * Mirrors composeDirected() in lib/js8call-threads.js, which is the tested
   * original and the one that actually addresses the transmission — main
   * composes from {text, to} so this can never disagree with what is sent.
   * Duplicated here only because the renderer has no require() (same reason
   * gridToLatLonLocal exists in app.js).
   */
  var GROUPS = ['@HB', '@ALLCALL', '@DX', '@GROUP', '@QSO', '@NET', '@CQ'];
  function isAddressed(t) {
    return /^@[A-Z0-9/]{2,}(s|$)/i.test(t) || /^[A-Z0-9/]{2,}:/i.test(t);
  }
  function outgoing() {
    var body = textEl.value.trim();
    if (!body) return '';
    if (isAddressed(body)) return body;
    var to = (toEl.value || '').trim().toUpperCase();
    if (!to) return body;
    var group = to.charAt(0) === '@' || GROUPS.indexOf(to) >= 0;
    return group ? to + ' ' + body : to + ': ' + body;
  }
  function refreshCompose() {
    textEl.disabled = toEl.disabled = !running;
    sendBtn.disabled = !running || !textEl.value.trim();
    textEl.placeholder = running ? 'Message' : 'JS8 is off';
    renderChips();
    var t = outgoing();
    if (t && !onairEl.classList.contains('err') && !onairEl.classList.contains('ok')) {
      // Show exactly what leaves. A transmit control that hides its payload is
      // how the wrong thing ends up on the air.
      onairEl.className = '';
      onairEl.innerHTML = 'Goes on the air as <code>' + esc(t) + '</code>';
    } else if (!t && !onairEl.classList.contains('err') && !onairEl.classList.contains('ok')) {
      onairEl.innerHTML = '';
    }
  }

  function note(html, cls) { onairEl.className = cls || ''; onairEl.innerHTML = html; }

  async function transmit(text, to) {
    note('Queueing…', '');
    var r;
    try { r = await window.api.send(text, to); }
    catch (e) { note('Send failed: ' + esc(e && e.message), 'err'); return; }
    if (r && r.ok) {
      note('On the air over the next ' + (r.frames > 1 ? r.frames + ' periods' : 'period') +
        ': <code>' + esc(r.text) + '</code>', 'ok');
      textEl.value = '';
    } else {
      note(esc((r && r.error) || 'Send refused.'), 'err');
    }
    refreshCompose();
  }

  sendBtn.addEventListener('click', function () {
    var body = textEl.value.trim();
    if (body) transmit(body, toEl.value);
  });
  toEl.addEventListener('change', refreshCompose);
  textEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
  });
  textEl.addEventListener('input', function () {
    onairEl.className = '';
    refreshCompose();
  });

  // ── station actions ────────────────────────────────────────────────────────
  // These SEND (CQ; HB sends one now AND arms the schedule) — station acts,
  // not compose acts.

  cqBtn.addEventListener('click', function () {
    transmit('CQ CQ CQ', '');
  });

  // ── band picker + dial readout ─────────────────────────────────────────────
  // The rig's dial, live, and one-click QSY to a band's JS8 calling
  // frequency. Mirror of main's JS8_DIAL_KHZ (and jtcat-popout's
  // JS8_BAND_FREQS) — keep the three in agreement.
  var JS8_BANDS = [
    ['160m', 1842], ['80m', 3578], ['60m', 5357], ['40m', 7078],
    ['30m', 10130], ['20m', 14078], ['17m', 18104], ['15m', 21078],
    ['12m', 24922], ['10m', 28078], ['6m', 50318],
  ];
  var bandEl = el('jc-band'), dialEl = el('jc-dial');
  var dialHz = 0;
  var bandByRange = function (hz) {
    // Nearest-dial classification is enough for highlighting the select —
    // the dial readout shows the exact truth.
    var mhz = hz / 1e6, best = '', bestD = Infinity;
    JS8_BANDS.forEach(function (b) {
      var d = Math.abs(mhz - b[1] / 1000);
      if (d < bestD) { bestD = d; best = b[0]; }
    });
    return bestD < 0.35 ? best : '';
  };
  (function initBand() {
    var blank = document.createElement('option');
    blank.value = ''; blank.textContent = 'Band';
    bandEl.appendChild(blank);
    JS8_BANDS.forEach(function (b) {
      var o = document.createElement('option');
      o.value = b[0];
      o.textContent = b[0] + ' · ' + (b[1] / 1000).toFixed(3);
      bandEl.appendChild(o);
    });
  })();
  bandEl.addEventListener('change', function () {
    if (!bandEl.value) return;
    window.api.setBand(bandEl.value).then(function (r) {
      if (r && !r.ok) note(esc(r.error || 'Could not tune.'), 'err');
    }).catch(function () {});
  });
  window.api.onCatFrequency(function (hz) {
    dialHz = Number(hz) || 0;
    dialEl.textContent = dialHz ? (dialHz / 1e6).toFixed(3) + ' MHz' : '';
    var b = bandByRange(dialHz);
    // Reflect, don't fight: only move the select when the value differs, so
    // an open dropdown isn't yanked mid-choice.
    if (b !== bandEl.value && document.activeElement !== bandEl) bandEl.value = b;
  });

  // ATU — momentary match cycle through the one rig-control dispatcher.
  // Not a toggle: every press starts a tune (same behavior as the desktop,
  // JTCAT popout, VFO popout and the mobile device). runAtu (defined below,
  // shared with the SWR banner's Run-ATU button) is the one implementation.
  var atuBtn = el('jc-atu');
  var atuTimer = null;
  atuBtn.addEventListener('click', function () { runAtu(); });

  // ── period countdown (the FT8-style cycle clock) ──────────────────────────
  // JS8 periods align to wall-clock UTC boundaries; transmissions begin at
  // the boundary. Local clock math — no wire traffic — same as JTCAT's bar.
  var SUBMODE_PERIODS = { NORMAL: 15, FAST: 10, TURBO: 6, SLOW: 30, ULTRA: 4 };
  var cycleEl = el('jc-cycle'), cycleBar = el('jc-cyclebar'), cycleFill = el('jc-cyclefill');
  var currentSubmode = 'NORMAL';
  var txNow = false;
  setInterval(function () {
    if (!running) return;
    var periodMs = (SUBMODE_PERIODS[currentSubmode] || 15) * 1000;
    var into = Date.now() % periodMs;
    cycleEl.textContent = Math.ceil((periodMs - into) / 1000) + 's';
    cycleFill.style.width = ((into / periodMs) * 100).toFixed(1) + '%';
    cycleFill.className = txNow ? 'tx' : '';
  }, 250);

  // HB = send one now, every press (momentary, like CQ). Repeatable — the
  // whole point (Casey 2026-08-09). Refusals (SWR trip, busy) come back on
  // the send-result channel.
  hbBtn.addEventListener('click', async function () {
    try {
      var r = await window.api.sendHeartbeat();
      if (r && r.ok) {
        // Confirm the enqueue — it transmits at the next period boundary, not
        // instantly, so silence read as "did nothing" (Casey 2026-08-09). The
        // TX indicator also flips to "1 queued" from the status push.
        note('Heartbeat queued' + (r.text ? ' (' + esc(r.text) + ')' : '') + ' — sends at the next period.', 'ok');
      } else if (r && !r.ok) {
        note(esc(r.error || 'Heartbeat not sent.'), 'err');
      }
    } catch (e) { /* ignore */ }
  });

  // Auto = the repeating scheduler toggle (separate from the momentary HB).
  var hbAutoBtn = el('jc-hb-auto');
  hbAutoBtn.addEventListener('click', async function () {
    try {
      // Interval defaults to the setting (15 min); no pre-flight picker now.
      var r = await window.api.heartbeat({ enabled: !hbOn });
      hbOn = !!(r && r.enabled);
      renderHb();
    } catch (e) { /* status push will correct us */ }
  });

  var hbNextAt = 0;   // epoch ms of the next scheduled auto-HB (0 = off)
  function renderHb() {
    hbAutoBtn.className = 'jc-btn' + (hbOn ? ' auto-on' : '');
    hbAutoBtn.title = hbOn
      ? 'Auto-heartbeat is on — turns itself off after 30 minutes without you'
      : 'Auto-heartbeat every few minutes while you are at the radio';
    // Countdown to the next scheduled heartbeat, computed locally from the
    // status snapshot's hbNextAt — the button reads "Auto · 12m".
    if (hbOn && hbNextAt) {
      var s = Math.max(0, Math.round((hbNextAt - Date.now()) / 1000));
      hbAutoBtn.textContent = 'Auto · ' + (s < 60 ? s + 's' : Math.ceil(s / 60) + 'm');
    } else {
      hbAutoBtn.textContent = 'Auto';
    }
  }
  setInterval(renderHb, 1000);

  // SWR-guard banner: persistent while latched, with the ATU recovery in it.
  var swrBanner = el('jc-swr'), swrMsg = el('jc-swr-msg'), swrAtu = el('jc-swr-atu');
  function renderSwr(tripped, message) {
    swrBanner.hidden = !tripped;
    if (tripped) swrMsg.textContent = message || 'TX blocked — SWR too high. Run the ATU.';
    // Make the bar ATU button shout while latched, so the fix is obvious.
    atuBtn.className = 'jc-btn jc-atu' + (tripped ? ' jc-atu-alert' : '');
  }
  function runAtu() {
    window.api.rigControl({ action: 'atu-tune' });
    atuBtn.classList.add('tuning');
    if (atuTimer) clearTimeout(atuTimer);
    atuTimer = setTimeout(function () { atuBtn.classList.remove('tuning'); atuTimer = null; }, 5000);
  }
  swrAtu.addEventListener('click', runAtu);

  // ── start / stop ───────────────────────────────────────────────────────────

  async function startJs8() {
    powerBtn.disabled = true;
    var r;
    try { r = await window.api.start(); }
    catch (e) { r = { ok: false, error: String(e && e.message) }; }
    powerBtn.disabled = false;
    // Errors (no callsign, radio busy) show on the on-air line — the operating
    // UI is up, so there's a place to say why instead of a setup-page banner.
    if (!(r && r.ok)) note(esc((r && r.error) || 'JS8 did not start.'), 'err');
  }

  // The one Start/Stop — the inline bar button, like the FT8 window.
  powerBtn.addEventListener('click', function () {
    if (running) window.api.stop();
    else startJs8();
  });

  function showRunning(on) {
    // Messaging UI is always up (no setup wall); the waterfall + meters appear
    // when the engine runs, so there's no dead black canvas while stopped.
    colsEl.hidden = false;
    instrumentsEl.hidden = !on;
    if (on) resizeWaterfall();   // the canvas had zero size while hidden
    renderRxAge();
  }

  // ── band activity ("I can see the band") ────────────────────────────────────
  function addTraffic(a) {
    if (!a) return;
    var kind = a.kind || 'activity';
    var row = document.createElement('div');
    row.className = 'jc-trow' + (kind === 'to-me' ? ' tome' : kind === 'activity' ? ' activity' : '');
    var from = a.from || '';
    var to = a.to ? ' › ' + a.to : '';
    var snr = (a.snr === 0 || a.snr) ? ((a.snr > 0 ? '+' : '') + a.snr) : '';
    row.innerHTML = '<span class="t">' + esc(hhmm(a.utc)) + '</span>' +
      '<span class="f">' + esc(from + to) + '</span>' +
      '<span class="x">' + esc(a.text || '') + '</span>' +
      '<span class="n">' + esc(snr) + '</span>';
    var empty = trafficList.querySelector('.jc-traffic-empty');
    if (empty) empty.parentNode.removeChild(empty);
    trafficList.insertBefore(row, trafficList.firstChild);
    while (trafficList.childElementCount > 200) trafficList.removeChild(trafficList.lastChild);
    var t = Number(a.utc) || 0; if (t && t < 1e12) t *= 1000;
    if (t > lastDecodeTs) { lastDecodeTs = t; renderRxAge(); }
  }

  // The compact "am I actually receiving?" chip. Green under 3 minutes since the
  // last decode, amber beyond — deliberately refuses to distinguish a dead
  // audio path from a quiet band (it can't), so it reports the observation, not
  // a verdict it can't support.
  function renderRxAge() {
    if (!running) { rxageEl.hidden = true; return; }
    rxageEl.hidden = false;
    if (!lastDecodeTs) { rxageEl.className = 'jc-rxage'; rxageEl.textContent = 'no decodes'; return; }
    var ms = Date.now() - lastDecodeTs;
    rxageEl.className = 'jc-rxage ' + (ms < 180000 ? 'fresh' : 'stale');
    var s = Math.floor(ms / 1000);
    rxageEl.textContent = s < 60 ? s + 's'
      : s < 3600 ? Math.floor(s / 60) + 'm'
      : Math.floor(s / 3600) + 'h ' + (Math.floor(s / 60) % 60) + 'm';
  }
  setInterval(renderRxAge, 1000);

  // ── clock-drift banner ──────────────────────────────────────────────────────
  var clockHideTimer = null;
  function fmtOffset(ms) { return (ms > 0 ? '+' : '') + (ms / 1000).toFixed(1) + 's'; }
  function applyClock(d) {
    if (clockHideTimer) { clearTimeout(clockHideTimer); clockHideTimer = null; }
    if (!d || d.level === 'ok') {
      if (d && d.rebaselined) {
        clockMsgEl.textContent = 'Clock corrected — JS8 timing re-baselined, decoding resumed.';
        clockEl.style.background = '#1a5a2a';
        clockEl.style.borderBottomColor = '#4ecca3';
        clockEl.hidden = false;
        clockHideTimer = setTimeout(function () { clockEl.hidden = true; }, 6000);
      } else { clockEl.hidden = true; }
      return;
    }
    if (d.level === 'unknown') { clockEl.hidden = true; return; } // couldn't measure — don't cry wolf
    var off = fmtOffset(d.offsetMs || 0);
    var bad = d.level === 'bad';
    clockMsgEl.textContent = bad
      // See renderer/jtcat-popout.js: the failure is asymmetric and the old
      // wording pointed the operator at their decoding, which looks healthy.
      ? 'PC clock is ' + off + ' off UTC — stations you call will NOT decode you, so nobody answers.'
        + (Math.abs(d.offsetMs || 0) >= 2000 ? ' Your own decoding will fail too.'
                                            : ' You will still decode them normally, which is why this is easy to miss.')
      : 'PC clock is ' + off + ' off UTC — you will decode fine, but weaker stations may not decode YOU. Sync recommended.';
    clockEl.style.background = bad ? '#5a1a1a' : '#5a4a1a';
    clockEl.style.borderBottomColor = bad ? '#e94560' : '#f0a500';
    clockEl.hidden = false;
  }
  window.api.onClock(applyClock);
  el('jc-clock-set').addEventListener('click', function () { window.api.openTimeSettings(); });
  el('jc-clock-recheck').addEventListener('click', function () {
    clockMsgEl.textContent = 'Checking clock…';
    window.api.checkClock().then(function (c) { if (c) applyClock(c); });
  });
  el('jc-clock-sync').addEventListener('click', function () {
    clockMsgEl.textContent = 'Syncing clock…';
    window.api.syncClock().then(function (r) {
      if (r && r.clock) applyClock(r.clock);
      if (r && r.sync && !r.sync.success) clockMsgEl.textContent = (r.sync.message || 'Sync failed') + ' — use Time settings.';
    });
  });
  if (window.api.getClock) window.api.getClock().then(function (c) { if (c) applyClock(c); });

  // ── waterfall ────────────────────────────────────────────────────────────────
  // Fed by main's FFT over the engine's audio (JS8 decodes in main, so there is
  // no renderer AnalyserNode as in FT8). RX gain here is a brightness control —
  // the native decoder normalises its own input, so attenuating it would only
  // hurt decodes; the operator's real use for the slider is taming the display.
  function resizeWaterfall() {
    var rect = wfCanvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var nw = Math.round(rect.width * dpr), nh = Math.round(rect.height * dpr);
    if (nw > 0 && nh > 0 && (wfCanvas.width !== nw || wfCanvas.height !== nh)) {
      var old = null;
      try { old = wfCtx.getImageData(0, 0, wfCanvas.width, wfCanvas.height); } catch (e) { /* first paint */ }
      wfCanvas.width = nw; wfCanvas.height = nh;
      if (old) wfCtx.putImageData(old, 0, 0);
    }
  }
  function wfColor(norm, data, i) {
    var r, g, b, t;
    if (norm < 0.2) { r = 0; g = 0; b = Math.floor(norm * 5 * 140); }
    else if (norm < 0.4) { t = (norm - 0.2) * 5; r = 0; g = Math.floor(t * 255); b = 140 + Math.floor(t * 115); }
    else if (norm < 0.6) { t = (norm - 0.4) * 5; r = Math.floor(t * 255); g = 255; b = Math.floor((1 - t) * 255); }
    else if (norm < 0.8) { t = (norm - 0.6) * 5; r = 255; g = Math.floor((1 - t) * 255); b = 0; }
    else { t = (norm - 0.8) * 5; r = 255; g = Math.floor(t * 255); b = Math.floor(t * 255); }
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  function drawWfMarkers(w, h) {
    var rxX = Math.round(rxOffsetHz / 3000 * w);
    var txX = Math.round(txOffsetHz / 3000 * w);
    wfCtx.fillStyle = '#000'; wfCtx.fillRect(rxX - 2, 0, 5, h);
    wfCtx.fillStyle = '#4ecca3'; wfCtx.fillRect(rxX - 1, 0, 3, h);
    wfCtx.fillStyle = '#000'; wfCtx.fillRect(txX - 2, 0, 5, h);
    wfCtx.fillStyle = '#ff2222'; wfCtx.fillRect(txX - 1, 0, 3, h);
  }
  window.api.onSpectrum(function (bins) {
    if (!running || wfHidden || !bins || !bins.length) return;   // don't paint a hidden canvas
    if (!wfCanvas.width || !wfCanvas.height) resizeWaterfall();
    var w = wfCanvas.width, h = wfCanvas.height;
    if (!w || !h) return;
    var muted = rxGainLevel <= 0.001;
    wfSilentEl.classList.toggle('show', muted);
    var img = wfCtx.getImageData(0, 0, w, h - 1);   // scroll down 1px
    wfCtx.putImageData(img, 0, 1);
    var line = wfCtx.createImageData(w, 1);
    var n = bins.length;
    for (var x = 0; x < w; x++) {
      var v = muted ? 0 : Math.min(255, bins[Math.floor(x * n / w)] * rxGainLevel);
      wfColor(v / 255, line.data, x * 4);
    }
    wfCtx.putImageData(line, 0, 0);
    drawWfMarkers(w, h);
  });
  wfCanvas.addEventListener('click', function (e) {
    var rect = wfCanvas.getBoundingClientRect();
    var hz = Math.round((e.clientX - rect.left) / rect.width * 3000 / 10) * 10;
    hz = Math.max(200, Math.min(2900, hz));
    txOffsetHz = hz;                 // optimistic; the status echo confirms
    if (window.api.setOffset) window.api.setOffset(hz);
  });
  window.addEventListener('resize', function () { if (!wfHidden) resizeWaterfall(); });

  // Hide/show the waterfall — persisted, so it stays the operator's choice.
  var WF_HIDDEN_KEY = 'potacat-js8-wf-hidden';
  function applyWfHidden(hidden, persist) {
    wfHidden = !!hidden;
    wfWrapEl.style.display = wfHidden ? 'none' : '';
    wfToggleBtn.textContent = wfHidden ? 'Show waterfall' : 'Hide waterfall';
    if (!wfHidden) resizeWaterfall();   // canvas had zero size while hidden
    if (persist) { try { localStorage.setItem(WF_HIDDEN_KEY, wfHidden ? '1' : '0'); } catch (e) { /* private mode */ } }
  }
  wfToggleBtn.addEventListener('click', function () { applyWfHidden(!wfHidden, true); });
  try { applyWfHidden(localStorage.getItem(WF_HIDDEN_KEY) === '1', false); } catch (e) { /* ignore */ }

  // ── ⚙ options popover (heartbeat reply, SWR auto-tune, HB interval) ──────────
  // Same open/close grammar as the JTCAT gear: the ⚙ toggles it, outside-click
  // and Esc close it. The toggles' authoritative state comes from onStatus.
  var gearBtn = el('jc-gear-btn'), gearPop = el('jc-gear-pop'),
      hbAckRow = el('jc-opt-hback'), swrAutoRow = el('jc-opt-swr-autotune'), hbMinInput = el('jc-opt-hbmin');
  function setGearOpen(open) {
    gearPop.classList.toggle('hidden', !open);
    gearBtn.classList.toggle('active', open);
  }
  gearBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    setGearOpen(gearPop.classList.contains('hidden'));
  });
  document.addEventListener('click', function (e) {
    if (gearPop.classList.contains('hidden')) return;
    if (gearPop.contains(e.target) || e.target === gearBtn) return;
    setGearOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !gearPop.classList.contains('hidden')) setGearOpen(false);
  });
  // HB ACK — automatic reply to heartbeats. Session-only, like the Auto HB
  // toggle; main enforces the attended-watchdog / SWR / dupe rules.
  hbAckRow.addEventListener('click', function () {
    var on = !hbAckRow.classList.contains('active');
    hbAckRow.classList.toggle('active', on);
    if (window.api.setHbAck) window.api.setHbAck(on);
  });
  swrAutoRow.addEventListener('click', function () {
    var on = !swrAutoRow.classList.contains('active');
    swrAutoRow.classList.toggle('active', on);
    if (window.api.setSwrAutoTune) window.api.setSwrAutoTune(on);
  });
  // Joined @NETS — persisted on change/Enter; status echo refills when idle.
  var groupsInput = el('jc-opt-groups');
  groupsInput.addEventListener('change', function () {
    if (window.api.setGroups) window.api.setGroups(groupsInput.value);
  });
  // Outbound SMS/email via APRS. Airtime estimate updates as you type: the
  // on-air text is "@APRSIS CMD :GATE:body{NN" and JS8 NORMAL moves ~10
  // chars/frame, 15 s each — the honesty matters more than the precision.
  var smsKind = el('jc-sms-kind'), smsTo = el('jc-sms-to'), smsText = el('jc-sms-text'),
      smsEst = el('jc-sms-est'), smsSend = el('jc-sms-send');
  smsKind.addEventListener('change', function () {
    smsTo.placeholder = smsKind.value === 'email' ? 'name@example.com' : '+1 555 123 4567';
  });
  function smsEstimate() {
    var len = 30 + smsTo.value.length + smsText.value.length;   // envelope + addressee overhead
    var frames = Math.max(1, Math.ceil(len / 10));
    smsEst.textContent = smsText.value
      ? '~' + frames + ' frames · ~' + Math.round(frames * 15 / 60 * 10) / 10 + ' min on air'
      : 'One-way text to a phone or email via the APRS network.';
  }
  smsTo.addEventListener('input', smsEstimate);
  smsText.addEventListener('input', smsEstimate);
  smsSend.addEventListener('click', async function (e) {
    e.preventDefault();
    smsSend.disabled = true;
    try {
      var r = await window.api.sendSms(smsKind.value, smsTo.value, smsText.value);
      smsEst.textContent = (r && r.ok) ? 'On the air — needs a listening APRS gateway to deliver.' : ((r && r.error) || 'Not sent.');
      if (r && r.ok) smsText.value = '';
    } catch (err) { smsEst.textContent = 'Not sent.'; }
    smsSend.disabled = false;
  });

  var mailHoldRow = el('jc-opt-mail-hold'), mailUnattRow = el('jc-opt-mail-unattended');
  mailHoldRow.addEventListener('click', function () {
    var on = !mailHoldRow.classList.contains('active');
    mailHoldRow.classList.toggle('active', on);
    if (window.api.setMailOpts) window.api.setMailOpts({ hold: on });
  });
  mailUnattRow.addEventListener('click', function () {
    var on = !mailUnattRow.classList.contains('active');
    mailUnattRow.classList.toggle('active', on);
    if (window.api.setMailOpts) window.api.setMailOpts({ unattended: on });
  });
  var aprsGateRow = el('jc-opt-aprs-gate'), aprsGateState = el('jc-aprs-gate-state');
  aprsGateRow.addEventListener('click', function () {
    var on = !aprsGateRow.classList.contains('active');
    aprsGateRow.classList.toggle('active', on);
    if (window.api.setAprsGate) window.api.setAprsGate(on);
  });
  hbMinInput.addEventListener('change', function () {
    var n = parseInt(hbMinInput.value, 10);
    if (n >= 5 && n <= 60 && window.api.heartbeat) window.api.heartbeat({ intervalMin: n });
  });

  // ── RX gain (the one synced level; also our waterfall brightness) ───────────
  function applyRxGainPct(pct, echo) {
    pct = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    rxGainEl.value = pct;
    rxGainValEl.textContent = pct + '%';
    rxGainLevel = pct / 100;
    if (echo && window.api.setRxGain) window.api.setRxGain(rxGainLevel);
  }
  rxGainEl.addEventListener('input', function () { applyRxGainPct(rxGainEl.value, true); });
  if (window.api.onSetRxGain) window.api.onSetRxGain(function (level) { applyRxGainPct(Number(level) * 100, false); });

  // ── S-meter + SWR bars (JTCAT's meter grammar) ──────────────────────────────
  if (window.api.onSmeter) window.api.onSmeter(function (val) {
    var v = Number(val) || 0;
    var color = v < 80 ? '#4ecca3' : v < 160 ? '#ffd740' : '#e94560';
    smeterBar.style.width = Math.min(100, v / 255 * 100) + '%';
    smeterBar.style.background = color;
    smeterVal.textContent = v <= 120 ? 'S' + Math.round(v * 9 / 120) : 'S9+' + Math.round((v - 120) * 60 / 135);
    smeterVal.style.color = color;
  });
  var swrIdle = null;
  function blankSwr() { swrBarEl.style.width = '0%'; swrValEl.textContent = '—'; swrValEl.style.color = ''; }
  function swrSeen() { if (swrIdle) clearTimeout(swrIdle); swrIdle = setTimeout(blankSwr, 10000); }
  function drawSwr(swr) {
    var color = swr <= 1.5 ? '#4ecca3' : swr <= 2.0 ? '#ffd740' : swr <= 3.0 ? '#f0a500' : '#e94560';
    swrBarEl.style.width = Math.min(100, ((swr - 1) / 4) * 100) + '%';
    swrBarEl.style.background = color;
    swrValEl.textContent = swr < 10 ? swr.toFixed(1) : '>10';
    swrValEl.style.color = color;
    swrSeen();
  }
  if (window.api.onSwr) window.api.onSwr(function (val) { var v = Number(val) || 0; if (v <= 0) { blankSwr(); return; } drawSwr(1.0 + v / 60); });
  if (window.api.onSwrRatio) window.api.onSwrRatio(function (s) { var v = Number(s) || 0; if (v <= 0) { blankSwr(); return; } drawSwr(v); });

  // ── Halt ─────────────────────────────────────────────────────────────────────
  haltBtn.addEventListener('click', function () { if (window.api.halt) window.api.halt(); });

  // ── Heartbeat Map ───────────────────────────────────────────────────────────
  el('jc-map').addEventListener('click', function () { if (window.api.openMap) window.api.openMap(); });

  // ── wire-up ────────────────────────────────────────────────────────────────

  window.api.onStatus(function (s) {
    var up = !!(s && (s.running || s.connected));
    var was = running;
    running = up;
    dotEl.className = 'jc-dot ' + (up ? 'up' : 'down');
    stateEl.textContent = up ? 'JS8 running' : 'JS8 is off';

    var st = (s && s.station) || {};
    stationEl.textContent = st.call || '';
    submodeEl.textContent = up && s.submode ? s.submode : '';
    if (s && s.submode) currentSubmode = String(s.submode).toUpperCase();

    var tx = !!(s && s.tx);
    txNow = tx;
    var queued = (s && s.txQueue) || 0;   // frames NOT yet started
    var total = (s && s.txTotal) || 0;    // frames in the whole message
    txEl.className = 'jc-tx' + (tx ? ' on' : '');
    if (tx) {
      // A multi-frame message keys for several periods — show which one we're on
      // so it doesn't just "keep keying up" with no sense of progress.
      var cur = total > 1 ? (total - queued) : 0;
      txEl.textContent = total > 1 ? ('TX ' + cur + '/' + total) : 'TX';
      txEl.title = total > 1 ? ('Transmitting ' + cur + ' of ' + total + ' — about ' + ((total - cur + 1) * (SUBMODE_PERIODS[currentSubmode] || 15)) + 's left.') : 'Transmitting this period.';
    } else if (queued) {
      txEl.textContent = total > 1 ? (total + ' tx queued') : (queued + ' queued');
      txEl.title = 'Queued — sends at the next period.';
    } else {
      txEl.textContent = 'RX';
      txEl.title = 'Receiving.';
    }
    // Halt is a reserved slot, disabled when there's nothing on air or queued —
    // never mounted conditionally (a control that appears as you reach for it
    // reflows the row). Merge-over-previous: absent fields leave it alone.
    haltBtn.disabled = !(tx || queued);

    // Waterfall markers follow the operator-chosen offsets.
    if (s && s.txOffset) txOffsetHz = s.txOffset;
    if (s && s.rxOffset) rxOffsetHz = s.rxOffset;

    // The period clock only means something while the engine runs.
    cycleEl.hidden = cycleBar.hidden = !up;

    hbOn = !!(s && s.heartbeat);
    hbNextAt = (s && s.hbNextAt) || 0;
    renderHb();
    renderSwr(!!(s && s.swrTripped), s && s.swrMessage);
    // Gear toggles mirror main's authoritative state.
    hbAckRow.classList.toggle('active', !!(s && s.hbAck));
    swrAutoRow.classList.toggle('active', !!(s && s.swrAutoTune));
    mailHoldRow.classList.toggle('active', !(s && s.mailHold === false));
    mailUnattRow.classList.toggle('active', !!(s && s.mailUnattended));
    aprsGateRow.classList.toggle('active', !!(s && s.aprsGate));
    aprsGateState.textContent = (s && s.aprsGate) ? (s.aprsGateUp ? '— connected' : '— connecting…') : '';
    if (s && Array.isArray(s.groups) && document.activeElement !== groupsInput) groupsInput.value = s.groups.join(', ');
    if (s && s.heartbeatMin && document.activeElement !== hbMinInput) hbMinInput.value = s.heartbeatMin;
    if (up !== was && !up) lastDecodeTs = 0;   // a fresh session starts unheard

    // Live dial + band picker from the status snapshot (also arrives via
    // cat-frequency; either keeps them current).
    if (s && s.dialHz) {
      dialEl.textContent = (s.dialHz / 1e6).toFixed(3) + ' MHz';
      var sb = bandByRange(s.dialHz);
      if (sb !== bandEl.value && document.activeElement !== bandEl) bandEl.value = sb;
    }

    actsEl.hidden = !up;
    powerBtn.textContent = up ? 'Stop' : 'Start';
    if (up !== was) showRunning(up);
    refreshCompose();
  });

  window.api.onThreads(function (d) {
    if (!d) return;
    lastList = d.list || [];
    renderConvs(lastList);
    setUnreadTotal(d.unread || 0);
    // Only re-render the transcript when the change is the thread on screen.
    if (d.changed && d.changed === openId && d.thread) renderThread(d.thread);
  });

  window.api.onHeard(function (list) {
    renderHeard(list);
  });

  // Band activity — EVERY decode, not just directed traffic. The conversation
  // rail shows only messages addressed to a correspondent, so without this an
  // operator decoding a busy band sees an empty screen ("am I receiving?").
  // Directed-to-you rows are highlighted; ambient traffic is dimmed.
  window.api.onActivity(function (a) { addTraffic(a); });

  // Refusals from a manual HB / send (SWR trip, radio busy) land here.
  window.api.onSendResult(function (r) {
    if (r && !r.ok) note(esc(r.error || 'Not sent.'), 'err');
  });

  window.api.onTheme(function (t) {
    if (typeof window._applyPopoutTheme === 'function') window._applyPopoutTheme(t);
  });

  // Initial state.
  (async function init() {
    try {
      var d = await window.api.threads();
      if (d) {
        lastList = d.list || [];
        renderConvs(lastList);
        setUnreadTotal(d.unread || 0);
        renderHeard(d.heard || []);
      }
    } catch (e) { /* main not ready yet; the status push will follow */ }
    refreshCompose();
    renderHb();
    if (!trafficList.childElementCount) {
      var ph = document.createElement('div');
      ph.className = 'jc-traffic-empty';
      ph.textContent = 'Decodes appear here once JS8 is running.';
      trafficList.appendChild(ph);
    }
    showThreadView(false);   // start on the band-activity view, no conversation open
    showRunning(false);      // the status push corrects this if JS8 is already up
  })();
  // Relative times drift; re-render the rails once a minute so "4m" stays true.
  setInterval(function () { if (lastList.length) renderConvs(lastList); renderHeard(heard); }, 60000);

  window.addEventListener('beforeunload', function () { window.api.threadClosed(); });

  // Titlebar buttons.
  el('jc-min').addEventListener('click', function () { window.api.minimizeWindow(); });
  el('jc-max').addEventListener('click', function () { window.api.maximizeWindow(); });
  el('jc-close').addEventListener('click', function () { window.api.closeWindow(); });

  // Zoom, matching the other popouts.
  var ZOOM_KEY = 'potacat-js8call-popout-zoom', ZMIN = 0.7, ZMAX = 2.0, ZSTEP = 0.1;
  function setZoom(z) {
    var c = Math.max(ZMIN, Math.min(ZMAX, z));
    window.api.setZoom(c);
    try { localStorage.setItem(ZOOM_KEY, c.toFixed(2)); } catch (e) { /* private mode */ }
  }
  try {
    var saved = parseFloat(localStorage.getItem(ZOOM_KEY) || '1');
    if (isFinite(saved) && saved >= ZMIN && saved <= ZMAX) setZoom(saved);
  } catch (e) { /* ignore */ }
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom((window.api.getZoom() || 1) + ZSTEP); }
    else if (e.key === '-') { e.preventDefault(); setZoom((window.api.getZoom() || 1) - ZSTEP); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
  });
  document.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom((window.api.getZoom() || 1) + (e.deltaY < 0 ? ZSTEP : -ZSTEP));
  }, { passive: false });
})();
